#!/usr/bin/env node
/* ai-visual.js — scene detection, beat sync, auto-reframe and the split fixes,
 * against ground truth.
 *
 * Headless Chromium can't seek real video (see HANDOFF §6), so footage is fed
 * through AI.frameSource: frames rendered on demand with KNOWN cut frames and
 * KNOWN subject positions. The face detector is the real MediaPipe model (from
 * the npm package — see lib/asr-env.js) running on a real photograph
 * (skimage's public-domain astronaut portrait). Beat tests use synthetic music
 * with known beat times (fixtures/music.py). The FFmpeg scene engine has its
 * own suite: scene-ffmpeg.js.
 * Usage: node tests/ai-visual.js   (about 1 minute)
 */
const fs = require('fs'), path = require('path');
const { openApp, addWavMedia } = require('./lib/fixture-page');
const FX = path.join(__dirname, 'fixtures');
(async () => {
  const app = await openApp({ protocolTimeout: 900000 });
  const p = app.page, R = {};
  const img = f => 'data:image/png;base64,' + fs.readFileSync(path.join(FX, 'images', f + '.png')).toString('base64');

  // ---- 1. scenes: browser engine on synthetic shots (color changes at similar brightness, steady motion inside shots)
  R.scenes = await p.evaluate(async () => {
    const CUTS = [2.0, 3.5, 5.5, 6.5], fps = 30;
    AI.frameSource = () => { const cv = document.createElement('canvas'), g = cv.getContext('2d', { willReadFrequently: true });
      return { async grab(t, w, h) { const tt = Math.round(t * fps) / fps, shot = CUTS.filter(c => tt >= c - 1e-9).length;
        cv.width = w; cv.height = h; const hue = [20, 200, 120, 300, 60][shot];
        g.fillStyle = `hsl(${hue},60%,${30 + shot * 8}%)`; g.fillRect(0, 0, w, h);
        g.fillStyle = `hsl(${(hue + 180) % 360},70%,60%)`; const x = (tt * 40 * (shot % 2 ? -1 : 1)) % w;
        g.fillRect((x + w) % w, h * 0.3, w * 0.25, h * 0.4); return cv; }, duration: () => 8, close() {} }; };
    state.project.fps = 30;
    state.media = [{ id: 'mv', type: 'video', name: 'syn', url: 'x', duration: 8, srcFps: 30 }, { id: 'ma', type: 'audio', name: 'syn-a', url: 'x', duration: 8 }];
    const v = makeClip({ type: 'video', track: 'V1', start: 1, duration: 8, mediaId: 'mv' }), a = makeClip({ type: 'audio', track: 'A1', start: 1, duration: 8, mediaId: 'ma' });
    v.linkId = a.linkId = 'lk1'; state.clips = [v, a];
    const data = await aiSceneScoresBrowser(state.media[0], 0, 8, () => {});
    const cuts = aiPickScenes(data, 50);
    const before = JSON.parse(JSON.stringify(state.clips));
    const n = aiSplitAt([v], cuts.map(t => 1 + t));
    let continuity = true;
    for (let t = 1.013; t < 9; t += 0.1) for (const tr of ['V1', 'A1']) { const o = before.find(c => c.track === tr), nn = state.clips.find(c => c.track === tr && t >= c.start && t < clipEnd(c));
      if (!nn || Math.abs(srcTimeFor(o, t) - srcTimeFor(nn, t)) > 1e-9) continuity = false; }
    const groups = {}; state.clips.forEach(c => (groups[c.linkId] = groups[c.linkId] || []).push(c.track));
    AI.frameSource = null;
    return { cuts, exactOK: JSON.stringify(cuts) === JSON.stringify(CUTS), splitOK: n === 4 && state.clips.length === 10, continuityOK: continuity,
      linksOK: Object.values(groups).every(g => g.length === 2) };
  });

  // ---- 2. beats: cut to the beat + snap
  const truth = JSON.parse(fs.readFileSync(path.join(FX, 'music120.json'))).beats;
  const mid = await addWavMedia(p, path.join(FX, 'music120.wav'), { name: 'song.wav' });
  R.beats = await p.evaluate(async (id, truth) => {
    state.project.fps = 30;
    const music = makeClip({ type: 'audio', track: 'A1', start: 1.0, duration: 20, inPoint: 2.0, mediaId: id, name: 'song' });
    state.media.push({ id: 'vid', type: 'video', name: 'broll.mp4', duration: 3.2 });
    const imgs = [0.7, 2.3, 1.1, 0.4, 3.0].map((d, i) => makeClip({ type: 'image', track: 'V1', start: 1.4 + i * 3.1, duration: d, name: 'img' + i }));
    const vid = makeClip({ type: 'video', track: 'V1', start: 18, duration: 0.4, inPoint: 2.8, mediaId: 'vid', name: 'short video' }); // 0.4 s of footage: less than a beat
    state.clips = [music, ...imgs, vid];
    const beats = await aiBeatsOfClip(music, 1);
    const tl = truth.map(t => 1.0 + t - 2.0).filter(t => t >= 1.0 && t <= 21);
    const beatErr = Math.max(...tl.map(t => Math.min(...beats.map(b => Math.abs(b - t)))));
    const res = aiCutToBeats([...imgs, vid], beats, 2);
    const V1 = state.clips.filter(c => c.track === 'V1').sort((a, b) => a.start - b.start);
    const F = 1 / 30;
    const onBeat = V1.every(c => tl.some(t => Math.abs(t - c.start) <= F / 2 + 0.015));
    const lengths = V1.slice(0, 5).every(c => Math.abs(c.duration - 1.0) <= F + 0.02);
    const shortKept = Math.abs(V1[5].duration - 0.4) < 1e-6;
    const backToBack = V1.slice(1).every((c, i) => Math.abs(c.start - clipEnd(V1[i])) < 1e-6);
    state.media.find(m => m.id === 'vid').duration = 10;
    const a = makeClip({ type: 'video', track: 'V2', start: 1.42, duration: 2.14, inPoint: 0.2, mediaId: 'vid', name: 'A' });
    const b = makeClip({ type: 'image', track: 'V2', start: clipEnd(a), duration: 1.5, name: 'B' });
    state.clips.push(a, b);
    const srcAt = srcTimeFor(a, 2.0);
    const s = aiSnapCutsToBeats([a, b], beats);
    return { beatErrMs: Math.round(beatErr * 1000), beatAccuracyOK: beatErr < 0.03, placedOK: res.ok && res.placed === 6 && res.short === 1, onBeatOK: onBeat, lengthsOK: lengths,
      shortKeptOK: shortKept, backToBackOK: backToBack, snapOK: s.moved === 1 && tl.some(t => Math.abs(t - clipEnd(a)) <= F) && Math.abs(b.start - clipEnd(a)) < 1e-9,
      snapKeepsFramesOK: Math.abs(srcTimeFor(a, 2.0) - srcAt) < 1e-9 };
  }, mid, truth);

  // ---- 3. reframe: real face detector on a real portrait, known positions
  R.reframe = await p.evaluate(async (A_, C_) => {
    const A = new Image(); A.src = A_; await A.decode(); const C = new Image(); C.src = C_; await C.decode();
    const fps = 30, W0 = 1920, H0 = 1080;
    const left = t => t < 4 ? 250 : t < 8 ? 100 + (t - 4) / 4 * 700 : null;
    const faceX = t => { const L = left(t); return L == null ? null : (L + 0.44 * 1080) / W0; };
    const full = document.createElement('canvas'); full.width = W0; full.height = H0; const fg = full.getContext('2d');
    AI.frameSource = () => { const cv = document.createElement('canvas'), g = cv.getContext('2d', { willReadFrequently: true });
      return { async grab(t, w, h) { t = Math.round(t * fps) / fps; fg.fillStyle = '#2a3140'; fg.fillRect(0, 0, W0, H0);
        if (t < 8) fg.drawImage(A, left(t), 0, 1080, 1080); else fg.drawImage(C, 0, 0, W0, H0);
        cv.width = w; cv.height = h; g.drawImage(full, 0, 0, w, h); return cv; }, duration: () => 10, close() {} }; };
    state.project = { w: 1920, h: 1080, fps: 30, bg: '#000' };
    state.media = [{ id: 'mv', type: 'video', name: 'interview.mp4', url: 'x', duration: 10, w: 1920, h: 1080, srcFps: 30 }];
    const c = makeClip({ type: 'video', track: 'V1', start: 0, duration: 10, mediaId: 'mv', name: 'interview' }); state.clips = [c];
    AI.reframeTarget = { w: 1080, h: 1920 };
    const plan = await aiAnalyzeReframe(c, () => {}); aiApplyReframe(c, plan, 1080, 1920);
    AI.frameSource = null;
    const W = 1080, g = aiCoverGeom(1920, 1080, 1080, 1920);
    const at = t => { const fx = faceX(t), x = liveProps(c, t).x; return fx == null ? null : (W / 2 + x / 100 * W + (fx - 0.5) * g.dw) / W; };
    const s1 = []; for (let t = 0.2; t < 3.2; t += 0.1) s1.push(at(t));
    const s2 = []; for (let t = 4.4; t < 7.6; t += 0.1) s2.push(at(t));
    const s3 = []; for (let t = 8.1; t < 10; t += 0.1) s3.push(liveProps(c, t).x);
    // no pixel of the frame is ever uncovered
    let covered = true; for (let t = 0; t < 10; t += 0.05) if (Math.abs(liveProps(c, t).x) > g.maxX + 1e-6) covered = false;
    return { cutAt8OK: plan.cuts.some(t => Math.abs(t - 8) < 1 / 30 + 1e-6),
      shot1CenteredOK: s1.every(x => Math.abs(x - 0.5) < 0.06), shot1LockedOK: Math.max(...s1) - Math.min(...s1) < 0.02,
      shot2InFrameOK: s2.every(x => x > 0.2 && x < 0.8), shot2Range: [+Math.min(...s2).toFixed(3), +Math.max(...s2).toFixed(3)],
      shot3CenteredOK: s3.every(x => Math.abs(x) < 1e-6), coverOK: covered && Math.abs(c.props.scale - 3.1605) < 0.001 };
  }, img('astronaut'), img('coffee'));

  // ---- 4. v4.6 split fixes: reversed and keyframed clips
  R.split = await p.evaluate(() => {
    state.media = [{ id: 'mv', type: 'video', duration: 100 }];
    let c = makeClip({ type: 'video', track: 'V1', start: 0, duration: 4, inPoint: 10, mediaId: 'mv' }); c.props.reverse = true;
    state.clips = [c]; let b = JSON.parse(JSON.stringify(c)); splitClip(c, 2);
    const L = state.clips.find(x => x.start === 0), Rr = state.clips.find(x => x.start === 2);
    const rev = Math.abs(srcTimeFor(L, 1) - srcTimeFor(b, 1)) < 1e-9 && Math.abs(srcTimeFor(Rr, 3) - srcTimeFor(b, 3)) < 1e-9;
    c = makeClip({ type: 'video', track: 'V1', start: 0, duration: 4, mediaId: 'mv' }); c.kfEaseMode = 'smooth'; c.kf = { x: [{ t: 0, v: 0 }, { t: 4, v: 400 }] };
    state.clips = [c]; b = JSON.parse(JSON.stringify(c)); splitClip(c, 1.3);
    const R2 = state.clips.find(x => x.start === 1.3);
    let kf = true; for (let t = 1.35; t < 4; t += 0.1) if (Math.abs(liveProps(R2, t).x - liveProps(b, t).x) > 1e-6) kf = false;
    return { reversedOK: rev, keyframesOK: kf };
  });

  // ---- 5. film-strip thumbnails are one stylesheet rule per media, not per clip
  R.thumbs = await p.evaluate(() => {
    const cv = document.createElement('canvas'); cv.width = 8; cv.height = 8;
    state.media = [{ id: 'm1', type: 'image', name: 'i', duration: 5, w: 8, h: 8, el: cv, thumb: cv.toDataURL() }];
    state.clips = [0, 1, 2, 3].map(i => makeClip({ type: 'image', track: 'V1', start: i * 2, duration: 2, mediaId: 'm1' }));
    renderTimeline();
    const strips = document.querySelectorAll('#tracksHost .clip .cthumbs').length;
    const inline = [...document.querySelectorAll('#tracksHost .clip')].some(e => /data:image/.test(e.outerHTML));
    const rule = [...document.getElementById('thumbRules').sheet.cssRules].some(r => /data:image/.test(r.cssText));
    return { stripsOK: strips === 4, noInlineDataOK: !inline, ruleOK: rule };
  });

  console.log(JSON.stringify(R, null, 1));
  const fails = []; for (const g in R) for (const k in R[g]) if (k.endsWith('OK') && !R[g][k]) fails.push(g + '.' + k);
  console.log('pageerrors:', app.errors.length ? app.errors : '(none)');
  console.log(fails.length || app.errors.length ? 'FAIL: ' + fails.join(', ') : 'PASS');
  await app.close(); process.exit(fails.length || app.errors.length ? 1 : 0);
})().catch(e => { console.error('FAIL:', e.message, e.stack); process.exit(1); });
