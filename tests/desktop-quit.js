/* desktop-quit.js — the desktop app's quit prompt and temp-file clean-up, run
 * for REAL: Electron + desktop/main.js + the page, one Electron launch per
 * scenario (tests/electron-harness/quit.js answers the native dialogs).
 *   · no unsaved changes → closes with no prompt;
 *   · unsaved changes → Save / Don't Save / Cancel: Cancel keeps the window,
 *     Don't Save closes without writing anything, Save writes the project (via
 *     the page's own saveProject) then closes, a cancelled Save dialog stays;
 *   · an export running → the export warning: Stay keeps the window, Quit
 *     closes — and with a REAL FFmpeg encode in flight, quitting stops FFmpeg,
 *     removes the half-written output and the master/audio temp files;
 *   · temp files: a proxy made this session is deleted on quit; stale vibe-*
 *     temp files (> 2 days) are swept at start; newer ones, non-matching names,
 *     files in sub-folders, the source video and finished export outputs are
 *     never touched.
 * Each run gets its own TMPDIR, so os.tmpdir() in main.js is a scratch folder.
 * Needs: an Electron binary (ELECTRON=path, or desktop/node_modules/electron)
 * and FFmpeg in desktop/bin. Linux runs under xvfb-run.
 * Usage: node tests/desktop-quit.js */
const fs = require('fs'), path = require('path'), os = require('os'), { spawnSync, execFileSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..'), DESK = path.join(ROOT, 'desktop');
const exe = process.platform === 'win32' ? '.exe' : '';
const electron = process.env.ELECTRON || [path.join(DESK, 'node_modules', 'electron', 'dist', 'electron' + exe), '/tmp/claude-0/e44/node_modules/electron/dist/electron'].find(fs.existsSync);
const FFM = path.join(DESK, 'bin', 'ffmpeg' + exe);
if (!electron || !fs.existsSync(FFM)) { console.log('SKIP: needs ELECTRON (or desktop/node_modules/electron) and FFmpeg in desktop/bin'); process.exit(0); }
const R = {}, fails = [];
const ck = (k, v) => { R[k] = !!v; if (!v) fails.push(k); };
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-quit-test-'));
const H = path.join(__dirname, 'electron-harness', 'quit.js');

function run(name, sc, opt = {}) {
  const tmp = path.join(work, name + '-tmp'); fs.mkdirSync(tmp, { recursive: true });
  const save = path.join(work, name + '-save'); fs.mkdirSync(save, { recursive: true });
  if (opt.prep) opt.prep(tmp);
  const out = path.join(work, name + '.json');
  const args = [H, '--no-sandbox'];
  const cmd = process.platform === 'linux' ? 'xvfb-run' : electron;
  const full = process.platform === 'linux' ? ['-a', electron, ...args] : args;
  const t0 = Date.now();
  const r = spawnSync(cmd, full, { env: { ...process.env, TMPDIR: tmp, TEMP: tmp, TMP: tmp, VIBE_QUIT_SCENARIO: JSON.stringify(sc), VIBE_QUIT_OUT: out, VIBE_SAVE_DIR: save }, encoding: 'utf8', timeout: 180000 });
  let log = null; try { log = JSON.parse(fs.readFileSync(out, 'utf8')); } catch (_) {}
  if (!log) { console.log(name, r.stdout, r.stderr); log = { dialogs: [], events: [] }; }
  log.secs = +((Date.now() - t0) / 1000).toFixed(1); log.tmp = tmp; log.save = save; log.exitCode = r.status;
  // closed by the APP (the harness's own exit at the end also closes the window — that doesn't count)
  const hx = log.events.indexOf('harness-exit'), before = hx < 0 ? log.events : log.events.slice(0, hx);
  log.closed = before.includes('closed'); log.quit = before.includes('will-quit');
  return log;
}
const DIRTY = "state.clips=[makeClip({type:'color',track:'V1',start:0,duration:3,color:'#123456'})];renderTimeline();return {dirty:projectDirty(),exporting:exportInFlight()};";
const btns = l => (l.dialogs[0] && l.dialogs[0].buttons || []).join('|');

// 1. nothing to lose: no prompt
let L = run('clean', { setup: 'return {dirty:projectDirty(),exporting:exportInFlight()};' });
R.clean = { setup: L.setup, dialogs: L.dialogs.length, events: L.events };
ck('clean: closes without a prompt', L.setup && !L.setup.dirty && L.dialogs.length === 0 && L.closed && L.quit);

// 2. unsaved changes: Cancel keeps the window
L = run('cancel', { setup: DIRTY, answer: 'Cancel', after: 'return {dirty:projectDirty(),clips:state.clips.length};' });
R.cancel = { setup: L.setup, buttons: btns(L), alive: L.alive, after: L.after };
ck('unsaved: prompt offers Save / Don\'t Save / Cancel', L.setup && L.setup.dirty && btns(L) === "Save|Don't Save|Cancel" && /unsaved changes/.test(L.dialogs[0].detail || ''));
ck('unsaved: Cancel keeps the window and the edit', L.alive && !L.closed && L.after && L.after.dirty && L.after.clips === 1);

// 3. Don't Save closes, writes nothing
L = run('dontsave', { setup: DIRTY, answer: "Don't Save", saveAs: path.join(work, 'dontsave-should-not-exist.vibe') });
R.dontsave = { dialogs: L.dialogs.length, saveDialogs: L.saveDialogs, events: L.events };
ck('unsaved: Don\'t Save closes without saving', L.dialogs.length === 1 && L.closed && L.quit && L.saveDialogs === 0 && !fs.existsSync(path.join(work, 'dontsave-should-not-exist.vibe')));

// 4. Save: the project Save dialog, the file written, then closed
const saved = path.join(work, 'saved-project.vibe');
L = run('save', { setup: DIRTY, answer: 'Save', saveAs: saved });
let proj = null; try { proj = JSON.parse(fs.readFileSync(saved, 'utf8')); } catch (_) {}
R.save = { dialogs: L.dialogs.length, saveDialogs: L.saveDialogs, events: L.events, written: !!proj };
ck('unsaved: Save writes the project, then closes', L.saveDialogs === 1 && proj && proj.clips && proj.clips.length === 1 && proj.clips[0].color === '#123456' && L.closed && L.quit);

// 5. Save, then Cancel in the Save dialog: stays open, still unsaved
L = run('savecancel', { setup: DIRTY, answer: 'Save', saveAs: null, after: 'return {dirty:projectDirty()};' });
R.savecancel = { saveDialogs: L.saveDialogs, alive: L.alive, after: L.after };
ck('unsaved: a cancelled Save dialog keeps the window', L.saveDialogs === 1 && L.alive && !L.closed && L.after && L.after.dirty);

// 6. a project that already has a file: Save writes it in place (no dialog)
const inplace = path.join(work, 'in-place.vibe'); fs.writeFileSync(inplace, '{}');
L = run('saveinplace', { setup: "state.savedPath=" + JSON.stringify(inplace) + ";" + DIRTY, answer: 'Save', saveAs: null });
let proj2 = null; try { proj2 = JSON.parse(fs.readFileSync(inplace, 'utf8')); } catch (_) {}
ck('unsaved: Save on a project with a file saves in place and closes', L.saveDialogs === 0 && proj2 && proj2.clips && proj2.clips.length === 1 && L.closed);

// 7. export running (flag only): Stay / Quit
L = run('exportstay', { setup: 'exportUI.active=true;return {dirty:projectDirty(),exporting:exportInFlight()};', answer: 'Stay', after: 'return {exporting:exportInFlight()};' });
R.exportstay = { setup: L.setup, buttons: btns(L), alive: L.alive };
ck('export: warns that an export is running; Stay keeps the window', L.setup && L.setup.exporting && btns(L) === 'Quit|Stay' && /export is still running/.test(L.dialogs[0].detail || '') && L.alive && !L.closed);

// 8. temp files + a REAL export in flight when quitting
const src = path.join(work, 'source.mp4');
execFileSync(FFM, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:v', 'libx264', '-g', '90', '-c:a', 'aac', '-shortest', src]);
const master = path.join(work, 'master.webm');   // long enough that the app's FFmpeg encode is still running at quit
execFileSync(FFM, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=40', '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '4M', master]);
const small = path.join(work, 'small.webm');
execFileSync(FFM, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=30:duration=1', '-c:v', 'libvpx', '-deadline', 'realtime', '-b:v', '300k', small]);
const DAY = 24 * 3600 * 1000;
const STALE = ['vibe-proxy-1000.mp4', 'vibe-master-1001.webm', 'vibe-audio-1002.wav', 'vibe-hq-1003.mp4'];
const FRESH = ['vibe-proxy-2000.mp4', 'vibe-audio-2001.wav'];                    // one day old: kept
const OTHER = ['vibe-proxy-abc.mp4', 'vibe-notes-1.txt', 'other.mp4', 'vibe-proxy-1.mp4.part', 'vibe-export-3.mp4', 'my-vibe-proxy-4.mp4'];
const prep = tmp => {
  const put = (n, age) => { const f = path.join(tmp, n); fs.writeFileSync(f, 'x'); const t = new Date(Date.now() - age); fs.utimesSync(f, t, t); };
  for (const n of STALE) put(n, 3 * DAY);
  for (const n of FRESH) put(n, 1 * DAY);
  for (const n of OTHER) put(n, 3 * DAY);
  fs.mkdirSync(path.join(tmp, 'sub'), { recursive: true }); put(path.join('sub', 'vibe-proxy-5.mp4'), 3 * DAY);
};
const wavJs = "const wav=(()=>{const n=48000,b=new ArrayBuffer(44+n*2),v=new DataView(b);const w=(o,s)=>{for(let i=0;i<s.length;i++)v.setUint8(o+i,s.charCodeAt(i));};"
  + "w(0,'RIFF');v.setUint32(4,36+n*2,true);w(8,'WAVE');w(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,48000,true);v.setUint32(28,96000,true);v.setUint16(32,2,true);v.setUint16(34,16,true);w(36,'data');v.setUint32(40,n*2,true);return b;})();";
const tempsSetup = `
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
${wavJs}
const R={};
// a proxy made this session (kept until quit)
const px=await vibeNative.makeProxy(${JSON.stringify(src)},'quit-px',{});
R.proxy=px&&px.ok?px.path:null;R.proxyExists=R.proxy?(await vibeNative.statPath(R.proxy)).ok:false;
// a finished export: the user's output file must survive the quit
const sm=await vibeNative.readPath(${JSON.stringify(small)});
const done=await vibeNative.encodeMp4(sm.bytes.buffer.slice(sm.bytes.byteOffset,sm.bytes.byteOffset+sm.bytes.byteLength),{jobId:'quit-done',filename:'finished',durationSec:1,audioWav:wav});
R.finished=done&&done.ok?done.path:null;
// an export still encoding when the user quits
const big=await vibeNative.readPath(${JSON.stringify(master)});
vibeNative.encodeMp4(big.bytes.buffer.slice(big.bytes.byteOffset,big.bytes.byteOffset+big.bytes.byteLength),{jobId:'quit-mid',filename:'midway',durationSec:40,audioWav:wav});
exportUI.encoding=true;
await sleep(2500);   // FFmpeg is running now
R.exporting=exportInFlight();
return R;`;
L = run('temps', { setup: tempsSetup, answer: 'Quit', delayClose: 4000, wait: 8000 }, { prep });
const tmp = L.tmp, ls = d => { try { return fs.readdirSync(d); } catch (_) { return []; } };
const left = ls(tmp), outs = ls(L.save);
R.temps = { setup: L.setup, setupError: L.setupError, buttons: btns(L), events: L.events, left: left.filter(n => /^vibe-|other|sub/.test(n)), outs, secs: L.secs };
const s = L.setup || {};
ck('temps: setup made a proxy, a finished export and a running one', s.proxy && s.proxyExists && s.finished && s.exporting);
ck('temps: quitting mid-export asks first (Quit)', btns(L) === 'Quit|Stay' && L.closed && L.quit);
ck('temps: the session\'s proxy is deleted on quit', s.proxy && !fs.existsSync(s.proxy));
ck('temps: master/audio intermediates of the stopped export are deleted', !left.some(n => /^vibe-(master|audio)-\d{16}\.(webm|wav)$/.test(n)));
ck('temps: no vibe temp of this session is left behind', !left.some(n => /^vibe-(proxy|hq|master|audio)-\d{16}\./.test(n)));
ck('temps: stale (> 2 days) vibe temp files swept at start', STALE.every(n => !left.includes(n)));
ck('temps: newer vibe temp files kept', FRESH.every(n => left.includes(n)));
ck('temps: non-matching names and sub-folders untouched', OTHER.every(n => left.includes(n)) && fs.existsSync(path.join(tmp, 'sub', 'vibe-proxy-5.mp4')));
ck('temps: the finished export output is kept', s.finished && fs.existsSync(s.finished) && fs.statSync(s.finished).size > 1000);
ck('temps: the half-written export output is removed', !outs.some(n => /midway/.test(n)));
ck('temps: the source video is untouched', fs.existsSync(src) && fs.existsSync(master));
// FFmpeg must not outlive the app
const ps = spawnSync('ps', ['-eo', 'args'], { encoding: 'utf8' }).stdout || '';
ck('temps: no FFmpeg left running after quit', !ps.split('\n').some(l => l.includes(L.save)));

try { fs.rmSync(work, { recursive: true, force: true }); } catch (_) {}
console.log(JSON.stringify(R, null, 1));
console.log(fails.length ? 'FAIL: ' + fails.join('; ') : 'PASS');
process.exit(fails.length ? 1 : 0);
