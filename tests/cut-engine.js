#!/usr/bin/env node
/* cut-engine.js — randomized property test for the ripple-cut engine (aiRippleCut).
 *
 * THE PROPERTY: after removing ranges R from the timeline, every frame that
 * survives must look and sound exactly as it did before. Concretely, for each
 * frame t' of the new timeline and every unlocked track, the clip showing there
 * must be the same media at the same SOURCE time (srcTimeFor) with the same
 * animated values (liveProps) as the old timeline at the corresponding old time.
 * Locked tracks must be byte-identical. Links must never span a cut.
 *
 * Randomized over speed, reverse, freeze frames, keyframes (linear/hold/smooth),
 * linked A/V pairs, locked tracks, overlapping ranges and off-grid input.
 *
 * Usage: node tests/cut-engine.js [iterations]
 */
const { launch, close } = require('./browser');
const path = require('path');
const APP = 'file://' + path.resolve(__dirname, '..', 'vibe-edit.html');

(async () => {
  const iters = +process.argv[2] || 300;
  const browser = await launch(); const page = await browser.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(APP); await new Promise(r => setTimeout(r, 600));
  const r = await page.evaluate((iters) => {
    let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
    const pick = a => a[Math.floor(rnd() * a.length)];
    const out = { iterations: iters, framesChecked: 0, failures: [], maxSmoothDev: 0 };
    const renderTimeline0 = window.renderTimeline;
    for (let it = 0; it < iters; it++) {
      const fps = pick([24, 25, 30, 60]); state.project.fps = fps; const F = 1 / fps;
      state.locked = {}; state.markers = []; state.rangeIn = state.rangeOut = null;
      if (rnd() < 0.3) state.locked[pick(['A2', 'V2'])] = true;
      state.media = [{ id: 'mv', type: 'video', duration: 400 }, { id: 'ma', type: 'audio', duration: 400 }];
      const clips = [];
      for (const tr of ['V1', 'V2', 'A1', 'A2', 'TX']) {
        let t = Math.floor(rnd() * 20) * F;
        const n = 1 + Math.floor(rnd() * 5);
        for (let i = 0; i < n; i++) {
          const dur = (5 + Math.floor(rnd() * 150)) * F;
          const type = tr[0] === 'V' ? pick(['video', 'video', 'image']) : tr[0] === 'A' ? 'audio' : 'text';
          const c = makeClip({ type, track: tr, start: t, duration: dur, inPoint: Math.floor(rnd() * 100) * F,
            mediaId: type === 'video' ? 'mv' : type === 'audio' ? 'ma' : null, name: 'c' + it + tr + i });
          c.props.speed = pick([1, 1, 1, 0.5, 2, 1.5]);
          if (type === 'video' && rnd() < 0.15) c.props.reverse = true;
          if (type === 'video' && rnd() < 0.08) { c.freeze = true; c.freezeAt = c.inPoint + 0.3; }
          if (rnd() < 0.35) {
            c.kfEaseMode = pick(['linear', 'hold', 'smooth']);
            c.kf = { x: [{ t: 0, v: rnd() * 100 }, { t: dur * rnd(), v: rnd() * 100 }, { t: dur, v: rnd() * 100 }].sort((a, b) => a.t - b.t),
                     opacity: [{ t: dur * 0.3, v: 0.2 }, { t: dur * 0.9, v: 1 }] };
          }
          c.props.fadeIn = rnd() < 0.2 ? 0.2 : 0; c.props.fadeOut = rnd() < 0.2 ? 0.2 : 0;
          clips.push(c); t += dur + (rnd() < 0.3 ? Math.floor(rnd() * 30) * F : 0);
        }
      }
      // linked pairs: V1 clips with a same-span A1 clip
      clips.filter(c => c.track === 'V1' && c.type === 'video').forEach(v => {
        if (rnd() < 0.5) return;
        const a = makeClip({ type: 'audio', track: 'A2', start: v.start, duration: v.duration, inPoint: v.inPoint, mediaId: 'ma' });
        a.props.speed = v.props.speed; const lid = 'lk' + uid(); v.linkId = a.linkId = lid;
        if (!clips.some(o => o.track === 'A2' && o.start < clipEnd(a) && clipEnd(o) > a.start)) clips.push(a); else { delete v.linkId; }
      });
      state.clips = clips;
      for (let m = 0; m < 4; m++) state.markers.push({ t: rnd() * 10, type: 'user' });
      const before = JSON.parse(JSON.stringify(state.clips));
      const snapBefore = JSON.stringify(state.clips.filter(c => state.locked[c.track]));
      const D = projDuration();
      const ranges = [];
      const nr = 1 + Math.floor(rnd() * 6);
      for (let i = 0; i < nr; i++) {
        const a = rnd() * D, b = a + (rnd() < 0.2 ? rnd() * 0.05 : rnd() * D * 0.3);
        ranges.push(rnd() < 0.5 ? [a, b] : [Math.round(a * fps) / fps + (rnd() - 0.5) * 0.01, b]);
      }
      const markersBefore = state.markers.map(m => m.t);
      window.renderTimeline = () => {};
      const res = aiRippleCut(ranges, { noHistory: true, noRender: true });
      window.renderTimeline = renderTimeline0;
      if (!res) continue;
      const rs = res.ranges;
      const toOld = tn => { let t = tn; for (const r of rs) { if (t >= r[0] - 1e-9) t += r[1] - r[0]; else break; } return t; };
      const oldAt = (tr, t) => before.find(c => c.track === tr && t >= c.start - 1e-9 && t < c.start + c.duration - 1e-9);
      const newAt = (tr, t) => state.clips.find(c => c.track === tr && t >= c.start - 1e-9 && t < c.start + c.duration - 1e-9);
      const fail = (m) => { if (out.failures.length < 12) out.failures.push('iter ' + it + ': ' + m); };
      // 1) locked tracks untouched
      if (JSON.stringify(state.clips.filter(c => state.locked[c.track])) !== snapBefore) fail('locked track changed');
      // 2) frame-by-frame continuity on unlocked tracks (sampled at frame centers)
      const Dn = projDuration();
      for (let f = 0; f * F < Dn; f++) {
        const tn = (f + 0.37) * F, to = toOld(tn);
        for (const tr of ['V1', 'V2', 'A1', 'A2', 'TX']) {
          if (state.locked[tr]) continue;
          const o = oldAt(tr, to), n = newAt(tr, tn);
          if (!o && !n) continue;
          if (!o || !n) { fail(`${tr} t'=${tn.toFixed(3)}: presence differs (old ${!!o}, new ${!!n})`); continue; }
          out.framesChecked++;
          if (o.mediaId !== n.mediaId) fail(`${tr} media differs`);
          const so = srcTimeFor(o, to), sn = srcTimeFor(n, tn);
          if (Math.abs(so - sn) > 1e-6) fail(`${tr} t'=${tn.toFixed(3)} src ${sn.toFixed(4)} vs ${so.toFixed(4)} (speed ${o.props.speed}${o.props.reverse ? ' rev' : ''})`);
          const po = liveProps(o, to), pn = liveProps(n, tn);
          for (const k of ['x', 'opacity']) {
            const dv = Math.abs(po[k] - pn[k]);
            if ((o.kfEaseMode || 'smooth') === 'smooth') out.maxSmoothDev = Math.max(out.maxSmoothDev, dv);
            else if (dv > 1e-6) fail(`${tr} ${k} ${pn[k]} vs ${po[k]} (${o.kfEaseMode})`);
          }
          if (n.freeze !== o.freeze) fail('freeze flag lost');
        }
      }
      // 3) the new program end is exactly where the last surviving content lands
      const remBefore = x => rs.reduce((a, r) => a + (r[1] <= x + 1e-9 ? r[1] - r[0] : 0), 0);
      let expectEnd = 0;
      for (const c of before) {
        const s0 = c.start, e0 = c.start + c.duration;
        if (state.locked[c.track]) { expectEnd = Math.max(expectEnd, e0); continue; }
        let x = e0; for (const r of rs) if (x > r[0] + 1e-9 && x <= r[1] + 1e-9) x = r[0];
        if (x <= s0 + 1e-9) continue;
        expectEnd = Math.max(expectEnd, x - remBefore(x));
      }
      if (Math.abs(Dn - expectEnd) > 1e-6) fail(`duration ${Dn} expected ${expectEnd}`);
      // 4) no new overlaps
      for (const tr of ['V1', 'V2', 'A1', 'A2', 'TX']) {
        const cs = state.clips.filter(c => c.track === tr).sort((a, b) => a.start - b.start);
        for (let i = 1; i < cs.length; i++) if (cs[i].start < cs[i - 1].start + cs[i - 1].duration - 1e-6) fail(tr + ' overlap after cut');
      }
      // 5) links never straddle a cut: all members of a link group abut/overlap in one island
      const groups = {}; state.clips.forEach(c => { if (c.linkId) (groups[c.linkId] = groups[c.linkId] || []).push(c); });
      for (const k in groups) { const g = groups[k]; if (g.length > 2) fail('link group of ' + g.length); }
      // 6) unique ids
      if (new Set(state.clips.map(c => c.id)).size !== state.clips.length) fail('duplicate clip ids');
      // 7) markers
      const expectM = markersBefore.filter(t => !rs.some(r => t >= r[0] - 1e-6 && t < r[1] - 1e-6)).length;
      if (state.markers.length !== expectM) fail('marker count');
    }
    return out;
  }, iters);
  console.log(JSON.stringify(Object.assign({}, r, { failures: r.failures.length ? r.failures : '(none)' }), null, 1));
  const ok = !r.failures.length && !errors.length && r.framesChecked > 1000 && r.maxSmoothDev < 1e-6;
  console.log('pageerrors:', errors.length ? errors : '(none)');
  console.log(ok ? 'PASS' : 'FAIL');
  await close(browser); process.exit(ok ? 0 : 1);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
