/* pro-grade.js — v4.8 Pro grading & motion: .cube LUTs, the keyframe curve
 * editor (per-key easing) and speed ramps. Each check compares against an
 * independent reference (analytic transform, closed-form curve, numeric
 * integral) rather than against the code's own output.
 * Usage: node tests/pro-grade.js
 */
const path = require('path'), fs = require('fs');
const { openApp, addWavMedia } = require('./lib/fixture-page');
const R = {}, fails = [];
const check = (k, ok) => { R[k + 'OK'] = !!ok; if (!ok) fails.push(k); };

// An analytic grade: channel mix + per-channel gamma + a lift. Smooth, so a
// 33³ trilinear table reproduces it to well under 1/255.
const F = (r, g, b) => {
  const c = x => Math.min(1, Math.max(0, x));
  return [c(Math.pow(c(0.85 * r + 0.15 * g), 0.8)), c(Math.pow(c(0.1 * r + 0.8 * g + 0.1 * b), 1.15) * 0.95 + 0.03), c(0.2 + 0.7 * Math.pow(b, 1.3))];
};
function cube3(N, f, title, extra = '') {
  const L = [`# test LUT`, `TITLE "${title}"`, `LUT_3D_SIZE ${N}`, extra];
  for (let b = 0; b < N; b++) for (let g = 0; g < N; g++) for (let r = 0; r < N; r++) L.push(f(r / (N - 1), g / (N - 1), b / (N - 1)).map(v => v.toFixed(6)).join(' '));
  return L.join('\r\n');
}
const analyticCube = cube3(33, F, 'Analytic');
const identityCube = cube3(17, (r, g, b) => [r, g, b], 'Identity');
// 1D invert curve, and a 3D LUT with DOMAIN_MAX 2 (input is halved before lookup)
const invert1D = ['LUT_1D_SIZE 5', ...[0, 1, 2, 3, 4].map(i => { const v = 1 - i / 4; return `${v} ${v} ${v}`; })].join('\n');
const domainCube = cube3(9, (r, g, b) => [r, g, b], 'Domain', 'DOMAIN_MIN 0 0 0\nDOMAIN_MAX 2 2 2');

(async () => {
  const app = await openApp({ asr: false });
  const p = app.page;

  // ---------------- 1. LUTs ----------------
  R.lut = await p.evaluate(async (cubes, Fsrc) => {
    const F = eval(Fsrc), out = {};
    const W = 96, H = 64;
    // random colors plus the corners of the cube
    const src = document.createElement('canvas'); src.width = W; src.height = H;
    const sg = src.getContext('2d'); const im = sg.createImageData(W, H);
    let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < im.data.length; i += 4) { im.data[i] = rnd() * 256 | 0; im.data[i + 1] = rnd() * 256 | 0; im.data[i + 2] = rnd() * 256 | 0; im.data[i + 3] = 255; }
    [[0, 0, 0], [255, 255, 255], [255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [0, 255, 255], [255, 0, 255]].forEach((c, k) => im.data.set([...c, 255], k * 4));
    sg.putImageData(im, 0, 0);
    const read = c => { const t = document.createElement('canvas'); t.width = W; t.height = H; const g = t.getContext('2d'); g.drawImage(c, 0, 0, W, H); return g.getImageData(0, 0, W, H).data; };
    const err = (a, b) => { let mx = 0, s = 0, n = 0; for (let i = 0; i < a.length; i += 4) for (let ch = 0; ch < 3; ch++) { const d = Math.abs(a[i + ch] - b[i + ch]); mx = Math.max(mx, d); s += d; n++; } return { max: mx, mean: +(s / n).toFixed(3) }; };
    const expect = (fn) => { const d = new Uint8ClampedArray(im.data.length); for (let i = 0; i < d.length; i += 4) { const o = fn(im.data[i] / 255, im.data[i + 1] / 255, im.data[i + 2] / 255); d[i] = Math.round(o[0] * 255); d[i + 1] = Math.round(o[1] * 255); d[i + 2] = Math.round(o[2] * 255); d[i + 3] = 255; } return d; };
    const L = proParseCube(cubes.analytic, 'x.cube'); const id = proLutAdd(L);
    out.parsed = L.name === 'Analytic' && L.size === 33 && L.data.length === 33 ** 3 * 3;
    out.gpu = !!_lutGLInit();
    const gpu = read(proLutApply(src, 0, 0, W, H, id, 1, W, H));
    out.gpuVsAnalytic = err(gpu, expect(F));
    // CPU fallback
    const G = _lutGL; _lutGL = false;
    const cpu = read(proLutApply(src, 0, 0, W, H, id, 1, W, H));
    _lutGL = G;
    out.cpuVsAnalytic = err(cpu, expect(F));
    out.gpuVsCpu = err(gpu, cpu);
    // intensity 50 %: halfway between original and graded
    const half = read(proLutApply(src, 0, 0, W, H, id, 0.5, W, H));
    out.halfVsMix = err(half, expect((r, g, b) => { const o = F(r, g, b); return [r + (o[0] - r) / 2, g + (o[1] - g) / 2, b + (o[2] - b) / 2]; }));
    // sub-rectangle (the crop uniform): right half of the source
    const t2 = document.createElement('canvas'); t2.width = W / 2; t2.height = H; t2.getContext('2d').drawImage(proLutApply(src, W / 2, 0, W / 2, H, id, 1, W / 2, H), 0, 0);
    const sub = t2.getContext('2d').getImageData(0, 0, W / 2, H).data, full = expect(F);
    let smx = 0; for (let y = 0; y < H; y++) for (let x = 0; x < W / 2; x++) for (let ch = 0; ch < 3; ch++) smx = Math.max(smx, Math.abs(sub[(y * W / 2 + x) * 4 + ch] - full[(y * W + x + W / 2) * 4 + ch]));
    out.subRectMax = smx;
    const idL = proLutAdd(proParseCube(cubes.identity));
    out.identity = err(read(proLutApply(src, 0, 0, W, H, idL, 1, W, H)), im.data);
    const inv = proLutAdd(proParseCube(cubes.invert1D, 'inv'));
    out.invert1D = err(read(proLutApply(src, 0, 0, W, H, inv, 1, W, H)), expect((r, g, b) => [1 - r, 1 - g, 1 - b]));
    const dom = proLutAdd(proParseCube(cubes.domain));
    out.domain = err(read(proLutApply(src, 0, 0, W, H, dom, 1, W, H)), expect((r, g, b) => [r / 2, g / 2, b / 2]));
    out.badFileMsg = (() => { try { proParseCube('hello world'); return false; } catch (e) { return /cube/i.test(e.message); } })();
    out.incompleteMsg = (() => { try { proParseCube('LUT_3D_SIZE 4\n0 0 0'); return false; } catch (e) { return /incomplete/i.test(e.message); } })();
    // pack/unpack keeps it within 16-bit precision
    const U = proLutUnpack(proLutPack(L)); let pm = 0; for (let i = 0; i < L.data.length; i++) pm = Math.max(pm, Math.abs(U.data[i] - L.data[i]));
    out.packErr = pm;

    // ---- in the real frame: clip, adjustment layer, save/load, undo ----
    state.media = [{ id: 'img', type: 'image', name: 'noise', duration: 10, w: W, h: H, el: src }];
    const cvs = document.getElementById('preview');
    const frame = () => { setTime(1); drawFrame(); const t = document.createElement('canvas'); t.width = W; t.height = H; const g = t.getContext('2d'); g.imageSmoothingEnabled = false; g.drawImage(cvs, 0, 0, W, H); return g.getImageData(0, 0, W, H).data; };
    // frame tests use a smooth image (a noise image would measure resampling, not grading)
    const sm = document.createElement('canvas'); sm.width = W; sm.height = H; const smg = sm.getContext('2d');
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { smg.fillStyle = `rgb(${x / (W - 1) * 255 | 0},${y / (H - 1) * 255 | 0},${(1 - x / (W - 1)) * 200 + 30 | 0})`; smg.fillRect(x, y, 1, 1); }
    state.media[0].el = sm;
    const clip = makeClip({ type: 'image', track: 'V1', start: 0, duration: 5, mediaId: 'img' }); state.clips = [clip]; renderTimeline();
    const plain = frame();
    // only pixels well inside the picture (the frame is 16:9, the image is pillarboxed; edges blend with black)
    const inside = new Uint8Array(plain.length / 4); for (let i = 0; i < inside.length; i++) { const x = i % W, y = (i / W) | 0; inside[i] = plain[i * 4 + 2] >= 30 && x > 0 && y > 0 && x < W - 1 && y < H - 1 && plain[i * 4 - 2] >= 30 && plain[i * 4 + 6] >= 30 ? 1 : 0; }
    const errIn = (a, b) => { let mx = 0, s = 0, n = 0; for (let i = 0; i < inside.length; i++) if (inside[i]) for (let ch = 0; ch < 3; ch++) { const d = Math.abs(a[i * 4 + ch] - b[i * 4 + ch]); mx = Math.max(mx, d); s += d; n++; } return { max: mx, mean: +(s / n).toFixed(3), n: n / 3 }; };
    clip.props.lutId = id; clip.props.lutAmt = 100;
    const graded = frame();
    out.clipChanged = err(plain, graded).mean > 5;
    // the preview smooths the upscale, so compare graded-frame against grade(plain-frame) through the analytic F
    const exp2 = new Uint8ClampedArray(plain.length); for (let i = 0; i < plain.length; i += 4) { const o = F(plain[i] / 255, plain[i + 1] / 255, plain[i + 2] / 255); exp2[i] = o[0] * 255; exp2[i + 1] = o[1] * 255; exp2[i + 2] = o[2] * 255; }
    out.clipVsAnalytic = errIn(graded, exp2);
    // the same LUT on an adjustment layer above an ungraded clip
    delete clip.props.lutId;
    const adj = makeClip({ type: 'adjust', track: 'V2', start: 0, duration: 5 }); adj.props.lutId = id; adj.props.lutAmt = 100;
    state.clips = [clip, adj]; renderTimeline();
    const viaAdj = frame();
    out.adjVsClip = errIn(viaAdj, graded);
    // save → load: LUT travels inside the project and the picture is unchanged
    const json = serializeProject(); const saved = JSON.parse(json);
    out.savedOnlyUsed = Object.keys(saved.luts || {}).length === 1 && !!saved.luts[id];
    state.luts = {};
    loadProjectJSON(json);
    out.mediaAfterLoad = state.media.map(m => m.id + ':' + !!m.el + ':' + !!m.missing).join(',');
    out.loadedLut = !!state.luts[id] && state.luts[id].size === 33;
    out.afterLoad = errIn(frame(), viaAdj);
    // inspector: the LUT section, choosing a LUT is one undo step
    const c0 = state.clips.find(c => c.type === 'image'); delete c0.props.lutId;
    state.selection = c0.id; state.selExtra = []; state.inspTab = 'clip'; renderInspector();
    const sel = document.getElementById('lutSel');
    out.inspector = !!sel && !!sel.title && [...sel.options].some(o => o.value === id) && [...sel.options].some(o => o.value === '__load');
    const h0 = state.hIndex;
    sel.value = id; await sel.onchange();
    out.pickSets = c0.props.lutId === id && state.hIndex === h0 + 1 && !!document.querySelector('[data-k="lutAmt"], #lutAmt, input[id*="lutAmt"]');
    undo();
    out.undoClears = !state.clips.find(c => c.type === 'image').props.lutId;
    // review fixes: shaper + 3D files, bad sizes, remux, texture cleanup, missing-LUT note
    const shp = ['LUT_1D_SIZE 1024', 'LUT_3D_SIZE 9', 'LUT_1D_INPUT_RANGE 0 1', 'LUT_3D_INPUT_RANGE 0 1'];
    for (let i = 0; i < 1024; i++) { const v = Math.sqrt(i / 1023).toFixed(6); shp.push(v + ' ' + v + ' ' + v); }
    for (let b = 0; b < 9; b++) for (let g = 0; g < 9; g++) for (let r = 0; r < 9; r++) shp.push([r / 8, g / 8, b / 8].join(' '));
    const SH = proLutAdd(proParseCube(shp.join('\n'), 'shaper'));
    out.shaper = err(read(proLutApply(src, 0, 0, W, H, SH, 1, W, H)), expect((r, g, b) => [Math.sqrt(r), Math.sqrt(g), Math.sqrt(b)]));
    { const G2 = _lutGL; _lutGL = false; out.shaperCpu = err(read(proLutApply(src, 0, 0, W, H, SH, 1, W, H)), expect((r, g, b) => [Math.sqrt(r), Math.sqrt(g), Math.sqrt(b)])); _lutGL = G2; }
    const SH2 = proLutAdd(proLutUnpack(proLutPack(state.luts[SH])));
    out.shaperPacked = err(read(proLutApply(src, 0, 0, W, H, SH2, 1, W, H)), expect((r, g, b) => [Math.sqrt(r), Math.sqrt(g), Math.sqrt(b)]));
    out.badSizes = ['LUT_1D_SIZE 1\n0 0 0', 'LUT_3D_SIZE 300\n0 0 0', 'LUT_3D_SIZE abc\n0 0 0'].every(t => { try { proParseCube(t); return false; } catch (e) { return true; } });
    const vc = makeClip({ type: 'video', track: 'V1', start: 0, duration: 3, mediaId: 'img' }); vc.props.lutId = id; state.clips = [vc];
    out.remuxLut = remuxEligibility().reasons.some(r => /LUT/.test(r));
    if (_lutGL) { const keep = state.luts[SH2]; state.luts = { [SH2]: keep }; proLutApply(src, 0, 0, W, H, SH2, 1, W, H); out.texPruned = Object.keys(_lutGL.tex).join() === SH2; } else out.texPruned = true;
    let note = ''; const t0 = toast; toast = (m) => { note += m; };
    loadProjectJSON(JSON.stringify({ app: 'vibe-edit', version: 2, project: { w: 640, h: 360, fps: 30 }, tracks: TRACKS, media: [], clips: [Object.assign(makeClip({ type: 'color', track: 'V1', start: 0, duration: 2 }), { props: Object.assign(defaultProps(), { lutId: 'lutGone' }) })] }));
    await new Promise(r => setTimeout(r, 20)); toast = t0;
    out.missingNote = /LUT/.test(note);
    return out;
  }, { analytic: analyticCube, identity: identityCube, invert1D, domain: domainCube }, F.toString());
  const L = R.lut;
  check('lut.parse', L.parsed && L.badFileMsg && L.incompleteMsg);
  check('lut.gpuAnalytic', L.gpu && L.gpuVsAnalytic.max <= 3 && L.gpuVsAnalytic.mean <= 0.6);
  check('lut.cpuAnalytic', L.cpuVsAnalytic.max <= 2 && L.cpuVsAnalytic.mean <= 0.5);
  check('lut.gpuMatchesCpu', L.gpuVsCpu.max <= 2);
  check('lut.intensity', L.halfVsMix.max <= 3);
  check('lut.subRect', L.subRectMax <= 3);
  check('lut.identity', L.identity.max <= 1);
  check('lut.oneD', L.invert1D.max <= 2);
  check('lut.domain', L.domain.max <= 2);
  check('lut.pack', L.packErr < 1e-4);
  check('lut.clip', L.clipChanged && L.clipVsAnalytic.max <= 3 && L.clipVsAnalytic.mean <= 0.5 && L.clipVsAnalytic.n > 3000);
  check('lut.adjust', L.adjVsClip.max <= 3);
  check('lut.saveLoad', L.savedOnlyUsed && L.loadedLut && L.afterLoad.max <= 1);
  check('lut.inspector', L.inspector && L.pickSets && L.undoClears);
  check('lut.shaper', L.shaper.max <= 2 && L.shaperCpu.max <= 2 && L.shaperPacked.max <= 2 && L.badSizes);
  check('lut.reviewFixes', L.remuxLut && L.texPruned && L.missingNote);

  // ---------------- 1b. built-in LUT library ----------------
  R.lutLib = await p.evaluate(async () => {
    const out = {}, md = (A, B) => Math.max(...A.flat().map((v, i) => Math.abs(v - B.flat()[i])));
    // gamut matrices from the primaries vs the manufacturers' / ITU published matrices
    out.sg3c = md(proGamutTo709('sgamut3cine'), [[1.6269474, -0.5401385, -0.0868089], [-0.1785155, 1.4179409, -0.2394254], [-0.0444361, -0.1959199, 1.2403560]]);
    out.awg3 = md(proGamutTo709('awg3'), [[1.617523, -0.537287, -0.080237], [-0.070573, 1.334613, -0.264040], [-0.021102, -0.226954, 1.248056]]);
    out.bt2087 = md(proGamutTo709('rec2020'), [[1.6605, -0.5876, -0.0728], [-0.1246, 1.1329, -0.0083], [-0.0182, -0.1006, 1.1187]]);
    // log curves: published 18 % gray code values, 0 % and continuity at every break
    out.gray = { slog3: PRO_LOGS.slog3(420 / 1023), vlog: PRO_LOGS.vlog(0.42329), logc3: PRO_LOGS.logc3(0.391007), applelog: PRO_LOGS.applelog(0.08550479 * Math.log2(0.18 + 0.00964052) + 0.69336945) };
    out.black = { slog3: PRO_LOGS.slog3(95 / 1023), vlog: PRO_LOGS.vlog(0.125), logc3: PRO_LOGS.logc3(0.092809) };
    const brk = { slog3: 171.2102946929 / 1023, vlog: 0.181, logc3: 5.367655 * 0.010591 + 0.092809, applelog: 47.28711236 * (0.01 + 0.05641088) ** 2 };
    out.continuity = Math.max(...Object.entries(brk).map(([k, x]) => Math.abs(PRO_LOGS[k](x - 1e-9) - PRO_LOGS[k](x + 1e-9))));
    out.monotonic = Object.keys(PRO_LOGS).every(k => { let p = -1e9; for (let i = 0; i <= 1000; i++) { const v = PRO_LOGS[k](i / 1000); if (v < p - 1e-12) return false; p = v; } return true; });
    // the generated LUTs: gray lands on Rec.709 gray and stays neutral
    const g709 = 1.099 * Math.pow(0.18, 0.45) - 0.099; out.grayOut = {};
    for (const [id, code] of [['slog3', 420 / 1023], ['vlog', 0.42329], ['logc3', 0.391007]]) { const L = proBuiltinLut(id), o = proLutSample(L, code, code, code); out.grayOut[id] = +Math.max(...o.map(v => Math.abs(v - g709))).toFixed(4); }
    const looks = PRO_LUT_LIB.filter(B => B.group === 'look').map(B => proBuiltinLut(B.id));
    out.looksValid = looks.every(L => L.data.every(v => v >= 0 && v <= 1)) && looks.every(L => { const o = proLutSample(L, 0.6, 0.4, 0.3); return Math.abs(o[0] - 0.6) + Math.abs(o[1] - 0.4) + Math.abs(o[2] - 0.3) > 0.02; });
    const mono = proBuiltinLut('mono'), mo = proLutSample(mono, 0.8, 0.2, 0.5); out.monoGray = Math.abs(mo[0] - mo[1]) < 1e-6 && Math.abs(mo[1] - mo[2]) < 1e-6;
    // projects store only the name; loading regenerates the same table
    const pk = proLutPack(proBuiltinLut('tealorange')), un = proLutUnpack(pk), ref = proBuiltinLut('tealorange');
    out.packSmall = !pk.b64 && JSON.stringify(pk).length < 100 && un.data.every((v, i) => v === ref.data[i]);
    // inspector: grouped menu; picking a built-in sets it
    state.media = [{ id: 'im', type: 'image', name: 'x', duration: 60, w: 64, h: 36, el: document.createElement('canvas') }];
    const c = makeClip({ type: 'image', track: 'V1', start: 0, duration: 5, mediaId: 'im' }); state.clips = [c]; state.selection = c.id; state.inspTab = 'clip'; renderInspector();
    const sel = document.getElementById('lutSel'); out.groups = [...sel.querySelectorAll('optgroup')].map(g => g.label);
    sel.value = 'b:slog3'; await sel.onchange(); out.picked = c.props.lutId === 'lutB_slog3' && !!state.luts.lutB_slog3;
    const j = JSON.parse(serializeProject()); out.savedByName = j.luts && j.luts.lutB_slog3 && j.luts.lutB_slog3.builtin === 'slog3' && !j.luts.lutB_slog3.b64;
    return out;
  });
  const LL = R.lutLib;
  check('lutLib.matrices', LL.sg3c < 1e-6 && LL.awg3 < 1e-6 && LL.bt2087 < 1e-4);
  check('lutLib.curves', Object.values(LL.gray).every(v => Math.abs(v - 0.18) < 1e-4) && Object.values(LL.black).every(v => Math.abs(v) < 1e-4) && LL.continuity < 1e-6 && LL.monotonic);
  check('lutLib.gray', Object.values(LL.grayOut).every(v => v < 0.005));
  check('lutLib.looks', LL.looksValid && LL.monoGray && LL.packSmall);
  check('lutLib.inspector', LL.groups.includes('Camera log → Rec.709') && LL.groups.includes('Looks') && LL.picked && LL.savedByName);

  // ---------------- 2. keyframe curves ----------------
  R.curves = await p.evaluate(async () => {
    const out = {};
    // cubic-bezier reference: dense parametric sampling (independent of the Newton solver)
    const ref = (B, u) => { let best = 0, bd = 1e9; for (let i = 0; i <= 200000; i++) { const s = i / 200000, x = 3 * (1 - s) * (1 - s) * s * B[0] + 3 * (1 - s) * s * s * B[2] + s * s * s; const d = Math.abs(x - u); if (d < bd) { bd = d; best = 3 * (1 - s) * (1 - s) * s * B[1] + 3 * (1 - s) * s * s * B[3] + s * s * s; } } return best; };
    let be = 0; for (const B of [[0.42, 0, 0.58, 1], [0.1, 0.9, 0.2, 1], [0.7, -0.4, 0.3, 1.5], [0, 0, 1, 1]]) for (const u of [0.05, 0.2, 0.37, 0.5, 0.81, 0.97]) be = Math.max(be, Math.abs(kfBezier(B, u) - ref(B, u)));
    out.bezierErr = be;
    out.presets = Math.abs(kfEase(0.5, 'in') - ref([0.42, 0, 1, 1], 0.5)) < 1e-4 && Math.abs(kfEase(0.5, 'out') - ref([0, 0, 0.58, 1], 0.5)) < 1e-4 && kfEase(0.3, 'linear') === 0.3 && kfEase(0.99, 'hold') === 0 && Math.abs(kfEase(0.3, 'smooth') - 0.3 * 0.3 * (3 - 0.6)) < 1e-12;
    // per-key types, falling back to the clip-wide mode
    const A = [{ t: 0, v: 0, i: 'linear' }, { t: 2, v: 10, i: 'hold' }, { t: 4, v: 0 }, { t: 6, v: 10 }];
    out.perKey = Math.abs(kfEval(A, 1, 'smooth') - 5) < 1e-12 && kfEval(A, 3, 'smooth') === 10 && Math.abs(kfEval(A, 4.5, 'smooth') - 10 * 0.25 * 0.25 * (3 - 0.5)) < 1e-12 && Math.abs(kfEval(A, 4.5, 'linear') - 2.5) < 1e-12;
    // splits keep every curve exactly (and pieces of pieces)
    state.media = [{ id: 'im', type: 'image', name: 'x', duration: 60, w: 64, h: 36, el: document.createElement('canvas') }];
    const c = makeClip({ type: 'image', track: 'V1', start: 1, duration: 8, mediaId: 'im' });
    c.kf = { x: [{ t: 0, v: -40, i: 'bezier', b: [0.8, -0.3, 0.2, 1.3] }, { t: 2, v: 30, i: 'in' }, { t: 4.5, v: -10, i: 'hold' }, { t: 5.5, v: 20, i: 'out' }, { t: 7.5, v: 0 }],
      scale: [{ t: 1, v: 1 }, { t: 6, v: 2, i: 'linear' }, { t: 7, v: 1.5 }] };
    state.clips = [c];
    const orig = JSON.parse(JSON.stringify(c)), TS = []; for (let t = 1.01; t < 9; t += 0.0731) TS.push(t);
    const val = (cl, t, k) => liveProps(cl, t)[k];
    const cuts = [2.3, 3.9, 6.05, 7.2];
    let pieces = [c]; for (const t of cuts) { const q = pieces.find(x => t > x.start && t < clipEnd(x)); const L = aiClipSub(q, q.start, t), Rr = aiClipSub(q, t, clipEnd(q)); pieces.splice(pieces.indexOf(q), 1, L, Rr); }
    // a piece of a piece
    const pp = pieces[2], sub = [aiClipSub(pp, pp.start, pp.start + 0.4), aiClipSub(pp, pp.start + 0.4, clipEnd(pp))]; pieces.splice(2, 1, ...sub);
    let se = 0; for (const t of TS) { const q = pieces.find(x => t >= x.start && t < clipEnd(x)); for (const k of ['x', 'scale']) se = Math.max(se, Math.abs(val(q, t, k) - val(orig, t, k))); }
    out.splitErr = se;
    // a hand edit on a piece keeps each segment's type
    const q2 = JSON.parse(JSON.stringify(pieces[1])); const typesBefore = q2.kf.x.map(k => (k.e ? k.e.i : k.i) || null);
    kfUpsert(q2, 'x', 5, 0.2); out.upsertKeepsType = q2.kf.x.filter(k => k.t !== 0.2).every(k => !k.e) && q2.kf.x.some(k => k.i === typesBefore[0]);
    // primitives
    const d = JSON.parse(JSON.stringify(orig)); state.clips = [d];
    out.moveClamped = (proCurveMoveKey(d, 'x', 1, 99, 3), d.kf.x[1].t === +(4.5 - KF_EPS).toFixed(3) && d.kf.x[1].v === 3);
    const snapX = JSON.parse(JSON.stringify(d.kf.x)); const ni = proCurveAddKey(d, 'x', 3.1);
    let ae = 0; for (let t = 0; t < 8; t += 0.013) ae = Math.max(ae, Math.abs(kfEval(d.kf.x, t, 'smooth') - kfEval(snapX, t, 'smooth')));
    out.addKeepsMotion = ni === 1 && ae < 1e-9 && proKfType(d, d.kf.x[1]) === 'bezier';
    // on a split piece, adding a key leaves the whole piece's motion alone (review v4.8 #4)
    const pc = JSON.parse(JSON.stringify(pieces[1])), snapP = JSON.parse(JSON.stringify(pc.kf.x)); proCurveAddKey(pc, 'x', pc.duration * 0.6);
    let pe = 0; for (let t = 0; t < pc.duration; t += 0.007) pe = Math.max(pe, Math.abs(kfEval(pc.kf.x, t, 'smooth') - kfEval(snapP, t, 'smooth')));
    out.addOnPieceExact = pe < 1e-9;
    // moving a key's value only re-shapes the two segments that meet at it
    const pm = JSON.parse(JSON.stringify(pieces[1])), snapM = JSON.parse(JSON.stringify(pm.kf.x)), last = pm.kf.x.length - 1;
    proCurveMoveKey(pm, 'x', last, null, pm.kf.x[last].v + 5);
    let me = 0; for (let t = 0; t < pm.kf.x[last - 1].t; t += 0.007) me = Math.max(me, Math.abs(kfEval(pm.kf.x, t, 'smooth') - kfEval(snapM, t, 'smooth')));
    out.moveLocal = pm.kf.x.length > 2 ? me < 1e-9 : true;
    proCurveDeleteKey(d, 'scale', 0); proCurveDeleteKey(d, 'scale', 0); proCurveDeleteKey(d, 'scale', 0);
    out.deleteLastEnds = !d.kf.scale && d.props.scale === 1.5;
    // the dialog: types, one undo step, add/delete, reset
    state.clips = [JSON.parse(JSON.stringify(orig))]; const e = state.clips[0]; state.selection = e.id; state.inspTab = 'clip'; renderInspector();
    out.inspectorButton = !!document.getElementById('kfCurves') && !!document.getElementById('kfCurves').title;
    const h0 = state.hIndex;
    document.getElementById('kfCurves').click(); await new Promise(r => setTimeout(r, 50));
    const types = [...document.querySelectorAll('.cv-type')];
    out.dialog = !!document.getElementById('cvGraph') && types.length === 6 && types.every(b => b.title && b.id) && document.querySelectorAll('.cv-prop').length === 2;
    document.getElementById('cvType_linear').click(); document.getElementById('cvType_out').click();
    out.typeSet = e.kf.x[0].i === 'out' && !e.kf.x[0].b;
    document.getElementById('cvType_bezier').click(); out.bezierDefault = JSON.stringify(e.kf.x[0].b) === '[0.33,0,0.67,1]';
    document.getElementById('cvAll').click(); out.applyAll = e.kf.x.every(k => k.i === 'bezier');
    const cv = document.getElementById('cvGraph'), r = cv.getBoundingClientRect();
    cv.dispatchEvent(new MouseEvent('dblclick', { clientX: r.left + r.width * 0.5, clientY: r.top + r.height * 0.5, bubbles: true }));
    out.dblAdds = e.kf.x.length === 6;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    out.deleteKey = e.kf.x.length === 5 && state.clips.length === 1;
    document.getElementById('cvReset').click(); out.reset = e.kf.x.every(k => !k.i);
    out.oneUndoStep = state.hIndex === h0 + 1;
    document.getElementById('cvDone').click();
    out.closed = !document.querySelector('#overlay.show') && !document.getElementById('cvGraph');
    // the clip-wide easing menu clears per-key overrides
    e.kf.x[0].i = 'hold'; renderInspector(); const es = document.getElementById('kfEase'); es.value = 'linear'; es.onchange({ target: es });
    out.clipModeClears = e.kf.x.every(k => !k.i) && e.kfEaseMode === 'linear';
    return out;
  });
  const K = R.curves;
  check('curves.bezier', K.bezierErr < 2e-4 && K.presets);
  check('curves.perKey', K.perKey);
  check('curves.splitExact', K.splitErr < 1e-9);
  check('curves.handEdit', K.upsertKeepsType);
  check('curves.primitives', K.moveClamped && K.addKeepsMotion && K.addOnPieceExact && K.moveLocal && K.deleteLastEnds);
  check('curves.dialog', K.inspectorButton && K.dialog && K.typeSet && K.bezierDefault && K.applyAll && K.dblAdds && K.deleteKey && K.reset && K.oneUndoStep && K.closed);
  check('curves.clipMode', K.clipModeClears);

  // real mouse drags on the graph, with the dialog opened while scaled (its opening
  // animation): the key under the pointer must be the one that moves (found on the PC)
  {
    const g = await p.evaluate(async () => {
      state.media = [{ id: 'im', type: 'image', name: 'x', duration: 60, w: 64, h: 36, el: document.createElement('canvas') }];
      const c = makeClip({ type: 'image', track: 'V1', start: 0, duration: 30, mediaId: 'im' }); c.kf = { x: [{ t: 9, v: 0 }, { t: 12, v: 100 }] }; state.clips = [c]; state.time = 0;
      // headless frames are irregular, so replace the opening animation by a fixed scale that is removed after opening
      const st = document.createElement('style'); st.id = 'noAnim'; st.textContent = '#overlay .modal{animation:none!important}'; document.head.appendChild(st);
      const ov = document.getElementById('overlay'); ov.style.transform = 'scale(0.8)';
      window._cvh = proCurvesOpen(c, 'x'); for (let i = 0; i < 4; i++) await new Promise(r => requestAnimationFrame(r)); await new Promise(r => setTimeout(r, 60)); ov.style.transform = '';
      await new Promise(r => setTimeout(r, 700));   // past the opening animation
      const r = document.getElementById('cvGraph').getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height };
    });
    // key 2 (t=12, v=100): x from the time axis; y = the top key row, found by scanning the canvas
    const [kx, ky] = await p.evaluate(() => window._cvh.keyAt(1));
    await p.mouse.move(kx, ky); await p.mouse.down(); await p.mouse.move(kx, ky + 40, { steps: 6 }); await p.mouse.up();
    R.curveDrag = await p.evaluate(() => { const k = state.clips[0].kf.x; const out = { t: k[1].t, v: k[1].v, first: k[0].v }; document.getElementById('noAnim').remove(); document.getElementById('cvDone').click(); return out; });
    check('curves.mouseDrag', R.curveDrag.t === 12 && R.curveDrag.v < 90 && R.curveDrag.first === 0);
  }

  // ---------------- 3. speed ramps ----------------
  R.ramp = await p.evaluate(async () => {
    const out = {};
    state.media = [{ id: 'vm', type: 'video', name: 'v', duration: 120, w: 64, h: 36 }];
    const mk = o => { const c = makeClip(Object.assign({ type: 'video', track: 'V1', start: 2, duration: 6, mediaId: 'vm' }, o)); c.inPoint = 10; return c; };
    const c = mk(); state.clips = [c]; const span0 = c.duration * c.props.speed;
    state.time = 0; proRampApply(c, 'hero');
    // independent integral of the speed curve (Simpson, 20000 steps)
    const S = q => rampS(c.ramp.pts, q), simpson = (f, a, b, n = 20000) => { const h = (b - a) / n; let s = f(a) + f(b); for (let i = 1; i < n; i++) s += f(a + i * h) * (i % 2 ? 4 : 2); return s * h / 3; };
    const D = span0 * simpson(q => 1 / S(q), 0, 1);
    out.spanKept = Math.abs(c.duration * c.props.speed - span0) < 1e-9;
    out.durErr = Math.abs(c.duration - D) / D;
    // srcTimeFor against the integral: t - start = span ∫0^p dq/S
    let te = 0, mono = true, prev = -1, de = 0;
    for (let k = 0; k <= 300; k++) {
      const t = c.start + c.duration * k / 300, s = srcTimeFor(c, t), pr = (s - 10) / span0;
      te = Math.max(te, Math.abs(t - c.start - span0 * simpson(q => 1 / S(q), 0, pr, 2000)));
      if (s < prev - 1e-12) mono = false; prev = s;
      if (k > 0 && k < 300) { const h = 1e-4, fd = (srcTimeFor(c, t + h) - srcTimeFor(c, t - h)) / (2 * h); de = Math.max(de, Math.abs(fd - rampSpeedAt(c, t)) / fd); }
    }
    out.mapErr = te; out.monotonic = mono; out.speedErr = de;
    out.ends = Math.abs(srcTimeFor(c, c.start) - 10) < 1e-9 && Math.abs(srcTimeFor(c, clipEnd(c) - 1e-9) - (10 + span0)) < 1e-6;
    let ie = 0; for (let k = 0; k <= 50; k++) { const t = c.start + c.duration * k / 50; ie = Math.max(ie, Math.abs(rampSrcToTl(c, srcTimeFor(c, t)) - t)); }
    out.inverseErr = ie;
    out.slowInMiddle = rampSpeedAt(c, c.start + c.duration / 2) < 0.4 && rampSpeedAt(c, c.start + 0.05) > 1.2;
    // splits: every piece plays exactly what the whole did (forward and reversed)
    let se = 0;
    for (const rev of [false, true]) {
      const w = mk(); w.props.reverse = rev; state.time = 0; proRampApply(w, 'montage'); const orig = JSON.parse(JSON.stringify(w));
      let pieces = [w]; for (const f of [0.17, 0.43, 0.61, 0.88]) { const t = orig.start + orig.duration * f, q = pieces.find(x => t > x.start && t < clipEnd(x)); pieces.splice(pieces.indexOf(q), 1, aiClipSub(q, q.start, t), aiClipSub(q, t, clipEnd(q))); }
      const pp = pieces[1]; pieces.splice(1, 1, aiClipSub(pp, pp.start, pp.start + 0.3), aiClipSub(pp, pp.start + 0.3, clipEnd(pp)));
      for (let k = 0; k < 400; k++) { const t = orig.start + orig.duration * (k + 0.5) / 400, q = pieces.find(x => t >= x.start && t < clipEnd(x)); se = Math.max(se, Math.abs(srcTimeFor(q, t) - srcTimeFor(orig, t))); }
      out['piecesSpan' + (rev ? 'Rev' : '')] = Math.abs(pieces.reduce((s, q) => s + q.duration * q.props.speed, 0) - span0) < 1e-6;
    }
    out.splitErr = se;
    // the Speed slider scales the whole ramp and keeps the source
    const v = mk(); state.clips = [v]; state.time = 0; proRampApply(v, 'flashIn'); const pts0 = JSON.stringify(v.ramp.pts), sp0 = v.props.speed, sp1 = sp0 * 1.5;
    state.selection = v.id; state.inspTab = 'clip'; renderInspector();
    const sl = document.querySelector('#inspBody input[data-k="speed"]'); sl.value = sp1; const spSet = +sl.value, k15 = spSet / sp0; sl.oninput();
    out.sliderScales = Math.abs(v.props.speed - spSet) < 1e-9 && Math.abs(v.duration * v.props.speed - span0) < 1e-9 && Math.abs(v.ramp.pts[0][1] / JSON.parse(pts0)[0][1] - k15) < 1e-9
      && Math.abs(v.duration - span0 * rampTable(v).T[RAMP_N]) < 1e-6;
    // inspector section: presets, graph, one undo step, removal keeps the length
    renderInspector();
    const bs = [...document.querySelectorAll('#inspBody .ramp-presets button')];
    out.section = bs.length === PRO_RAMPS.length + 1 && bs.every(b => b.title && b.id) && !!document.getElementById('rampGraph');
    const h0 = state.hIndex; document.getElementById('ramp_bullet').click();
    out.presetClick = state.clips[0].ramp.preset === 'bullet' && state.hIndex === h0 + 1;
    out.timelineBadge = !!document.querySelector('.clip .ramp-line') && !!document.querySelector('.clip .ramp-tag');
    const len = state.clips[0].duration; document.getElementById('rampNone').click();
    out.removeKeepsLength = !state.clips[0].ramp && Math.abs(state.clips[0].duration - len) < 1e-9;
    undo(); out.undoRestores = !!state.clips[0].ramp;
    // export paths: never stream-copied, sound through the browser mix
    const u = state.clips[0];
    out.noRemux = remuxEligibility().reasons.some(x => /Speed/.test(x)); out.noFfmpegMix = _audioSpecSupported() === false;
    // save/load keeps the ramp, without the cached table
    const j = JSON.parse(serializeProject()); out.saved = !!j.clips[0].ramp && !('_t' in j.clips[0].ramp);
    // preview: the element plays at the ramp's speed right now
    const stub = { currentTime: 0, paused: true, playbackRate: 1, volume: 1, play() { return Promise.resolve(); }, pause() { } };
    els.vm = stub; state.playing = false;
    for (const f of [0.1, 0.5, 0.9]) { state.time = u.start + u.duration * f; syncMediaPlayback(); out['rate' + f] = +(stub.playbackRate / rampSpeedAt(u, state.time)).toFixed(6); }
    delete els.vm;
    // review fixes: detached sound follows the ramp; freeze drops it; the slider can't push points out of range; paste speed carries it
    const dv = mk(); state.clips = [dv]; state.time = 0; proRampApply(dv, 'hero'); state.media[0].url = 'data:,'; detachAudio(dv);
    const da = state.clips.find(x => x.type === 'audio'); let dd = 0; for (let k = 1; k < 20; k++) { const t = dv.start + dv.duration * k / 20; dd = Math.max(dd, Math.abs(srcTimeFor(da, t) - srcTimeFor(dv, t))); }
    out.detachSync = !!da.ramp && dd < 1e-9;
    const fz = mk(); state.clips = [fz]; state.time = 0; proRampApply(fz, 'hero'); const ft = fz.start + fz.duration * 0.4, fsrc = srcTimeFor(fz, ft);
    freezeFrameAt(fz, ft); const hold = state.clips.find(x => x.freeze);
    out.freezeDropsRamp = !!hold && !hold.ramp && Math.abs(hold.freezeAt - fsrc) < 1e-9;
    const bt = mk(); state.clips = [bt]; state.time = 0; proRampApply(bt, 'bullet'); state.selection = bt.id; state.inspTab = 'clip'; renderInspector();
    const sl2 = document.querySelector('#inspBody input[data-k="speed"]'); sl2.value = 0.25; sl2.oninput();
    const spanB = bt.duration * bt.props.speed; out.sliderInRange = bt.ramp.pts.every(q => q[1] >= 0.1 - 1e-9 && q[1] <= 10 + 1e-9);
    const durB = bt.duration; proRampEdit(bt, () => { }); out.sliderConsistent = Math.abs(bt.duration - durB) / durB < 1e-6 && Math.abs(bt.duration * bt.props.speed - spanB) < 1e-9;
    const ps = mk(), pd = mk(); pd.start = 20; state.clips = [ps, pd]; state.time = 0; proRampApply(ps, 'flashOut'); const spanD = pd.duration * pd.props.speed;
    clipboardClip = JSON.parse(JSON.stringify(ps)); state.selection = pd.id; state.selExtra = []; pasteAttrsDialog();
    document.querySelectorAll('#overlay [data-pa]').forEach(b => { b.checked = b.dataset.pa === 'speed'; }); document.getElementById('paApply').click();
    out.pasteSpeed = !!pd.ramp && Math.abs(pd.duration * pd.props.speed - spanD) < 1e-9 && Math.abs(pd.duration - spanD * rampTable(pd).T[RAMP_N]) < 1e-6;
    closeOverlay();
    // sound: a source whose samples ARE their own time stamps
    const SR = 8000, N = 120 * SR, ctx = new OfflineAudioContext(1, 10, SR), buf = ctx.createBuffer(1, N, SR), d = buf.getChannelData(0);
    for (let i = 0; i < N; i++) d[i] = i / SR / 128;           // scaled to stay in range as float anyway
    const snd = mk(); snd.props.preservePitch = false; state.time = 0; proRampApply(snd, 'hero');
    const ob = proRampBuffer(ctx, snd, buf), o = ob.getChannelData(0); let ae = 0;
    for (let i = 0; i < o.length - 1; i += 37) ae = Math.max(ae, Math.abs(o[i] * 128 - rampTlToSrc(snd, snd.start + i / SR)));
    out.soundLen = Math.abs(ob.length - Math.round(snd.duration * SR)) <= 1; out.soundMapErr = ae;
    // pitch-preserved: clicks land where the picture says, and a tone keeps its pitch
    const SR2 = 16000, N2 = 40 * SR2, b2 = ctx.createBuffer(1, N2, SR2), d2 = b2.getChannelData(0);
    for (let i = 0; i < N2; i++) d2[i] = 0.3 * Math.sin(2 * Math.PI * 440 * i / SR2);
    const tone = mk(); tone.inPoint = 5; tone.props.preservePitch = true; state.time = 0; proRampApply(tone, 'hero');
    const tb = proRampBuffer(ctx, tone, b2).getChannelData(0);
    const zc = (a, i0, i1) => { let n = 0; for (let i = i0 + 1; i < i1; i++) if ((a[i - 1] < 0) !== (a[i] < 0)) n++; return n / 2 / ((i1 - i0) / SR2); };
    const mid = Math.round(tb.length / 2), q = Math.round(0.25 * SR2);
    out.pitchSlow = +zc(tb, mid - q, mid + q).toFixed(1); out.pitchFast = +zc(tb, Math.round(0.2 * SR2), Math.round(0.7 * SR2)).toFixed(1);
    return out;
  });
  // the ramp's sound through the real offline mix (what every export uses): a
  // click every 0.5 s of source must land where the picture mapping puts it
  {
    const SR = 16000, N = SR * 30, wav = Buffer.alloc(44 + N * 2);
    wav.write('RIFF', 0); wav.writeUInt32LE(36 + N * 2, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(SR, 24); wav.writeUInt32LE(SR * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(N * 2, 40);
    for (let k = 1; k < 60; k++) { const i0 = Math.round(k * 0.5 * SR); for (let i = 0; i < 16; i++) wav.writeInt16LE(Math.round(20000 * Math.exp(-i / 3)), 44 + (i0 + i) * 2); }
    const f = path.join(require('os').tmpdir(), 'vibe-clicks.wav'); require('fs').writeFileSync(f, wav);
    const cid = await addWavMedia(p, f, { name: 'clicks.wav' });
    R.rampMix = await p.evaluate(async (cid) => {
      const m = state.media.find(x => x.id === cid); els[cid] = new Audio(m.url);
      const c = makeClip({ type: 'audio', track: 'A1', start: 1, duration: 6, mediaId: cid }); c.inPoint = 3; c.props.preservePitch = false;
      state.clips = [c]; state.time = 0; proRampApply(c, 'hero');
      const b = await renderAudioOffline(clipEnd(c) + 0.5, 48000), d = b.getChannelData(0), SR = b.sampleRate;
      const got = []; for (let i = 1; i < d.length; i++) if (d[i] > 0.25 && d[i - 1] <= 0.25) { got.push(i / SR); i += Math.round(0.02 * SR); }
      const want = []; for (let s = 3; s < 3 + c.duration * c.props.speed - 1e-3; s += 0.5) want.push(rampSrcToTl(c, s));
      let e = 0; for (const w of want) e = Math.max(e, Math.min(...got.map(g => Math.abs(g - w))));
      return { n: got.length, want: want.length, maxErr: +e.toFixed(5) };
    }, cid);
  }
  const Q = R.ramp;
  check('ramp.duration', Q.spanKept && Q.durErr < 1e-4);
  check('ramp.mapping', Q.mapErr < 2e-3 && Q.monotonic && Q.ends && Q.inverseErr < 1e-9 && Q.slowInMiddle);
  check('ramp.speed', Q.speedErr < 5e-3);
  check('ramp.splitExact', Q.splitErr < 1e-5 && Q.piecesSpan && Q.piecesSpanRev);
  check('ramp.slider', Q.sliderScales);
  check('ramp.inspector', Q.section && Q.presetClick && Q.timelineBadge && Q.removeKeepsLength && Q.undoRestores);
  check('ramp.export', Q.noRemux && Q.noFfmpegMix && Q.saved);
  check('ramp.previewRate', [0.1, 0.5, 0.9].every(f => Math.abs(Q['rate' + f] - 1) < 1e-6));
  check('ramp.sound', Q.soundLen && Q.soundMapErr < 2e-3);
  check('ramp.mix', R.rampMix.n === R.rampMix.want && R.rampMix.maxErr < 0.002);
  check('ramp.reviewFixes', Q.detachSync && Q.freezeDropsRamp && Q.sliderInRange && Q.sliderConsistent && Q.pasteSpeed);
  check('ramp.pitch', Math.abs(Q.pitchSlow - 440) < 12 && Math.abs(Q.pitchFast - 440) < 12);

  // a ducked, speed-ramped music clip that is split afterwards: Remove ducking still
  // recognizes its own keys in every piece (v4.9 fix)
  R.duckRamp = await p.evaluate(() => {
    state.media = [{ id: 'mm', type: 'audio', name: 'm', duration: 120 }];
    const c = makeClip({ type: 'audio', track: 'A2', start: 0, duration: 20, mediaId: 'mm' }); c.inPoint = 5; state.clips = [c]; state.time = 0;
    proRampApply(c, 'montage');
    c.kf = { volume: [{ t: 0, v: 1 }, { t: 3, v: 1 }, { t: 3.4, v: 0.25 }, { t: 7, v: 0.25 }, { t: 7.6, v: 1 }, { t: 11, v: 1 }, { t: 11.3, v: 0.25 }, { t: c.duration, v: 0.25 }] };
    c.duck = { prev: null, sig: _proVolSig(c), db: -12, keys: JSON.parse(JSON.stringify(c.kf.volume)), in0: c.inPoint, sp: c.props.speed, dur: c.duration, ramp: JSON.parse(JSON.stringify(c.ramp)) };
    const t1 = c.start + c.duration * 0.37, t2 = c.start + c.duration * 0.71;
    const pieces = [aiClipSub(c, c.start, t1), aiClipSub(c, t1, t2), aiClipSub(c, t2, clipEnd(c))];
    return pieces.map(q => proUnduckClip(q) && !(q.kf && q.kf.volume));
  });
  check('ramp.duckSplit', R.duckRamp.every(Boolean));

  // ---------------- 5. speed & reverse on compound clips ----------------
  // What plays at outer time t must be the inner timeline at inPoint + (t-start)*speed
  // (mirrored when reversed): compare against the same compound at speed 1.
  {
    const SR = 16000, N = SR * 8, wav = Buffer.alloc(44 + N * 2);
    wav.write('RIFF', 0); wav.writeUInt32LE(36 + N * 2, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(SR, 24); wav.writeUInt32LE(SR * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(N * 2, 40);
    const clickT = [0.7, 1.9, 2.6, 4.1, 5.5]; for (const ct of clickT) { const i0 = Math.round(ct * SR); for (let i = 0; i < 24; i++) wav.writeInt16LE(Math.round(22000 * (i < 12 ? i / 12 : (24 - i) / 12)), 44 + (i0 + i) * 2); }
    const f = path.join(require('os').tmpdir(), 'vibe-clicks2.wav'); fs.writeFileSync(f, wav);
    const cid = await addWavMedia(p, f, { name: 'clicks2.wav' });
    R.cmpSpeed = await p.evaluate(async (cid, clickT) => {
      const out = {};
      const mk = (col, w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); g.fillStyle = col; g.fillRect(0, 0, w, h); g.fillStyle = '#fff'; g.fillRect(w / 2 - 10, h / 2 - 10, 20, 20); return c; };
      const am = state.media.find(m => m.id === cid); els[cid] = new Audio(am.url);
      state.media = [am, { id: 'ra', type: 'image', name: 'red', duration: 30, w: 320, h: 180, el: mk('#d33', 320, 180) }, { id: 'rb', type: 'image', name: 'blue', duration: 30, w: 160, h: 90, el: mk('#33d', 160, 90) }];
      state.project.w = 640; state.project.h = 360;
      const build = () => {
        const A = makeClip({ type: 'image', track: 'V1', start: 0, duration: 6, mediaId: 'ra' });
        A.kf = { x: [{ t: 0, v: -30, i: 'in' }, { t: 1.5, v: 20, i: 'bezier', b: [0.7, -0.2, 0.3, 1.2] }, { t: 3, v: -10, i: 'hold' }, { t: 4.2, v: 25, i: 'out' }, { t: 5.5, v: 0 }], scale: [{ t: 0.5, v: 0.6 }, { t: 5, v: 1.2 }] };
        const B = makeClip({ type: 'image', track: 'V2', start: 1, duration: 3.5, mediaId: 'rb' }); B.props.scale = 0.5; B.props.fadeIn = 0.8; B.props.fadeOut = 1.1; B.kf = { y: [{ t: 0, v: -25 }, { t: 3.5, v: 25 }] };
        const S = makeClip({ type: 'audio', track: 'A1', start: 0, duration: 7, mediaId: cid }); S.props.preservePitch = false;
        state.clips = [A, B, S]; state.selection = A.id; state.selExtra = [B.id, S.id]; return proMakeCompound();
      };
      const cvs = document.getElementById('preview');
      const frame = t => { setTime(t); drawFrame(); return cvs.getContext('2d').getImageData(0, 0, cvs.width, cvs.height).data; };
      const diff = (a, b) => { let s = 0, mx = 0; for (let i = 0; i < a.length; i += 8) { const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]); s += d; if (d > mx) mx = d; } return { mean: s / (a.length / 8 * 3), max: mx }; };
      const cmp = build(); const st = cmp.start, D = cmp.duration;
      const TAU = [0.3, 1.1, 2.2, 2.95, 3.4, 4.6, 5.3, 6.4];
      const ref = TAU.map(tau => frame(st + tau));
      const peaks = async (D) => { const b = await renderAudioOffline(D, 48000), d = b.getChannelData(0), SR = b.sampleRate, out = []; for (let i = 1; i < d.length - 1; i++) if (d[i] > 0.3 && d[i] >= d[i - 1] && d[i] > d[i + 1]) { out.push(i / SR); i += Math.round(0.05 * SR); } return out; };
      const near = (got, want) => Math.max(...want.map(w => Math.min(...got.map(g => Math.abs(g - w)))));
      for (const [sp, rev] of [[2, false], [0.5, false], [1, true], [1.5, true]]) {
        cmp.props.speed = sp; cmp.props.reverse = rev; cmp.duration = D / sp; proCmpTouched();
        const tOf = tau => rev ? st + (D - tau) / sp : st + tau / sp;
        let worst = 0; TAU.forEach((tau, i) => { const d = diff(frame(tOf(tau)), ref[i]); worst = Math.max(worst, d.mean); });
        const got = await peaks(st + D / sp + 0.3), want = clickT.filter(c => c < D).map(c => tOf(c + 12 / 16000));
        let wrong = 0; TAU.forEach((tau, i) => { wrong = Math.max(wrong, diff(frame(tOf(tau) + 0.15), ref[i]).mean); });
        out[sp + (rev ? 'rev' : '')] = { picture: +worst.toFixed(4), wrong: +wrong.toFixed(4), clicks: got.length, want: want.length, clickErr: +near(got, want).toFixed(4) };
      }
      // break apart keeps the timing: picture after = picture before
      cmp.props.speed = 2; cmp.props.reverse = true; cmp.duration = D / 2; proCmpTouched();
      const before = TAU.map(tau => frame(st + (D - tau) / 2));
      state.selection = cmp.id; proBreakCompound(cmp);
      let bw = 0; TAU.forEach((tau, i) => { bw = Math.max(bw, diff(frame(st + (D - tau) / 2), before[i]).mean); });
      out.breakSame = +bw.toFixed(4); out.breakClips = state.clips.length;
      // review fixes: open/close through speed; compound volume reaches fragment keys; stabilization follows
      const c2 = build(); c2.props.speed = 2; c2.inPoint = 1; c2.duration = 2.5; proCmpTouched();
      setTime(c2.start + 1); proOpenCompound(c2); out.openTime = +state.time.toFixed(6);
      state.clips = state.clips.filter(x => x.type !== 'audio').map(x => { x.duration = Math.min(x.duration, 4 - x.start); return x; });   // shorten the inside to 4 s
      proCloseCompound(); const c3 = state.clips.find(x => x.type === 'compound');
      out.closeFit = Math.abs(c3.inPoint + c3.duration * 2 - 4) < 1e-6;
      const c4 = build(); const au = c4.inner.clips.find(x => x.type === 'audio'); au.kf = { volume: [{ t: 0, v: 1, i: 'linear' }, { t: 7, v: 0.2 }] };
      c4.props.volume = 0.5; c4.props.reverse = true; proCmpTouched();
      const va = _cmpVirtual(c4, true).find(x => x.type === 'audio');
      const want = t => 0.5 * (1 + (0.2 - 1) * ((c4.start + c4.duration - t) - c4.start) / 7);   // mirrored, halved
      out.volFrag = Math.max(...[0.5, 2, 4.5].map(t => Math.abs(kfEval(va.kf.volume, t - va.start, va.kfEaseMode || 'smooth') * (va.kf.volume ? 1 : va.props.volume) - want(c4.start + t))));
      const c5 = build(); const im = c5.inner.clips.find(x => x.type === 'image'); im.props.stabMode = 'smooth'; const n = 150;
      im.stab = { fps: 25, n, dx: [...Array(n)].map((_, i) => Math.sin(i / 7) * 0.02), dy: [...Array(n)].map((_, i) => Math.cos(i / 9) * 0.02), rot: [...Array(n)].map((_, i) => i * 0.001), sc: [...Array(n)].map(() => 1) };
      c5.props.speed = 2; c5.props.reverse = true; proCmpTouched();
      const vi = _cmpVirtual(c5, false).find(x => x.type === 'image');
      let se = 0; for (const tau of [0.4, 1.3, 2.9, 4.2]) { const t = c5.start + (c5.duration * 2 - tau) / 2, a = _stabCorrection(vi, t), b = _stabCorrection(im, im.start + tau); se = Math.max(se, Math.abs(a.dx - b.dx), Math.abs(a.dy - b.dy)); }
      out.stab = se;
      return out;
    }, cid, clickT);
    for (const k of ['2', '0.5', '1rev', '1.5rev']) { const q = R.cmpSpeed[k]; check('compound.speed' + k, q.picture < 0.01 && q.wrong > 0.2 && q.clicks === q.want && q.clickErr < 0.003); }
    check('compound.speedBreak', R.cmpSpeed.breakSame < 0.01 && R.cmpSpeed.breakClips === 3);
    check('compound.speedOpenClose', Math.abs(R.cmpSpeed.openTime - 3) < 1e-6 && R.cmpSpeed.closeFit);
    check('compound.speedVolume', R.cmpSpeed.volFrag < 1e-6);
    check('compound.speedStab', R.cmpSpeed.stab < 0.002);
  }

  // ---------------- 6. color scopes ----------------
  R.scopes = await p.evaluate(async () => {
    const out = {}, w = 160, h = 40, d = new Uint8ClampedArray(w * h * 4);
    const bars = [[191, 191, 191], [191, 191, 0], [0, 191, 191], [0, 191, 0], [191, 0, 191], [191, 0, 0], [0, 0, 191], [0, 0, 0]];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const c = bars[Math.floor(x / 20)], i = (y * w + x) * 4; d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255; }
    const S = proScopeCompute(d, w, h, 181);
    // luma: every column has all its pixels at its bar's luma
    let lumaOK = true; for (let x = 0; x < w; x++) { const c = bars[Math.floor(x / 20)], Y = Math.round(0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]); if (S.luma[Y * w + x] !== h) lumaOK = false; }
    out.luma = lumaOK;
    let parOK = true; for (let x = 0; x < w; x++) { const c = bars[Math.floor(x / 20)]; for (let ch = 0; ch < 3; ch++) if (S.rgb[ch][c[ch] * w + x] !== h) parOK = false; }
    out.parade = parOK;
    // vectorscope: each colored bar lands in its 75% target box
    const VN = 181, cc = 90, names = { 1: 'Yl', 2: 'Cy', 3: 'G', 4: 'Mg', 5: 'R', 6: 'B' }; let vecOK = true;
    for (const [bi, n] of Object.entries(names)) { const t = PRO_SC_TARGETS.find(q => q.n === n), x = Math.round(cc + t.cb * 2 * cc), y = Math.round(cc - t.cr * 2 * cc); let cnt = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) cnt += S.vec[(y + dy) * VN + x + dx]; if (cnt !== 20 * h) vecOK = false; }   // within a bin of the box center
    out.vectorscope = vecOK && S.vec[cc * VN + cc] === 2 * 20 * h;   // grey + black at the center
    out.crushedShare = +S.crushed.toFixed(4);   // the black bar: 1/8
    const white = new Uint8ClampedArray(w * h * 4).fill(255); out.clippedAll = proScopeCompute(white, w, h).clipped === 1;
    // the panel: toggles, three modes, readout, tooltips
    scopesOn = false; document.getElementById('scopesBtn').click();
    const panel = document.getElementById('scopes');
    out.panel = !panel.hidden && !!document.getElementById('scWave') && !!document.getElementById('scVec') && !!document.getElementById('scHist') && /Crushed/.test(document.getElementById('scRead').textContent);
    const modes = [...panel.querySelectorAll('#scWaveMode button')]; modes[1].click();
    out.modes = modes.length === 3 && modes.every(b => b.title) && PRO_SC.wave === 'parade';
    modes[0].click();
    // the chip in grading sections
    const c = state.clips.find(x => x.type === 'image') || state.clips[0];
    if (c) { state.selection = c.id; state.inspTab = 'clip'; renderInspector(); }
    out.chip = !!document.querySelector('#inspBody .sc-chip');
    document.getElementById('scopesBtn').click(); out.hides = panel.hidden;
    return out;
  });
  const SC = R.scopes;
  check('scopes.math', SC.luma && SC.parade && SC.vectorscope && Math.abs(SC.crushedShare - 0.125) < 1e-9 && SC.clippedAll);
  check('scopes.panel', SC.panel && SC.modes && SC.chip && SC.hides);

  // ---------------- 7. frame blending & motion blur ----------------
  // A 25 fps video whose frame k is a flat gray of level 20+2k: every blended
  // frame must be the weighted mix of the frames the plan names.
  {
    const b64 = fs.readFileSync(path.join(__dirname, 'fixtures', 'blend', 'ramp25.webm')).toString('base64');
    R.blend = await p.evaluate(async (b64) => {
      const out = {}, url = URL.createObjectURL(new Blob([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], { type: 'video/webm' }));
      const el = await loadMediaEl('video', url);
      const m = { id: 'bv', type: 'video', name: 'ramp', url, duration: el.duration, w: 64, h: 36, srcFps: 25 };
      state.media = [m]; els.bv = el; state.project.fps = 30; state.playing = false;
      const px = cvs => cvs.getContext('2d').getImageData(Math.floor(cvs.width / 2), Math.floor(cvs.height / 2), 1, 1).data[1];
      // decoded level of each frame, measured through the sampler itself
      const S = _pbSampler('bv'), tmp = document.createElement('canvas'), lev = [];
      for (let k = 0; k < 60; k++) { await _pbGrab(S, (k + 0.5) / 25, tmp); lev.push(px(tmp)); }
      out.levelsStep = lev.slice(1).every((v, i) => v > lev[i]);
      const expect = plan => plan.reduce((s, [x, w]) => s + w * lev[Math.round(x * 25 - 0.5)], 0);
      const run = async (c, t) => { const plan = proBlendPlan(c, t); await proBlendPrepare(t); const bf = proBlendFrame(c, t); return { plan, got: bf ? px(bf.frame) : null, want: plan ? expect(plan) : null }; };
      // slow motion: 0.25× → each output frame between two source frames
      const slow = makeClip({ type: 'video', track: 'V1', start: 0, duration: 8, mediaId: 'bv' }); slow.props.speed = 0.25; slow.props.frameBlend = true; state.clips = [slow];
      let we = 0, n2 = 0; for (const t of [0.37, 1.13, 2.29, 3.51, 5.07, 6.93]) { const r = await run(slow, t); if (r.plan && r.plan.length === 2) { n2++; we = Math.max(we, Math.abs(r.got - r.want)); } }
      out.slowBlended = n2; out.slowErr = we;
      // the weights follow the position between frames
      const pl = proBlendPlan(slow, 1.13), f = srcTimeFor(slow, 1.13) * 25 - 0.5; out.weightOK = Math.abs(pl[1][1] - (f - Math.floor(f))) < 1e-9;
      // off: no blending
      slow.props.frameBlend = false; out.offNone = proBlendPlan(slow, 1.13) === null;
      // fast: 4× with a 180° shutter → average of the frames the shutter spans
      const fast = makeClip({ type: 'video', track: 'V1', start: 0, duration: 0.35, mediaId: 'bv' }); fast.props.speed = 6; fast.props.motionBlur = 360; state.clips = [fast];
      let fe = 0, nk = 0; for (const t of [0.05, 0.13, 0.21, 0.29]) { const r = await run(fast, t); nk = Math.max(nk, r.plan.length); fe = Math.max(fe, Math.abs(r.got - r.want)); }
      out.fastSamples = nk; out.fastErr = fe;
      // span = speed × shutter/360 / project fps (seconds of source)
      const pf = proBlendPlan(fast, 0.13), span = pf[pf.length - 1][0] - pf[0][0]; out.span = +span.toFixed(4);
      // the viewer shows the blended frame when paused
      state.clips = [slow]; slow.props.frameBlend = true; setTime(2.29); await proBlendPrepare(2.29); drawFrame();
      const pv = document.getElementById('preview'), g = pv.getContext('2d').getImageData(pv.width / 2, pv.height / 2, 1, 1).data[1];
      out.viewer = Math.abs(g - expect(proBlendPlan(slow, 2.29))) <= 2;
      // inspector controls
      state.selection = slow.id; state.inspTab = 'clip'; renderInspector();
      const ck = document.getElementById('pFrameBlend'), mb = document.querySelector('#inspBody input[data-k="motionBlur"]');
      out.controls = !!ck && ck.checked && !!mb && !!ck.closest('label').title && !!mb.closest('.ctl').title;
      // no frame rate known (browser copy): measured from the video itself
      proBlendReset(); delete m.srcFps; proBlendPlan(slow, 1.1);
      for (let i = 0; i < 40 && !(m.srcFps > 0); i++) await new Promise(r => setTimeout(r, 100));
      out.fpsDetected = m.srcFps;
      // a file the sampler can't open: no blended frame (never a blank one)
      const bad = { id: 'bad', type: 'video', name: 'bad', url: 'blob:nothing', duration: 5, w: 64, h: 36, srcFps: 25 };
      state.media.push(bad); els.bad = { currentSrc: 'data:video/webm;base64,AAAA', src: '' };
      const bc = makeClip({ type: 'video', track: 'V2', start: 0, duration: 5, mediaId: 'bad' }); bc.props.speed = 0.25; bc.props.frameBlend = true;
      out.badNull = (await _pbCompute(bc, [[0.02, 0.5], [0.06, 0.5]])) === null;
      delete els.bad;
      return out;
    }, b64);
    const B = R.blend;
    check('blend.slow', B.levelsStep && B.slowBlended >= 4 && B.slowErr <= 2 && B.weightOK && B.offNone);
    check('blend.fast', B.fastSamples >= 3 && B.fastErr <= 2 && Math.abs(B.span - 6 / 30) <= 1 / 25 + 1e-9);
    check('blend.viewer', B.viewer && B.controls);
    check('blend.robust', Math.abs(B.fpsDetected - 25) < 1e-9 && B.badNull);
  }

  // ---------------- 4. CAM++ speaker model (desktop copy, app/models/) ----------------
  {
    const dapp = await openApp({ asr: false, desktop: true }), dp = dapp.page;
    const ref = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'campp', 'reference.json'), 'utf8'));
    const b64 = fs.readFileSync(path.join(__dirname, 'fixtures', 'campp', 'dialog16k.wav')).toString('base64');
    // fbank vs torchaudio.compliance.kaldi.fbank; embeddings vs the PyTorch/ONNX original
    R.campp = await dp.evaluate(async (b64, ref) => {
      const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0)), dv = new DataView(bytes.buffer), n = (bytes.length - 44) / 2, y = new Float32Array(n);
      for (let i = 0; i < n; i++) y[i] = dv.getInt16(44 + 2 * i, true) / 32768;
      const { F, T } = proKaldiFbank(y.slice(0, Math.round(1.6 * 16000)), false);
      let fe = 0; for (let t = 0; t < T; t++) for (let m = 0; m < 80; m++) fe = Math.max(fe, Math.abs(F[t * 80 + m] - ref.fbank0[t][m]));
      const files = await proCamppFiles(); if (!files) return { files: false };
      _proSpkEngine = 'campp';
      const wins = ref.wins.map(([a, b]) => y.slice(Math.round(a * 16000), Math.round(b * 16000)));
      const E = await proEmbedWindows(i => wins[i].slice(), wins.length, null, files);
      const cos = E.map((e, i) => { let d = 0, nr = 0; for (let j = 0; j < 192; j++) { d += e[j] * ref.emb[i][j]; nr += ref.emb[i][j] ** 2; } return d / Math.sqrt(nr); });
      return { files: true, T, Tref: ref.fbank0.length, fbankErr: fe, minCos: Math.min(...cos) };
    }, b64, ref);
    check('campp.fbank', R.campp.files && R.campp.T === R.campp.Tref && R.campp.fbankErr < 1e-3);
    check('campp.embedding', R.campp.minCos > 0.9999);
    // speaker labels with CAM++ on the same recordings as pro-tools.js (GE2E there)
    const FX = path.join(__dirname, 'fixtures'), ids = {};
    const acc = (pred, truth) => { const cnt = {}; pred.forEach((q, i) => { const k = q + '|' + truth[i]; cnt[k] = (cnt[k] || 0) + 1; });
      const pairs = Object.entries(cnt).map(([k, v]) => [...k.split('|').map(Number), v]).sort((a, b) => b[2] - a[2]); const uc = new Set(), us = new Set(); let ok = 0;
      for (const [c, sp, v] of pairs) { if (uc.has(c) || us.has(sp)) continue; uc.add(c); us.add(sp); ok += v; } return +(ok / truth.length).toFixed(3); };
    for (const [fx, k, minAcc, wantN] of [['dialog', 0, 0.98, 3], ['phone', 2, 0.97, 2], ['phone', 0, 0.97, 2], ['dialog4', 4, 0.8, 4], ['long', 0, 0.99, 1]]) {
      ids[fx] = ids[fx] || await addWavMedia(dp, path.join(FX, fx === 'phone' ? 'phone-sample.wav' : fx + '.wav'), { name: fx + '.wav' });
      const gt = JSON.parse(fs.readFileSync(path.join(FX, fx + '.json'), 'utf8')), truth = gt.words.map(w => w.spk || 0), t0 = Date.now();
      const r = await dp.evaluate(async (id, words, k) => {
        const m = state.media.find(x => x.id === id); m.transcript = { words: words.map(w => [w.w, w.s, w.e]), covered: [[0, m.duration]] };
        state.clips = [makeClip({ type: 'audio', track: 'A1', start: 0, duration: m.duration, mediaId: id })];
        const res = await proLabelSpeakers(m, k); const L = aiTimelineWords().filter(x => x.k === 'w');
        return { n: res.speakers, engine: res.engine, pred: L.map(x => (proSpeakerOf(x) || { i: -1 }).i) };
      }, ids[fx], gt.words, k);
      const tag = 'campp:' + fx + (k ? '@' + k : '@auto'), a = acc(r.pred, truth);
      R[tag] = { found: r.n, engine: r.engine, wordAccuracy: a, seconds: +((Date.now() - t0) / 1000).toFixed(1) };
      check(tag.replace(':', '.'), r.engine === 'campp' && r.n === wantN && a >= minAcc);
    }
    // a damaged CAM++ install falls back to the built-in model instead of failing
    R.camppFallback = await dp.evaluate(async (id) => {
      const orig = proCamppFiles; proCamppFiles = async () => { const f = await orig(); return f && Object.assign({}, f, { graph: f.graph.slice(0, 1000) }); };
      proCamppForget(); PRO_SPK.camppBroken = false;
      const m = state.media.find(x => x.id === id); state.clips = [makeClip({ type: 'audio', track: 'A1', start: 0, duration: m.duration, mediaId: id })];
      let res = null, err = null; try { res = await proLabelSpeakers(m, 0); } catch (e) { err = String(e.message || e); }
      proCamppFiles = orig; PRO_SPK.camppBroken = false;
      return { engine: res && res.engine, n: res && res.speakers, err };
    }, ids.dialog);
    check('campp.fallback', R.camppFallback.engine === 'ge2e' && R.camppFallback.n === 3);
    if (dapp.errors.length) app.errors.push(...dapp.errors);
    await dapp.close();
  }

  console.log(JSON.stringify(R, null, 1));
  console.log('pageerrors:', app.errors.length ? app.errors : '(none)');
  await app.close();
  const bad = fails.length || app.errors.length;
  console.log(bad ? 'FAIL: ' + fails.join(', ') : 'PASS');
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error('FAIL:', e); process.exit(1); });
