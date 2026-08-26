import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  stopSession,
  type OwnedProcessIdentity,
  type RecordingExecutables,
  type RecordingSessionPhase,
  type RecordingSessionState,
} from "../src/session.js";
import type { UploadsPublication } from "../src/uploads.js";

const linuxOnly = { skip: process.platform !== "linux" } as const;

test(
  "recovery returns an existing publication without remuxing or uploading again",
  linuxOnly,
  async () => {
    const fixture = await createFixture({
      recordingId: "00000000-0000-4000-8000-000000000001",
      phase: "uploading_mp4",
      publication: publicationFor("00000000-0000-4000-8000-000000000001"),
    });
    try {
      const result = await stopSession({
        runtimeDirectory: fixture.runtimeDirectory,
        timeoutMs: 5_000,
      });

      assert.equal(result.exists, true);
      if (!result.exists) return;
      assert.equal(result.state.phase, "finished");
      assert.deepEqual(result.state.publication, fixture.publication);
      assert.equal(typeof result.state.browserClosedAt, "string");
    } finally {
      await fixture.cleanup();
    }
  },
);

test("recovery fails instead of finishing without an uploaded MP4", linuxOnly, async () => {
  const fixture = await createFixture({
    recordingId: "00000000-0000-4000-8000-000000000002",
    phase: "recording",
  });
  try {
    const result = await stopSession({
      runtimeDirectory: fixture.runtimeDirectory,
      timeoutMs: 5_000,
    });

    assert.equal(result.exists, true);
    if (!result.exists) return;
    assert.equal(result.state.phase, "failed");
    assert.match(result.state.failure ?? "", /without an uploaded MP4/u);
    assert.equal(result.state.publication, undefined);
  } finally {
    await fixture.cleanup();
  }
});

test("repeated stop retries browser cleanup that was not confirmed", linuxOnly, async () => {
  const fixture = await createFixture({
    recordingId: "00000000-0000-4000-8000-000000000004",
    phase: "failed",
    publication: publicationFor("00000000-0000-4000-8000-000000000004"),
    failure: "agent-browser cleanup: previous attempt failed",
  });
  try {
    const result = await stopSession({
      runtimeDirectory: fixture.runtimeDirectory,
      timeoutMs: 5_000,
    });

    assert.equal(result.exists, true);
    if (!result.exists) return;
    assert.equal(result.state.phase, "finished");
    assert.equal(typeof result.state.browserClosedAt, "string");
    assert.equal(result.state.failure, undefined);
  } finally {
    await fixture.cleanup();
  }
});

test(
  "repeated stop returns an early startup failure without browser cleanup",
  linuxOnly,
  async () => {
    const fixture = await createFixture({
      recordingId: "00000000-0000-4000-8000-000000000005",
      phase: "failed",
      failure: "FFmpeg readiness timed out",
      browserStartAttempted: false,
      recordingReached: false,
      upload: false,
    });
    try {
      const result = await stopSession({
        runtimeDirectory: fixture.runtimeDirectory,
        timeoutMs: 5_000,
      });

      assert.equal(result.exists, true);
      if (!result.exists) return;
      assert.deepEqual(result.state, fixture.state);
    } finally {
      await fixture.cleanup();
    }
  },
);

test(
  "failed hosted verification remains retryable until publication succeeds",
  linuxOnly,
  async () => {
    const executableDirectory = await mkdtemp(join(tmpdir(), "sandbox-video-executables-"));
    const ffmpeg = join(executableDirectory, "ffmpeg");
    const ffprobe = join(executableDirectory, "ffprobe");
    const uploads = join(executableDirectory, "uploads");
    const recordingId = "00000000-0000-4000-8000-000000000006";
    const publication = publicationFor(recordingId, 5);
    await writeExecutable(
      ffmpeg,
      '#!/bin/sh\nfor output do :; done\nif [ "$output" != "-" ]; then printf video > "$output"; fi\n',
    );
    await writeExecutable(
      ffprobe,
      '#!/bin/sh\nprintf \'%s\\n\' \'{"streams":[{"codec_name":"h264","pix_fmt":"yuv420p","width":1280,"height":720,"avg_frame_rate":"30/1","nb_frames":"30"}],"format":{"duration":"1"}}\'\n',
    );
    await writeExecutable(
      uploads,
      `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ key: publication.key, url: publication.url, size: 5 })}'\n`,
    );

    const fixture = await createFixture({
      recordingId,
      phase: "failed",
      failure: "Uploaded MP4 verification failed: HTTP 503",
      executables: { ffmpeg, ffprobe },
      uploadExecutable: uploads,
    });
    await mkdir(join(fixture.runtimeDirectory, "capture"), { recursive: true });
    await writeFile(join(fixture.runtimeDirectory, "capture", "index.m3u8"), "playlist\n");

    const originalFetch = globalThis.fetch;
    let hosted = false;
    globalThis.fetch = async () =>
      new Response(null, {
        status: hosted ? 200 : 503,
        headers: hosted
          ? { "content-type": "video/mp4", "content-length": "5" }
          : { "content-type": "text/plain", "content-length": "0" },
      });
    try {
      const failed = await stopSession({
        runtimeDirectory: fixture.runtimeDirectory,
        timeoutMs: 1_000,
      });
      assert.equal(failed.exists, true);
      if (!failed.exists) return;
      assert.equal(failed.state.phase, "failed");
      assert.equal(failed.state.publication, undefined);

      hosted = true;
      const recovered = await stopSession({
        runtimeDirectory: fixture.runtimeDirectory,
        timeoutMs: 5_000,
      });
      assert.equal(recovered.exists, true);
      if (!recovered.exists) return;
      assert.equal(recovered.state.phase, "finished");
      assert.deepEqual(recovered.state.publication, publication);
      assert.equal(recovered.state.failure, undefined);

      const repeated = await stopSession({
        runtimeDirectory: fixture.runtimeDirectory,
        timeoutMs: 5_000,
      });
      assert.deepEqual(repeated, recovered);
    } finally {
      globalThis.fetch = originalFetch;
      await fixture.cleanup();
      await rm(executableDirectory, { recursive: true, force: true });
    }
  },
);

test(
  "concurrent callers wait for dead-supervisor recovery and receive one publication",
  linuxOnly,
  async () => {
    const windowManager = spawn(
      process.execPath,
      [
        "-e",
        "process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),400));setInterval(()=>{},1000)",
      ],
      { stdio: "ignore" },
    );
    await new Promise<void>((resolve, reject) => {
      windowManager.once("spawn", resolve);
      windowManager.once("error", reject);
    });
    assert.ok(windowManager.pid !== undefined);
    const openbox: OwnedProcessIdentity = {
      pid: windowManager.pid,
      startTimeTicks: await readStartTimeTicks(windowManager.pid),
      executable: process.execPath,
    };
    const fixture = await createFixture({
      recordingId: "00000000-0000-4000-8000-000000000003",
      phase: "uploading_mp4",
      publication: publicationFor("00000000-0000-4000-8000-000000000003"),
      openbox,
    });
    try {
      const [first, second] = await Promise.all([
        stopSession({ runtimeDirectory: fixture.runtimeDirectory, timeoutMs: 5_000 }),
        stopSession({ runtimeDirectory: fixture.runtimeDirectory, timeoutMs: 5_000 }),
      ]);

      for (const result of [first, second]) {
        assert.equal(result.exists, true);
        if (!result.exists) continue;
        assert.equal(result.state.phase, "finished");
        assert.deepEqual(result.state.publication, fixture.publication);
      }
    } finally {
      windowManager.kill("SIGKILL");
      await fixture.cleanup();
    }
  },
);

interface FixtureOptions {
  readonly recordingId: string;
  readonly phase: RecordingSessionPhase;
  readonly publication?: UploadsPublication;
  readonly openbox?: OwnedProcessIdentity;
  readonly failure?: string;
  readonly browserStartAttempted?: boolean;
  readonly recordingReached?: boolean;
  readonly upload?: boolean;
  readonly executables?: RecordingExecutables;
  readonly uploadExecutable?: string;
}

async function createFixture(options: FixtureOptions): Promise<{
  readonly runtimeDirectory: string;
  readonly publication?: UploadsPublication;
  readonly state: RecordingSessionState;
  cleanup(): Promise<void>;
}> {
  const runtimeDirectory = await mkdtemp(join(tmpdir(), "sandbox-video-recovery-"));
  const now = new Date().toISOString();
  const config = {
    id: options.recordingId,
    runtimeDirectory,
    width: 1280,
    height: 720,
    fps: 30 as const,
    segmentDurationSeconds: 10,
    initialUrl: "about:blank",
    startupTimeoutMs: 30_000,
    stopTimeoutMs: 15_000,
    executables: {
      agentBrowser: "/usr/bin/true",
      ffmpeg: "must-not-run-ffmpeg",
      ffprobe: "must-not-run-ffprobe",
      mcookie: "mcookie",
      openbox: "openbox",
      xauth: "xauth",
      xdpyinfo: "xdpyinfo",
      xprop: "xprop",
      xvfb: "Xvfb",
      ...options.executables,
    },
    ...(options.upload === false
      ? {}
      : {
          upload: {
            key: `screenshots/sandbox-video/${options.recordingId}/proof.mp4`,
            executable: options.uploadExecutable ?? "must-not-run-uploads",
          },
        }),
  };
  const state: RecordingSessionState = {
    schemaVersion: 1,
    id: options.recordingId,
    phase: options.phase,
    runtimeDirectory,
    display: ":65000",
    xauthorityPath: join(runtimeDirectory, "Xauthority"),
    displayLockPath: "/tmp/sandbox-video-display-65000.lock",
    playlistPath: join(runtimeDirectory, "capture", "index.m3u8"),
    segmentPattern: join(runtimeDirectory, "capture", "segment-%06d.ts"),
    finalMp4Path: join(runtimeDirectory, "recording.mp4"),
    supervisorLogPath: join(runtimeDirectory, "supervisor.log"),
    agentBrowserSession: `sv-${options.recordingId.slice(-12)}`,
    agentBrowserNamespace: `sv-${options.recordingId.slice(-12)}`,
    width: config.width,
    height: config.height,
    fps: config.fps,
    segmentDurationSeconds: config.segmentDurationSeconds,
    supervisor: {
      pid: 2_147_483_647,
      startTimeTicks: "1",
      executable: process.execPath,
    },
    ...(options.openbox === undefined ? {} : { openbox: options.openbox }),
    ...(options.publication === undefined ? {} : { publication: options.publication }),
    ...(options.failure === undefined ? {} : { failure: options.failure }),
    ...(options.browserStartAttempted === false ? {} : { browserStartAttemptedAt: now }),
    phaseHistory: [
      { phase: "starting", at: now },
      ...(options.recordingReached === false ? [] : [{ phase: "recording" as const, at: now }]),
      ...(options.phase === "recording" ? [] : [{ phase: options.phase, at: now }]),
    ],
    startedAt: now,
    updatedAt: now,
  };
  await writeFile(join(runtimeDirectory, "session-config.json"), `${JSON.stringify(config)}\n`);
  await writeFile(join(runtimeDirectory, "session.json"), `${JSON.stringify(state)}\n`);
  return {
    runtimeDirectory,
    ...(options.publication === undefined ? {} : { publication: options.publication }),
    state,
    cleanup: () => rm(runtimeDirectory, { recursive: true, force: true }),
  };
}

function publicationFor(recordingId: string, sizeBytes = 1_024): UploadsPublication {
  const key = `screenshots/sandbox-video/${recordingId}/proof.mp4`;
  return {
    key,
    url: `https://storage.uploads.sh/example/${key}`,
    contentType: "video/mp4",
    sizeBytes,
  };
}

async function writeExecutable(path: string, source: string): Promise<void> {
  await writeFile(path, source);
  await chmod(path, 0o755);
}

async function readStartTimeTicks(pid: number): Promise<string> {
  const source = await readFile(`/proc/${pid}/stat`, "utf8");
  const closing = source.lastIndexOf(")");
  assert.ok(closing >= 0);
  const value = source
    .slice(closing + 1)
    .trim()
    .split(/\s+/u)[19];
  assert.match(value ?? "", /^\d+$/u);
  return value!;
}
