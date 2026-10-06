# Vibe Edit

A complete video editor that runs entirely on your own machine — in a browser
tab or as a desktop app. No server, no uploads, no accounts.

**Version 4.10.3** — local AI editing (edit by transcript, remove fillers and pauses,
captions that follow your edit, scene detection, beat sync, auto-reframe) and Pro tools:
compound clips (with speed and reverse), auto-ducking, speaker labels (CAM++ in the
desktop app), a proxy workflow, LUT grading with a built-in library, grading scopes,
a keyframe curve editor, speed ramps, frame blending and motion blur.

---

## What's in this folder

| Path | What it is |
|---|---|
| **`vibe-edit.html`** | The entire editor. Open it in a browser and it works. |
| **`vibe-edit-converter.html`** | Converts projects saved under the old name (`.cutroom`) to `.vibe`. Optional — the app opens both. |
| **`desktop/`** | The Electron wrapper: same editor, plus FFmpeg for wider format support and better exports. |
| **`tests/`** | Headless verification harness. Run before shipping any change. |
| **`HANDOFF.md`** | **Start here if you're working on the code.** Architecture, invariants, gotchas, workflow. |
| **`HANDOFF-HISTORY.md`** | Detailed change log with root causes and measurements. |

---

## Running it

**Browser** — open `vibe-edit.html`. Everything works except the formats and
export options that need FFmpeg.

**Desktop** (recommended — unlocks HEVC, ProRes, MKV, MP4/MOV export, hardware
encoding):

```
cd desktop
npm install
npm start
```

Then drop `ffmpeg` and `ffprobe` into `desktop/bin/` — see `desktop/README.md`
for details. **Both binaries are needed**; `ffplay` is not used.

To build installers: `npm run dist` (or `dist:win` / `dist:mac` / `dist:linux`).

---

## Working on the code

Read **`HANDOFF.md`** first — it documents the architecture and, more usefully,
the mistakes already made and how they were found.

The three rules that matter most:

1. **`vibe-edit.html` and `desktop/app/index.html` must stay identical.**
   The build step is `cp vibe-edit.html desktop/app/index.html`. A mismatch means
   the desktop app runs a stale interface.
2. **Run `node tests/tdz-scan.js` before every ship.** It catches a specific
   silent-failure bug class that has shipped four times.
3. **Bump both version numbers together** — `APP_VERSION` in the HTML and
   `version` in `desktop/package.json`. The app warns at launch if they differ.

```
cd tests && npm install     # once
node tdz-scan.js            # static check — must pass
node smoke.js               # boots the app, verifies every subsystem
npm run all                 # every suite, including the AI ground-truth tests
```

---

## Notes

- Nothing is uploaded. All decoding, rendering, analysis and encoding are local —
  including speech recognition and face detection. Their models download once on
  first use, then work offline.
- Projects are small `.vibe` files that reference your media rather than copying
  it, so keep your footage where it is.
- FFmpeg is user-supplied and never redistributed, which keeps the project clear
  of its licensing obligations.
- Press **`?`** inside the app for a searchable guide to every tool.
