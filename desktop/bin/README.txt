PUT FFMPEG HERE
===============

Drop these two files into this folder, then restart Vibe Edit:

    ffmpeg.exe      and      ffprobe.exe          (Windows)
    ffmpeg          and      ffprobe              (macOS / Linux)

On macOS and Linux make them executable:  chmod +x ffmpeg ffprobe

Official downloads:  https://ffmpeg.org/download.html
On Windows, use the gyan.dev or BtbN builds and take both files from the
"bin" folder inside the archive. Version 6.0 or newer is recommended.


WHICH FILES ARE NEEDED
----------------------

  ffmpeg    REQUIRED.  Does all converting and encoding: importing formats
                       the engine can't open, building editing proxies, and
                       every export.

  ffprobe   REQUIRED.  Inspects files before import: codecs, resolution,
                       frame rate, audio and subtitle tracks, and keyframe
                       spacing.

  ffplay    NOT USED.  Vibe Edit never calls it. No need to copy it.

Please include ffprobe, not just ffmpeg. An older version of this note said
ffprobe was optional, which was wrong. Vibe Edit uses it to decide whether a
clip needs an editing proxy; without it those checks fail and awkward files
get loaded raw, which shows up as sluggish scrubbing and stuttery exports.
Both files come in the same download, so there is nothing extra to fetch.


WHAT THIS UNLOCKS
-----------------

Importing
  * Formats the engine can't open on its own: HEVC/H.265 (including iPhone
    and 10-bit), ProRes, MKV, AVI, WMV, FLV, MPEG-2, VC-1 and more
  * Audio codecs browsers won't play: DTS, AC-3, E-AC-3, TrueHD, WMA
  * Choosing which audio track or subtitle to bring in from a multi-track file
  * Editing proxies, so 4K and sparse-keyframe footage scrubs smoothly
  * Importing only a portion of a long recording

Exporting
  * MP4 (H.264 / H.265), MOV (H.264 / ProRes 422), MKV, WebM, animated GIF
  * Audio-only in nine formats, from MP3 to 24-bit FLAC
  * Container-only export: remux with zero re-encoding, when the timeline allows
  * Hardware encoding where supported (NVENC, QuickSync, AMF)
  * Full-quality export, which reads your original files rather than the proxies

Without FFmpeg you can still import whatever the engine plays natively (most
H.264 MP4, WebM, MP3, WAV, AAC, OGG, PNG, JPG, GIF, WebP), edit freely, and
export to WebM.


DID IT WORK?
------------

Restart the app and open Export. With FFmpeg present you will see MP4, MOV,
MKV and the audio-only formats. Without it, only WebM is offered.

Note: auto-captions download a small speech model on first use and then work
offline. FFmpeg is not required for captions.
