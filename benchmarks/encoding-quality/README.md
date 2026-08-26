# Encoding quality benchmark

This benchmark compares FFmpeg profiles against one shared high-fidelity RGB
capture of the interactive recording test rig. Capture and every transcode run
inside one 4-vCPU Vercel Sandbox. uploads.sh receives the resulting files from
that Sandbox before they are downloaded for local, decode-only analysis.

This is the historical v1 quality study, retained so encoding decisions remain
reproducible. It is not the current v2 recorder implementation.

Run the matrix with a prepared Vercel Sandbox snapshot containing FFmpeg,
Xvfb, openbox, agent-browser, Chromium, and uploads.sh:

```sh
cd benchmarks/encoding-quality
npm ci
SANDBOX_VIDEO_SNAPSHOT_ID=snap_... node run.mjs
```

The runner reads uploads.sh authentication from its normal shared config. For
compatibility with earlier runs, it falls back to the ignored repository file
`.sandbox-video/snapshot.json` when `SANDBOX_VIDEO_SNAPSHOT_ID` is absent.

The runner always requests Sandbox shutdown, including on `SIGINT`, `SIGTERM`,
and failure. It prints a secret-free JSON report containing hashes, probes,
encode durations, uploads.sh URLs, playback results, and final stop status.

## August 25, 2026 result

The source was 49.03 seconds at 1920×1080 and 60 FPS. The page reported 60.0
source FPS and 59.9 mean rendered FPS during the 45-second interaction. FFmpeg
8.0.1-3ubuntu2 performed every capture and transcode in Vercel Sandbox. Local
FFmpeg 8.0-tessus decoded the downloaded files for XPSNR, SSIM, and PSNR only.

| Profile                        |        Size |      Encode |    Frames |       XPSNR¹ |         SSIM |         PSNR | Chrome |
| ------------------------------ | ----------: | ----------: | --------: | -----------: | -----------: | -----------: | ------ |
| CRF 23, 4:2:0, forced CFR      |     1.52 MB |     18.17 s |     2,944 |     28.72 dB |     0.987538 |     30.19 dB | Pass   |
| CRF 23, 4:4:4, passthrough     |     2.76 MB |     20.77 s |     2,942 |     37.66 dB |     0.993902 |     40.47 dB | Fail   |
| CRF 16, 4:4:4, passthrough     |     4.40 MB |     20.80 s |     2,942 |     40.30 dB |     0.997971 |     44.97 dB | Fail   |
| CRF 14, 4:4:4, passthrough     |     4.97 MB |     20.30 s |     2,942 |     40.69 dB |     0.998561 |     46.19 dB | Fail   |
| CRF 12, 4:2:0, passthrough     |     4.78 MB |     17.20 s |     2,942 |     31.31 dB |     0.994176 |     37.06 dB | Pass   |
| **CRF 12, 4:4:4, passthrough** | **5.61 MB** | **22.56 s** | **2,942** | **41.09 dB** | **0.998933** | **47.32 dB** | Fail   |

¹ The table reports the lowest RGB-channel XPSNR aggregate. Both inputs were
decoded to planar RGB and compared on a shared microsecond timebase with nearest
timestamp synchronization. Per-frame metric logs remain in the ignored local
`artifacts/encoding-quality/2026-08-25T20-40-45-260Z/` directory.

The current output-side `-r 60` created two frames that were not present in the
reference. The passthrough profiles retained the reference's 2,942 frames. In a
separate shorter run, one manufactured CFR frame preserved the old browser image
after both the reference and passthrough output had turned black. That behavior
is unacceptable for temporal defect evidence.

The 4:4:4 profiles preserve colored UI edges much better than 4:2:0. Lowering
CRF without preserving chroma did not close that gap: CRF 12/4:2:0 scored 31.31
dB XPSNR, while CRF 23/4:4:4 scored 37.66 dB. However, neither of the four
hosted 4:4:4 MP4s advanced during the Sandbox Chrome playback check; both 4:2:0
files did. The v1 result therefore needed two artifacts:

- CRF 12/4:4:4 with timestamp passthrough as durable diagnostic evidence.
- CRF 12/4:2:0 with timestamp passthrough as the Chrome-compatible share copy.

CRF 14 and 16 reduce evidence size by 11% and 21% relative to CRF 12, but the
absolute CRF 12 output is only 5.61 MB for 49 seconds. Evidence quality takes
priority over those small savings.

## Hosted artifacts

- [RGB CRF 8 reference](https://storage.uploads.sh/curtis-arch/screenshots/sandbox-video/encoding-quality/2026-08-25T20-40-45-260Z/rgb-reference-crf8.mkv)
- [Current CRF 23/4:2:0/CFR](https://embed.uploads.sh/curtis-arch/screenshots/sandbox-video/encoding-quality/2026-08-25T20-40-45-260Z/current-crf23-420-cfr.mp4)
- [Selected CRF 12/4:4:4 evidence](https://storage.uploads.sh/curtis-arch/screenshots/sandbox-video/encoding-quality/2026-08-25T20-40-45-260Z/diagnostic-crf12-444-passthrough.mp4)
- [CRF 12/4:2:0 share](https://embed.uploads.sh/curtis-arch/screenshots/sandbox-video/encoding-quality/2026-08-25T20-40-45-260Z/crf12-420.mp4)
- [CRF 14/4:4:4](https://storage.uploads.sh/curtis-arch/screenshots/sandbox-video/encoding-quality/2026-08-25T20-40-45-260Z/crf14-444.mp4)
- [CRF 16/4:4:4](https://storage.uploads.sh/curtis-arch/screenshots/sandbox-video/encoding-quality/2026-08-25T20-40-45-260Z/crf16-444.mp4)
- [CRF 23/4:4:4](https://storage.uploads.sh/curtis-arch/screenshots/sandbox-video/encoding-quality/2026-08-25T20-40-45-260Z/crf23-444.mp4)

## Settings not selected

- **CRF 23/4:2:0 with output `-r`:** smallest file, but insufficient colored-edge
  fidelity and manufactured frames.
- **CRF 23/4:4:4:** proved that chroma preservation matters, but quantization
  remained unnecessarily high.
- **CRF 14 or 16/4:4:4:** good results, but their small absolute savings do not
  justify weaker evidence.
- **RGB CRF 8 or RGB lossless:** appropriate as benchmark references, not as the
  only production artifact because browser compatibility is poor.
- **Single 4:4:4 MP4:** rejected because hosted Chrome playback did not advance.
- **Single 4:2:0 MP4:** rejected because it cannot preserve the evidence quality
  demonstrated by 4:4:4.

The study did not test 120 FPS, all-intra codecs, CBR, AV1, HEVC,
or hardware encoding. Those are intentionally untested, not failed profiles.
120 FPS is not justified until Chromium/Xvfb demonstrates distinct 120 Hz
rendered states.

## Historical v1 pipeline qualification

Run `59611d98-aa68-41b7-95e3-084f2b0d7fdb` exercised the selected dual-output
settings and the credential-isolated uploads.sh sidecar on the pinned Vercel
snapshot `snap_Po2zFz09YrSmOIgOcr7IzYfzjKVU`:

- 50.33 seconds, 1920×1080, 60 FPS, and 3,020 decoded frames.
- Zero FFmpeg duplicate or dropped frames; page rAF measured 59.97 FPS.
- Six closed segments were stream-copy remuxed to MP4 and acknowledged through
  50.33 seconds before Sandbox shutdown.
- [4:4:4 evidence MP4](https://storage.uploads.sh/curtis-arch/screenshots/sandbox-video/59611d98-aa68-41b7-95e3-084f2b0d7fdb/evidence-yuv444p.mp4):
  3,827,756 bytes, SHA-256
  `9ebb253e73305bd660f5385f7ebb3a5f9039feafe2b31c9426c2207ba5957d4e`.
- [4:2:0 share MP4](https://embed.uploads.sh/curtis-arch/screenshots/sandbox-video/59611d98-aa68-41b7-95e3-084f2b0d7fdb/share-yuv420p.mp4):
  4,198,894 bytes, SHA-256
  `31acbc6480ae9a3097b29149178a4b56fab2fe32c6fd688dffc6227e25fd5710`.
- A hosted Sandbox Chrome check opened the share URL and advanced playback past
  0.25 seconds. The subsequent diagnostic evaluation timed out, so only the
  advancement check is claimed.

The original strict proof verdict was `proof_failed`: 94.71% useful frames and
a reported 433 ms unchanged interval. Decode-only inspection later showed that
all 2,700 frames in the approximate 45-second motion interval had different
full-frame hashes, default `mpdecimate` retained 2,615 (96.85%), and the maximum
completed unchanged interval was 33.33 ms. The false verdict came from a late
capture epoch sample that placed pre-motion content inside the validation slice.

Two follow-up Vercel runs isolated the measurement problem without changing the
encoder:

- Run `35e3daca-7887-4bcb-94f5-323b3be80b6c` used 8 vCPUs and became worse
  (90.09% useful, 450 ms), ruling out average CPU capacity as the cause.
- Run `f8ee26e2-77e5-44b0-a3f3-bf1bb0b8cd84` backdated the clock by FFmpeg's
  media time and narrowed the false lead-in to 300 ms, but still failed at
  94.97%.
- Run `dcfbca96-836e-459b-927f-155e4a1cbaaa` conservatively bracketed the clock
  and reduced maximum freeze to 50 ms. Default `mpdecimate` still retained only
  86.58% even though page rAF was 59.85 FPS.

On the identical downloaded bytes from the last run, a decode-only threshold
matrix retained 2,291 frames with FFmpeg defaults, 2,634 with
`hi=64:lo=32:frac=0.01`, and 2,648 with `hi=1:lo=1:frac=1` over 2,646 nominal
frames. Production selects `hi=64:lo=32:frac=0.01`: it rejects near-identical
frames without treating normal full-screen animation changes as duplicates.
The exact-match profile was not selected because tiny encoding differences
would make it too permissive. Acceptance remains 95%; the study changed the
measurement to match that contract rather than lowering the threshold.

Final run `054361b3-00d9-422a-a370-2a33d5f87a61` passed the complete 60 FPS
production path on 4 vCPUs:

- 50.617 seconds, 1920×1080, 60.000 FPS, and 3,037 decoded frames.
- Page rAF 59.817 FPS, 99.924% changed frames, 33.333 ms maximum freeze, zero
  FFmpeg duplicate or dropped frames, and no black area.
- The clock bracket measured 1,057 ms uncertainty and validated the guaranteed
  interior motion window from 3.457 through 47.471 seconds.
- Six rolling MP4 chunks were acknowledged through the complete 50.617 seconds.
- [4:4:4 evidence MP4](https://storage.uploads.sh/curtis-arch/screenshots/sandbox-video/054361b3-00d9-422a-a370-2a33d5f87a61/evidence-yuv444p.mp4):
  3,903,769 bytes, SHA-256
  `50e9b1b58548c70a0c388e55801d28deb595e0dd5e5310fe4e55ca0d1d620a0d`.
- [4:2:0 share MP4](https://storage.uploads.sh/curtis-arch/screenshots/sandbox-video/054361b3-00d9-422a-a370-2a33d5f87a61/share-yuv420p.mp4):
  4,259,507 bytes, SHA-256
  `f553ca3dae5b3567f67ec9d7e225453ea7a7c9845ddb64ff033f96983b96cbc4`.

Run `3d219434-78d8-4e4e-96f9-a6eb0738eb3a` passed the identical production
path at 30 FPS:

- 50.567 seconds, 1920×1080, 30.000 FPS, and 1,517 decoded frames.
- Page rAF 60.025 FPS, 100% changed frames, 66.667 ms maximum freeze, zero
  FFmpeg duplicate or dropped frames, and no black area.
- [4:4:4 evidence MP4](https://storage.uploads.sh/curtis-arch/screenshots/sandbox-video/3d219434-78d8-4e4e-96f9-a6eb0738eb3a/evidence-yuv444p.mp4):
  2,681,560 bytes, SHA-256
  `bf93e16f557747952df2aa12978dfc4e06760cd22b053074cb9581fca7a210d1`.
- [4:2:0 share MP4](https://storage.uploads.sh/curtis-arch/screenshots/sandbox-video/3d219434-78d8-4e4e-96f9-a6eb0738eb3a/share-yuv420p.mp4):
  2,784,923 bytes, SHA-256
  `f02e95eb9ef37e9455878c353c12907895a964781f2bffe2628372c352c76954`.

## Lifecycle and durability qualification

The production pipeline was also exercised at its real Vercel and uploads.sh
boundaries rather than only through unit doubles:

- **Agent nonzero:** run `b20c651f-410b-4c90-9508-478eabfe7a2c` completed the
  motion fixture and then exited 7. The runner returned exit 3 / `agent_failed`,
  while capture validation passed and both final MP4s plus five rolling chunks
  remained durable through 48.8 seconds.
- **Reserved deadline:** run `665f06b0-7782-4a58-98ec-f9a5fc2126e6` kept the
  agent alive past the finalization boundary. The runner stopped it with 143,
  returned exit 5 / `timed_out`, and still published valid final evidence/share
  MP4s plus six chunks through 53.567 seconds.
- **Host cancellation:** run `76f39447-2db0-4561-bc7e-ec158c0614ec`
  completed the motion fixture, then received SIGINT at the verified CLI PID.
  It returned exit 130 / `cancelled`, stopped the agent with 143, and preserved
  an accepted 52.567-second 30 FPS proof with six acknowledged chunks, final
  evidence/share MP4s, and a local Markdown summary. The summary reported
  public access and the same artifact identifiers; a scan found no credential
  names or values.
- **Forced Sandbox loss:** during run
  `7c216df7-7bc8-4759-bd8b-290444714f44`, the exact 4-vCPU capture Sandbox was
  stopped with `vercel sandbox stop` after three chunks were acknowledged. The
  runner returned exit 5 / `sandbox_died`, no final MP4, and exactly 30 seconds
  durable. All three published chunks were downloaded, matched their manifest
  SHA-256 hashes, and probed as 10-second H.264/yuv444p 1920×1080/30 FPS MP4s.
- **Host SIGKILL:** local orchestrator PID 6695 was verified by command and
  working directory, then killed with SIGKILL. The remote FFmpeg process (PID 679) remained alive with the exact production argv, and closed chunks advanced
  from three to five before both named Sandboxes were explicitly stopped. This
  proves the recorder is detached from the host process. It also identifies the
  durability gap precisely: the host watcher owns publication, so chunks closed
  after host death remain only in the Sandbox and are not acknowledged as
  durable. A separate durable queue/service would be required to close that gap.

Snapshot preparation was invoked twice with the same image, expiration, and
lock. Both calls returned schema 5, snapshot
`snap_Po2zFz09YrSmOIgOcr7IzYfzjKVU`, creation time
`2026-08-25T21:21:00.687Z`, and identical pinned tool versions without creating
a Sandbox.

The cancellation artifacts are retained at:

- [4:4:4 evidence MP4](https://storage.uploads.sh/curtis-arch/screenshots/sandbox-video/76f39447-2db0-4561-bc7e-ec158c0614ec/evidence-yuv444p.mp4),
  SHA-256
  `4d1a09f156a58f88c2ce3cc908fe15c751b1efd2812a551fbba1c16028c1ed41`.
- [4:2:0 share MP4](https://storage.uploads.sh/curtis-arch/screenshots/sandbox-video/76f39447-2db0-4561-bc7e-ec158c0614ec/share-yuv420p.mp4),
  SHA-256
  `b78b047b85393ddc8ae43852acd496d14099f827a8efd2241d67e6466950e18f`.
