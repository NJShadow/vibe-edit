#!/usr/bin/env node
/* ai-speech.js — the AI editing features against GROUND TRUTH.
 *
 * Speech fixtures are synthesized (tests/fixtures/make.sh, eSpeak NG) so every
 * word's true start and end is known. The app's REAL pipeline runs end to end:
 * decode -> window planning -> Whisper in the worker -> lag calibration ->
 * word refinement -> timeline mapping -> cut planning -> ripple cut. Nothing
 * is mocked except where the model files come from (see lib/asr-env.js), and
 * the test model is multilingual whisper-tiny rather than tiny.en (same size
 * and architecture; the .en build isn't available offline here).
 *
 * The synthetic voice is robotic, so the word ERROR rate here (~30%) is far
 * worse than on real speech and is NOT asserted. What is asserted is what the
 * app controls: nothing dropped, timing, and where cuts land.
 *
 * Usage: node tests/ai-speech.js      (about 2 minutes)
 */
const fs = require('fs');
const path = require('path');
const { openApp, addWavMedia } = require('./lib/fixture-page');
const FX = path.join(__dirname, 'fixtures');
const truth = JSON.parse(fs.readFileSync(path.join(FX, 'long.json'))).words;
const nSeg = Math.max(...truth.map(w => w.seg)) + 1;
const segSpan = i => { const w = truth.filter(x => x.seg === i); return [w[0].s, w[w.length - 1].e]; };
const med = v => { const s = [...v].sort((a, b) => a - b); return s[s.length >> 1]; };

(async () => {
  const R = {};
  let pageErrors = [];
  for (const fx of ['long', 'long-noisy']) {
    const app = await openApp({ protocolTimeout: 1800000 });
    const p = app.page;
    const id = await addWavMedia(p, path.join(FX, fx + '.wav'), { name: fx + '.wav' });
    const out = await p.evaluate(async (id) => {
      const m = state.media.find(x => x.id === id);
      state.clips = [makeClip({ type: 'audio', track: 'A1', start: 0, duration: m.duration, mediaId: id })];
      const tr = await aiTranscribe(m, aiUsedSpans(m));
      const L = aiTimelineWords();
      return { tr, words: m.transcript.words, list: L.map(x => ({ k: x.k, w: x.w, t0: x.t0, t1: x.t1 })) };
    }, id);
    const r = R[fx] = {};
    // 1) completeness: every true word lies under some transcribed word/sound
    const hyp = out.list;
    const covered = truth.filter(t => hyp.some(h => h.t0 < t.e && h.t1 > t.s)).length / truth.length;
    r.coverage = +covered.toFixed(3); r.coverageOK = covered >= 0.95;
    r.lagMs = Math.round(out.tr.lag * 1000); r.retries = out.tr.retries;
    // 2) deleting each whole sentence (select what's heard during it)
    let sentBad = [];
    for (let si = 0; si < nSeg; si++) {
      const [a, b] = segSpan(si);
      const idx = hyp.map((x, n) => [x, n]).filter(([x]) => (x.t0 + x.t1) / 2 >= a - 0.05 && (x.t0 + x.t1) / 2 <= b + 0.05).map(q => q[1]);
      if (!idx.length) { sentBad.push(si + ':unheard'); continue; }
      const rg = await p.evaluate((i, j) => aiRangeForWords(aiTimelineWords(), i, j), Math.min(...idx), Math.max(...idx));
      const pv = si > 0 ? segSpan(si - 1)[1] : -1, nx = si < nSeg - 1 ? segSpan(si + 1)[0] : 1e9;
      const clip = Math.max(0, pv - rg[0], rg[1] - nx), left = Math.max(0, a - rg[0] < 0 ? rg[0] - a : 0, b - rg[1]);
      if (clip > 0.005 || left > 0.03) sentBad.push(`${si}:clip${Math.round(clip * 1000)}/left${Math.round(left * 1000)}`);
    }
    r.sentenceCuts = nSeg - sentBad.length + '/' + nSeg; r.sentenceCutsOK = !sentBad.length; if (sentBad.length) r.sentenceFailures = sentBad;
    // 3) deleting single words inside continuous speech
    const wordClips = [];
    for (let k = 1; k < truth.length - 1; k++) {
      const t = truth[k]; if (truth[k - 1].seg !== t.seg || truth[k + 1].seg !== t.seg) continue;
      const i = hyp.findIndex(h => h.k === 'w' && Math.abs((h.t0 + h.t1) / 2 - (t.s + t.e) / 2) < 0.12);
      if (i < 0) continue;
      const rg = await p.evaluate(i => aiRangeForWords(aiTimelineWords(), i, i), i);
      wordClips.push(Math.max(0, truth[k - 1].e - rg[0], rg[1] - truth[k + 1].s));
    }
    r.wordNeighborClipMedMs = Math.round(med(wordClips) * 1000); r.wordCutsOK = med(wordClips) <= 0.06 && wordClips.length >= 30;
    // 4) pauses: all found, none cut into speech; 5) fillers; 6) mapping after edits
    const pz = await p.evaluate(async () => {
      await aiEnsureEnvelopesForTracks(['A1']);
      const pauses = aiFindPauses(aiTimelineActivity(['A1'], 0), 0.35);
      const cuts = aiNormalizeRanges(aiPauseCuts(pauses, 0.25));
      const L = aiTimelineWords();
      const fill = L.map((x, i) => [x, i]).filter(([x]) => x.k === 's' || x.filler === 'um').map(q => q[1]);
      return { pauses, cuts, fillerRanges: aiRangesForEntries(L, fill) };
    });
    const segs = [...Array(nSeg).keys()].map(segSpan), truthPauses = segs.slice(1).map((s, i) => [segs[i][1], s[0]]);
    r.pausesFound = truthPauses.filter(tp => pz.pauses.some(q => q[0] < tp[1] && q[1] > tp[0])).length + '/' + truthPauses.length;
    r.pauseCutsIntoSpeech = pz.cuts.filter(c => segs.some(s => Math.min(c[1], s[1]) - Math.max(c[0], s[0]) > 0.001)).length;
    r.pausesOK = r.pausesFound === truthPauses.length + '/' + truthPauses.length && r.pauseCutsIntoSpeech === 0;
    const fillers = truth.filter(w => /^(um|uh)$/i.test(w.w.replace(/[^a-z]/gi, '')));
    r.fillersRemoved = fillers.filter(w => { const g = pz.fillerRanges.find(g => g[0] < w.e && g[1] > w.s); if (!g) return false;
      const k = truth.indexOf(w); return g[0] <= w.s + 0.01 && g[1] >= w.e - 0.01 && g[0] >= truth[k - 1].e - 0.005 && g[1] <= truth[k + 1].s + 0.005; }).length + '/' + fillers.length;
    r.fillersOK = r.fillersRemoved === fillers.length + '/' + fillers.length;
    const after = await p.evaluate((cuts) => {
      const before = aiTimelineWords().filter(x => x.k === 'w').map(x => x.w).join(' ');
      aiRippleCut(cuts);
      const L = aiTimelineWords();
      // every word must still sit exactly on its source audio
      let worst = 0;
      for (const x of L) { const c = state.clips.find(c => x.t0 >= c.start - 1e-6 && x.t0 < clipEnd(c)); worst = Math.max(worst, Math.abs(srcTimeFor(c, x.t0) - x.s)); }
      return { same: L.filter(x => x.k === 'w').map(x => x.w).join(' ') === before, worst, clips: state.clips.length };
    }, pz.cuts);
    // splitting clips must not invent "…" sound markers out of words cut in two
    const spl = await p.evaluate(() => {
      const keep = JSON.stringify(state.clips), n0 = aiTimelineWords().filter(x => x.k === 's').length;
      const end = Math.max(...state.clips.map(clipEnd));
      for (let t = 0.73; t < end; t += 0.91) { const c = state.clips.find(c => c.type === 'audio' && t > c.start + 0.05 && t < clipEnd(c) - 0.05); if (c) splitClip(c, t); }
      const n1 = aiTimelineWords().filter(x => x.k === 's').length, clips = state.clips.length;
      state.clips = JSON.parse(keep); return { n0, n1, clips };
    });
    r.soundsAfterSplit = spl.n0 + '→' + spl.n1 + ' (' + spl.clips + ' clips)'; r.splitSoundsOK = spl.n1 <= spl.n0;
    r.wordsSurvivePauseCut = after.same; r.mappingErrMs = +(after.worst * 1000).toFixed(3); r.mappingOK = after.worst < 1e-4;
    // 7) captions & subtitles follow the edited timeline
    const cap = await p.evaluate(() => {
      const lines = aiCaptionLines(7);
      const words = aiTimelineWords().filter(x => x.k === 'w').map(x => x.w).join(' ');
      let overlap = 0; for (let i = 1; i < lines.length; i++) if (lines[i].start < lines[i - 1].end - 1e-6) overlap++;
      return { n: lines.length, overlap, textSame: lines.map(l => l.text).join(' ') === words, inRange: lines.every(l => l.start >= 0 && l.end <= projDuration() + 1.01) };
    });
    r.captionsOK = cap.n > 5 && !cap.overlap && cap.textSame && cap.inRange;
    // 8) the transcript survives save -> load
    r.saveLoadOK = await p.evaluate(() => {
      const before = aiTimelineWords().map(x => x.w).join('|');
      const json = serializeProject();
      state.media.forEach(m => { delete m.transcript; });
      loadProjectJSON(json);
      return aiTimelineWords().map(x => x.w).join('|') === before;
    });
    pageErrors = pageErrors.concat(app.errors);
    await app.close();
  }
  console.log(JSON.stringify(R, null, 1));
  const fails = [];
  for (const fx in R) for (const k in R[fx]) if (k.endsWith('OK') && !R[fx][k]) fails.push(fx + '.' + k);
  console.log('pageerrors:', pageErrors.length ? pageErrors : '(none)');
  console.log(fails.length || pageErrors.length ? 'FAIL: ' + fails.join(', ') : 'PASS');
  process.exit(fails.length || pageErrors.length ? 1 : 0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
