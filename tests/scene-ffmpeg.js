#!/usr/bin/env node
/* scene-ffmpeg.js — the desktop scene-analysis handler (main.js 'ffmpeg:scenes')
 * run for real against FFmpeg, on synthetic video with hard cuts at KNOWN frames,
 * a camera move inside a shot (must not count as a cut) and a trimmed window.
 * (v4.6.1: the handler returns the editor's own per-frame metric; cuts are
 * picked by the renderer's prominence rule, loaded from the app here.)
 * Electron is stubbed through require.cache; FFmpeg is the system one, exposed
 * to main.js through a temporary resources/bin folder.
 * Usage: node tests/scene-ffmpeg.js      (needs ffmpeg on PATH)
 */
const fs = require('fs'), os = require('os'), path = require('path'), { execFileSync } = require('child_process');
const Module = require('module');
const which = n => { try { return execFileSync('which', [n]).toString().trim(); } catch (e) { return null; } };
const FF = process.env.FFMPEG || which('ffmpeg');
if (!FF) { console.log('SKIP: ffmpeg not found'); process.exit(0); }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 've-scn-'));
fs.mkdirSync(path.join(tmp, 'bin'));
fs.symlinkSync(FF, path.join(tmp, 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'));
process.resourcesPath = tmp;
const handlers = {}, sent = [];
const stub = { app: { getVersion: () => 'test', whenReady: () => new Promise(() => {}), on() {}, commandLine: { appendSwitch() {} } },
  BrowserWindow: function () {}, dialog: {}, Menu: { setApplicationMenu() {}, buildFromTemplate() { return {}; } }, shell: {},
  ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; }, on() {} } };
const load = Module._load;
Module._load = function (req, parent, isMain) { if (req === 'electron') return stub; return load.apply(this, arguments); };
require(path.resolve(__dirname, '..', 'desktop', 'main.js'));
Module._load = load;

// 30 fps: shots of 2.0 s (panning testsrc), 1.5 s (bars), 2.0 s (mandelbrot), 1.0 s (red), 1.5 s (testsrc2)
const vid = path.join(tmp, 'cuts.mp4');
execFileSync(FF, ['-v', 'error', '-y',
  '-f', 'lavfi', '-i', 'testsrc=s=640x360:r=30:d=2,crop=480:270:x=t*60:y=0,scale=640:360',
  '-f', 'lavfi', '-i', 'smptebars=s=640x360:r=30:d=1.5',
  '-f', 'lavfi', '-i', 'mandelbrot=s=640x360:r=30,trim=duration=2',
  '-f', 'lavfi', '-i', 'color=c=red:s=640x360:r=30:d=1',
  '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=1.5',
  '-filter_complex', '[0][1][2][3][4]concat=n=5:v=1:a=0,format=yuv420p', '-c:v', 'libx264', '-g', '300', '-preset', 'veryfast', vid]);
const CUTS = [2.0, 3.5, 5.5, 6.5];
(async () => {
  const ev = { sender: { send: (ch, d) => sent.push([ch, d]) } };
  // the renderer's own picker (prominence over neighbors), loaded from the app
  const html = fs.readFileSync(path.resolve(__dirname, '..', 'vibe-edit.html'), 'utf8');
  const grab = n => { const i = html.indexOf('function ' + n); let d = 0, j = html.indexOf('{', i); for (; j < html.length; j++) { if (html[j] === '{') d++; else if (html[j] === '}' && --d === 0) break; } return html.slice(i, j + 1); };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const aiPick = new Function('clamp', grab('aiSceneProminence') + grab('aiSceneThreshold') + grab('aiPickScenes') + ';return aiPickScenes;')(clamp);
  const pick = (scores, sens) => aiPick({ kind: 'frames', scores }, sens);
  const r = await handlers['ffmpeg:scenes'](ev, { input: vid, jobId: 'j1' });
  const found = pick(r.scores, 50);
  const out = {};
  out.ok = r.ok;
  out.frames = r.scores.length; out.framesOK = r.metric === 'v461' && r.scores.length > 100 && r.scores.length <= 241 && r.scores.every((x, i) => !i || x[0] > r.scores[i - 1][0]); // duplicate (static) frames are skipped
  out.cutsFound = found.map(t => +t.toFixed(3));
  out.exactFrames = CUTS.every(c => found.some(t => Math.abs(t - c) < 1 / 60)) && found.length === CUTS.length;
  out.progressEvents = sent.filter(s => s[0] === 'ffmpeg:scenes-progress').length;
  // a window: 3.0 .. 7.0 s -> cuts 3.5, 5.5, 6.5 in FILE time
  const w = await handlers['ffmpeg:scenes'](ev, { input: vid, start: 3, end: 7, jobId: 'j2' });
  const wf = pick(w.scores, 50);
  out.windowCuts = wf.map(t => +t.toFixed(3));
  out.windowOK = w.ok && [3.5, 5.5, 6.5].every(c => wf.some(t => Math.abs(t - c) < 1 / 60)) && wf.length === 3 && w.scores[0][0] >= 2.99;
  out.missingFileHandled = (await handlers['ffmpeg:scenes'](ev, { input: path.join(tmp, 'nope.mp4') })).ok === false;
  console.log(JSON.stringify(out, null, 1));
  fs.rmSync(tmp, { recursive: true, force: true });
  const fails = Object.keys(out).filter(k => typeof out[k] === 'boolean' && !out[k]);
  console.log(fails.length ? 'FAIL: ' + fails.join(',') : 'PASS');
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error('FAIL:', e); process.exit(1); });
