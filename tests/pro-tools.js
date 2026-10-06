/* pro-tools.js — the v4.7 Pro features, measured against ground truth.
 *   1. Auto-ducking: TTS speech with KNOWN word times on A1, music on A2.
 *      The music must be fully down at every word, already down when each
 *      sentence starts, back up in long pauses, and re-running must replace
 *      (not stack) the previous dips. Both detection paths are measured:
 *      transcript words and raw loudness.
 * Usage: node tests/pro-tools.js   (prints JSON, then PASS or FAIL)
 */
const fs = require('fs'), path = require('path');
const { openApp, addWavMedia } = require('./lib/fixture-page');
const FX = path.join(__dirname, 'fixtures');
const R = {}, fails = [];
const check = (k, ok) => { R[k + 'OK'] = !!ok; if (!ok) fails.push(k); };

(async () => {
  const app = await openApp({ protocolTimeout: 600000 });
  const p = app.page;
  const truth = JSON.parse(fs.readFileSync(path.join(FX, 'long.json'), 'utf8'));
  const voice = await addWavMedia(p, path.join(FX, 'long.wav'), { name: 'voice.wav' });
  const music = await addWavMedia(p, path.join(FX, 'music120.wav'), { name: 'music.wav' });
  const noisy = await addWavMedia(p, path.join(FX, 'long-noisy.wav'), { name: 'noisy.wav' });

  // ---------------- 1. auto-ducking ----------------
  for (const pathKind of ['transcript', 'loudness', 'noisy']) {
    const r = await p.evaluate(async (voice, music, truth, pathKind) => {
      const vm = state.media.find(m => m.id === voice), mm = state.media.find(m => m.id === music);
      delete vm.transcript;
      if (pathKind === 'transcript') vm.transcript = { words: truth.words.map(w => [w.w, w.s, w.e]), covered: [[0, vm.duration]] };
      const D = vm.duration;
      state.clips = [makeClip({ type: 'audio', track: 'A1', start: 0, duration: D, mediaId: voice })];
      // music loops under the whole voice: back-to-back clips
      let t = 0; while (t < D) { const d = Math.min(mm.duration, D - t); state.clips.push(makeClip({ type: 'audio', track: 'A2', start: t, duration: d, mediaId: music })); t += d; }
      for (const c of state.clips) if (c.track === 'A2') c.props.volume = 0.8;
      await aiEnsureEnvelopesForTracks(['A1', 'A2']);
      const o = { db: -12, down: 0.25, up: 0.6, hold: 0.5, pre: 0.08 };
      const res = proApplyDucking(['A1'], ['A2'], o);
      const d = Math.pow(10, o.db / 20);
      const gainAt = tt => { const c = state.clips.find(c => c.track === 'A2' && tt >= c.start && tt < clipEnd(c)); return liveProps(c, tt).volume / 0.8; };
      // words: fully down
      const W = truth.words;
      const atWords = W.map(w => gainAt((w.s + w.e) / 2));
      const worstWord = Math.max(...atWords.map(g => Math.abs(g - d)));
      // sentence onsets: already down
      const segs = {}; for (const w of W) { (segs[w.seg] = segs[w.seg] || [w.s, w.e]); segs[w.seg][0] = Math.min(segs[w.seg][0], w.s); segs[w.seg][1] = Math.max(segs[w.seg][1], w.e); }
      const S = Object.values(segs).sort((a, b) => a[0] - b[0]);
      const onsetWorst = Math.max(...S.map(s => gainAt(s[0] + 0.005)));
      // long pauses: back up in the middle
      const longP = []; for (let i = 1; i < S.length; i++) if (S[i][0] - S[i - 1][1] >= 1.8) longP.push((S[i][0] + S[i - 1][1]) / 2);
      const pauseMin = longP.length ? Math.min(...longP.map(gainAt)) : null;
      // re-run: identical keys (replaces, never stacks)
      const before = JSON.stringify(state.clips.map(c => c.kf || null));
      proApplyDucking(['A1'], ['A2'], o);
      const same = JSON.stringify(state.clips.map(c => c.kf || null)) === before;
      // remove: music back to its original flat level
      state.clips.forEach(c => proUnduckClip(c));
      const clean = state.clips.every(c => !c.kf && !c.duck);
      // the voice track is never touched
      const voiceUntouched = !state.clips.find(c => c.track === 'A1').kf;
      return { duckTarget: +d.toFixed(4), worstWordErr: +worstWord.toFixed(4), words: W.length, onsetWorst: +onsetWorst.toFixed(4), longPauses: longP.length, pauseMin: pauseMin && +pauseMin.toFixed(4), rerunSame: same, removeClean: clean, voiceUntouched, dips: res.dips };
    }, pathKind === 'noisy' ? noisy : voice, music, truth, pathKind);
    R['duck:' + pathKind] = r;
    // transcript path: words are exact; loudness path: onsets within the envelope's resolution
    check('duck.' + pathKind + '.words', r.worstWordErr <= (pathKind === 'transcript' ? 0.002 : 0.02));
    check('duck.' + pathKind + '.onsets', r.onsetWorst <= r.duckTarget * 1.05);
    check('duck.' + pathKind + '.pauses', r.longPauses >= 1 && r.pauseMin >= 0.98);
    check('duck.' + pathKind + '.rerun', r.rerunSame);
    check('duck.' + pathKind + '.remove', r.removeClean && r.voiceUntouched);
  }

  // ---------------- 2. speaker labels ----------------
  // Transcript = ground-truth words (so only the speaker labelling is measured).
  // dialog: 3 synthetic voices; dialog4: 4 voices, two of them very close;
  // phone: a real two-woman phone call (pyannote.audio's MIT sample); long: 1 voice.
  const SPK = [['dialog', 0, 0.95, 3], ['dialog', 3, 0.95, 3], ['long', 0, 0.99, 1], ['phone', 2, 0.88, 2], ['dialog4', 4, 0.72, 4], ['phone', 0, 0.75, null]];
  const loaded = {};
  for (const [fx, k, minAcc, wantN] of SPK) {
    const gt = JSON.parse(fs.readFileSync(path.join(FX, fx + '.json'), 'utf8'));
    const wav = fx === 'phone' ? 'phone-sample.wav' : fx + '.wav';
    loaded[fx] = loaded[fx] || await addWavMedia(p, path.join(FX, wav), { name: fx + '.wav' });
    const t0 = Date.now();
    const r = await p.evaluate(async (id, words, k) => {
      const m = state.media.find(x => x.id === id);
      m.transcript = { words: words.map(w => [w.w, w.s, w.e]), covered: [[0, m.duration]] };
      state.clips = [makeClip({ type: 'audio', track: 'A1', start: 0, duration: m.duration, mediaId: id })];
      const res = await proLabelSpeakers(m, k);
      // per-word predicted labels through the same lookup the transcript panel uses
      const L = aiTimelineWords().filter(x => x.k === 'w');
      return { n: res.speakers, windows: res.windows, pred: L.map(x => (proSpeakerOf(x) || { i: -1 }).i) };
    }, loaded[fx], gt.words, k);
    const truth = gt.words.map(w => w.spk || 0);
    // one-to-one mapping of predicted to true speakers, greedy by overlap count
    const cnt = {}; r.pred.forEach((q, i) => { const key = q + '|' + truth[i]; cnt[key] = (cnt[key] || 0) + 1; });
    const pairs = Object.entries(cnt).map(([key, v]) => [...key.split('|').map(Number), v]).sort((a, b) => b[2] - a[2]);
    const uc = new Set(), us = new Set(); let ok = 0; for (const [c, sp, v] of pairs) { if (uc.has(c) || us.has(sp)) continue; uc.add(c); us.add(sp); ok += v; }
    const acc = ok / truth.length, tag = 'speakers:' + fx + (k ? '@' + k : '@auto');
    R[tag] = { found: r.n, wordAccuracy: +acc.toFixed(3), windows: r.windows, seconds: +((Date.now() - t0) / 1000).toFixed(1) };
    check(tag.replace(':', '.'), acc >= minAcc && (wantN == null || r.n === wantN));
  }
  // rename / merge / captions carry names
  R.speakerTools = await p.evaluate(() => {
    const m = state.media.find(x => x.transcript && x.transcript.speakers && x.transcript.speakers.n === 3) || state.media.find(x => x.transcript && x.transcript.speakers);
    state.clips = [makeClip({ type: 'audio', track: 'A1', start: 0, duration: m.duration, mediaId: m.id })];
    m.transcript.speakers.names[0] = 'Host';
    TX.dirty = true; aiShowTab('tx'); aiTxRebuild(true);
    const chips = [...document.querySelectorAll('#txBody .tx-spk')].map(b => b.textContent);
    const lines = aiCaptionLines(7);
    const breaksAtChange = lines.every(l => { const ws = aiTimelineWords().filter(x => x.k === 'w' && x.t0 >= l.start - 1e-6 && x.t1 <= l.end + 1e-6); return new Set(ws.map(x => (proSpeakerOf(x) || {}).name)).size <= 1; });
    const n0 = m.transcript.speakers.n; proMergeSpeaker(m, n0 - 1, 0);
    return { chips: chips.length, hostShown: chips.includes('Host'), captionLinesOneVoice: breaksAtChange, mergedTo: m.transcript.speakers.n, from: n0,
      survivesSave: JSON.parse(serializeProject()).media.find(x => x.id === m.id).transcript.speakers.n === m.transcript.speakers.n };
  });
  check('speakerTools', R.speakerTools.hostShown && R.speakerTools.captionLinesOneVoice && R.speakerTools.mergedTo === R.speakerTools.from - 1 && R.speakerTools.survivesSave);

  // ---------------- 3. compound clips ----------------
  const tone = await addWavMedia(p, path.join(FX, 'music120.wav'), { name: 'tone.wav' });
  R.compound = await p.evaluate(async (tone) => {
    const out = {};
    const mk = (col, w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); g.fillStyle = col; g.fillRect(0, 0, w, h); g.fillStyle = '#fff'; g.fillRect(w / 2 - 10, h / 2 - 10, 20, 20); return c; };
    const tm = state.media.find(m => m.id === tone); els[tone] = new Audio(tm.url);
    state.media = state.media.filter(m => m.id === tone).concat([{ id: 'ia', type: 'image', name: 'red', duration: 5, w: 320, h: 180, el: mk('#d33', 320, 180) }, { id: 'ib', type: 'image', name: 'blue', duration: 5, w: 160, h: 90, el: mk('#33d', 160, 90) }]);
    const build = () => {
      state.clips = [makeClip({ type: 'image', track: 'V1', start: 1, duration: 4, mediaId: 'ia', name: 'red' }), makeClip({ type: 'image', track: 'V2', start: 2, duration: 2, mediaId: 'ib', name: 'blue' }),
        makeClip({ type: 'text', track: 'TX', start: 1.5, duration: 2, name: 'Hello' }), makeClip({ type: 'audio', track: 'A1', start: 1.2, duration: 3, mediaId: tone, name: 'tone' })];
      state.clips[1].props.scale = 0.4; state.clips[1].kf = { x: [{ t: 0, v: -20 }, { t: 2, v: 20 }] }; state.clips[2].text.content = 'Inside';
      state.clips[3].props.volume = 0.7; state.selection = null; state.selExtra = []; renderTimeline();
    };
    const cvs = document.getElementById('preview');
    const frame = t => { setTime(t); drawFrame(); const g = cvs.getContext('2d'); return g.getImageData(0, 0, cvs.width, cvs.height).data; };
    const diff = (a, b) => { let s = 0; for (let i = 0; i < a.length; i += 16) s += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]); return s / (a.length / 16 * 3) / 255; };
    const TS = [1.1, 1.7, 2.6, 3.3, 3.9, 4.8];
    const mix = async () => { const b = await renderAudioOffline(6, 48000); return b ? b.getChannelData(0) : null; };
    const adiff = (a, b) => { let s = 0, n = 0; for (let i = 0; i < Math.min(a.length, b.length); i += 7) { s += Math.abs(a[i] - b[i]); n++; } return s / n; };
    build();
    const ref = TS.map(frame), refMix = await mix();
    // make: identical picture and sound
    state.selection = state.clips[0].id; state.selExtra = state.clips.slice(1).map(c => c.id);
    const cmp = proMakeCompound();
    out.madeOne = state.clips.length === 1 && cmp.type === 'compound' && cmp.inner.clips.length === 4;
    out.pictureSame = Math.max(...TS.map((t, i) => diff(ref[i], frame(t))));
    const cmpMix = await mix(); out.soundSame = +adiff(refMix, cmpMix).toExponential(2); out.soundLevel = +adiff(refMix, new Float32Array(refMix.length)).toExponential(2);
    // compound volume and mute reach the mix
    cmp.props.volume = 0.5; const half = await mix(); out.volumeHalf = +(adiff(half, new Float32Array(half.length)) / out.soundLevel).toFixed(3);
    cmp.props.volume = 1; state.muted[cmp.track] = true; const muted = await mix(); out.trackMuteSilences = !muted || adiff(muted, new Float32Array(muted.length)) < 1e-6; state.muted[cmp.track] = false;
    // trimmed window: compound [1.5 .. 3.5) shows the original's 2.5 .. 4.5
    cmp.inPoint = 1.5; cmp.start = 2.5; cmp.duration = 2;
    out.trimSame = Math.max(...[2.6, 3.3, 3.9].map(t => { const i = TS.indexOf(t); return diff(ref[i], frame(t)); }));
    out.trimOutsideEmpty = diff(frame(1.7), new Uint8ClampedArray(ref[0].length).fill(0).map((v, i) => i % 4 === 3 ? 255 : 0)) < 0.02;
    cmp.inPoint = 0; cmp.start = 1; cmp.duration = 4;
    // split: both halves together render the same
    splitClip(cmp, 3.0); out.splitClips = state.clips.length;
    out.splitSame = Math.max(...TS.map((t, i) => diff(ref[i], frame(t))));
    undo();
    // nested: a compound inside a compound
    const c1 = state.clips.find(c => c.type === 'compound'); state.selection = c1.id; state.selExtra = [];
    const c2 = proMakeCompound(); out.nestedSame = Math.max(...TS.map((t, i) => diff(ref[i], frame(t))));
    proBreakCompound(c2);
    // edit inside: move the red clip 0.5 s later, come back out, one undo reverts it
    const c3 = state.clips.find(c => c.type === 'compound');
    proOpenCompound(c3); out.insideClips = state.clips.length;
    state.clips.find(c => c.name === 'red').props.x = 25;
    out.saveWhileInside = JSON.parse(serializeProject()).clips.length === 1 && JSON.parse(serializeProject()).clips[0].type === 'compound';
    proCloseCompound();
    out.editKept = state.clips[0].inner.clips.find(c => c.name === 'red').props.x === 25 && diff(ref[0], frame(1.1)) > 0.01;
    undo(); out.undoRevertsInside = diff(ref[0], frame(1.1)) < 1e-9;
    // break apart: back to separate clips, same picture
    proBreakCompound(state.clips.find(c => c.type === 'compound'));
    out.brokenClips = state.clips.length; out.breakSame = Math.max(...TS.map((t, i) => diff(ref[i], frame(t))));
    return out;
  }, tone);
  // review follow-ups: split-safe ducking, stale caches, fades, placement, media removal, keys
  const voice2 = await addWavMedia(p, path.join(FX, 'long.wav'), { name: 'voice2.wav' }), music2 = await addWavMedia(p, path.join(FX, 'music120.wav'), { name: 'music2.wav' });
  R.review = await p.evaluate(async (tone, voiceId, musicId) => {
    const out = {};
    // ducking survives a split: re-run replaces, Remove cleans both halves
    const vm = state.media.find(m => m.id === voiceId), mm = state.media.find(m => m.id === musicId);
    vm.transcript = vm.transcript || null;
    state.clips = [makeClip({ type: 'audio', track: 'A1', start: 0, duration: vm.duration, mediaId: voiceId }), makeClip({ type: 'audio', track: 'A2', start: 0, duration: Math.min(mm.duration, vm.duration), mediaId: musicId })];
    await aiEnsureEnvelopesForTracks(['A1', 'A2']);
    proApplyDucking(['A1'], ['A2'], { db: -12 });
    const mus = state.clips[1]; splitClip(mus, 11.3);
    const halves = state.clips.filter(c => c.track === 'A2');
    const fresh = () => { const cl = JSON.parse(JSON.stringify(halves)); cl.forEach(c => { delete c.kf; delete c.duck; }); return cl; };
    const clean = fresh();
    proApplyDucking(['A1'], ['A2'], { db: -12 });
    const again = JSON.stringify(state.clips.filter(c => c.track === 'A2').map(c => c.kf.volume));
    state.clips = state.clips.filter(c => c.track !== 'A2').concat(clean); proApplyDucking(['A1'], ['A2'], { db: -12 });
    out.duckSplitNoStack = again === JSON.stringify(state.clips.filter(c => c.track === 'A2').map(c => c.kf.volume));
    // split AFTER ducking, then Remove: both halves flat again
    state.clips = state.clips.filter(c => c.track !== 'A2').concat(fresh().slice(0, 1)); state.clips[1].duration = Math.min(mm.duration, vm.duration); state.clips[1].start = 0;
    proApplyDucking(['A1'], ['A2'], { db: -12 }); splitClip(state.clips.find(c => c.track === 'A2'), 7.7);
    let removed = 0; for (const c of state.clips) if (c.duck && proUnduckClip(c)) removed++;
    out.duckSplitRemove = removed === 2 && state.clips.every(c => !c.kf);
    // speech inside a compound clip still ducks the music, exactly as when loose
    state.clips = state.clips.filter(c => c.track !== 'A2').concat(fresh().slice(0, 1)); state.clips[1].duration = Math.min(mm.duration, vm.duration); state.clips[1].start = 0;
    proApplyDucking(['A1'], ['A2'], { db: -12 }); const looseKeys = JSON.stringify(state.clips[1].kf.volume); proUnduckClip(state.clips[1]);
    state.selection = state.clips[0].id; state.selExtra = []; proMakeCompound();
    const cmpTrack = state.clips.find(c => c.type === 'compound').track;
    proApplyDucking([cmpTrack], ['A2'], { db: -12 });
    out.duckFromCompound = JSON.stringify(state.clips.find(c => c.track === 'A2').kf.volume) === looseKeys;
    // compound: editing inside changes what is HEARD (no stale flattened list)
    const tm = state.media.find(m => m.id === tone); els[tone] = els[tone] || new Audio(tm.url);
    state.clips = [makeClip({ type: 'audio', track: 'A1', start: 1, duration: 2, mediaId: tone })];
    state.selection = state.clips[0].id; state.selExtra = [];
    const mix = async () => { const b = await renderAudioOffline(5, 48000); return b ? Array.from(b.getChannelData(0).filter((_, i) => i % 97 === 0)) : null; };
    const cmp = proMakeCompound(); const m0 = await mix();
    proOpenCompound(cmp); state.clips[0].start += 1; proCloseCompound();
    const m1 = await mix();
    const loose = JSON.parse(JSON.stringify(state.clips[0].inner.clips[0])); loose.start += 1; loose.duration = 1; // the compound still shows inner 0..2 s
    const keep = state.clips; state.clips = [loose]; const m2 = await mix(); state.clips = keep;
    out.innerEditHeard = JSON.stringify(m0) !== JSON.stringify(m1) && m1.every((v, i) => Math.abs(v - m2[i]) < 1e-6);
    // compound fade-out reaches the sound
    const c2 = state.clips[0]; c2.props.fadeOut = 1.0;
    const mf = await mix(); const tail = (arr, a, b) => { let s = 0; for (let i = Math.floor(a * 48000 / 97); i < Math.floor(b * 48000 / 97); i++)s += Math.abs(arr[i]); return s; };
    out.fadeRatioEnd = +(tail(mf, 2.7, 3.0) / tail(m1, 2.7, 3.0)).toFixed(3); out.fadeRatioStart = +(tail(mf, 2.0, 2.15) / tail(m1, 2.0, 2.15)).toFixed(3);
    out.fadeHeard = out.fadeRatioEnd < 0.3 && out.fadeRatioStart > 0.8;
    c2.props.fadeOut = 0;
    // a compound of titles only lands on a VIDEO track and draws no stray "Title"
    state.clips = [makeClip({ type: 'text', track: 'TX', start: 0, duration: 2, name: 'T' })]; state.clips[0].text.content = 'ONLY';
    state.selection = state.clips[0].id; state.selExtra = [];
    const tc = proMakeCompound(); out.titleCompoundTrack = (trackOf(tc.track) || {}).kind;
    // removing media used only inside a compound removes those clips (undoable)
    state.clips = [makeClip({ type: 'audio', track: 'A1', start: 0, duration: 1, mediaId: tone })]; state.selection = state.clips[0].id; state.selExtra = [];
    proMakeCompound(); const h0 = state.hIndex;
    const saved = state.media.slice(); await removeMedia(tone, true);   // (true: skip the in-app confirmation)
    out.removeInside = state.clips[0].inner.clips.length === 0 && state.hIndex === h0 + 1;
    state.media = saved; undo();
    out.removeUndo = state.clips[0].inner.clips.length === 1;
    // Ctrl+Alt+G makes a compound and does NOT also group
    state.clips = [makeClip({ type: 'image', track: 'V1', start: 0, duration: 1, mediaId: 'ia' }), makeClip({ type: 'image', track: 'V1', start: 1, duration: 1, mediaId: 'ia' })];
    state.selection = state.clips[0].id; state.selExtra = [state.clips[1].id]; renderTimeline();
    document.body.focus(); dispatchEvent(new KeyboardEvent('keydown', { key: 'g', ctrlKey: true, altKey: true, bubbles: true }));
    await new Promise(r => setTimeout(r, 30));
    out.ctrlAltG = state.clips.length === 1 && state.clips[0].type === 'compound' && !state.clips[0].inner.clips.some(c => c.groupId);
    // Esc closes a dialog first, and only a second Esc leaves the compound
    proOpenCompound(state.clips[0]); openGuide();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise(r => setTimeout(r, 30));
    const stillInside = proInsideCompound() && !document.querySelector('#overlay.show');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await new Promise(r => setTimeout(r, 30));
    out.escOrder = stillInside && !proInsideCompound();
    // loading another project while inside a compound leaves it cleanly
    proOpenCompound(state.clips[0]);
    loadProjectJSON(JSON.stringify({ app: 'vibe-edit', version: 2, project: { w: 1920, h: 1080, fps: 30 }, tracks: TRACKS, media: [], clips: [] }));
    out.loadResets = !proInsideCompound() && !document.getElementById('cmpCrumb');
    return out;
  }, tone, voice2, music2);
  for (const k in R.review) if (typeof R.review[k] !== 'number') check('review.' + k, R.review[k] === true || R.review[k] === 'video');
  const C = R.compound;
  check('compound.make', C.madeOne && C.pictureSame < 1e-9 && C.soundSame < 1e-6 && C.soundLevel > 1e-3);
  check('compound.volumeMute', Math.abs(C.volumeHalf - 0.5) < 0.01 && C.trackMuteSilences);
  check('compound.trim', C.trimSame < 1e-9 && C.trimOutsideEmpty);
  check('compound.split', C.splitClips === 2 && C.splitSame < 1e-9);
  check('compound.nested', C.nestedSame < 1e-9);
  check('compound.editInside', C.insideClips === 4 && C.saveWhileInside && C.editKept && C.undoRevertsInside);
  check('compound.break', C.brokenClips === 4 && C.breakSame < 1e-9);

  console.log(JSON.stringify(R, null, 1));
  console.log('pageerrors:', app.errors.length ? app.errors : '(none)');
  await app.close();
  const bad = fails.length || app.errors.length;
  console.log(bad ? 'FAIL: ' + fails.join(', ') : 'PASS');
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error('FAIL:', e); process.exit(1); });
