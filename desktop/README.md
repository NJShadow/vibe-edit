# Vibe Edit — desktop app

A full video editor that runs entirely on your own machine. It ships with its
own rendering engine (Electron/Chromium), so no browser is needed, it works
offline, and **your media is never uploaded anywhere**.

---

## Quick start

Requires [Node.js](https://nodejs.org) **22.12 or newer** (the current LTS is fine), once, to
install and build — Electron 44 will not install on older Node. On Windows you can
simply double-click `Start Vibe Edit.cmd`: it checks Node, installs or updates the
runtime when needed, and starts the app.

After pulling a version that changes the Electron version in `package.json`, run
`npm install` again (the launcher does this for you).

```
npm install
npm start
```

### Building installers

```
npm run dist          # installer for the OS you're on
npm run dist:win      # Windows .exe installer + portable .exe
npm run dist:mac      # macOS .dmg   (must be run on a Mac)
npm run dist:linux    # Linux AppImage + .deb
```

Output lands in `dist/`. The installed app launches like any other program —
no Node, no terminal, no browser on the target machine.

---

## FFmpeg — strongly recommended

Vibe Edit runs without FFmpeg, but a large part of the app stays locked. The
two-minute setup below is worth doing before your first real project.

### Where the files go

Put the binaries in the **`bin/` folder next to `main.js`**:

```
vibe-edit-app/
├── main.js
├── package.json
└── bin/
    ├── ffmpeg.exe      <- Windows       (ffmpeg   on macOS/Linux)
    └── ffprobe.exe     <- Windows       (ffprobe  on macOS/Linux)
```

In a **packaged/installed** build the same `bin` folder sits inside the app's
`resources` directory. Vibe Edit checks both locations at launch, so during
development you can simply drop the files into `bin/` and restart.

On macOS and Linux the files have no `.exe` extension and must be executable:

```
chmod +x bin/ffmpeg bin/ffprobe
```

### Which binaries are used

| Binary | Needed? | What it does here |
|---|---|---|
| **ffmpeg** | **Yes** | All conversion and encoding: importing formats the engine can't open, building editing proxies, and every export — MP4, MOV, MKV, WebM, GIF and the nine audio formats. |
| **ffprobe** | **Yes** | Inspects files before import: codecs, resolution, frame rate, audio and subtitle tracks, and **keyframe spacing**. |
| **ffplay** | **No** | Not used at all. Don't bother copying it. |

> **Please include ffprobe, not just ffmpeg.** An earlier version of this note
> said ffprobe was optional; that was wrong. Vibe Edit uses it to decide whether
> a clip needs an editing proxy. Without it those checks fail and awkward files
> are loaded raw — which shows up as sluggish scrubbing and stuttery exports.
> Both files come in the same download, so there is nothing extra to fetch.

### Getting the binaries

Official builds: **https://ffmpeg.org/download.html**

- **Windows** — the gyan.dev or BtbN "essentials"/"full" builds. Unzip and take
  `ffmpeg.exe` and `ffprobe.exe` from the `bin` folder inside.
- **macOS** — `brew install ffmpeg`, then copy the binaries:
  `cp "$(which ffmpeg)" bin/ && cp "$(which ffprobe)" bin/`
- **Linux** — your package manager (`apt install ffmpeg`), then copy them the
  same way.

Any reasonably recent build works; version 6.0 or newer is recommended.

### Checking it worked

Restart the app and open the Export dialog. With FFmpeg present you will see
MP4, MOV, MKV and the audio-only formats. Without it the list falls back to
WebM only, and importing an unusual file reports that it couldn't be decoded.

### What FFmpeg unlocks

**Importing**

- Formats the engine can't open natively — HEVC/H.265 (including iPhone and
  10-bit), ProRes, MKV, AVI, WMV, FLV, MPEG-2, VC-1 and more
- Audio codecs browsers won't play — DTS, AC-3, E-AC-3, TrueHD, WMA
- Choosing which audio track or subtitle to bring in from multi-track files
- Editing proxies: smooth scrubbing on 4K, and on files whose keyframes are
  spaced too far apart to seek cleanly
- Importing only a portion of a long recording instead of the whole thing

**Exporting**

- MP4 (H.264 / H.265), MOV (H.264 / ProRes 422), MKV, WebM, animated GIF
- Audio-only in nine formats, from MP3 to 24-bit FLAC
- Container-only export: remux with zero re-encoding when the timeline allows it
- Hardware encoding where your machine supports it (NVENC, QuickSync, AMF)
- Full-quality export, which goes back to your original files rather than the
  editing proxies

**Without FFmpeg** you can still import anything the engine plays natively
(most H.264 MP4, WebM, MP3, WAV, AAC, OGG, PNG, JPG, GIF, WebP), edit freely,
and export to WebM.

---

## Other things worth knowing

- **AI tools** (transcript editing, captions, filler/pause removal, auto-reframe)
  download small models on first use, then work offline. FFmpeg makes **scene
  detection** check every frame; without it, scenes are found by sampling.
- **Projects** save as small `.vibe` files that reference your media rather than
  copying it, so keep your footage where it is. Projects saved under the app's
  previous name (`.cutroom`) still open.
- **Nothing is uploaded.** All rendering, analysis and encoding happen locally.

---

## Project layout

```
main.js          Electron main process — window, dialogs, menus, FFmpeg
preload.js       The bridge between the editor and the main process
app/index.html   The entire editor — UI, engine, exporter
bin/             Where you put ffmpeg and ffprobe
package.json     Scripts and packaging configuration
```

---

## Troubleshooting

**"Couldn't decode &lt;file&gt;"** — usually FFmpeg is missing or in the wrong
folder. Check that `bin/ffmpeg.exe` sits beside `main.js` and restart. If the
message names a specific error instead, that text is the actual cause.

**Scrubbing is sluggish, or an export stutters** — normally a sign that
`ffprobe` is absent, so clips that need an editing proxy never get one. Add it
to `bin/`, restart, and **re-import** the affected clips: the proxy decision is
made at import time.

**An export sits on "preparing" for a long time** — clips in a format the engine
can't open directly need a temporary working file first. It covers only the part
of the recording your timeline uses, shows progress, and can be switched to the
fast proxy path or cancelled at any point.

**Press `?` inside the app** for the full guide to every tool and feature.
