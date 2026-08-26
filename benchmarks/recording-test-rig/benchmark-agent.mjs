import { spawnSync } from "node:child_process";

const session = "sandbox-video-benchmark";
const agentBrowserExecutable = process.env.SANDBOX_VIDEO_AGENT_BROWSER_BIN ?? "agent-browser";
const benchmarkUrl =
  process.env.SANDBOX_VIDEO_BENCHMARK_URL ??
  "file:///vercel/sandbox/.sandbox-video/benchmarks/recording-test-rig/dist/index.html";

run(["open", benchmarkUrl]);
run(["wait", '[data-testid="recording-test-rig"]', "--timeout", "15000"]);
click("1m");
click("Start");

evaluate(`(() => {
  const read = (id) => document.querySelector('[data-testid="' + id + '"]').textContent.trim();
  window.__sandboxVideoRun = {
    startedAtMs: performance.now(),
    startedAtEpochMs: Date.now(),
    beaconFrames: Number(read("beacon-frames")),
    framesDrawn: Number(read("frames-drawn")),
    longFrames: Number(read("long-frames")),
  };
  return window.__sandboxVideoRun;
})()`);

for (const step of [
  { atMs: 1_000, duration: "150ms" },
  { atMs: 2_500, target: 1 },
  { atMs: 5_000, target: 6 },
  { atMs: 8_000, target: 12 },
  { atMs: 12_000, duration: "300ms" },
  { atMs: 14_000, target: 2 },
  { atMs: 17_000, target: 7 },
  { atMs: 20_000, target: 13 },
  { atMs: 23_000, duration: "600ms" },
  { atMs: 25_000, target: 3 },
  { atMs: 28_000, target: 8 },
  { atMs: 31_000, target: 14 },
  { atMs: 34_000, duration: "1000ms" },
  { atMs: 36_000, target: 4 },
  { atMs: 39_000, target: 9 },
  { atMs: 42_000, target: 15 },
  { atMs: 44_000, target: 24 },
]) {
  waitUntil(step.atMs);
  if (step.duration !== undefined) {
    click(step.duration);
    click("Flash all");
  } else {
    clickTarget(step.target);
  }
}

waitUntil(45_000);
const metrics = evaluate(`(() => {
  const read = (id) => {
    const node = document.querySelector('[data-testid="' + id + '"]');
    if (!node) throw new Error('Missing metric: ' + id);
    return node.textContent.trim();
  };
  const elapsedMs = performance.now() - window.__sandboxVideoRun.startedAtMs;
  const beaconEnd = Number(read("beacon-frames"));
  const framesEnd = Number(read("frames-drawn"));
  const longEnd = Number(read("long-frames"));
  const beaconDelta = beaconEnd - window.__sandboxVideoRun.beaconFrames;
  return {
    schemaVersion: 1,
    startedAtEpochMs: window.__sandboxVideoRun.startedAtEpochMs,
    elapsedMs: Math.round(elapsedMs),
    countdown: read("countdown"),
    activeTransitionMs: Number.parseInt(
      document.querySelector('[aria-label="Transition length"] [aria-pressed="true"]').textContent,
      10,
    ),
    beaconFrames: { start: window.__sandboxVideoRun.beaconFrames, end: beaconEnd, delta: beaconDelta },
    framesDrawn: {
      start: window.__sandboxVideoRun.framesDrawn,
      end: framesEnd,
      delta: framesEnd - window.__sandboxVideoRun.framesDrawn,
    },
    sourceFps: Number((beaconDelta * 1000 / elapsedMs).toFixed(2)),
    fps: {
      now: Number(read("fps-now")),
      mean: Number(read("fps-mean")),
      floor: Number(read("fps-floor")),
    },
    frameMs: Number(read("frame-ms")),
    longFrames: {
      start: window.__sandboxVideoRun.longFrames,
      end: longEnd,
      delta: longEnd - window.__sandboxVideoRun.longFrames,
    },
    litBeaconCells: document.querySelectorAll(".ladder-cell.is-lit").length,
    targetClicks: [...document.querySelectorAll(".cell .cell-hits")].map((node) => Number(node.textContent)),
  };
})()`);

if (
  metrics.elapsedMs < 45_000 ||
  metrics.activeTransitionMs !== 1_000 ||
  metrics.framesDrawn.delta <= 0 ||
  metrics.litBeaconCells !== 1 ||
  metrics.targetClicks.reduce((sum, clicks) => sum + clicks, 0) !== 13
) {
  throw new Error(`Benchmark invariants failed: ${JSON.stringify(metrics)}`);
}

process.stdout.write(
  `SANDBOX_VIDEO_MOTION=${JSON.stringify({
    frames: metrics.framesDrawn.delta,
    elapsedMs: metrics.elapsedMs,
    startedAtEpochMs: metrics.startedAtEpochMs,
    benchmark: metrics,
  })}\n`,
);

function click(name) {
  run(["find", "role", "button", "click", "--name", name, "--exact"]);
}

function clickTarget(index) {
  run(["click", `.cell:nth-child(${index})`]);
}

function waitUntil(elapsedMs) {
  run([
    "wait",
    "--fn",
    `performance.now() - window.__sandboxVideoRun.startedAtMs >= ${elapsedMs}`,
    "--timeout",
    "15000",
  ]);
}

function evaluate(expression) {
  const payload = JSON.parse(run(["eval", expression]));
  if (payload.success !== true || payload.data === undefined || !("result" in payload.data)) {
    throw new Error(`Unexpected agent-browser response: ${JSON.stringify(payload)}`);
  }
  return payload.data.result;
}

function run(args) {
  const result = spawnSync(agentBrowserExecutable, ["--session", session, "--json", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    throw new Error(`agent-browser ${args[0]} exited ${result.status ?? 1}`);
  }
  return result.stdout.trim();
}
