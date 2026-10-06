# Vibe Edit — Engineering Handoff

**App version 4.10.3.** This document is the working reference for whoever picks
this project up next. Read sections 1–4 before changing anything; they encode
mistakes that have already cost real debugging time.

---

## 1. What this is

A complete video editor that runs locally — as a single HTML file in a browser,
or wrapped in Electron as a desktop app. No server, no uploads, no accounts.
Everything (decoding, rendering, analysis, encoding) happens on the user's
machine.

It is genuinely feature-deep: multi-track timeline, keyframe animation, motion
tracking, stabilization, multi-cam sync, a 22-style music visualizer, corner-pin
perspective warping, and an export pipeline covering MP4/MOV/MKV/WebM/GIF plus
nine audio formats.

v4.6 added **local AI editing** (the AI EDITING block, §3b): edit video by
editing its transcript, filler-word and pause removal, captions/subtitles that
follow the edit, scene detection, beat sync and auto-reframe to 9:16 / 4:5 /
1:1 — plus a visual refresh of the whole interface.

v4.7 added the **Pro tools** (§3c): compound clips (nesting), auto-ducking,
speaker labels in the transcript, and a proxy workflow — plus a redesigned,
two-column Export dialog and Electron 44.

v4.8 completed the Pro list: **.cube LUT grading**, a **keyframe curve editor**
(per-key easing: linear, smooth, ease in/out, hold, custom bezier) and **speed
ramps** (a speed curve per clip, with presets).

v4.9: a **built-in LUT library** (camera log → Rec.709 from published curves,
plus looks), **grading scopes** (waveform/parade, vectorscope, histogram),
**frame blending and motion blur**, **speed/reverse on compound clips**, and
the **CAM++ speaker model** in the desktop app (`desktop/app/models/`).

**Who it's for:** one user, who is not a programmer, uses Windows, and gives
excellent, specific bug reports — often with screenshots, project files and VLC
codec dumps. Take those seriously; they have repeatedly contained the answer.

---

## 2. The files

```
vibe-edit/
├── vibe-edit.html              The ENTIRE editor. UI, engine, exporter. ~15,000 lines.
├── vibe-edit-converter.html    Standalone tool: converts old .cutroom projects to .vibe
├── desktop/                    Electron wrapper
│   ├── main.js                 Main process: FFmpeg, dialogs, IPC (~1,000 lines)
│   ├── preload.js              The window.vibeNative bridge
│   ├── app/index.html          COPY of vibe-edit.html — must be kept identical
│   ├── bin/                    Where the user drops ffmpeg + ffprobe
│   └── package.json            electron-builder config
└── tests/                      Headless verification harness (see §6)
    ├── fixtures/               Ground-truth speech, music and photos + generators
    └── lib/                    Shared launcher, offline model server, scorers
```

**`vibe-edit.html` and `desktop/app/index.html` must always match.** The build
step is literally `cp vibe-edit.html desktop/app/index.html`. A mismatch means
the desktop app runs a stale interface — this has happened and cost a session of
confusion, which is why the app now detects and warns about it at launch.

**Do not split the app into modules.** Single-file delivery is deliberate: the
user downloads one file and it works. It is large but navigable via search.

---

## 3. Architecture in one page

### Renderer (`vibe-edit.html`)

Plain JavaScript in `<script>` blocks — no framework, no build step.

- **`state`** — the single source of truth: `clips`, `media`, `time`, `pps`
  (timeline zoom), `selection`, `project` (w/h/fps/bg).
- **`TRACKS`** — track definitions. Video tracks stack upward (higher = drawn on
  top); audio below.
- **A clip** is a plain object: `{id, type, track, start, duration, inPoint,
  mediaId, props{}, kf{}}`. Types: `video, audio, image, text, color, meme,
  overlay, adjust, viz`.
- **`drawFrame()`** is the heart. It composites every visible clip onto the
  preview canvas for `state.time`. **Preview and export share this one function**
  — that is why exports match what you see, and why a rendering fix needs no
  export-side counterpart.
- **`renderTimeline()`** rebuilds the timeline DOM; **`renderInspector()`**
  rebuilds the right-hand panel from the selected clip.

### Key invariants — violate these and things break subtly

| Invariant | Why |
|---|---|
| Read animatable props via `liveProps(c,t)`, never `c.props.x` directly | keyframes are evaluated per-frame |
| Write them via `setAnimProp` / `kfUpsert` | keeps keyframes consistent |
| Source time comes from `srcTimeFor(c,t)` — never compute it inline | it handles speed, reverse, freeze-frame, and the full-quality export offset in one place |
| A clip owns `[start, end)` — the frame landing exactly on `end` belongs to the NEXT clip | otherwise adjacent clips double-expose for one frame |
| Never mutate the live `<video>` element for analysis | tracking/stabilization/reverse use dedicated cloned elements |
| New inspector controls must register in `defaultProps()` and `HINTS` | otherwise reset arrows write 0 and tooltips are silently missing |
| Every CSS class used in injected markup must exist in the stylesheet | an undefined class fails silently, unstyled |
| Element IDs must be unique | a duplicate ID silently steals the later handler |

### 3b. AI EDITING block (v4.6) — the last `<script>` in the file

Search for `AI-JS BEGIN`. Layered so each layer only calls the ones above it:

1. **Ripple-cut engine** — `aiRippleCut(ranges)` removes timeline ranges on every
   UNLOCKED track at once and closes the gaps (locked tracks are untouched —
   that is how a music bed stays continuous). Frame-snapped, one undo step.
   `aiClipSub(c,a,b)` is the exact slicer behind it (forward, reversed and
   frozen clips; keyframes; fades); `splitClip` now uses it too.
2. **Audio analysis** — each source decoded once to 16 kHz mono and reduced to a
   10 ms dBFS envelope (`_aiEnv[rootId]`, in memory only; rebuilt on demand).
3. **Speech engine** — Whisper (transformers.js 3.0.2, pinned) in a Web Worker
   built from a Blob. Windows ≤ 28 s are planned by the APP, ending in the
   quietest moment; silent stretches are skipped. Each window's result is
   checked against the audio (coverage) and retried if poor. Word times are
   then lag-corrected and snapped onto the audio (`aiRefineWords`).
4. **Timeline transcript** — words are stored on the ROOT media in SOURCE
   seconds (`m.transcript = {words:[[text,s,e]...], covered:[[a,b]...], lag}`,
   saved in the project) and mapped through every audible clip by
   `aiTimelineWords()`, so the text always matches the current edit.
5. **Features/UI** — Transcript tab, fillers review, pauses, captions/SRT,
   scenes (`ai-scenes`), beat sync, auto-reframe, AI tools menu, Guide section.

The block is built from `dev/*.js` + `dev/*.css` with `dev/build.py` during
development; the HTML is the source of truth that ships. Edit either — but if
you edit the HTML directly, don't run the build afterwards with stale dev files.

**Invariants added in v4.6**

| Invariant | Why |
|---|---|
| Never use transformers.js long-form mode (`chunk_length_s`) with word timestamps | MEASURED: 3.0.2 dropped everything before 30 s (38 of 116 words) |
| Cut through `aiRippleCut` / slice through `aiClipSub` | exact source mapping incl. reverse + keyframes; property-tested |
| Keyframe fragments carry `key.e` — `kfUpsert`/`kfRemove` clear it | makes cut pieces animate exactly like the uncut clip (see `kfEval`) |
| Pause detection uses `aiSilenceLevel` (floor-relative), not the speech threshold | the speech threshold cut 133 ms into soft words on noisy audio |
| Analysis frames come from `aiFrameGrabber` (own hidden `<video>`) | never touch the live preview element; tests inject `AI.frameSource` |
| `aiFrameGrabber.grab(t)` seeks; `.capture(times)` plays through (≤8×) and copies frames as playback passes each time | seeks wait for `requestVideoFrameCallback` only while it proves to fire (else 250 ms per seek); `capture` returns `exact:false` when it had to poll `currentTime`, and callers must then re-read cut boundaries by seeking |
| Film-strip thumbs are ONE stylesheet rule per media (`_thumbClass`) | inline data URLs per clip would bloat every timeline rebuild |

### 3c. PRO block (v4.7) — `dev/pro-*.js`, spliced after the AI block

| File | What |
|---|---|
| `pro-duck.js` | Auto-ducking. Speech intervals from transcript words (else loudness above the voice clip's `env.auto`), merged across short gaps; written as ordinary `kf.volume` keys on music clips. `c.duck={prev,sig}` lets a re-run REPLACE (not stack) — only when the keys are still exactly what it wrote. A compound with sound on a Music track is ducked by keys on the COMPOUND (folded into its sound by `_cmpGainKeys`); roles are guessed from the flattened content. |
| `pro-proxy.js` | Proxy badges + menus in the bin, "Play the original" (`_proPlay[mediaId]={offset}` — read by `_hqOffset`, so `srcTimeFor` stays the single door), on-demand proxies (`vibeNative.makeProxy` with `maxDim`), heavy-footage batch. |
| `pro-ge2e.js` | GE2E speaker encoder in plain JS (librosa-exact mel + 3-layer LSTM). Weights: `dev/speaker-ge2e.bin` (Resemblyzer, Apache-2.0, float16 2.8 MB) embedded as base64 in `<script type="text/plain" id="vibeSpeakerModel">` by `build.py`. The same function is the Worker source and is unit-tested in Node against PyTorch (`tests/ge2e-reference.js`, cos = 1.0000). |
| `pro-speakers.js` | Diarization: windows over speech → embeddings on a Worker pool → average-linkage clustering (auto τ=0.70, or a given count with per-recording mean removal) → centroid refinement → Viterbi → per-word labels, each change moved to the best pause/sentence end within 0.9 s (`_proSnapTurns`) stored as `transcript.speakers={byT:[[wordStart,label]],names,n,k}` (keyed by word START time so re-transcribing other parts never shifts them). |
| `pro-compound.js` | Compound clips. `c.type='compound'`, `c.inner.clips` in the compound's own time, `inPoint/duration` = the window. Drawn by running the SAME compositor on the inner clips into an offscreen layer (recursive). `playClips()` flattens compounds into virtual clips for everything that plays or mixes media. Edit-inside swaps `state.clips` + history; `proRootClips()` makes every save write the outer timeline. `_cmpInherit` passes the compound's Preserve pitch off / frame blending / motion blur to the clips inside. Break apart folds look/LUT/opacity/volume (and their keys), fades and mute into the clips where it maps one-to-one and names the rest in a warning; break/open refuse on locked tracks. The inspector shows only controls that act on a compound (no Motion presets, Transitions, Vignette, Film fade, Grain). |
| `pro-lut.js` | (v4.8) .cube LUTs. `proParseCube` (3D; 1D expanded to 33³; a Resolve-style 1D shaper before a 3D table stays a separate first stage; DOMAIN_MIN/MAX, LUT_3D/1D_INPUT_RANGE). `state.luts[id]={name,size,dmin,dmax,data:Float32Array,shaper?}` — NOT in undo history; saved in the project as 16-bit base64 (only LUTs in use). Clip props `lutId`, `lutAmt` (0–100). GPU: WebGL2, LUT as an RGB16F 3D texture with hardware trilinear, shaper as a 2D texture; CPU fallback does the same math (used when WebGL2 is missing, e.g. Electron under xvfb). Applied to the source rect BEFORE the clip's filters (clip draw + chroma path), to the adjustment-layer snapshot (`proLutInPlace(_adjC)`), and to a compound's layer. Textures of LUTs no longer loaded are freed on the next use. |
| `pro-curves.js` | (v4.8) Keyframe curve editor (modal). Editing primitives `proCurveSetType/MoveKey/AddKey/DeleteKey` are separate from the UI (tests call them). Adding a key splits its segment into two exact `e` fragments (motion unchanged); moving/deleting a key re-shapes only the segments that meet at it. |
| `pro-ramp.js` | (v4.8) Speed ramps: presets, the inspector curve (x = progress through the source, y = log speed 0.1–10×), `proRampEdit` (keeps the SOURCE span, length follows), `proRampBuffer` (the ramp's sound rendered straight onto the timeline: WSOLA with the analysis position taken from the picture's mapping, so it can't drift; record-style when Preserve pitch is off or reversed), timeline badge. The math itself is in the core (see below). |
| `pro-lutlib.js` | (v4.9) Built-in LUTs generated in the app (33³): camera log→Rec.709 (S-Log3/S-Gamut3.Cine, V-Log/V-Gamut, LogC3 EI800/AWG3, Apple Log/Rec.2020 — log curves and primaries as published; gamut matrices computed from the primaries and checked against Sony/ARRI/ITU tables) with a soft shoulder above 0.6 and the Rec.709 OETF; plus 8 looks. A project stores only `{builtin:id}` (`state.luts['lutB_'+id]`). |
| `pro-scopes.js` | (v4.9) Replaces the core `updateScopes` (reassigns the global). `proScopeCompute` (pure: luma/RGB waveform accumulators, BT.709 Cb/Cr vectorscope, histograms, crushed/clipped) + `proScopeDraw`. "Scopes" chips in the grade/color/LUT headers. |
| `pro-blend.js` | (v4.9) Frame blending (slow parts) and motion blur (fast parts, shutter angle). `proBlendPlan(c,t)` → source frame times + weights (frame centers at (k+0.5)/fps; fps from `m.srcFps`, measured with requestVideoFrameCallback when unknown). A hidden sampler `<video>` per media seeks to each; the weighted average is drawn in SOURCE space via the clip draw (`proBlendFrame`). Precise export awaits `proBlendPrepare(t)` per frame; the preview computes it only while paused; Fast (realtime) export skips it (the summary says so). |
| `pro-campp.js` | (v4.9) CAM++ speaker embeddings (3D-Speaker, Apache-2.0) with ONNX Runtime Web 1.30 in Workers. Files in `desktop/app/models/` (graph, float16 weights → float32 externalData, ORT bundle + wasm), read via `vibeNative.readPath` (XHR elsewhere). `proKaldiFbank` = torchaudio kaldi.fbank (checked to 1e-4). Missing or damaged files → GE2E (`PRO_SPK.camppBroken`). Per-engine clustering settings in `PRO_SPK_ENGINES` (CAM++ autoTau 0.55, tuned on the fixtures). |
| `pro-ui.js` | Inspector hooks (`proInspectorSections`, `proBindInspector`), command palette entries + Guide "Pro tools" section. |

**v4.8 core additions**
- **Per-key easing.** `key.i` ∈ linear/smooth/in/out/hold/bezier (+ `key.b=[x1,y1,x2,y2]`) is the interpolation of the segment that STARTS at that key; absent → the clip-wide `kfEaseMode`. `kfEval` → `kfEase(u,mode,b)`; `kfBezier` is CSS cubic-bezier (Newton + bisection). Exact fragments carry their original segment's type in `e.i/e.b`; `_aiKfSlice` copies `i/b` onto whole segments and into `e`; `kfUnfrag` (used by `kfUpsert/kfRemove`) promotes `e.i` to `i`. Choosing a clip-wide easing in the inspector clears the per-key overrides.
- **Speed ramps.** `c.ramp={pts:[[q,speed],…], w?:[w0,w1], preset?}` — speed as a function of q = progress through the ramp's source span (playback order), log-space smoothstep between points, constant past the ends. `rampTable` = cumulative ∫dq/speed (2048 steps, cached non-enumerably on the ramp); `rampPAt(c,u)` / `rampUAt(c,p)` are exact inverses; `srcTimeFor` uses `rampPAt`; `rampSrcToTl/rampTlToSrc` for everything that maps source↔timeline (transcript, beats, scenes, reframe, beat markers, waveforms). A split piece keeps the same `pts` with a narrower window `w`, so both halves play exactly as the whole did; trims keep the shape stretched over the new span (intended).

**Invariants added in v4.7**

| Invariant | Why |
|---|---|
| Anything that PLAYS, SEEKS or MIXES media iterates `_playClips()` (core) / `playClips()` (PRO block), never `state.clips` | otherwise clips inside compounds are silent / frozen. Patched: syncMediaSeek/Playback, seekMediaExact, prerollMedia, renderAudioOffline, buildAudioMixSpec, _audioSpecSupported, meterLevelAt, export source plan, full-quality export, fps helpers |
| Timeline EDITING code keeps using `state.clips` | a compound is one clip to the editor; its inner clips are not on the outer timeline |
| Crop/source rects are in MEDIA pixels; the draw scales them to the element's real size (`_kx/_ky`) | an original behind a downscaled proxy (full-quality export, Play original) is a different size. Before v4.7 a 4K original drew only its top-left quarter |
| Core code never calls an AI/PRO-block function unguarded on a path that can run at startup | the render loop ticks before the last `<script>` runs; the error is swallowed as "frame error". smoke.js and the Electron harness fail on such logged errors |
| Speaker labels are keyed by word start time | indices shift whenever part of a source is re-transcribed |
| `_drawComposition` clears (not fills) and returns early when `_cmpDepth>0` | a compound layer must be transparent and must not touch gizmo/guides/scopes |
| (v4.8) With a ramp, `props.speed` is the AVERAGE speed and `span = duration*speed` still holds | every "duration*speed" span in the app stays right; but a source↔timeline MAPPING must go through `srcTimeFor` / `rampSrcToTl` / `aiSrcToTl`, never `(src-inPoint)/speed`. Anything that changes a ramp goes through `proRampEdit` (recomputes speed and duration from the curve) |
| (v4.8) `key.i` belongs to the segment that STARTS at the key; `e` fragments carry `e.i` | edit code that drops `e` must use `kfUnfrag`, or a split piece silently changes its curve type |
| (v4.8) LUTs are applied to the source picture FIRST, then the clip's filters/grade | a log→Rec.709 LUT must see the camera's log signal; users expect their tweaks on top |
| (v4.9) A compound's window is `[inPoint, inPoint+duration×speed]` in INNER seconds; inner clips are re-timed onto the outer timeline by `_cmpRetime` (times ÷ speed, mirrored when reversed: keyframes via `_cmpMirrorKeys` — easing mirrored, holds re-expressed —, fades/transitions/text animations swapped, ramps flipped, stabilization via `stab.tk/rev/revLen` — only for older analyses; since the review fixes `stab.st` stores each analyzed frame's SOURCE time and `_stabIndex` looks up by `srcTimeFor`, which survives splits, trims, speed and compounds) | anything that maps compound time to inner time must include speed and reverse (open/close, trims, rolls, break apart) |
| (v4.9) Frame blending/motion blur replace the SOURCE frame (like the reverse cache does) | so crop, transform, LUT and color apply once to the blended picture |
| (v4.10) A clip's placement transform lives in ONE function, `_clipXform` (position → rotation → stabilization → motion zoom → transition → flip), used by `drawFrame`; anything mapping a preview point to source pixels (or back) uses `clipSourceMap(c,t)` (inverts `_clipXform`, the corner-pin homography and crop/fit; media pixels) and `clipSourceFrame(c,t)` (the element drawn + kx/ky) | the chroma pick and motion tracking used their own partial inverses that ignored corner pin, stabilization and keyframed/motion placement |

### Desktop (`main.js`)

Exposes IPC channels consumed through `window.vibeNative` (the preload bridge,
which also keeps the old name `cutroomNative` as an alias so a missed reference
cannot fail at runtime):

```
ffmpeg:has  probeStreams  streams  duration  keylead  list-encoders
ffmpeg:proxy  readproxy  cancelProxy  encode  encodeAudio  cancelEncode  remux
project:save  project:open   file:readPath  file:statPath   app:version
ffmpeg:scenes  ffmpeg:cancelScenes            (v4.6: per-frame scene scores)
```

**FFmpeg is user-supplied** in `desktop/bin/` — it is never redistributed, which
keeps the app clear of LGPL/GPL obligations. Both `ffmpeg` **and `ffprobe`** are
required; `ffplay` is not used.

---

## 4. The two ideas most likely to trip you up

### Proxies

Awkward imports (HEVC, 10-bit, 4K, or **keyframes more than 0.5 s apart**) are
converted to a browser-friendly **proxy** with very dense keyframes. This is what
makes scrubbing smooth and frame-accurate export possible.

The decision is made **at import time** in `importFiles`. Consequences:

- Changing proxy rules only affects **newly imported** clips. Always tell the
  user to re-import when a fix depends on it.
- If the probe block throws, nothing is proxied and the app degrades badly but
  silently. This happened; see §5.

### Full-quality export

Editing runs on proxies, but exporting from them would bake in their quality
loss. So at export the app goes back to the originals — `beginFullQualityExport()`:

1. Use the **original file** directly when the browser can decode it **and its
   keyframes are dense enough to seek accurately**.
2. Otherwise build a **full-resolution intermediate** with dense keyframes,
   covering **only the span the timeline uses** (`_hqUsedSpan`) — not the whole
   recording.
3. If neither is possible, keep the **proxy** — softer beats stuttering.

`endFullQualityExport()` restores everything; it is called from
`restoreAfterExport()`. **Accuracy outranks sharpness**: a sparse-keyframe
original must never be rendered from directly, however decodable it is.

---

## 5. Hard-won lessons (each cost a real debugging session)

1. **Temporal dead zone, four times.** A `const`/`let` read above its declaration
   throws, and in this codebase those reads sat inside `try/catch` blocks that
   swallowed it — so an entire probe block or IPC handler silently stopped
   working. Symptoms: "nothing gets proxied", "every import fails", "the note
   never appears". **`tests/tdz-scan.js` exists specifically for this. Run it
   before every ship.**

2. **Test what the user sees, not what the code says.** A test asserting
   `element.style.display !== 'none'` passed while the panel was invisible —
   because it was nested inside a hidden parent. Assert **painted geometry**
   (`getBoundingClientRect().height`), walk the ancestor chain, and **click the
   real button** rather than calling the handler directly (a duplicate ID bug
   survived precisely because the test called the function).

3. **Measure before fixing, and measure honestly.** Several "fixes" were only
   provable because a metric was defined first: waveform fidelity vs ground truth
   (0.52 → 0.99), export frame duplication (231 vs 325 unique frames), sync
   accuracy (0.57 ms), stabilization jitter (2.77 → 0.32 px). Beware metrics that
   flatter the bug — counting "oscillations" once rewarded aliasing artifacts,
   and a "deviation from a straight line" metric conflated deliberate pans with
   shake.

4. **Reproduce the user's exact scenario.** Twice the real cause was found only
   after building the user's precise geometry or codec situation in a test.

5. **The user's console output is gold.** The `hq` dead-zone bug was found
   instantly from a screenshot of the Windows console after a long session of
   speculation.

6. **Prove a test catches the bug.** Reintroduce the fault, watch the test fail,
   then restore. Several suites were verified this way.

---

## 6. Testing

```
cd tests
npm install          # once (also pulls transformers.js, Whisper-tiny weights, MediaPipe)
node tdz-scan.js     # static: dead-zone reads. MUST pass.
node smoke.js        # boots the app, checks every subsystem + UI structure
node cut-engine.js   # 1000 random timelines: every surviving frame identical after cuts
node ai-visual.js    # scenes, beat sync, reframe (real face model), split fixes, thumbs
node ai-ui.js        # every new panel/dialog opened by REAL clicks; tooltips, painting
node ai-speech.js    # real Whisper on ground-truth speech: coverage, cut accuracy,
                     #   pauses, fillers, captions, save/load   (~2 min)
node scene-ffmpeg.js # main.js scene handler with real FFmpeg on known cuts
node ge2e-reference.js # speaker encoder vs the PyTorch original (mel 8e-8, cos 1.0000)
node pro-tools.js    # ducking (3 paths), speakers (4 recordings), compound clips (pixel/sound exact)
node review-fixes.js # v4.10 full-review regressions (timeline, audio, picture, io, ai, pro, ux,
                     #   xfade, chroma, sweep2 = v4.10.1 follow-up review; axfade = v4.10.2 sound crossfades;
                     #   kfspeed = keys follow speed (+ linked partners on reset/paste); samemedia = one file
                     #   shown by several clips at once, each on its own decoder; wedge = v4.10.3 stuck-seek
                     #   element replaced);
                     #   `node review-fixes.js <section>` runs one section
node pro-grade.js    # LUTs vs an analytic grade (GPU+CPU) + the built-in library vs published
                     #   curves/matrices, keyframe curves, speed ramps vs a numeric integral,
                     #   compound speed/reverse (picture + clicks exact), scopes on color bars,
                     #   frame blending/motion blur on a known-levels video, CAM++ (fbank and
                     #   embeddings vs PyTorch, speaker accuracy, fallback)
npm run all          # everything above
node desktop-pro.js  # REAL Electron + FFmpeg: proxies made/switched, frames identical; a ramp
                     #   on real H.264 shows the exact frame; a LUT on playing video (needs
                     #   ELECTRON=… and a video in VIBE_TEST_MEDIA; Linux runs it under xvfb)
node desktop-quit.js # REAL Electron: quit prompt (Save / Don't Save / Cancel, export warning), FFmpeg
                     #   stopped on quit, session temps deleted, stale ones swept, user files kept
```

The launcher (`tests/browser.js`) finds Chromium via `$CHROME_PATH`,
@sparticuz/chromium (either export shape — the shape change broke the old
snippet), or a Playwright install. `lib/asr-env.js` answers the app's CDN and
Hugging Face requests from local npm packages, so the REAL speech and face
pipelines run offline. Fixtures regenerate with `tests/fixtures/make.sh`.

**Measured baseline (v4.9.0)** — keep these from regressing:
v4.9: CAM++ speakers — the real phone call 98.8 % of words with the count found
automatically (GE2E: 4 speakers found, 86 %), 3 synthetic voices 99 %, one voice
→ 1, 4 voices incl. two near-identical 84 %; about 4× faster than GE2E; JS fbank
within 1.2e-4 of torchaudio, embeddings cosine ≥ 0.99996 vs PyTorch. Compound
speed 2×/0.5×/reversed: picture identical to the inner timeline at the mapped
time, click positions exact. Built-in camera LUTs: 18 % gray → Rec.709 gray within
0.004. Frame blending/motion blur: blended levels within 0.5/255 of the weighted
mix. Scopes: color bars land exactly in the waveform/parade rows and within one
bin of the vectorscope targets.

v4.8: LUTs — a 33³ table of an analytic grade reproduces it within 1/255 on the
GPU and the CPU path (GPU vs CPU ≤ 1), identity exact, 1D/shaper/domain files
≤ 1–2/255, adjustment layer = clip LUT, save/load identical; keyframe curves —
bezier solver within 4e-6 of a dense reference, splits (incl. pieces of pieces)
reproduce every curve type to 1e-14, adding a key never changes the motion;
speed ramps — length matches an independent Simpson integral of the curve to
4e-8 (relative), picture mapping within 0.2 ms, pieces of a split ramp within
10 µs, the offline mix puts every click where the picture mapping says (0.14 ms),
pitch-preserved sound keeps a 440 Hz tone at 440 Hz through the slow and fast
parts; on real H.264 in Electron the ramped viewer shows exactly (diff 0) the
frame a plain clip at the integral's in-point shows.

Pro tools: ducking — music exactly at the duck level at every one of 116 words,
already down at every sentence onset, fully back up in long pauses (transcript,
loudness and noisy-loudness paths); speakers — 3 synthetic voices 99% of words
with the count found, 1 voice → 1 speaker, a REAL two-woman phone call 94% given
"2" (auto over-splits it: 4 speakers, 86%), 4 voices incl. two near-identical 83%;
compound clips — picture and mix bit-identical to the loose clips (make, trim
window, split, nested, break apart), edit-inside is one undo step; proxies (real
Electron + FFmpeg) — viewer frames identical on proxy and original, incl. a
trimmed portion (window offset).

transcription covers 100% of spoken words; deleting any whole sentence clips
0 ms of its neighbors (14/14, clean and noisy); deleting one word inside
continuous speech clips a median 30–40 ms of a neighbor; pauses 13/13 found,
0 cuts into speech; fillers 2/2 removed cleanly; splitting clips adds no "…"
markers; beat error ≤ 13 ms; scene cuts found on the exact frame.
On the owner's real clips (`real-footage.js`, needs `VIBE_TEST_MEDIA`): FFmpeg
scene path 60/60 labelled cuts with 0 false; beats match librosa's tempo exactly
with ≥ 95% agreement; the news clip transcribes with its key words. On the owner's
Windows PC (v4.6.1/4.6.2 session): transcribe, word delete + undo, pauses,
captions, scenes (10/10 cuts on the news clip, FFmpeg path) and auto-reframe all
confirmed by hand.

`smoke.js` verifies: all subsystem functions defined, a frame draws, corner-pin
renders, legacy `.cutroom` projects open, new projects save as `vibe-edit`, the
Guide has ≥25 entries, no duplicate IDs, every visible control tooltipped, no
unlabelled buttons, and the export panels are true siblings.

### Writing further tests — the pattern

```js
const { openApp, addWavMedia } = require('./lib/fixture-page');
const app = await openApp();            // app loaded, offline model server installed
// app.page.evaluate(...) drives the REAL functions. Return an object of booleans;
// any false = failure. Mutate the app to prove the test fails, then restore.
```

### Sandbox limits (known, verified — don't waste time rediscovering)

- The test Chromium has **no H.264** (open-source build). Transcode to VP9 WebM
  for browser-side video tests, and load it through a `blob:` URL (fetch it
  first) — seeking and playback then work. Electron 44 itself (downloadable
  from npm here, run under `xvfb-run`) plays H.264 and runs `main.js` for real.
- `requestVideoFrameCallback` rarely fires for an off-screen video in this
  sandbox; the frame grabber detects that and falls back (see §3b).
- Canvas, Web Audio (`OfflineAudioContext`), FFmpeg via CLI, and the whole
  renderer all work fine.
- `main.js` can be exercised by stubbing `electron` in `require.cache` — see the
  handoff history for the pattern; it caught a live handler bug.

---

## 7. Ship ritual

```bash
# 1. syntax check the renderer (extract the <script> blocks first)
python3 -c "import re;s=open('vibe-edit.html').read();open('/tmp/all.js','w').write(
  '\n'.join(re.findall(r'<script>\n(.*?)\n</script>',s,re.S)))"
node --check /tmp/all.js && node --check desktop/main.js && node --check desktop/preload.js

# 2. tests
cd tests && npm run all

# 3. bump BOTH version numbers — they must match
#    vibe-edit.html : const APP_VERSION='x.y.z'
#    desktop/package.json : "version": "x.y.z"

# 4. sync the copy, then package
cp vibe-edit.html desktop/app/index.html
```

Then verify **inside the packaged artifact** that the two versions match and the
interface hash equals the source file. The app warns the user at launch if they
ever diverge.

**Spelling:** American English throughout (`color`, `analyze`, `stabilize`,
`neighbor`). British forms have slipped in repeatedly; a guard in the test suite
is worth keeping.

---

## 8. Current state & possible next steps

Everything described here works and is tested headlessly, and the AI tools
were confirmed by hand on the owner's Windows PC in the v4.6.1/4.6.2 session.
Still worth a hand check after packaging with Electron 44: export (all
presets), import of odd formats, and Beat sync on a real song.

Known limits, stated honestly in the Guide:
- Cutting a single word out of fast continuous speech is accurate to roughly
  ±40 ms (Whisper's alignment, after correction). Cuts at pauses are clean.
  A dedicated forced-aligner model would tighten this; none was testable here.
- Whisper usually leaves "um"/"uh" out of the text; the "unwritten sounds"
  detector catches them acoustically (and breaths/laughs too — hence review).
- Auto-reframe treats a jump cut between near-identical framings INSIDE one clip
  as the same shot. Transcript/pause edits split clips at every cut, so this
  rarely matters.
- Speech and face models download on first use (internet needed once).

Ideas not built:
- Speaker labels use a small, older voice model (GE2E). Clearly different voices
  are labelled well; similar voices need the count set and may need a paragraph
  relabelled. A stronger model (WeSpeaker/ECAPA via ONNX) would help — its
  weights could not be fetched from this sandbox to test, so it wasn't shipped.
- Speed ramps: a ramp can't go above 10× or below 0.1× (preview playback can't
  exceed 16× even with shuttle speed); ramps apply to video/audio clips, not
  compounds; auto-ducking on a ramped music clip works but "Remove ducking" may
  not recognise the keys of a ramped clip that was split afterwards.
- Frame blending/motion blur: Precise exports and the paused preview only
  (each blended frame needs 2–12 extra seeks). No optical flow — slow motion
  mixes neighboring frames, it doesn't invent new ones.
- Reversed compounds swap text entrance/exit animations and transitions for
  their counterparts rather than playing them exactly backwards.
- CAM++ ships with the desktop app only (≈29 MB in app/models); the single-file
  browser copy uses GE2E.
- LUTs: very large LUTs (65³) are saved inside the project; the crash-recovery
  autosave leaves LUT data out if the browser's storage quota is hit (the
  restored session then asks to load the .cube again).
- Compound clips: transitions/motion
  presets apply inside, not to the compound; the transcript and AI tools see
  a compound as opaque (open it to use them inside).
- Code signing (Windows: an OV/EV certificate or Azure Trusted Signing; macOS:
  a Developer ID + notarization). Unsigned builds trigger SmartScreen /
  Gatekeeper warnings. Needs the owner's certificate — nothing to do in code
  beyond the electron-builder `win.signtoolOptions` / `mac.identity` settings.

**Before public release:** `desktop/package.json` declares MIT, which permits
anyone to resell the work — confirm that is intended.

---

## 9. Version history

The detailed change log for every version from 3.41 to 4.10.3 — root causes,
measurements and the reasoning behind each fix — is preserved in
`HANDOFF-HISTORY.md` beside this file. Consult it when a piece of code looks
strange; the reason is usually recorded there.
