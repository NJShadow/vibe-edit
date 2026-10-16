const { app, BrowserWindow, dialog, Menu, shell, ipcMain } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
// fileUrlToPath + buildAudioFilter live in audio-filter.js (pure; tested against real FFmpeg)
const { buildAudioFilter, fileUrlToPath } = require('./audio-filter');

/* ---------- FFmpeg helpers ---------- */
function ffPath(name) {
  const exe = process.platform === 'win32' ? name + '.exe' : name;
  const candidates = [
    path.join(process.resourcesPath || '', 'bin', exe), // packaged app
    path.join(__dirname, 'bin', exe),                   // running from source
  ];
  for (const p of candidates) { try { if (fs.existsSync(p)) return p; } catch (e) {} }
  return null;
}
// Every long-running FFmpeg child (encodes, proxies, scene scans): stopped on
// quit, so none keeps writing (or holding a temp file open) after the app exits.
const liveKids = new Set();
function trackKid(p) { liveKids.add(p); const off = () => liveKids.delete(p); p.on('close', off); p.on('error', off); return p; }
function runFF(ff, args, onProgress, onSpawn) {
  return new Promise(res => {
    const p = trackKid(spawn(ff, args, { windowsHide: true }));
    if (onSpawn) { try { onSpawn(p); } catch (_) {} }
    let err = '';
    p.stderr.on('data', d => {
      const s = d.toString();
      err += s; if (err.length > 8000) err = err.slice(-4000);
      if (onProgress) {
        // ffmpeg prints "time=HH:MM:SS.cc" repeatedly while encoding
        const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(s);
        if (m) onProgress((+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]));
      }
    });
    p.on('close', c => res({ ok: c === 0, error: err.slice(-500), code: c }));
    p.on('error', e => res({ ok: false, error: String(e) }));
  });
}
// The currently-running export encode child (so it can be cancelled from the UI).
let activeEncodeProc = null;
// Where that encode is writing (the user's chosen file) — so a quit mid-export
// can remove the half-written output, as Cancel does.
let activeEncodeDest = null;
// Export cancels are per JOB: the renderer sends its job id with the encode and
// with Cancel. (A single global flag was reset by the next encode AFTER its
// save dialog — so a Cancel pressed while the audio was still mixing was lost.)
let activeEncodeJob = null;
const cancelledEncodes = new Set();
// Temp files this session created (proxies, intermediates): removed on quit.
const sessionTemps = new Set();
const OUR_TEMP = /^vibe-(proxy|hq|master|audio)-\d+\.(mp4|webm|wav)$/;
// A fresh temp path that matches OUR_TEMP. Date.now() alone collided when two
// imports (or an import and an export) started in the same millisecond — both
// FFmpeg runs then wrote the SAME file. A per-session counter keeps names unique.
let tempSeq = 0;
function tempPath(kind, ext) {
  tempSeq = (tempSeq + 1) % 1000;
  return path.join(os.tmpdir(), `vibe-${kind}-${Date.now()}${String(tempSeq).padStart(3, '0')}.${ext}`);
}
// Import conversions run per-file and several can be in flight at once, so they
// are tracked BY JOB rather than with a single global like the export above.
const activeProxies = new Map();   // jobId -> child process
const cancelledProxies = new Set(); // jobIds the user abandoned
// Probe a media file's duration (seconds) so conversion progress can be a %.
function ffDuration(input) {
  return new Promise(res => {
    const fp = ffPath('ffprobe');
    if (fp) {
      const p = spawn(fp, ['-v', 'error', '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1', input], { windowsHide: true });
      let out = '';
      p.stdout.on('data', d => out += d);
      p.on('close', () => { const v = parseFloat(out.trim()); res(isFinite(v) ? v : 0); });
      p.on('error', () => res(0));
    } else {
      // no ffprobe: parse "Duration: HH:MM:SS.cc" from ffmpeg -i stderr
      const ff = ffPath('ffmpeg'); if (!ff) return res(0);
      const p = spawn(ff, ['-i', input], { windowsHide: true });
      let err = '';
      p.stderr.on('data', d => err += d);
      p.on('close', () => { const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(err);
        res(m ? (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]) : 0); });
      p.on('error', () => res(0));
    }
  });
}

ipcMain.handle('app:version', () => app.getVersion());

/* ---------- Scene analysis (v4.6.1) ----------
   FFmpeg's own scene score was MEASURED unable to separate cuts from motion
   across real footage (cuts as low as 0.18 in a letterboxed video, camera
   moves as high as 0.33 in another). Instead every frame is decoded at 64x36
   and scored here with the editor's metric: pixel change x color-histogram
   change against the last DISTINCT frame (duplicated frames in converted
   footage otherwise fake spikes), over the picture area only (letterbox bars
   are found first from keyframes). The editor turns these scores into cuts by
   prominence over the neighboring frames, so its sensitivity slider stays live.
   Times are in the FILE's timeline (start + frame time). */
const activeScenes = new Map();   // jobId -> child process
const cancelledScenes = new Set(); // jobIds cancelled (checked between the two passes)
const SW = 64, SH = 36, SN = SW * SH;
function sceneHist(buf, off, mask) {
  const h = new Float64Array(64); let n = 0;
  for (let i = 0; i < SN; i++) { if (mask && !mask[i]) continue; const o = off + i * 3;
    h[(buf[o] >> 6) * 16 + (buf[o + 1] >> 6) * 4 + (buf[o + 2] >> 6)]++; n++; }
  for (let k = 0; k < 64; k++) h[k] /= Math.max(1, n);
  return h;
}
function sceneDiff(a, ao, b, bo, ha, hb, mask) {
  let s = 0, n = 0;
  for (let i = 0; i < SN; i++) { if (mask && !mask[i]) continue; const x = ao + i * 3, y = bo + i * 3;
    s += Math.abs(a[x] - b[y]) + Math.abs(a[x + 1] - b[y + 1]) + Math.abs(a[x + 2] - b[y + 2]); n += 3; }
  const pix = s / Math.max(1, n) / 255;
  let hd = 0; for (let k = 0; k < 64; k++) hd += Math.abs(ha[k] - hb[k]);
  return { pix, score: Math.sqrt(Math.min(1, 3 * pix) * hd * 0.5) };
}
function spawnFrames(ff, args, onFrame, jobId) {
  return new Promise(res => {
    const p = trackKid(spawn(ff, args, { windowsHide: true }));
    if (jobId) activeScenes.set(jobId, p);
    let pend = Buffer.alloc(0), err = '', times = [];
    p.stdout.on('data', d => {
      pend = pend.length ? Buffer.concat([pend, d]) : d;
      const FB = SN * 3; let o = 0;
      while (pend.length - o >= FB) { onFrame(pend, o); o += FB; }
      pend = pend.subarray(o);
    });
    p.stderr.on('data', d => { const t = d.toString(); err += t; if (err.length > 20000) err = err.slice(-4000);
      const re = /pts_time:\s*(-?[\d.]+)/g; let m; while ((m = re.exec(t))) times.push(parseFloat(m[1])); });
    p.on('close', code => { if (jobId) activeScenes.delete(jobId); res({ code, err, times }); });
    p.on('error', e => res({ code: -1, err: String(e), times }));
  });
}
ipcMain.handle('ffmpeg:scenes', async (e, o) => {
  const ff = ffPath('ffmpeg');
  if (!ff) return { ok: false, error: 'FFmpeg not found' };
  if (!o || !o.input || !fs.existsSync(o.input)) return { ok: false, error: 'File not found: ' + (o && o.input) };
  const start = Math.max(0, +o.start || 0), end = +o.end > start ? +o.end : 0;
  const win = []; if (start > 0) win.push('-ss', String(start)); if (end) win.push('-t', String(end - start));
  const vf = `scale=${SW}:${SH}:flags=area,format=rgb24`;
  // 1) picture area: pixels that are ever brighter than near-black on the keyframes
  const maxv = new Uint8Array(SN); let kf = 0;
  await spawnFrames(ff, ['-hide_banner', '-nostats', '-skip_frame', 'nokey', ...win, '-i', o.input, '-map', '0:v:0', '-an', '-sn', '-dn',
    '-vf', vf, '-fps_mode', 'passthrough', '-f', 'rawvideo', '-'], (buf, off) => {
      if (o.jobId && cancelledScenes.has(o.jobId)) return;
      kf++; for (let i = 0; i < SN; i++) { const q = off + i * 3; const v = Math.max(buf[q], buf[q + 1], buf[q + 2]); if (v > maxv[i]) maxv[i] = v; } }, o.jobId);
  if (o.jobId && cancelledScenes.has(o.jobId)) { cancelledScenes.delete(o.jobId); return { ok: false, cancelled: true, error: 'cancelled' }; }
  let mask = new Uint8Array(SN), on = 0; for (let i = 0; i < SN; i++) { mask[i] = maxv[i] > 24 ? 1 : 0; on += mask[i]; }
  if (!kf || on < SN * 0.2) mask = null;
  // 2) every frame, scored against the last distinct frame
  const scores = []; let prev = null, prevH = null, idx = 0, lastSent = 0;
  const r = await spawnFrames(ff, ['-hide_banner', '-nostats', ...win, '-i', o.input, '-map', '0:v:0', '-an', '-sn', '-dn',
    '-vf', vf + ',showinfo', '-fps_mode', 'passthrough', '-f', 'rawvideo', '-'], (buf, off) => {
      const h = sceneHist(buf, off, mask); let sc = 0;
      if (prev) { const d = sceneDiff(buf, off, prev, 0, h, prevH, mask); if (d.pix < 0.004) { scores.push(null); idx++; return; } sc = d.score; }
      prev = Buffer.from(buf.subarray(off, off + SN * 3)); prevH = h;
      scores.push(sc); idx++;
      const now = Date.now();
      if (now - lastSent > 200) { lastSent = now; try { e.sender.send('ffmpeg:scenes-progress', { jobId: o.jobId, frames: idx }); } catch (_) {} }
    }, o.jobId);
  const wasCancelled = !!(o.jobId && cancelledScenes.delete(o.jobId));
  if (wasCancelled) return { ok: false, cancelled: true, error: 'cancelled' };
  if (!scores.length) return { ok: false, error: (r.err || '').slice(-400) || 'no frames decoded' };
  const t0 = r.times.length ? r.times[0] : 0;
  const out = []; for (let i = 0; i < scores.length; i++) {
    if (scores[i] == null) continue;
    const t = i < r.times.length ? r.times[i] - t0 : i / 30;
    out.push([+(start + t).toFixed(4), +scores[i].toFixed(5)]);
  }
  return { ok: true, metric: 'v461', scores: out, letterbox: !!mask && on < SN, cancelled: r.code !== 0 };
});
ipcMain.handle('ffmpeg:cancelScenes', async (_e, jobId) => {
  if (jobId) { cancelledScenes.add(jobId); setTimeout(() => cancelledScenes.delete(jobId), 60000); }
  const p = activeScenes.get(jobId); if (p) { try { p.kill(); } catch (_) {} activeScenes.delete(jobId); }
  return true;
});
ipcMain.handle('ffmpeg:has', () => !!ffPath('ffmpeg'));
ipcMain.handle('ffmpeg:list-encoders', async () => {
  const ff = ffPath('ffmpeg'); if (!ff) return { nvenc: false, qsv: false, amf: false };
  try {
    const out = await new Promise((res) => {
      const p = require('child_process').spawn(ff, ['-hide_banner', '-encoders']);
      let s = ''; p.stdout.on('data', d => s += d); p.stderr.on('data', d => s += d);
      p.on('close', () => res(s)); p.on('error', () => res(''));
      setTimeout(() => { try { p.kill(); } catch (_) {} res(s); }, 6000);
    });
    return { nvenc: /h264_nvenc/.test(out), qsv: /h264_qsv/.test(out), amf: /h264_amf/.test(out) };
  } catch (e) { return { nvenc: false, qsv: false, amf: false }; }
});
async function probeKeyLead(inPath, ss) {
  // last video keyframe at/just before ss — stream copy can only start there
  const fp = ffPath('ffprobe'); if (!fp) return null;
  try {
    const out = await new Promise((res) => {
      const a = ['-v', 'error', '-select_streams', 'v:0', '-skip_frame', 'nokey',
        '-show_entries', 'frame=pts_time', '-of', 'csv=p=0',
        '-read_intervals', Math.max(0, ss - 120).toFixed(3) + '%' + (ss + 0.05).toFixed(3), inPath];
      const p = require('child_process').spawn(fp, a);
      let s = ''; p.stdout.on('data', d => s += d);
      p.on('close', () => res(s)); p.on('error', () => res(''));
      setTimeout(() => { try { p.kill(); } catch (_) {} res(s); }, 15000);
    });
    const ks = out.split(/\s+/).map(parseFloat).filter(v => isFinite(v) && v <= ss + 0.001);
    if (!ks.length) return null;
    return Math.max(0, ss - Math.max(...ks));
  } catch (e) { return null; }
}
ipcMain.handle('ffmpeg:keylead', async (e, o) => {
  if (!o || !o.inPath || !fs.existsSync(o.inPath)) return { lead: null };
  const cds = await probeCodecs(o.inPath);
  return { lead: await probeKeyLead(o.inPath, +o.ss || 0), v: cds.v, a: cds.a,
    mp4ok: (!cds.v || MP4_V.has(cds.v)) && (!cds.a || MP4_A.has(cds.a)) };
});
function buildRemuxArgs(o) {
  // stream copy: -ss BEFORE -i lands on the keyframe at/just before the cut.
  // +genpts: AVI stores no pts; without it the mp4 muxer writes broken timing
  // ("pts has no value" x hundreds -> choppy playback). For MPEG-4 ASP (XviD),
  // packed B-frames are legal in AVI but broken in MP4 -> the lossless
  // mpeg4_unpack_bframes bitstream filter repacks them (still zero re-encode).
  const seek = (o.ss || 0) > 0.005 ? ['-ss', o.ss.toFixed(3)] : []; // no seek for a full-file remux
  return ['-y', '-fflags', '+genpts', ...seek, '-i', o.inPath, '-t', (o.dur || 0).toFixed(3),
    '-c', 'copy', ...(o.bsf ? ['-bsf:v', 'mpeg4_unpack_bframes'] : []),
    ...(o.bsfA ? ['-bsf:a', 'aac_adtstoasc'] : []), // ADTS AAC (TS/FLV sources) is malformed inside MP4 without this
    '-avoid_negative_ts', 'make_zero', ...(o.container === 'mp4' ? ['-movflags', '+faststart'] : []), o.outPath];
}
async function probeCodecs(inPath) {
  const fp = ffPath('ffprobe'); if (!fp) return { v: null, a: null };
  const one = (sel) => new Promise((res) => {
    const p = require('child_process').spawn(fp, ['-v', 'error', '-select_streams', sel,
      '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', inPath]);
    let s = ''; p.stdout.on('data', d => s += d);
    p.on('close', () => res(s.trim().split('\n')[0] || null)); p.on('error', () => res(null));
    setTimeout(() => { try { p.kill(); } catch (_) {} res(null); }, 8000);
  });
  try { return { v: await one('v:0'), a: await one('a:0') }; } catch (e) { return { v: null, a: null }; }
}
// Codecs MP4 can hold with broad player support; anything else remuxes to MKV
// (still lossless) rather than emitting a stuttering/unplayable file — the
// XviD lesson, generalized.
const MP4_V = new Set(['h264', 'hevc', 'mpeg4', 'av1', 'vp9', 'mpeg2video', 'mjpeg']);
const MP4_A = new Set(['aac', 'mp3', 'ac3', 'eac3', 'opus', 'alac']);
ipcMain.handle('ffmpeg:remux', async (e, o) => {
  const win = BrowserWindow.fromWebContents(e.sender); // same per-handler pattern as every other dialog here
  const ff = ffPath('ffmpeg'); if (!ff) return { ok: false, error: 'FFmpeg not found' };
  if (!o || !o.inPath || !fs.existsSync(o.inPath)) return { ok: false, error: 'Source file not found on disk' };
  const ext = o.container === 'mp4' ? 'mp4' : 'mkv';
  let dest = dialog.showSaveDialogSync(win, {
    title: 'Save container-only export',
    defaultPath: (o.suggest || 'export') + '.' + ext,
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }]
  });
  if (!dest) return { ok: false, cancelled: true };
  const lead = await probeKeyLead(o.inPath, +o.ss || 0);
  const cds = await probeCodecs(o.inPath);
  let forcedMkv = null;
  if (o.container === 'mp4') {
    if (cds.v && !MP4_V.has(cds.v)) forcedMkv = 'video codec ' + cds.v;
    else if (cds.a && !MP4_A.has(cds.a)) forcedMkv = 'audio codec ' + cds.a;
    if (forcedMkv && /\.mp4$/i.test(dest)) dest = dest.replace(/\.mp4$/i, '.mkv');
  }
  const container = forcedMkv ? 'mkv' : o.container;
  const r = await runFF(ff, buildRemuxArgs({ ...o, container, outPath: dest,
    bsf: cds.v === 'mpeg4',
    bsfA: container === 'mp4' && cds.a === 'aac' }), () => {}, () => {});
  if (r.ok && fs.existsSync(dest)) { shell.showItemInFolder(dest); return { ok: true, path: dest, leadIn: lead, forcedMkv }; }
  return { ok: false, error: (r && r.err) ? String(r.err).slice(-300) : 'remux failed (the source codec may not fit this container \u2014 try MKV)' };
});

ipcMain.handle('project:save', async (e, json, suggestedName) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const dest = dialog.showSaveDialogSync(win, {
    title: 'Save project',
    defaultPath: (suggestedName || 'project') + '.vibe',
    filters: [{ name: 'Vibe Edit project', extensions: ['vibe'] }],
  });
  if (!dest) return { ok: false, cancelled: true };
  try { fs.writeFileSync(dest, json, 'utf8'); return { ok: true, path: dest }; }
  catch (err) { return { ok: false, error: err.message }; }
});

// Ctrl+S on a project that already has a file: write it in place (no dialog).
ipcMain.handle('project:saveTo', async (_e, json, dest) => {
  if (typeof dest !== 'string' || !/\.(vibe|cutroom)$/i.test(dest) || !path.isAbsolute(dest)) return { ok: false, error: 'not a project path' };
  try { fs.writeFileSync(dest, json, 'utf8'); return { ok: true, path: dest }; }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('project:open', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const picked = dialog.showOpenDialogSync(win, {
    title: 'Open project', properties: ['openFile'],
    // both extensions, so projects saved before the rename still appear
    filters: [{ name: 'Vibe Edit project', extensions: ['vibe', 'cutroom'] }],
  });
  if (!picked || !picked.length) return { ok: false, cancelled: true };
  try { return { ok: true, json: fs.readFileSync(picked[0], 'utf8'), path: picked[0] }; }
  catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('file:statPath', async (_e, p) => {
  try {
    if (typeof p !== 'string' || !fs.existsSync(p)) return { ok: false, missing: true };
    const stat = fs.statSync(p);
    return { ok: true, exists: true, size: stat.size, name: path.basename(p) };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('file:readPath', async (_e, p) => {
  try {
    if (typeof p !== 'string' || !fs.existsSync(p)) return { ok: false, missing: true };
    const stat = fs.statSync(p);
    if (stat.size > 600 * 1024 * 1024) return { ok: false, tooLarge: true, error: 'file too large to read directly' };
    const buf = fs.readFileSync(p);
    return { ok: true, bytes: buf, name: path.basename(p), size: stat.size };
  } catch (err) { return { ok: false, error: err.message }; }
});

// Probe the audio + video codecs so the renderer can decide whether a file
// (e.g. an MKV with DTS audio) needs converting even if its video plays fine.
ipcMain.handle('ffmpeg:probeStreams', async (_e, input) => {
  const fp = ffPath('ffprobe');
  if (!fp || typeof input !== 'string' || !fs.existsSync(input)) return { ok: false };
  return new Promise(res => {
    // Include avg_frame_rate / r_frame_rate so the app can match the project fps
    // to the source (avoids judder from e.g. a 23.976fps film in a 30fps timeline).
    const p = spawn(fp, ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_type,codec_name,avg_frame_rate,r_frame_rate,width,height,nb_frames,duration:format=duration',
      '-of', 'default=noprint_wrappers=1', input], { windowsHide: true });
    const p2 = spawn(fp, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name',
      '-of', 'csv=p=0', input], { windowsHide: true });
    // Keyframe cadence from packet flags over the first ~10s (header-only, no decode).
    // A long gap between keyframes (long GOP) makes frame-accurate seeking unreliable
    // in the browser — the root cause of repeated-frame judder on precise export.
    const p3 = spawn(fp, ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0',
      '-read_intervals', '%+10', input], { windowsHide: true });
    let out = '', out2 = '', out3 = '';
    p.stdout.on('data', d => out += d);
    p2.stdout.on('data', d => out2 += d);
    p3.stdout.on('data', d => out3 += d);
    let done = 0;
    const finish = () => {
      if (++done < 3) return;
      const v = [], a = [];
      out2.trim().split('\n').forEach(line => {
        const [codec, type] = line.split(',').map(s => (s || '').trim());
        if (type === 'video') v.push(codec);
        else if (type === 'audio') a.push(codec);
      });
      // parse fps from the first video stream
      let fps = 0;
      const fields = {};
      out.trim().split('\n').forEach(line => {
        const i = line.indexOf('='); if (i > 0) fields[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      });
      const parseRate = r => { if (!r || r === '0/0') return 0; const m = String(r).split('/');
        const n = +m[0], d = m[1] ? +m[1] : 1; return (d > 0 && n > 0) ? n / d : 0; };
      fps = parseRate(fields.avg_frame_rate);
      // VFR / odd containers can report avg_frame_rate as 0/0. Derive the true average
      // from frame count / duration when available (header-level, no full decode), then
      // fall back to r_frame_rate as a last resort.
      if (!fps) {
        const nf = parseInt(fields.nb_frames) || 0;
        const dur = parseFloat(fields.duration) || 0;
        if (nf > 0 && dur > 0) fps = nf / dur;
      }
      if (!fps) fps = parseRate(fields.r_frame_rate) || 0;
      const width = parseInt(fields.width) || 0, height = parseInt(fields.height) || 0;
      // keyframe interval (seconds) from packet flags
      let gop = 0;
      try {
        const kf = [];
        out3.trim().split('\n').forEach(line => {
          const parts = line.split(','); if (parts.length < 2) return;
          if (String(parts[1]).indexOf('K') >= 0) { const t = parseFloat(parts[0]); if (!isNaN(t)) kf.push(t); }
        });
        kf.sort((a, b) => a - b);
        if (kf.length >= 2) gop = (kf[kf.length - 1] - kf[0]) / (kf.length - 1);
        // Only ONE keyframe in the whole 10-second probe window means keyframes are
        // at least that far apart — the WORST case for seeking. Reporting 0 here
        // read as "unknown" and skipped the proxy, so the files that most needed
        // dense keyframes were the ones that never got them.
        else if (kf.length === 1) gop = 10;
      } catch (_) {}
      res({ ok: true, video: v, audio: a, fps: fps ? Math.round(fps * 1000) / 1000 : 0,
        width, height, gop: Math.round(gop * 1000) / 1000 });
    };
    p.on('close', finish); p.on('error', finish);
    p2.on('close', finish); p2.on('error', finish);
    p3.on('close', finish); p3.on('error', finish);
  });
});

ipcMain.handle('ffmpeg:duration', async (_e, input) => {
  if (typeof input !== 'string' || !fs.existsSync(input)) return { ok: false, duration: 0 };
  const d = await ffDuration(input);
  return { ok: true, duration: d };
});

ipcMain.handle('ffmpeg:streams', async (_e, p) => {
  // audio + subtitle stream inventory so the import chooser can offer them
  const fp = ffPath('ffprobe'); if (!fp || !fs.existsSync(p)) return { audio: [], subs: [] };
  try {
    const out = await new Promise((res) => {
      const pr = require('child_process').spawn(fp, ['-v', 'error', '-show_entries',
        'stream=index,codec_type,codec_name:stream_disposition=default:stream_tags=language,title',
        '-of', 'json', p]);
      let s = ''; pr.stdout.on('data', d => s += d);
      pr.on('close', () => res(s)); pr.on('error', () => res(''));
      setTimeout(() => { try { pr.kill(); } catch (_) {} res(s); }, 10000);
    });
    const st = (JSON.parse(out).streams || []);
    const TEXT_SUBS = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text']);
    // `def` = the track the container flags as default (what a player picks on its
    // own). Choosing THAT track needs no conversion — only a different one does.
    const dflt = x => !!(x.disposition && x.disposition.default);
    const audio = st.filter(x => x.codec_type === 'audio').map((x, i) => ({
      i, codec: x.codec_name, lang: (x.tags && x.tags.language) || '', title: (x.tags && x.tags.title) || '',
      def: dflt(x) }));
    const subs = st.filter(x => x.codec_type === 'subtitle').map((x, i) => ({
      i, codec: x.codec_name, lang: (x.tags && x.tags.language) || '', title: (x.tags && x.tags.title) || '',
      def: dflt(x), burnable: TEXT_SUBS.has(x.codec_name) }));
    return { audio, subs };
  } catch (e2) { return { audio: [], subs: [] }; }
});
function subFilterEscape(p) { // path inside the subtitles= filter argument
  return p.replace(/\\/g, '/').replace(/:/g, '\\\\:').replace(/'/g, "\\\\'");
}
ipcMain.handle('ffmpeg:proxy', async (e, input, jobId, opts) => {
  const ff = ffPath('ffmpeg');
  if (!ff) return { ok: false, error: 'ffmpeg.exe not found in bin/' };
  if (typeof input !== 'string' || !fs.existsSync(input)) return { ok: false, error: 'source file not found' };
  // hq = an export-time intermediate: its own name, so it can be deleted after
  // the export (proxies stay for the session — the renderer reads them).
  const out = tempPath(opts && opts.hq ? 'hq' : 'proxy', 'mp4');
  sessionTemps.add(out);
  const wc = e.sender;
  const fullDur = await ffDuration(input); // seconds; 0 if unknown
  // Optional trim: only convert [start,end]. -ss before -i = fast input seek.
  const hasTrim = opts && (opts.start > 0 || (opts.end && opts.end > 0));
  let start = 0, segLen = fullDur;
  const pre = [], post = [];
  let firstProxyError = null, usedSafeMode = false;
  if (hasTrim) {
    start = Math.max(0, +opts.start || 0);
    const end = (opts.end && opts.end > start) ? Math.min(opts.end, fullDur || opts.end) : fullDur;
    segLen = (end > start) ? (end - start) : fullDur;
    pre.push('-ss', String(start));            // accurate-ish fast seek on input
    if (segLen > 0) post.push('-t', String(segLen)); // duration to copy
  }
  const total = segLen || fullDur; // progress is measured against the converted span
  const send = (pct, phase) => { try { wc.send('ffmpeg:proxy-progress', { jobId, pct, phase }); } catch (_) {} };
  send(0, 'convert');
  // If only the AUDIO is unplayable (e.g. DTS) and the video is browser-friendly,
  // copy the video stream untouched and just transcode audio — far faster, no
  // quality loss, and works even on large files.
  const audioOnly = opts && opts.audioOnly;
  // Pure audio file (music etc.) — there is no timeline video to keep. Many such files
  // (esp. .m4a) embed cover art as a still "video" stream; we drop it with -vn so it
  // can't derail the encode or produce a bogus 1-frame video.
  const pureAudio = opts && opts.pureAudio;
  // Dense keyframes (~every 6 frames) make frame-accurate seeking reliable. Without
  // this, copied/long-GOP video causes the precise renderer to repeat frames (judder).
  const KEY = ['-g', '6', '-keyint_min', '1', '-sc_threshold', '0', '-bf', '0'];
  // hq: the EXPORT-time intermediate — no downscale and near-transparent quality,
  // so exports are not limited by proxy loss. DECLARED HERE, above every use:
  // reading it from the maxDim line below while it was still declared further
  // down threw "Cannot access 'hq' before initialization" and killed the handler
  // before any conversion could start, which broke EVERY import that needed one.
  const hq = !!(opts && opts.hq);
  // Optional downscale for very large (4K+) sources so the proxy stays smooth to
  // seek/decode. Caps the longest side to maxDim, keeps aspect, and forces even
  // dimensions (yuv420p requirement). When downscaling we must re-encode video, so
  // ignore audioOnly's copy shortcut in that case.
  const maxDim = (!hq && opts && opts.maxDim) ? Math.max(640, opts.maxDim | 0) : 0;
  const scaleVf = maxDim
    ? [`scale='if(gte(iw,ih),min(${maxDim},iw),-2)':'if(gte(iw,ih),-2,min(${maxDim},ih))':flags=lanczos`]
    : null;
  let vArgs = pureAudio
    ? ['-vn']
    : hq
    ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14', '-pix_fmt', 'yuv420p',
       '-g', '6', '-keyint_min', '1', '-sc_threshold', '0', '-bf', '0']
    : audioOnly
    ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', ...KEY]
    : ['-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', ...KEY];
  // Chosen streams (import chooser): -map picks the audio track; a burnable text
  // subtitle track is BURNED into the proxy picture, so it flows through playback
  // and every export path with no further plumbing.
  const aTrack = (opts && Number.isInteger(opts.audioTrack)) ? opts.audioTrack : null;
  const sTrack = (opts && Number.isInteger(opts.subTrack)) ? opts.subTrack : null;
  const mapArgs = (aTrack != null)
    ? (pureAudio ? ['-map', '0:a:' + aTrack + '?'] : ['-map', '0:v:0?', '-map', '0:a:' + aTrack + '?'])
    : [];
  const vfParts = [];
  if (scaleVf && !pureAudio) vfParts.push(scaleVf[0]);
  if (sTrack != null && !pureAudio)
    vfParts.push("subtitles='" + subFilterEscape(input) + "':si=" + sTrack);
  const vf = vfParts.length ? ['-vf', vfParts.join(',')] : [];
  // Always resample to 48 kHz: high-rate sources (96/192 kHz, common in lossless music)
  // encode fine but won't decode in the browser's media pipeline. 48 kHz is universal and
  // is the rate everything exports at anyway, so there's no audible loss.
  const aArgs = ['-c:a', 'aac', '-b:a', pureAudio ? '256k' : '192k', '-ac', '2', '-ar', '48000'];
  let r = await runFF(ff, ['-y', ...pre, '-i', input, ...post, ...mapArgs,
    ...vf, ...vArgs, ...aArgs, '-movflags', '+faststart', out],
    sec => { if (total > 0) send(Math.min(99, Math.round(sec / total * 100)), 'convert'); },
    proc => { if (jobId) activeProxies.set(jobId, proc); });
  // SAFE MODE: if the tuned command fails (odd timestamps, an encoder option a
  // particular build dislikes, a stream that needs regenerating), try again with
  // the fussy parts removed rather than reporting a dead end. Slightly larger
  // proxy, but an import that works beats one that doesn't.
  if (!r.ok && !(jobId && cancelledProxies.has(jobId))) {
    firstProxyError = r.error || 'conversion failed';
    try { fs.unlinkSync(out); } catch (e5) {}
    const safeV = pureAudio ? ['-vn']
      : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
         '-g', '6', '-keyint_min', '1', '-sc_threshold', '0', '-bf', '0'];
    r = await runFF(ff, ['-y', '-fflags', '+genpts', '-err_detect', 'ignore_err',
      ...pre, '-i', input, ...post, ...mapArgs, ...vf, ...safeV, ...aArgs, out],
      sec => { if (total > 0) send(Math.min(99, Math.round(sec / total * 100)), 'convert'); },
      proc => { if (jobId) activeProxies.set(jobId, proc); });
    if (r.ok) usedSafeMode = true;
  }
  if (jobId) activeProxies.delete(jobId);
  // Cancelled by the user: bin the half-written file and say so explicitly, so
  // the renderer can offer a retry instead of reporting a failure.
  if (jobId && cancelledProxies.has(jobId)) {
    cancelledProxies.delete(jobId);
    try { fs.unlinkSync(out); } catch (e2) {}
    return { ok: false, cancelled: true };
  }
  if (r.ok && fs.existsSync(out)) {
    send(100, 'convert');
    return { ok: true, path: out, trimmed: hasTrim, start, duration: segLen, safeMode: usedSafeMode };
  }
  try { fs.unlinkSync(out); } catch (e2) {}
  // Report BOTH attempts: the tuned command's failure is usually the informative
  // one, and a generic "couldn't decode" hides it completely.
  const detail = [firstProxyError, r.error].filter(Boolean).join(' | ');
  return { ok: false, error: detail || 'conversion failed' };
});

// Delete one of OUR temp files (export intermediates) — nothing else.
ipcMain.handle('file:deleteTemp', async (_e, p) => {
  try {
    if (typeof p !== 'string') return false;
    const norm = path.normalize(p);
    if (path.dirname(norm) !== path.normalize(os.tmpdir()) || !OUR_TEMP.test(path.basename(norm))) return false;
    fs.unlinkSync(norm); sessionTemps.delete(norm); return true;
  } catch (_) { return false; }
});
ipcMain.handle('ffmpeg:readproxy', async (_e, p) => {
  try {
    if (typeof p !== 'string') return null;
    const norm = path.normalize(p);
    if (!norm.startsWith(os.tmpdir()) || !path.basename(norm).startsWith('vibe-proxy-')) return null;
    return fs.readFileSync(norm); // arrives in the renderer as a Uint8Array
  } catch (err) { return null; }
});

// Build FFmpeg output args for a given target spec. The input is always the
// frame-accurate VP9/Opus master Vibe Edit hands over.
// v3.43: user-selectable compression (CRF vs bitrate), x264 preset, and GPU
// hardware encoders (NVENC/QSV/AMF) with per-encoder quality-knob mapping.
function vArgs(codec, adv, vb, vbMax, vbBuf) {
  const enc = (adv && adv.encoder) || 'cpu';
  const preset = (adv && adv.preset) || 'medium';
  const crf = (adv && adv.comp === 'crf') ? Math.max(10, Math.min(40, adv.crf || 18)) : null;
  if (enc === 'nvenc') {
    const c = codec === 'hevc' ? 'hevc_nvenc' : 'h264_nvenc';
    return ['-c:v', c, '-preset', 'p5',
      ...(crf != null ? ['-rc', 'vbr', '-cq', String(crf), '-b:v', '0']
                      : ['-b:v', vb, '-maxrate', vbMax, '-bufsize', vbBuf])];
  }
  if (enc === 'qsv') {
    const c = codec === 'hevc' ? 'hevc_qsv' : 'h264_qsv';
    return ['-c:v', c,
      ...(crf != null ? ['-global_quality', String(crf)]
                      : ['-b:v', vb, '-maxrate', vbMax, '-bufsize', vbBuf])];
  }
  if (enc === 'amf') {
    const c = codec === 'hevc' ? 'hevc_amf' : 'h264_amf';
    return ['-c:v', c,
      ...(crf != null ? ['-rc', 'cqp', '-qp_i', String(crf), '-qp_p', String(crf)]
                      : ['-b:v', vb])];
  }
  const c = codec === 'hevc' ? 'libx265' : 'libx264';
  return ['-c:v', c, '-preset', preset,
    ...((adv && adv.threads > 0) ? ['-threads', String(adv.threads)] : []),
    ...(crf != null ? ['-crf', String(crf)]
                    : ['-b:v', vb, '-maxrate', vbMax, '-bufsize', vbBuf])];
}
function ffArgsFor(target, mbps, fps, extra) {
  // every sound-only target goes through the one audio builder
  if (AUDIO_TARGETS.has(target))
    return audioExportArgs(target, (extra && extra.audio) || { kbps: (extra && extra.audioKbps) || 0, flacLevel: extra && extra.flacLevel });
  const gif = extra && extra.gif;
  const aKbps = Math.max(32, Math.min(320, (extra && extra.audioKbps) || 0));
  const flacLevel = Math.max(0, Math.min(12, (extra && extra.flacLevel != null) ? extra.flacLevel : 5));
  const adv = (extra && extra.adv) || null;
  const vb = String(Math.round(mbps * 1e6));
  const vbMax = String(Math.round(mbps * 1.45e6));
  const vbBuf = String(Math.round(mbps * 2e6));
  switch (target) {
    case 'mp4-h264':
      return [...vArgs('h264', adv, vb, vbMax, vbBuf), '-r', String(fps), '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'];
    case 'mp4-h265':
      // -brand mp42: FFmpeg's mp4 muxer otherwise writes major_brand=isom with
      // compatible_brands isom/iso2/mp41 — MP4 version 1, a spec that predates
      // HEVC entirely. Players mostly ignore brands, but strict upload validators
      // and some platforms read them and reject or refuse to play the result.
      return [...vArgs('hevc', adv, vb, vbMax, vbBuf), '-tag:v', 'hvc1', '-brand', 'mp42', '-r', String(fps), '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'];
    case 'mov-h264':
      return [...vArgs('h264', adv, vb, vbMax, vbBuf), '-r', String(fps), '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '192k', '-f', 'mov'];
    case 'mov-prores':
      // ProRes 422 (profile 2); rgb-friendly yuv422p10le, PCM audio
      return ['-c:v', 'prores_ks', '-profile:v', '2', '-pix_fmt', 'yuv422p10le',
        '-r', String(fps), '-c:a', 'pcm_s16le', '-f', 'mov'];
    case 'webm-vp9':
      return ['-c:v', 'libvpx-vp9', '-b:v', vb, '-r', String(fps), '-pix_fmt', 'yuv420p',
        '-row-mt', '1', '-c:a', 'libopus', '-b:a', '192k'];
    case 'mkv-h264':
      return [...vArgs('h264', adv, vb, vbMax, vbBuf), '-r', String(fps), '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '192k', '-f', 'matroska'];
    case 'gif': {
      // GIF is a 256-colour palette format — there is no bitrate. Size/quality are
      // governed by resolution, fps, palette size and dithering. Build an optimized
      // palette from the whole clip, then apply it.
      const colors = Math.max(2, Math.min(256, (gif && gif.colors) || 256));
      const ditherMap = {
        smooth: 'dither=sierra2_4a',            // smoothest gradients, largest file
        balanced: 'dither=bayer:bayer_scale=5', // patterned, good balance (default)
        none: 'dither=none',                    // flat, smallest file
      };
      const dither = ditherMap[(gif && gif.dither)] || ditherMap.balanced;
      const gfps = Math.max(2, Math.min(50, fps));
      return ['-vf',
        `fps=${gfps},split[s0][s1];[s0]palettegen=max_colors=${colors}:stats_mode=diff[p];[s1][p]paletteuse=${dither}`,
        '-an'];
    }
    case 'mp3': case 'm4a': case 'opus': case 'ogg': case 'ac3': case 'alac': case 'aiff':
      // audio-only targets share one builder (see audioExportArgs)
      return audioExportArgs(target, (extra && extra.audio) || { kbps: aKbps });
    case 'lossless-mkv':
      // The master already carries lossless VP9 frames (captured at quantizer 0), so
      // COPY them with no second encode — bit-for-bit lossless — and pair with lossless
      // FLAC audio in an MKV container. Fast, and truly lossless.
      return ['-c:v', 'copy', '-c:a', 'flac', '-compression_level', String(flacLevel), '-f', 'matroska'];
    case 'flac':
      return audioExportArgs('flac', (extra && extra.audio) || { flacLevel, depth: 24 });
    case 'wav':
      return audioExportArgs('wav', (extra && extra.audio) || { depth: 24 });
    default:
      return ['-c:v', 'libx264', '-preset', 'medium', '-b:v', vb, '-r', String(fps),
        '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'];
  }
}
// ---------- Audio export matrix (v3.56) ----------
// One builder for every audio-only export. Returns the COMPLETE output tail
// (filters + codec + rate + channels), so callers must not append their own -ar.
const AUDIO_TARGETS = new Set(['mp3', 'm4a', 'opus', 'ogg', 'ac3', 'flac', 'alac', 'wav', 'aiff']);
// Highest sample rate each codec actually supports — asking for more than this
// makes FFmpeg fail or silently pick something else, so we clamp and report it.
const AUDIO_MAX_RATE = { mp3: 48000, ac3: 48000, opus: 48000, m4a: 96000, ogg: 96000,
  flac: 96000, alac: 96000, wav: 96000, aiff: 96000 };
function audioExportArgs(target, a) {
  a = a || {};
  const kbps = Math.max(32, Math.min(640, +a.kbps || 192));
  const want = [44100, 48000, 96000].includes(+a.rate) ? +a.rate : 48000;
  const rate = target === 'opus' ? 48000 : Math.min(want, AUDIO_MAX_RATE[target] || 48000);
  const ch = (+a.chan === 1) ? 1 : 2;
  const depth = [16, 24, 32].includes(+a.depth) ? +a.depth : 24;
  const filters = [];
  if (a.norm) {
    filters.push('loudnorm=I=' + a.norm + ':TP=-1.0:LRA=11');
    // loudnorm emits 192 kHz internally — always resample back to the target rate
    filters.push('aresample=' + rate);
  }
  const head = ['-vn', ...(filters.length ? ['-af', filters.join(',')] : []),
    '-ar', String(rate), '-ac', String(ch)];
  switch (target) {
    case 'mp3':  return [...head, '-c:a', 'libmp3lame',
      ...(a.vbr ? ['-q:a', String(a.vbrQ == null ? 2 : a.vbrQ)] : ['-b:a', kbps + 'k'])];
    case 'm4a':  return [...head, '-c:a', 'aac', '-b:a', kbps + 'k', '-movflags', '+faststart'];
    case 'opus': return [...head, '-c:a', 'libopus', '-b:a', kbps + 'k', '-vbr', 'on'];
    case 'ogg':  return [...head, '-c:a', 'libvorbis',
      ...(a.vbr ? ['-q:a', String(a.vbrQ == null ? 6 : a.vbrQ)] : ['-b:a', kbps + 'k'])];
    case 'ac3':  return [...head, '-c:a', 'ac3', '-b:a', kbps + 'k'];
    case 'flac': return [...head, '-c:a', 'flac',
      '-compression_level', String(a.flacLevel == null ? 5 : a.flacLevel),
      '-sample_fmt', depth >= 24 ? 's32' : 's16',
      ...(depth >= 24 ? ['-bits_per_raw_sample', '24'] : [])];
    case 'alac': return [...head, '-c:a', 'alac', '-sample_fmt', depth >= 24 ? 's32p' : 's16p'];
    case 'aiff': return [...head, '-c:a', depth >= 24 ? 'pcm_s24be' : 'pcm_s16be'];
    case 'wav':
    default:     return [...head, '-c:a',
      depth === 32 ? 'pcm_f32le' : (depth === 24 ? 'pcm_s24le' : 'pcm_s16le')];
  }
}
const TARGET_EXT = {
  'mp4-h264': 'mp4', 'mp4-h265': 'mp4', 'mov-h264': 'mov', 'mov-prores': 'mov',
  'webm-vp9': 'webm', 'mkv-h264': 'mkv', 'lossless-mkv': 'mkv', 'gif': 'gif', 'mp3': 'mp3', 'm4a': 'm4a', 'flac': 'flac', 'wav': 'wav',
  'opus': 'opus', 'ogg': 'ogg', 'ac3': 'ac3', 'alac': 'm4a', 'aiff': 'aiff',
};
const TARGET_FILTER = {
  mp4: { name: 'MP4 video', extensions: ['mp4'] },
  mov: { name: 'QuickTime movie', extensions: ['mov'] },
  webm: { name: 'WebM video', extensions: ['webm'] },
  mkv: { name: 'Matroska video', extensions: ['mkv'] },
  gif: { name: 'Animated GIF', extensions: ['gif'] },
  mp3: { name: 'MP3 audio', extensions: ['mp3'] },
  m4a: { name: 'M4A audio', extensions: ['m4a'] },
  flac: { name: 'FLAC audio', extensions: ['flac'] },
  wav: { name: 'WAV audio', extensions: ['wav'] },
  opus: { name: 'Opus audio', extensions: ['opus'] },
  ogg: { name: 'Ogg Vorbis audio', extensions: ['ogg'] },
  ac3: { name: 'Dolby Digital audio', extensions: ['ac3'] },
  aiff: { name: 'AIFF audio', extensions: ['aiff'] },
};

// Build FFmpeg -i inputs and an audio filtergraph from an audioSpec produced by
// the renderer. Returns {inputs:[...args], filter:'...', outLabel:'[aout]'} or null.
// A clip can be perfectly audible in the app and still have NO audio stream on
// disk (a video-only WebM/MP4, a camera file whose audio track was stripped).
// Referencing [N:a] for such an input makes FFmpeg reject the whole graph with
// "matches no streams" AFTER the frames have already been rendered — so these
// inputs are pruned before the graph is written.
const _audioStreamCache = new Map();
const _audioChannelCache = new Map();   // path -> [channels of each audio stream] (0 = unknown)
async function fileHasAudioStream(p) {
  if (_audioStreamCache.has(p)) return _audioStreamCache.get(p);
  const fp = ffPath('ffprobe');
  if (!fp) { _audioStreamCache.set(p, true); return true; }   // can't tell: assume yes
  const has = await new Promise((res) => {
    const pr = require('child_process').spawn(fp, ['-v', 'error', '-select_streams', 'a',
      '-show_entries', 'stream=index,channels', '-of', 'csv=p=0', p], { windowsHide: true });
    let s = ''; pr.stdout.on('data', d => s += d);
    pr.on('close', () => {
      const chs = s.trim().split(/\r?\n/).filter(Boolean).map(l => +((l.split(',')[1]) || 0));
      if (chs.length) _audioChannelCache.set(p, chs);
      res(/\d/.test(s.trim()));
    });
    pr.on('error', () => res(true));
    setTimeout(() => { try { pr.kill(); } catch (_) {} res(true); }, 8000);
  });
  _audioStreamCache.set(p, has);
  return has;
}
async function pruneSilentAudioInputs(spec) {
  if (!spec || !Array.isArray(spec.clips) || !spec.clips.length) return { spec, dropped: 0 };
  const keep = [];
  let dropped = 0;
  for (const c of spec.clips) {
    const p = fileUrlToPath(c.url);
    const chs = (p && fs.existsSync(p) && await fileHasAudioStream(p)) ? (_audioChannelCache.get(p) || []) : null;
    const ti = Number.isInteger(c.aTrack) ? c.aTrack : 0;
    if (chs && (!chs.length || ti < chs.length)) {
      // the channel count lets the graph play a mono source on both sides at full level
      const ch = chs[ti] || 0;
      keep.push(ch ? Object.assign({}, c, { channels: ch }) : c);
    }
    else dropped++;
  }
  return { spec: Object.assign({}, spec, { clips: keep }), dropped };
}
ipcMain.handle('ffmpeg:encode', async (e, buf, opts) => {
  const ff = ffPath('ffmpeg');
  if (!ff) return { ok: false, error: 'ffmpeg.exe not found in bin/' };
  const target = (opts && opts.target) || 'mp4-h264';
  const ext = TARGET_EXT[target] || 'mp4';
  const filter = TARGET_FILTER[ext] || TARGET_FILTER.mp4;
  const win = BrowserWindow.fromWebContents(e.sender);
  let base = (opts && opts.filename) || ('vibe-edit-export.' + ext);
  base = base.replace(/\.[^.]+$/, '') + '.' + ext;
  const job = (opts && opts.jobId) || ('enc-' + Date.now());
  const isCancelled = () => cancelledEncodes.has(job);
  if (isCancelled()) { cancelledEncodes.delete(job); return { ok: false, cancelled: true }; }
  const dest = dialog.showSaveDialogSync(win, {
    title: 'Save export', defaultPath: base, filters: [filter],
  });
  if (!dest) return { ok: false, cancelled: true };
  activeEncodeJob = job;
  const tmpIn = tempPath('master', 'webm');
  try { fs.writeFileSync(tmpIn, Buffer.from(buf)); sessionTemps.add(tmpIn); }
  catch (err) { activeEncodeJob = null; try { fs.unlinkSync(tmpIn); } catch (_) {} return { ok: false, error: 'could not stage master: ' + err.message }; }
  const mbps = Math.max(0.3, Math.min(60, (opts && opts.mbps) || 10));
  const isGif = target === 'gif';
  const fps = isGif
    ? Math.max(2, Math.min(50, (opts && opts.fps) || 15))
    : Math.max(10, Math.min(60, (opts && opts.fps) || 30));
  const gifOpts = (opts && opts.gif) || null;
  const ffExtra = { gif: gifOpts, audioKbps: (opts && opts.audioKbps) || 0, flacLevel: (opts && opts.flacLevel != null) ? opts.flacLevel : 5, adv: (opts && opts.adv) || null, audio: (opts && opts.audio) || null };
  // Hard cap the output length to the project duration so no inherited timecode/data
  // track can make a player report the source's full length with a broken seekbar.
  const durCap = (opts && opts.durationSec > 0) ? ['-t', (Math.round(opts.durationSec*1000)/1000).toFixed(3)] : [];
  // If the renderer supplied a separate clean PCM/WAV audio track, mux THAT in
  // and ignore the master's audio. This bypasses the in-browser Opus encoder,
  // which can degrade/crackle; FFmpeg encodes the audio cleanly instead.
  let tmpAud = null;
  if (opts && opts.audioWav) {
    tmpAud = tempPath('audio', 'wav');
    try { fs.writeFileSync(tmpAud, Buffer.from(opts.audioWav)); sessionTemps.add(tmpAud); }
    catch (err) { try { fs.unlinkSync(tmpAud); } catch (_) {} tmpAud = null; }
  }
  // Preferred: build the audio entirely with FFmpeg from the source files on disk
  // (no browser-decoded WAV involved). Falls back to tmpAud / master audio.
  // Declared BEFORE first use: reading it from the audio-prune block below while
  // it was still declared further down threw inside a silent try/catch, so the
  // "clips have no audio" note never reached the user.
  const wc = win && win.webContents;
  let af = null;
  if (opts && opts.audioSpec) {
    try {
      const pruned = await pruneSilentAudioInputs(opts.audioSpec);
      if (pruned.dropped) {
        try { wc && wc.send('ffmpeg:note',
          pruned.dropped + ' clip(s) have no audio track — exported without their sound'); } catch (_) {}
      }
      af = buildAudioFilter(pruned.spec, 1);
    } catch (e4) { af = null; }
  }
  let args;
  const buildArgs = (fx) => {
  // Drop data/subtitle/chapter tracks and source metadata so nothing (e.g. a
  // Blu-ray timecode/bin_data track) leaks in and misreports the duration.
  const CLEAN = ['-dn', '-sn', '-map_chapters', '-1', '-map_metadata', '-1'];
  if (af) {
    // input 0 = video master; inputs 1..N = audio sources for the filtergraph
    args = ['-y', '-i', tmpIn, ...af.inputs,
      '-filter_complex', af.filter || 'anull',
      '-map', '0:v:0', '-map', af.outLabel,
      ...CLEAN,
      ...ffArgsFor(target, mbps, fps, fx), ...(AUDIO_TARGETS.has(target) ? [] : ['-ar', '48000']), ...durCap, dest];
  } else if (tmpAud) {
    args = ['-y', '-i', tmpIn, '-i', tmpAud,
      '-map', '0:v:0', '-map', '1:a:0',
      ...CLEAN,
      ...ffArgsFor(target, mbps, fps, fx), ...(AUDIO_TARGETS.has(target) ? [] : ['-ar', '48000']), ...durCap, dest];
  } else {
    args = ['-y', '-i', tmpIn, ...CLEAN, ...ffArgsFor(target, mbps, fps, fx), ...durCap, dest];
  }
    return args; };
  args = buildArgs(ffExtra);
  // Total seconds of output, so ffmpeg's running "time=" can become a real %.
  const totalSec = (opts && opts.durationSec > 0) ? opts.durationSec : 0;
  // (declared earlier now — see below)
  const sendProg = (pct, secs) => { try { wc && wc.send('ffmpeg:encode-progress', { pct, secs, totalSec }); } catch (_) {} };
  sendProg(0, 0);
  const dropTemps = () => { for (const t of [tmpIn, tmpAud]) if (t) { try { fs.unlinkSync(t); } catch (_) {} sessionTemps.delete(t); } };
  if (isCancelled()) { dropTemps(); cancelledEncodes.delete(job); activeEncodeJob = null; return { ok: false, cancelled: true }; }
  let r = await runFF(ff, args,
    (secs) => { if (totalSec > 0) sendProg(Math.max(0, Math.min(99.5, secs / totalSec * 100)), secs); else sendProg(null, secs); },
    (proc) => { activeEncodeProc = proc; activeEncodeDest = dest; });
  activeEncodeProc = null; activeEncodeDest = null;
  if (!r.ok && !isCancelled() && ffExtra.adv && ffExtra.adv.encoder && ffExtra.adv.encoder !== 'cpu') {
    // GPU encoder unavailable on this machine/driver — transparent CPU retry
    args = buildArgs({ ...ffExtra, adv: { ...ffExtra.adv, encoder: 'cpu' } });
    r = await runFF(ff, args,
      (secs) => { if (totalSec > 0) sendProg(Math.max(0, Math.min(99.5, secs / totalSec * 100)), secs); else sendProg(null, secs); },
      (proc) => { activeEncodeProc = proc; activeEncodeDest = dest; });
    activeEncodeProc = null; activeEncodeDest = null;
    if (r.ok) { try { wc && wc.send('ffmpeg:note', 'GPU encoder unavailable \u2014 encoded on CPU instead'); } catch (_) {} }
  }
  dropTemps();
  activeEncodeJob = null;
  if (isCancelled()) { cancelledEncodes.delete(job); try { fs.existsSync(dest) && fs.unlinkSync(dest); } catch (_) {} return { ok: false, cancelled: true }; }
  if (r.ok && fs.existsSync(dest)) { sendProg(100, totalSec); shell.showItemInFolder(dest); return { ok: true, path: dest }; }
  // a failed encode leaves a truncated/empty file behind — remove it
  try { fs.existsSync(dest) && fs.unlinkSync(dest); } catch (_) {}
  return { ok: false, error: r.error || 'encode failed' };
});
// Cancel an in-flight export encode: kill the ffmpeg child if one is running.
ipcMain.handle('ffmpeg:cancelProxy', async (_e, jobId) => {
  if (!jobId) return { ok: false };
  // Mark first, then kill: the runFF promise resolves as soon as the child dies,
  // so the flag has to be set before the handler resumes or the cancellation
  // would be reported as a conversion failure.
  cancelledProxies.add(jobId);
  const proc = activeProxies.get(jobId);
  if (proc) {
    try { proc.kill('SIGKILL'); } catch (_) {}
    activeProxies.delete(jobId);
    return { ok: true, killed: true };
  }
  return { ok: true, killed: false }; // not spawned yet — the flag stops it on arrival
});
ipcMain.handle('ffmpeg:cancelEncode', async (_e, jobId) => {
  // With a job id: cancel THAT job, whether it is running or not started yet.
  // Without one (older callers): cancel only what is running right now.
  const job = jobId || activeEncodeJob;
  if (!job) return { ok: false };
  cancelledEncodes.add(job);
  if (activeEncodeProc && job === activeEncodeJob) {
    try { activeEncodeProc.kill('SIGKILL'); } catch (_) {}
    activeEncodeProc = null; activeEncodeDest = null;
    return { ok: true };
  }
  return { ok: false };
});



ipcMain.handle('ffmpeg:encodeAudio', async (e, wavBuf, opts) => {
  const ff = ffPath('ffmpeg');
  if (!ff) return { ok: false, error: 'ffmpeg.exe not found in bin/' };
  const target = (opts && opts.target) || 'mp3';
  const ext = TARGET_EXT[target] || 'mp3';
  const filter = TARGET_FILTER[ext] || { name: 'Audio', extensions: [ext] };
  const win = BrowserWindow.fromWebContents(e.sender);
  let base = ((opts && opts.filename) || 'vibe-edit-export').replace(/\.[^.]+$/, '') + '.' + ext;
  const job = (opts && opts.jobId) || ('aud-' + Date.now());
  const isCancelled = () => cancelledEncodes.has(job);
  if (isCancelled()) { cancelledEncodes.delete(job); return { ok: false, cancelled: true }; }
  const dest = dialog.showSaveDialogSync(win, { title: 'Save audio', defaultPath: base, filters: [filter] });
  if (!dest) return { ok: false, cancelled: true };
  activeEncodeJob = job;
  const tmpIn = tempPath('audio', 'wav');
  try { fs.writeFileSync(tmpIn, Buffer.from(wavBuf)); sessionTemps.add(tmpIn); }
  catch (err) { activeEncodeJob = null; try { fs.unlinkSync(tmpIn); } catch (_) {} return { ok: false, error: 'could not stage audio: ' + err.message }; }
  const wc = win && win.webContents;
  const totalSec = (opts && opts.durationSec > 0) ? opts.durationSec : 0;
  const sendProg = (pct, secs) => { try { wc && wc.send('ffmpeg:encode-progress', { pct, secs, totalSec }); } catch (_) {} };
  sendProg(totalSec ? 0 : null, 0);
  // The audio options object carries format/bitrate/rate/channels/depth/loudness.
  // audioExportArgs sets -ar itself, so no trailing override here (that bug would
  // silently pin every export to 48 kHz).
  const aOpts = (opts && opts.audio) || { kbps: (opts && opts.audioKbps) || 0,
    flacLevel: (opts && opts.flacLevel != null) ? opts.flacLevel : 5 };
  const r = isCancelled() ? { ok: false } : await runFF(ff, ['-y', '-i', tmpIn, ...audioExportArgs(target, aOpts), dest],
    (secs) => { if (totalSec > 0) sendProg(Math.max(0, Math.min(99.5, secs / totalSec * 100)), secs); else sendProg(null, secs); },
    (proc) => { activeEncodeProc = proc; activeEncodeDest = dest; });
  activeEncodeProc = null; activeEncodeDest = null; activeEncodeJob = null;
  try { fs.unlinkSync(tmpIn); } catch (e2) {}
  sessionTemps.delete(tmpIn);
  if (isCancelled()) { cancelledEncodes.delete(job); try { fs.existsSync(dest) && fs.unlinkSync(dest); } catch (_) {} return { ok: false, cancelled: true }; }
  if (r.ok && fs.existsSync(dest)) { sendProg(100, totalSec); shell.showItemInFolder(dest); return { ok: true, path: dest }; }
  try { fs.existsSync(dest) && fs.unlinkSync(dest); } catch (_) {}
  return { ok: false, error: r.error || 'encode failed' };
});

function createWindow() {
  const { workAreaSize } = require('electron').screen.getPrimaryDisplay();
  const win = new BrowserWindow({
    width: Math.min(1440, workAreaSize.width),
    height: Math.min(900, workAreaSize.height),
    minWidth: 980,
    minHeight: 620,
    backgroundColor: '#0c0d11',
    autoHideMenuBar: true,
    title: 'Vibe Edit',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // Keep timers, rAF and media at full speed even when the window is
      // minimized or covered — exports must never slow down or starve.
      backgroundThrottling: false
    }
  });

  win.maximize();
  win.loadFile(path.join(__dirname, 'app', 'index.html'));

  // Exports: prompt the user for a save location instead of silently
  // dropping the file in Downloads.
  win.webContents.session.on('will-download', (event, item) => {
    // Filters must match what's actually being saved — snapshots are images,
    // audio-only exports are audio, projects are .vibe. A fixed mp4/webm
    // filter made Windows append .mp4 to PNG snapshots.
    const name = item.getFilename();
    const ext = (name.split('.').pop() || '').toLowerCase();
    const FILTERS = {
      png:  { name: 'PNG image', extensions: ['png'] },
      jpg:  { name: 'JPEG image', extensions: ['jpg', 'jpeg'] },
      jpeg: { name: 'JPEG image', extensions: ['jpg', 'jpeg'] },
      webp: { name: 'WebP image', extensions: ['webp'] },
      gif:  { name: 'GIF animation', extensions: ['gif'] },
      wav:  { name: 'WAV audio', extensions: ['wav'] },
      mp3:  { name: 'MP3 audio', extensions: ['mp3'] },
      srt:  { name: 'Subtitles', extensions: ['srt'] },
      vibe: { name: 'Vibe Edit project', extensions: ['vibe'] },
      cutroom: { name: 'Vibe Edit project (legacy)', extensions: ['cutroom'] },
      webm: { name: 'Video', extensions: ['webm', 'mp4'] },
      mp4:  { name: 'Video', extensions: ['mp4', 'webm'] }
    };
    const primary = FILTERS[ext] || { name: ext ? ext.toUpperCase() + ' file' : 'File', extensions: ext ? [ext] : ['*'] };
    const result = dialog.showSaveDialogSync(win, {
      title: 'Save file',
      defaultPath: name,
      filters: [primary, { name: 'All files', extensions: ['*'] }]
    });
    if (result) {
      item.setSavePath(result);
      item.once('done', (_e, state) => {
        if (state === 'completed') shell.showItemInFolder(result);
      });
    } else {
      item.cancel();
    }
  });

  // Keep navigation inside the app; open external links in the OS browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', e => e.preventDefault());

  // Confirm before closing so an edit isn't lost by accident.
  // Asks the page whether the project has unsaved changes / an export is
  // running, then words the question to match (nothing to lose: no question).
  // Unsaved changes: Save / Don't Save / Cancel — Save runs the page's own
  // saveProject() (Ctrl+S: in place, or the Save dialog) and closes only if the
  // project was actually saved. A running export: Quit (stops it) / Stay.
  let confirmedClose = false, asking = false;
  const closeNow = () => { confirmedClose = true; if (!win.isDestroyed()) win.close(); };
  win.on('close', e => {
    if (confirmedClose) return;
    e.preventDefault();
    if (asking) return;
    asking = true;
    const probe = "(()=>{try{return {dirty:typeof projectDirty==='function'?!!projectDirty():true,"
      + "exporting:typeof exportInFlight==='function'&&!!exportInFlight()};}catch(e){return {dirty:true,exporting:false};}})()";
    const ask = async (st) => {
      st = st || { dirty: true, exporting: false };
      if (!st.dirty && !st.exporting) { asking = false; closeNow(); return; }
      if (st.exporting) {
        const choice = dialog.showMessageBoxSync(win, {
          type: 'warning', buttons: ['Quit', 'Stay'], defaultId: 1, cancelId: 1,
          title: 'Quit Vibe Edit?', message: 'Quit Vibe Edit?',
          detail: 'An export is still running \u2014 quitting stops it and nothing is saved.' + (st.dirty ? ' Unsaved changes to the project will also be lost.' : '')
        });
        asking = false;
        if (choice === 0) closeNow();
        return;
      }
      const choice = dialog.showMessageBoxSync(win, {
        type: 'question', buttons: ['Save', "Don't Save", 'Cancel'], defaultId: 0, cancelId: 2,
        title: 'Quit Vibe Edit?', message: 'Save changes to this project before quitting?',
        detail: "If you don't save, your unsaved changes will be lost."
      });
      if (choice === 1) { asking = false; closeNow(); return; }
      if (choice !== 0) { asking = false; return; }
      let saved = false;
      try { saved = await win.webContents.executeJavaScript('(async()=>{try{return !!(await saveProject());}catch(e){return false;}})()', true); }
      catch (_) { saved = false; }
      asking = false;
      if (saved === true) closeNow();   // Save dialog cancelled or save failed: stay
    };
    let settled = false;
    const once = st => { if (!settled) { settled = true; ask(st); } };
    win.webContents.executeJavaScript(probe, true).then(once, () => once(null));
    setTimeout(() => once(null), 1500);   // a hung page still gets the question
  });
}

// Minimal menu so standard shortcuts (copy/paste in text fields,
// zoom, fullscreen, devtools) keep working everywhere.
function buildMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'togglefullscreen' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'toggleDevTools' }
      ]
    },
    { role: 'windowMenu' }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Windows reports a window that is fully covered by another as hidden, and
// Chromium then stops presenting video frames to it (a background timer takes
// over at ~4 per second). backgroundThrottling:false doesn't cover that, so a
// Precise export rendered while the user worked in a browser drew stale frames
// (repeats + skips, "looks like a lower frame rate"). Keep the window live.
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.whenReady().then(() => {
  buildMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Temp files: this session's proxies/intermediates go on quit; stale ones from
// earlier sessions (crashes) older than two days go at start. Only our own
// name patterns in the temp folder are ever touched. Saved projects never
// reference a proxy file (they store the ORIGINAL path and rebuild proxies),
// so nothing a project needs is removed.
function cleanStaleTemps() {
  try {
    const dir = os.tmpdir(), cutoff = Date.now() - 2 * 24 * 3600 * 1000;
    for (const n of fs.readdirSync(dir)) {
      if (!OUR_TEMP.test(n)) continue;
      const f = path.join(dir, n);
      try { if (fs.statSync(f).mtimeMs < cutoff) fs.unlinkSync(f); } catch (_) {}
    }
  } catch (_) {}
}
app.whenReady().then(() => setTimeout(cleanStaleTemps, 5000));
// On quit: stop every FFmpeg child first (an export or proxy still running
// would otherwise carry on after the app is gone — and on Windows hold its temp
// file open so it can't be deleted), remove a half-written export output (as
// Cancel does), then this session's temp files. The quit waits (≤ 3 s) for the
// children to exit so the files are released.
let quitCleaned = false;
function removeSessionTemps() {
  for (const f of sessionTemps) { try { fs.unlinkSync(f); sessionTemps.delete(f); } catch (e) { if (e && e.code === 'ENOENT') sessionTemps.delete(f); } }
}
app.on('will-quit', e => {
  if (quitCleaned) return;
  quitCleaned = true;
  const partial = activeEncodeProc ? activeEncodeDest : null;
  if (activeEncodeJob) cancelledEncodes.add(activeEncodeJob);
  const kids = [...liveKids];
  const finish = () => {
    if (partial) { try { fs.unlinkSync(partial); } catch (_) {} }
    removeSessionTemps();
  };
  if (!kids.length) { finish(); return; }
  e.preventDefault();
  let left = kids.length, done = false;
  const go = () => { if (done) return; done = true; finish(); app.quit(); };
  for (const k of kids) {
    k.once('close', () => { if (--left <= 0) go(); });
    try { k.kill('SIGKILL'); } catch (_) { if (--left <= 0) go(); }
  }
  setTimeout(go, 3000);
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
