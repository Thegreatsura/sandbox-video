import { useState, useRef, useEffect, useCallback, memo } from "react";

/**
 * Screen recording test rig.
 *
 * Perf rules this file follows, since the page itself must not be the bottleneck:
 *  - Exactly one requestAnimationFrame loop for everything (fps, timecode, beacon).
 *  - Per-frame updates write to DOM nodes through refs. No setState inside rAF.
 *  - Color transitions are CSS on background-color + transform only. No filter,
 *    no animated box-shadow, no layout-affecting properties.
 *  - Each box owns its state and is memoized, so a click repaints one box.
 *  - Grid cells use `contain: layout paint style` to bound invalidation.
 *  - Ambient motion is a single compositor-only translate3d animation.
 */

const SWATCHES = [
  { bg: "#EDEBE6", fg: "#16181A" },
  { bg: "#C8452F", fg: "#FFFFFF" },
  { bg: "#D98B0B", fg: "#16181A" },
  { bg: "#B9C21F", fg: "#16181A" },
  { bg: "#1E8E63", fg: "#FFFFFF" },
  { bg: "#1B7FA8", fg: "#FFFFFF" },
  { bg: "#2B3E9C", fg: "#FFFFFF" },
  { bg: "#7A3B9E", fg: "#FFFFFF" },
  { bg: "#16181A", fg: "#FAFAF8" },
];

const LADDER_CELLS = 12;
const DURATIONS = [150, 300, 600, 1000];
const COUNTS = [12, 24, 40];
const PRESETS = [10, 30, 60, 180];

function fmt(ms) {
  const clamped = Math.max(0, ms);
  const m = Math.floor(clamped / 60000);
  const s = Math.floor((clamped % 60000) / 1000);
  const c = Math.floor((clamped % 1000) / 10);
  return `${m}:${String(s).padStart(2, "0")}.${String(c).padStart(2, "0")}`;
}

const Box = memo(function Box({ index, duration, flashSeq }) {
  const [clicks, setClicks] = useState(0);
  const step = (clicks + flashSeq) % SWATCHES.length;
  const { bg, fg } = SWATCHES[step];
  const targetNumber = String(index + 1).padStart(2, "0");

  return (
    <button
      type="button"
      className="cell"
      aria-label={`Target ${targetNumber}, ${clicks} ${clicks === 1 ? "click" : "clicks"}`}
      onClick={() => setClicks((c) => c + 1)}
      style={{
        backgroundColor: bg,
        color: fg,
        transitionDuration: `${duration}ms`,
      }}
    >
      <span className="cell-cross" aria-hidden="true">
        <i className="cell-cross-h" />
        <i className="cell-cross-v" />
      </span>
      <span className="cell-id">{targetNumber}</span>
      <span className="cell-hits">{clicks}</span>
    </button>
  );
});

export default function ScreenRecordTestRig() {
  const [duration, setDuration] = useState(600);
  const [count, setCount] = useState(24);
  const [flashSeq, setFlashSeq] = useState(0);
  const [gridKey, setGridKey] = useState(0);
  const [preset, setPreset] = useState(30);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [ambient, setAmbient] = useState(true);

  // rAF-owned state, deliberately outside React.
  const remainingRef = useRef(preset * 1000);
  const runningRef = useRef(false);
  const timeRef = useRef(null);
  const fpsRef = useRef(null);
  const minRef = useRef(null);
  const avgRef = useRef(null);
  const frameMsRef = useRef(null);
  const longRef = useRef(null);
  const totalRef = useRef(null);
  const beaconRef = useRef(null);
  const ladderRef = useRef([]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (mq.matches) setAmbient(false);
  }, []);

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let bucketMs = 0;
    let bucketFrames = 0;
    let sessionMs = 0;
    let sessionFrames = 0;
    let minFps = Infinity;
    let baseline = Infinity;
    let longFrames = 0;
    let lit = -1;
    let total = 0;

    const loop = (now) => {
      const dt = now - last;
      last = now;
      total += 1;

      if (dt > 0.5) {
        if (dt < baseline) baseline = dt;
        if (baseline < Infinity && dt > baseline * 1.75) longFrames += 1;
        bucketMs += dt;
        bucketFrames += 1;
        sessionMs += dt;
        sessionFrames += 1;
      }

      // Frame beacon: one lit cell chases around the ladder, one cell per
      // rendered frame. Scrub the recording and count cells to find drops.
      const next = total % LADDER_CELLS;
      if (next !== lit) {
        const cells = ladderRef.current;
        if (cells[lit]) cells[lit].className = "ladder-cell";
        if (cells[next]) cells[next].className = "ladder-cell is-lit";
        lit = next;
      }
      if (beaconRef.current) {
        beaconRef.current.textContent = String(total).padStart(7, "0");
      }

      if (runningRef.current) {
        remainingRef.current -= dt;
        if (remainingRef.current <= 0) {
          remainingRef.current = 0;
          runningRef.current = false;
          setRunning(false);
          setDone(true);
        }
      }
      if (timeRef.current) {
        timeRef.current.textContent = fmt(remainingRef.current);
      }

      if (bucketMs >= 250 && bucketFrames > 0) {
        const fps = (bucketFrames * 1000) / bucketMs;
        if (fps < minFps) minFps = fps;
        if (fpsRef.current) fpsRef.current.textContent = fps.toFixed(1);
        if (minRef.current) minRef.current.textContent = minFps.toFixed(1);
        if (frameMsRef.current) {
          frameMsRef.current.textContent = (bucketMs / bucketFrames).toFixed(2);
        }
        if (avgRef.current && sessionMs > 0) {
          avgRef.current.textContent = ((sessionFrames * 1000) / sessionMs).toFixed(1);
        }
        if (longRef.current) longRef.current.textContent = String(longFrames);
        if (totalRef.current) totalRef.current.textContent = String(total);
        bucketMs = 0;
        bucketFrames = 0;
      }

      raf = requestAnimationFrame(loop);
    };

    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const toggleClock = useCallback(() => {
    if (runningRef.current) {
      runningRef.current = false;
      setRunning(false);
      return;
    }
    if (remainingRef.current <= 0) remainingRef.current = preset * 1000;
    setDone(false);
    runningRef.current = true;
    setRunning(true);
  }, [preset]);

  const resetClock = useCallback(() => {
    runningRef.current = false;
    remainingRef.current = preset * 1000;
    setRunning(false);
    setDone(false);
    if (timeRef.current) timeRef.current.textContent = fmt(preset * 1000);
  }, [preset]);

  const pickPreset = useCallback((seconds) => {
    setPreset(seconds);
    runningRef.current = false;
    remainingRef.current = seconds * 1000;
    setRunning(false);
    setDone(false);
    if (timeRef.current) timeRef.current.textContent = fmt(seconds * 1000);
  }, []);

  const resetGrid = useCallback(() => {
    setFlashSeq(0);
    setGridKey((k) => k + 1);
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.target instanceof HTMLElement && e.target.tagName === "BUTTON") {
        if (e.code === "Space" || e.code === "Enter") return;
      }
      if (e.code === "Space") {
        e.preventDefault();
        toggleClock();
      } else if (e.key === "f" || e.key === "F") {
        setFlashSeq((s) => s + 1);
      } else if (e.key === "r" || e.key === "R") {
        resetGrid();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleClock, resetGrid]);

  return (
    <div className="rig" data-testid="recording-test-rig">
      <style>{css}</style>

      <header className="head">
        <div className="head-mark">
          <span className="dot" />
          <span>Capture test rig</span>
        </div>
        <p className="head-note">
          Record this page, then compare the on-page counters against the recording. Space starts
          the clock, F flashes every box, R clears the grid.
        </p>
      </header>

      <section className="deck">
        <div className="panel clock-panel">
          <span className="label">Countdown</span>
          <div
            ref={timeRef}
            data-testid="countdown"
            className={`timecode${running ? " is-live" : ""}${done ? " is-done" : ""}`}
          >
            {fmt(preset * 1000)}
          </div>
          <div className="row">
            <button type="button" className="btn btn-primary" onClick={toggleClock}>
              {running ? "Pause" : done ? "Run again" : "Start"}
            </button>
            <button type="button" className="btn" onClick={resetClock}>
              Reset
            </button>
          </div>
          <div className="row seg" role="group" aria-label="Countdown length">
            {PRESETS.map((s) => (
              <button
                key={s}
                type="button"
                className={`chip${preset === s ? " is-on" : ""}`}
                aria-pressed={preset === s}
                onClick={() => pickPreset(s)}
              >
                {s < 60 ? `${s}s` : `${s / 60}m`}
              </button>
            ))}
          </div>
        </div>

        <div className="panel">
          <span className="label">Render telemetry</span>
          <div className="stats">
            <div className="stat stat-lead">
              <b ref={fpsRef} data-testid="fps-now">
                --
              </b>
              <span>fps now</span>
            </div>
            <div className="stat">
              <b ref={avgRef} data-testid="fps-mean">
                --
              </b>
              <span>fps mean</span>
            </div>
            <div className="stat">
              <b ref={minRef} data-testid="fps-floor">
                --
              </b>
              <span>fps floor</span>
            </div>
            <div className="stat">
              <b ref={frameMsRef} data-testid="frame-ms">
                --
              </b>
              <span>ms / frame</span>
            </div>
            <div className="stat">
              <b ref={longRef} data-testid="long-frames">
                0
              </b>
              <span>long frames</span>
            </div>
            <div className="stat">
              <b ref={totalRef} data-testid="frames-drawn">
                0
              </b>
              <span>frames drawn</span>
            </div>
          </div>
          <p className="fine">
            A long frame is any frame more than 1.75x the shortest interval seen so far, which is
            the page stalling rather than the encoder dropping it.
          </p>
        </div>
      </section>

      <section className="panel beacon-panel">
        <div className="beacon-head">
          <span className="label">Frame beacon</span>
          <button
            type="button"
            className={`chip${ambient ? " is-on" : ""}`}
            aria-pressed={ambient}
            onClick={() => setAmbient((a) => !a)}
          >
            {ambient ? "Sweep on" : "Sweep off"}
          </button>
        </div>
        <div className="ladder" aria-hidden="true">
          {Array.from({ length: LADDER_CELLS }, (_, i) => (
            <span
              key={i}
              className="ladder-cell"
              ref={(el) => {
                ladderRef.current[i] = el;
              }}
            />
          ))}
          <span className="ladder-count" ref={beaconRef} data-testid="beacon-frames">
            0000000
          </span>
        </div>
        <div className="sweep-track" aria-hidden="true">
          <div className="ruler" />
          {ambient && <div className="sweep" />}
        </div>
        <p className="fine">
          The lit cell advances one step per painted frame and the sweep moves at a fixed rate on
          the compositor. In playback, a sweep that jumps while the ladder stays even means the
          capture dropped frames, not the page.
        </p>
      </section>

      <section className="panel">
        <div className="grid-head">
          <span className="label">Click targets</span>
          <div className="controls">
            <div className="seg" role="group" aria-label="Transition length">
              {DURATIONS.map((d) => (
                <button
                  key={d}
                  type="button"
                  className={`chip${duration === d ? " is-on" : ""}`}
                  aria-pressed={duration === d}
                  onClick={() => setDuration(d)}
                >
                  {d}ms
                </button>
              ))}
            </div>
            <div className="seg" role="group" aria-label="Target count">
              {COUNTS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`chip${count === c ? " is-on" : ""}`}
                  aria-pressed={count === c}
                  onClick={() => setCount(c)}
                >
                  {c}
                </button>
              ))}
            </div>
            <button type="button" className="btn" onClick={() => setFlashSeq((s) => s + 1)}>
              Flash all
            </button>
            <button type="button" className="btn" onClick={resetGrid}>
              Clear
            </button>
          </div>
        </div>

        <div className="grid" key={gridKey}>
          {Array.from({ length: count }, (_, i) => (
            <Box key={i} index={i} duration={duration} flashSeq={flashSeq} />
          ))}
        </div>
        <p className="fine">
          Colors cross the full hue wheel on a linear curve, so banding, posterized gradients, and
          chroma subsampling artifacts all show up in playback. Flash all repaints every target at
          once for a worst-case frame.
        </p>
      </section>
    </div>
  );
}

const css = `
.rig {
  --paper: #F3F3F1;
  --card: #FBFBFA;
  --ink: #16181A;
  --muted: #6E7378;
  --line: #D8D8D4;
  --accent: #1B7FA8;
  background: var(--paper);
  color: var(--ink);
  font-family: Inter, ui-sans-serif, system-ui, "Helvetica Neue", sans-serif;
  min-height: 100%;
  padding: 28px clamp(16px, 4vw, 48px) 56px;
  box-sizing: border-box;
  -webkit-font-smoothing: antialiased;
}
.rig *, .rig *::before, .rig *::after { box-sizing: border-box; }

.head { border-bottom: 1px solid var(--line); padding-bottom: 16px; margin-bottom: 20px; }
.head-mark {
  display: flex; align-items: center; gap: 8px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px; letter-spacing: 0.14em; text-transform: uppercase;
}
.dot { width: 8px; height: 8px; background: var(--accent); display: inline-block; }
.head-note { margin: 8px 0 0; max-width: 62ch; color: var(--muted); font-size: 13.5px; line-height: 1.5; }

.deck { display: grid; grid-template-columns: minmax(260px, 340px) 1fr; gap: 14px; margin-bottom: 14px; }
@media (max-width: 780px) { .deck { grid-template-columns: 1fr; } }

.panel { background: var(--card); border: 1px solid var(--line); padding: 16px; margin-bottom: 14px; }
.deck .panel { margin-bottom: 0; }

.label {
  display: block;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10.5px; letter-spacing: 0.16em; text-transform: uppercase;
  color: var(--muted); margin-bottom: 10px;
}

.timecode {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-variant-numeric: tabular-nums;
  font-size: clamp(44px, 8vw, 68px);
  line-height: 1; letter-spacing: -0.02em;
  padding: 2px 0 10px;
  transition: color 200ms linear;
}
.timecode.is-live { color: var(--accent); }
.timecode.is-done { color: #C8452F; }

.row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
.seg { display: flex; gap: 6px; flex-wrap: wrap; }

.btn {
  font: inherit; font-size: 13px; font-weight: 500;
  padding: 9px 16px; border: 1px solid var(--ink); background: transparent;
  color: var(--ink); cursor: pointer;
  transition: background-color 140ms linear, color 140ms linear;
}
.btn:hover { background: var(--ink); color: var(--card); }
.btn-primary { background: var(--ink); color: var(--card); }
.btn-primary:hover { background: var(--accent); border-color: var(--accent); }

.chip {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11.5px; padding: 7px 11px;
  border: 1px solid var(--line); background: transparent; color: var(--muted);
  cursor: pointer; transition: color 120ms linear, border-color 120ms linear;
}
.chip:hover { color: var(--ink); border-color: var(--ink); }
.chip.is-on { color: var(--ink); border-color: var(--ink); background: #EAEAE6; }

.btn:focus-visible, .chip:focus-visible, .cell:focus-visible {
  outline: 2px solid var(--accent); outline-offset: 2px;
}

.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(92px, 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); }
.stat { background: var(--card); padding: 12px 10px; display: flex; flex-direction: column; gap: 4px; }
.stat b {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-variant-numeric: tabular-nums; font-size: 20px; font-weight: 500;
}
.stat-lead b { font-size: 28px; color: var(--accent); }
.stat span { font-size: 10.5px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }

.fine { margin: 10px 0 0; font-size: 12px; line-height: 1.55; color: var(--muted); max-width: 78ch; }

.beacon-head, .grid-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.beacon-head .label, .grid-head .label { margin-bottom: 10px; }
.controls { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 10px; }

.ladder { display: flex; align-items: center; gap: 3px; margin-bottom: 10px; }
.ladder-cell { width: 18px; height: 22px; background: #E3E3DF; display: block; contain: strict; }
.ladder-cell.is-lit { background: var(--ink); }
.ladder-count {
  margin-left: 10px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-variant-numeric: tabular-nums; font-size: 13px; color: var(--muted);
}

.sweep-track { position: relative; height: 40px; border: 1px solid var(--line); overflow: hidden; background: #FFF; }
.ruler {
  position: absolute; inset: 0;
  background-image: repeating-linear-gradient(to right, var(--line) 0 1px, transparent 1px 40px);
}
.sweep {
  position: absolute; top: 0; bottom: 0; left: 0; width: 4px;
  background: var(--accent);
  will-change: transform;
  animation: sweep 2s linear infinite alternate;
}
@keyframes sweep {
  from { transform: translate3d(0, 0, 0); }
  to { transform: translate3d(calc(100vw - 140px), 0, 0); }
}

.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(124px, 1fr)); gap: 10px; }
.cell {
  position: relative;
  aspect-ratio: 4 / 3;
  min-height: 96px;
  border: 1px solid rgba(22, 24, 26, 0.16);
  cursor: crosshair;
  padding: 0;
  contain: layout paint style;
  transition-property: background-color, color, transform;
  transition-timing-function: linear;
}
.cell:active { transform: scale(0.985); transition-duration: 90ms; }
.cell-cross { position: absolute; inset: 0; opacity: 0.5; }
.cell-cross-h, .cell-cross-v { position: absolute; background: currentColor; }
.cell-cross-h { left: 50%; top: 50%; width: 26px; height: 1px; transform: translate(-50%, -50%); }
.cell-cross-v { left: 50%; top: 50%; width: 1px; height: 26px; transform: translate(-50%, -50%); }
.cell-id, .cell-hits {
  position: absolute;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px; letter-spacing: 0.08em; color: currentColor;
}
.cell-id { top: 8px; left: 9px; opacity: 0.85; }
.cell-hits { bottom: 8px; right: 9px; opacity: 0.6; font-variant-numeric: tabular-nums; }

@media (prefers-reduced-motion: reduce) {
  .sweep { animation: none; }
}
`;
