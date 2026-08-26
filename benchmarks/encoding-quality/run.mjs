#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import process from "node:process";
import { Sandbox } from "@vercel/sandbox";

const SNAPSHOT_LOCK = new URL("../../.sandbox-video/snapshot.json", import.meta.url);
const RIG_ROOT = new URL("../recording-test-rig/", import.meta.url);
const SANDBOX_ROOT = "/vercel/sandbox/.sandbox-video/encoding-quality";
const RIG_DIRECTORY = `${SANDBOX_ROOT}/recording-test-rig`;
const OUTPUT_DIRECTORY = `${SANDBOX_ROOT}/artifacts`;
const DISPLAY = ":99";
const XAUTHORITY = `${SANDBOX_ROOT}/Xauthority`;
const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 60;
const SANDBOX_TIMEOUT_MS = 20 * 60 * 1000;
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const PROCESS_STOP_TIMEOUT_MS = 5_000;
const UPLOADS_CLI_PACKAGE = "@buildinternet/uploads@0.48.0";
const UPLOADS_CLI_VERSION = "0.48.0";

const RIG_FILES = [
  "benchmark-agent.mjs",
  "index.html",
  "main.jsx",
  "package-lock.json",
  "package.json",
  "screen-record-test-rig.jsx",
  "vite.config.js",
];

const MASTER = {
  id: "rgb-reference-crf8",
  filename: "rgb-reference-crf8.mkv",
  contentType: "video/x-matroska",
  settings: {
    codec: "libx264rgb",
    preset: "veryfast",
    crf: 8,
    pixelFormat: "bgr0",
    gopFrames: 120,
    timestampMode: "passthrough",
  },
};

const PROFILES = [
  {
    id: "current-crf23-420-cfr",
    filename: "current-crf23-420-cfr.mp4",
    contentType: "video/mp4",
    settings: {
      codec: "libx264",
      preset: "veryfast",
      crf: 23,
      pixelFormat: "yuv420p",
      gopFrames: 600,
      timestampMode: "cfr",
      container: "mp4",
    },
    args: [
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-pix_fmt",
      "yuv420p",
      "-r",
      "60",
      "-g",
      "600",
      "-keyint_min",
      "600",
      "-sc_threshold",
      "0",
      "-force_key_frames",
      "expr:gte(t,n_forced*10)",
      "-movflags",
      "+faststart",
    ],
  },
  diagnosticProfile("diagnostic-crf12-444-passthrough", 12, "yuv444p"),
  diagnosticProfile("crf14-444", 14, "yuv444p"),
  diagnosticProfile("crf16-444", 16, "yuv444p"),
  diagnosticProfile("crf12-420", 12, "yuv420p"),
  diagnosticProfile("crf23-444", 23, "yuv444p"),
];

function diagnosticProfile(id, crf, pixelFormat) {
  return {
    id,
    filename: `${id}.mp4`,
    contentType: "video/mp4",
    settings: {
      codec: "libx264",
      preset: "veryfast",
      crf,
      pixelFormat,
      gopFrames: 120,
      timestampMode: "passthrough",
      container: "mp4",
    },
    args: [
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      String(crf),
      "-pix_fmt",
      pixelFormat,
      "-g",
      "120",
      "-fps_mode",
      "passthrough",
      "-movflags",
      "+faststart",
    ],
  };
}

async function resolveSnapshotId() {
  const configured = process.env.SANDBOX_VIDEO_SNAPSHOT_ID?.trim();
  if (configured) return configured;
  try {
    const snapshot = parseJson(await readFile(SNAPSHOT_LOCK, "utf8"), "snapshot lock");
    assertNonemptyString(snapshot.snapshotId, "snapshotId");
    return snapshot.snapshotId;
  } catch (error) {
    throw new Error(
      "Set SANDBOX_VIDEO_SNAPSHOT_ID or provide .sandbox-video/snapshot.json with a snapshotId",
      { cause: error },
    );
  }
}

async function main() {
  const startedAt = new Date();
  const snapshotId = await resolveSnapshotId();
  const uploads = await readUploadsConfig();
  const runId = startedAt.toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const uploadPrefix = `screenshots/sandbox-video/encoding-quality/${runId}`;
  const vcpus = positiveInteger(process.env.SANDBOX_VIDEO_BENCHMARK_VCPUS ?? "4", "vCPU count");

  let sandbox = null;
  let preview = null;
  let xvfb = null;
  let openbox = null;
  let capture = null;
  let stopTask = null;
  let interruptSignal = null;
  let report;

  const requestSandboxStop = () => {
    if (sandbox === null) return null;
    stopTask ??= sandbox.stop();
    return stopTask;
  };
  const handleInterrupt = (signal) => {
    if (interruptSignal !== null) return;
    interruptSignal = signal;
    process.exitCode = signal === "SIGINT" ? 130 : 143;
    progress(`${signal} received; requesting immediate Sandbox stop`);
    void requestSandboxStop()?.catch(() => undefined);
  };
  const handleSigint = () => handleInterrupt("SIGINT");
  const handleSigterm = () => handleInterrupt("SIGTERM");
  process.on("SIGINT", handleSigint);
  process.on("SIGTERM", handleSigterm);

  try {
    progress(`creating ${vcpus}-vCPU Sandbox from ${snapshotId}`);
    sandbox = await Sandbox.create({
      source: { type: "snapshot", snapshotId },
      resources: { vcpus },
      timeout: SANDBOX_TIMEOUT_MS,
      persistent: false,
    });
    if (interruptSignal !== null) {
      await requestSandboxStop();
      throw new Error(`interrupted by ${interruptSignal}`);
    }

    await runSuccess(sandbox, "mkdir", ["-p", RIG_DIRECTORY, OUTPUT_DIRECTORY]);
    await uploadRig(sandbox);
    progress("building recording test rig inside Sandbox");
    await runSuccess(sandbox, "npm", ["ci", "--no-audit", "--no-fund"], {
      cwd: RIG_DIRECTORY,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    await runSuccess(sandbox, "npm", ["run", "build"], {
      cwd: RIG_DIRECTORY,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    preview = await sandbox.runCommand({
      cmd: "npm",
      args: ["run", "preview", "--", "--host", "127.0.0.1"],
      cwd: RIG_DIRECTORY,
      detached: true,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    await waitForCommand(
      sandbox,
      "curl",
      ["--fail", "--silent", "--show-error", "http://127.0.0.1:4173/"],
      {},
    );

    const display = await startDisplay(sandbox);
    xvfb = display.xvfb;
    openbox = display.openbox;

    progress("capturing one high-fidelity RGB 1920x1080@60 reference");
    const masterPath = `${OUTPUT_DIRECTORY}/${MASTER.filename}`;
    capture = await sandbox.runCommand({
      cmd: "ffmpeg",
      args: [
        "-hide_banner",
        "-loglevel",
        "warning",
        "-y",
        "-f",
        "x11grab",
        "-framerate",
        String(FPS),
        "-video_size",
        `${WIDTH}x${HEIGHT}`,
        "-i",
        `${DISPLAY}.0`,
        "-an",
        "-c:v",
        MASTER.settings.codec,
        "-preset",
        MASTER.settings.preset,
        "-crf",
        String(MASTER.settings.crf),
        "-pix_fmt",
        MASTER.settings.pixelFormat,
        "-g",
        String(MASTER.settings.gopFrames),
        "-fps_mode",
        MASTER.settings.timestampMode,
        masterPath,
      ],
      env: { DISPLAY, XAUTHORITY },
      detached: true,
      timeoutMs: COMMAND_TIMEOUT_MS,
    });
    await runSuccess(sandbox, "sleep", ["1"]);
    await runSuccess(sandbox, "pgrep", ["-f", "ffmpeg.*rgb-reference-crf8.mkv"]);

    const agentResult = await runSuccess(sandbox, "node", ["benchmark-agent.mjs"], {
      cwd: RIG_DIRECTORY,
      env: {
        ...browserEnvironment(),
        SANDBOX_VIDEO_BENCHMARK_URL: "http://127.0.0.1:4173/",
      },
      timeoutMs: 75_000,
    });
    const captureResult = await stopCommand(capture, "SIGINT", 15_000);
    capture = null;
    if (captureResult.exitCode !== 0 && captureResult.exitCode !== 255) {
      throw new Error(
        `master capture exited ${captureResult.exitCode}: ${await captureResult.stderr()}`,
      );
    }
    await runOptional(sandbox, "agent-browser", ["--session", "sandbox-video-benchmark", "close"], {
      env: browserEnvironment(),
    });

    const ffmpegVersion = firstLine((await runSuccess(sandbox, "ffmpeg", ["-version"])).stdout);
    const masterArtifact = await inspectMedia(
      sandbox,
      MASTER,
      masterPath,
      captureResult.durationMs,
    );
    const profileArtifacts = [];

    for (const profile of PROFILES) {
      progress(`encoding ${profile.id}`);
      const outputPath = `${OUTPUT_DIRECTORY}/${profile.filename}`;
      const result = await runSuccess(
        sandbox,
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "warning",
          "-y",
          "-i",
          masterPath,
          "-map",
          "0:v:0",
          "-an",
          ...profile.args,
          outputPath,
        ],
        { timeoutMs: COMMAND_TIMEOUT_MS },
      );
      profileArtifacts.push(await inspectMedia(sandbox, profile, outputPath, result.durationMs));
    }

    progress(`installing pinned uploads.sh CLI ${UPLOADS_CLI_VERSION} inside Sandbox`);
    await runSuccess(
      sandbox,
      "npm",
      ["install", "--global", "--no-audit", "--no-fund", UPLOADS_CLI_PACKAGE],
      { sudo: true, timeoutMs: COMMAND_TIMEOUT_MS },
    );
    const uploadsVersion = firstLine((await runSuccess(sandbox, "uploads", ["--version"])).stdout);
    if (uploadsVersion !== UPLOADS_CLI_VERSION) {
      throw new Error(`expected uploads CLI ${UPLOADS_CLI_VERSION}, received ${uploadsVersion}`);
    }

    const allArtifacts = [masterArtifact, ...profileArtifacts];
    const uploadOrder = [...profileArtifacts, masterArtifact];
    for (const artifact of uploadOrder) {
      progress(`uploading ${artifact.id} directly from Sandbox`);
      artifact.upload = await uploadArtifact(
        sandbox,
        artifact,
        `${OUTPUT_DIRECTORY}/${artifact.filename}`,
        `${uploadPrefix}/${artifact.filename}`,
        uploads,
      );
    }

    for (const artifact of allArtifacts.filter(({ contentType }) => contentType === "video/mp4")) {
      progress(`checking Chrome playback for ${artifact.id}`);
      artifact.playback = await checkPlayback(sandbox, artifact.upload.url);
    }
    await runOptional(sandbox, "agent-browser", ["--session", "sandbox-video-playback", "close"], {
      env: browserEnvironment(),
    });

    report = {
      schemaVersion: 1,
      status: "complete",
      runId,
      startedAt: startedAt.toISOString(),
      endedAt: new Date().toISOString(),
      sandbox: {
        id: sandbox.name,
        snapshotId,
        vcpus,
        stopped: false,
      },
      source: {
        width: WIDTH,
        height: HEIGHT,
        fps: FPS,
        agentMetrics: parseMotion(agentResult.stdout),
      },
      tools: { ffmpeg: ffmpegVersion, uploads: uploadsVersion },
      uploads: { workspace: uploads.workspace, prefix: uploadPrefix },
      artifacts: allArtifacts,
    };
  } catch (error) {
    report = {
      schemaVersion: 1,
      status: "failed",
      startedAt: startedAt.toISOString(),
      endedAt: new Date().toISOString(),
      error: interruptSignal === null ? safeError(error) : `interrupted by ${interruptSignal}`,
      ...(sandbox === null ? {} : { sandbox: { id: sandbox.name, snapshotId, stopped: false } }),
    };
    process.exitCode = 1;
  } finally {
    await Promise.all([
      killCommand(capture, "SIGINT"),
      killCommand(openbox),
      killCommand(xvfb),
      killCommand(preview),
    ]);
    if (sandbox !== null) {
      progress(`stopping Sandbox ${sandbox.name}`);
      try {
        await requestSandboxStop();
        if (report.sandbox) report.sandbox.stopped = true;
      } catch (error) {
        if (report.sandbox) report.sandbox.stopped = false;
        report.cleanupError = `failed to stop Sandbox: ${safeError(error)}`;
        if (report.status === "complete") report.status = "failed";
        process.exitCode = 1;
      }
    }
    process.off("SIGINT", handleSigint);
    process.off("SIGTERM", handleSigterm);
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

async function uploadRig(sandbox) {
  const files = await Promise.all(
    RIG_FILES.map(async (name) => ({
      path: `${RIG_DIRECTORY}/${name}`,
      content: await readFile(new URL(name, RIG_ROOT)),
    })),
  );
  await sandbox.writeFiles(files);
}

async function startDisplay(sandbox) {
  const cookie = firstLine((await runSuccess(sandbox, "mcookie", [])).stdout);
  await runSuccess(sandbox, "xauth", ["-f", XAUTHORITY, "add", DISPLAY, ".", cookie]);
  const env = { DISPLAY, XAUTHORITY };
  const xvfb = await sandbox.runCommand({
    cmd: "Xvfb",
    args: [
      DISPLAY,
      "-screen",
      "0",
      `${WIDTH}x${HEIGHT}x24`,
      "-nolisten",
      "tcp",
      "-auth",
      XAUTHORITY,
    ],
    env,
    detached: true,
  });
  try {
    await waitForCommand(sandbox, "xdpyinfo", ["-display", DISPLAY], env);
    const openbox = await sandbox.runCommand({
      cmd: "openbox",
      args: ["--sm-disable"],
      env,
      detached: true,
    });
    try {
      await waitForCommand(sandbox, "xprop", ["-root", "_NET_SUPPORTING_WM_CHECK"], env);
      return { xvfb, openbox };
    } catch (error) {
      await killCommand(openbox);
      throw error;
    }
  } catch (error) {
    await killCommand(xvfb);
    throw error;
  }
}

async function waitForCommand(sandbox, cmd, args, env) {
  let lastDetail = "not ready";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = await runOptional(sandbox, cmd, args, { env, timeoutMs: 2_000 });
    if (result.exitCode === 0) return;
    lastDetail = firstLine(result.stderr) || firstLine(result.stdout) || lastDetail;
    await runSuccess(sandbox, "sleep", ["0.25"]);
  }
  throw new Error(`${cmd} did not become ready: ${lastDetail}`);
}

async function inspectMedia(sandbox, definition, path, encodeDurationMs) {
  const probe = parseJson(
    (
      await runSuccess(sandbox, "ffprobe", [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=codec_name,profile,pix_fmt,width,height,avg_frame_rate,r_frame_rate,nb_frames:format=duration,size,bit_rate",
        "-of",
        "json",
        path,
      ])
    ).stdout,
    `ffprobe output for ${definition.id}`,
  );
  const sizeBytes = Number((await runSuccess(sandbox, "stat", ["-c", "%s", path])).stdout.trim());
  const sha256 = firstLine((await runSuccess(sandbox, "sha256sum", [path])).stdout).split(
    /\s+/u,
  )[0];
  return {
    id: definition.id,
    filename: definition.filename,
    contentType: definition.contentType,
    settings: definition.settings,
    sizeBytes,
    encodeDurationMs: encodeDurationMs ?? null,
    sha256,
    probe,
  };
}

async function uploadArtifact(sandbox, artifact, path, key, uploads) {
  const result = await runSuccess(
    sandbox,
    "uploads",
    [
      "put",
      path,
      "--key",
      key,
      "--workspace",
      uploads.workspace,
      "--content-type",
      artifact.contentType,
      "--no-optimize",
      "--no-git",
      "--no-auto",
      "--no-pr",
      "--format",
      "json",
      "--replace",
    ],
    { env: uploads.env, timeoutMs: COMMAND_TIMEOUT_MS },
  );
  const payload = parseJson(result.stdout, `uploads response for ${artifact.id}`);
  if (typeof payload.url !== "string" || typeof payload.key !== "string") {
    throw new Error(`uploads returned an invalid response for ${artifact.id}`);
  }
  return {
    key: payload.key,
    url: payload.url,
    contentType:
      typeof payload.contentType === "string" ? payload.contentType : artifact.contentType,
    sizeBytes: typeof payload.size === "number" ? payload.size : artifact.sizeBytes,
  };
}

async function checkPlayback(sandbox, url) {
  const sessionArgs = ["--session", "sandbox-video-playback", "--json"];
  try {
    await runSuccess(sandbox, "agent-browser", [...sessionArgs, "open", url], {
      env: browserEnvironment(),
      timeoutMs: 20_000,
    });
    const metadataWait = await runOptional(
      sandbox,
      "agent-browser",
      [
        ...sessionArgs,
        "wait",
        "--fn",
        "(() => { const v = document.querySelector('video'); return Boolean(v && (v.readyState >= 1 || v.error)); })()",
        "--timeout",
        "15000",
      ],
      { env: browserEnvironment(), timeoutMs: 20_000 },
    );
    await evaluateBrowser(
      sandbox,
      sessionArgs,
      `(() => {
      const video = document.querySelector('video');
      window.__sandboxVideoPlayback = { playError: null };
      if (!video) return { started: false, reason: 'missing_video_element' };
      video.muted = true;
      video.play().catch((error) => {
        window.__sandboxVideoPlayback.playError = error instanceof Error ? error.message : String(error);
      });
      return { started: true };
    })()`,
    );
    const advancementWait = await runOptional(
      sandbox,
      "agent-browser",
      [
        ...sessionArgs,
        "wait",
        "--fn",
        `(() => {
          const video = document.querySelector('video');
          const state = window.__sandboxVideoPlayback;
          return Boolean(video && (video.currentTime >= 0.25 || video.error || state?.playError));
        })()`,
        "--timeout",
        "15000",
      ],
      { env: browserEnvironment(), timeoutMs: 20_000 },
    );
    const result = await evaluateBrowser(
      sandbox,
      sessionArgs,
      `(() => {
      const video = document.querySelector('video');
      if (!video) return { playable: false, reason: 'missing_video_element' };
      const error = video.error;
      const currentTimeSeconds = video.currentTime;
      const advanced = currentTimeSeconds >= 0.25;
      const playError = window.__sandboxVideoPlayback?.playError ?? null;
      return {
        playable: !error && !playError && advanced && Number.isFinite(video.duration),
        advanced,
        currentTimeSeconds,
        readyState: video.readyState,
        networkState: video.networkState,
        durationSeconds: Number.isFinite(video.duration) ? video.duration : null,
        width: video.videoWidth,
        height: video.videoHeight,
        paused: video.paused,
        playError,
        error: error ? { code: error.code, message: error.message || null } : null,
      };
    })()`,
    );
    return {
      checked: true,
      metadataWaitCompleted: metadataWait.exitCode === 0,
      advancementWaitCompleted: advancementWait.exitCode === 0,
      ...result,
    };
  } catch (error) {
    return { checked: true, playable: false, reason: safeError(error) };
  }
}

async function evaluateBrowser(sandbox, sessionArgs, expression) {
  const result = await runSuccess(sandbox, "agent-browser", [...sessionArgs, "eval", expression], {
    env: browserEnvironment(),
    timeoutMs: 20_000,
  });
  const payload = parseJson(result.stdout, "agent-browser playback response");
  if (payload.success !== true || payload.data === undefined || !("result" in payload.data)) {
    throw new Error("agent-browser returned an invalid playback response");
  }
  return payload.data.result;
}

async function readUploadsConfig() {
  const configPath =
    process.env.BUILDINTERNET_CONFIG ??
    join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "buildinternet", "config");
  const text = await readFile(configPath, "utf8");
  const allowed = new Set([
    "UPLOADS_API_URL",
    "UPLOADS_WORKSPACE",
    "UPLOADS_TOKEN",
    "UPLOADS_SESSION_TOKEN",
  ]);
  const values = {};
  for (const sourceLine of text.split(/\r?\n/u)) {
    const line = sourceLine.trim().replace(/^export\s+/u, "");
    if (line.length === 0 || line.startsWith("#")) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line);
    if (!match || !allowed.has(match[1])) continue;
    values[match[1]] = parseConfigValue(match[2].trim());
  }
  assertNonemptyString(values.UPLOADS_WORKSPACE, "UPLOADS_WORKSPACE");
  if (!values.UPLOADS_TOKEN && !values.UPLOADS_SESSION_TOKEN) {
    throw new Error(`uploads credentials are missing from ${basename(configPath)}`);
  }
  return {
    workspace: values.UPLOADS_WORKSPACE,
    env: values,
  };
}

function parseConfigValue(raw) {
  if (raw.startsWith('"') && raw.endsWith('"')) {
    return JSON.parse(raw);
  }
  if (raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1);
  }
  return raw;
}

function browserEnvironment() {
  return {
    DISPLAY,
    XAUTHORITY,
    AGENT_BROWSER_HEADED: "1",
    AGENT_BROWSER_NO_XVFB: "1",
    AGENT_BROWSER_ALLOW_FILE_ACCESS: "1",
    AGENT_BROWSER_ARGS: "--start-maximized",
  };
}

async function runSuccess(sandbox, cmd, args, options = {}) {
  const result = await runOptional(sandbox, cmd, args, options);
  if (result.exitCode !== 0) {
    const detail = (result.stderr.trim() || result.stdout.trim() || "no output").slice(0, 2_000);
    throw new Error(`${cmd} exited ${result.exitCode}: ${detail}`);
  }
  return result;
}

async function runOptional(sandbox, cmd, args, options = {}) {
  const command = await sandbox.runCommand({
    cmd,
    args,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.sudo === undefined ? {} : { sudo: options.sudo }),
    timeoutMs: options.timeoutMs ?? 30_000,
  });
  const [stdout, stderr] = await Promise.all([command.stdout(), command.stderr()]);
  return { exitCode: command.exitCode, stdout, stderr, durationMs: command.durationMs };
}

async function killCommand(command, initialSignal = "SIGTERM") {
  if (command === null) return;
  await stopCommand(command, initialSignal, PROCESS_STOP_TIMEOUT_MS).catch(() => undefined);
}

async function stopCommand(command, initialSignal, waitMs) {
  await signalCommand(command, initialSignal);
  let result = await waitForCommandExit(command, waitMs);
  if (result !== null) return result;
  await signalCommand(command, "SIGKILL");
  result = await waitForCommandExit(command, waitMs);
  if (result === null) throw new Error("Sandbox command did not exit after SIGKILL");
  return result;
}

async function signalCommand(command, signal) {
  const abortSignal = AbortSignal.timeout(2_000);
  await command.kill(signal, { abortSignal }).catch(() => undefined);
}

async function waitForCommandExit(command, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await command.wait({ signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) return null;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function parseMotion(stdout) {
  const line = stdout.split(/\r?\n/u).find((value) => value.startsWith("SANDBOX_VIDEO_MOTION="));
  return line ? parseJson(line.slice("SANDBOX_VIDEO_MOTION=".length), "agent metrics") : null;
}

function parseJson(text, description) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`invalid ${description}: ${safeError(error)}`);
  }
}

function positiveInteger(raw, description) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${description} must be positive`);
  return value;
}

function assertNonemptyString(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} is missing or invalid`);
  }
}

function firstLine(value) {
  return (
    value
      .split(/\r?\n/u)
      .find((line) => line.trim().length > 0)
      ?.trim() ?? ""
  );
}

function safeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/up_[A-Za-z0-9._-]+/gu, "[REDACTED]")
    .replace(/(UPLOADS_TOKEN|UPLOADS_SESSION_TOKEN)=[^\s]+/gu, "$1=[REDACTED]");
}

function progress(message) {
  process.stderr.write(`[encoding-quality] ${message}\n`);
}

try {
  await main();
} catch (error) {
  process.exitCode = 1;
  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        status: "failed",
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        error: safeError(error),
      },
      null,
      2,
    )}\n`,
  );
}
