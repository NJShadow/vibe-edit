#!/usr/bin/env node
/* ai-ui.js — structural audit of every v4.6 panel and dialog, opened through the
 * REAL controls (clicks, not function calls — a duplicate-ID bug once survived
 * because a test called the handler directly). For each: it must actually paint
 * (non-zero geometry), every visible control needs a tooltip or label, no
 * duplicate IDs, no page errors. Screenshots land in tests/out/.
 * Usage: node tests/ai-ui.js  (about 1 minute; transcribes one fixture)
 */
const path = require('path'), fs = require('fs');
const { openApp, addWavMedia } = require('./lib/fixture-page');
const OUT = path.join(__dirname, 'out'); fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  const app = await openApp({ protocolTimeout: 900000, viewport: { width: 1600, height: 950 } });
  const p = app.page, R = {};
  const audit = async (name, rootSel) => {
    const a = await p.evaluate((rootSel) => {
      const root = document.querySelector(rootSel); if (!root) return { painted: false, missing: true };
      const r = root.getBoundingClientRect();
      const vis = e => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
      const ctrls = [...root.querySelectorAll('button,select,input,[role=tab]')].filter(vis);
      const noTip = ctrls.filter(e => !((e.title || '').length > 3 || e.getAttribute('aria-label') || (e.closest('[title]') && e.closest('[title]').title.length > 3) || (e.tagName === 'INPUT' && e.placeholder)));
      const ids = {}; document.querySelectorAll('[id]').forEach(e => ids[e.id] = (ids[e.id] || 0) + 1);
      return { painted: r.width > 40 && r.height > 20, controls: ctrls.length, untooltipped: noTip.map(e => e.id || e.className || e.textContent.trim().slice(0, 20)),
        dupIds: Object.keys(ids).filter(k => ids[k] > 1) };
    }, rootSel);
    R[name] = a; await p.screenshot({ path: path.join(OUT, name + '.png') });
  };
  const id = await addWavMedia(p, path.join(__dirname, 'fixtures', 'long-noisy.wav'), { name: 'voiceover.wav' });
  await p.evaluate((id) => {
    const m = state.media.find(x => x.id === id); renderBin(); addMediaToTimeline(m, 0, 'A1');
    const cv = document.createElement('canvas'); cv.width = 64; cv.height = 36;
    state.media.push({ id: 'img', type: 'image', name: 'still.png', duration: 5, w: 64, h: 36, el: cv });
    ['a', 'b', 'c'].forEach((n, i) => state.clips.push(makeClip({ type: 'image', track: 'V1', start: i * 2, duration: 2, mediaId: 'img', name: 'shot ' + n })));
    renderTimeline();
  }, id);
  // AI tools menu from the top bar
  await p.click('#aiToolsBtn'); await sleep(250); await audit('ai-tools-menu', '#ctxMenu');
  R.menuItems = await p.evaluate(() => [...document.querySelectorAll('#ctxMenu .mitem')].map(b => b.textContent.trim()));
  await p.keyboard.press('Escape'); await p.mouse.click(800, 400); await sleep(100);
  // transcript tab: empty state, then transcribe
  await p.click('#tabTx'); await sleep(350); await audit('transcript-empty', '#binTx');
  await p.click('#txGo'); await p.waitForFunction(() => !AI.job, { timeout: 600000 }); await sleep(400);
  await audit('transcript', '#binTx');
  R.transcriptWords = await p.evaluate(() => TX.list.length);
  // filler review
  await p.click('#txFillers'); await sleep(250); await audit('fillers', '#binTx');
  R.fillerCount = await p.evaluate(() => TX.review ? [...TX.review.idx].length : -1);
  await p.click('#rvDone'); await sleep(100);
  // pauses dialog
  await p.click('#txPauses'); await p.waitForSelector('#apStrip', { timeout: 60000 }); await sleep(400); await audit('pauses', '#overlay .modal');
  R.pauseStats = await p.evaluate(() => $('#apStats').textContent);
  await p.click('#apX'); await sleep(150);
  // captions dialog
  await p.click('#txCaps'); await p.waitForSelector('#capGo', { timeout: 60000 }); await sleep(200); await audit('captions', '#overlay .modal');
  await p.click('#capGo'); await sleep(300);
  R.captionClips = await p.evaluate(() => state.clips.filter(c => c.isCaption).length);
  // beat sync (select the three image clips first)
  await p.evaluate(() => { const ims = state.clips.filter(c => c.type === 'image'); state.selection = ims[0].id; state.selExtra = ims.slice(1).map(c => c.id); renderTimeline(); });
  await p.click('#aiToolsBtn'); await sleep(200);
  await p.evaluate(() => [...document.querySelectorAll('#ctxMenu .mitem')].find(b => /Beat sync/.test(b.textContent)).click());
  await p.waitForSelector('#bsGo', { timeout: 60000 }); await sleep(900); await audit('beat-sync', '#overlay .modal');
  await p.click('#bsX'); await sleep(150);
  // reframe dialog
  await p.click('#aiToolsBtn'); await sleep(200);
  await p.evaluate(() => [...document.querySelectorAll('#ctxMenu .mitem')].find(b => /Auto-reframe/.test(b.textContent)).click());
  await p.waitForSelector('#rfGo'); await sleep(200); await audit('reframe', '#overlay .modal');
  await p.click('#rfX'); await sleep(150);
  // command palette knows the new tools
  R.palette = await p.evaluate(() => COMMANDS.filter(c => /Transcript|filler|pauses|Captions|scenes|Beat|reframe|AI tools/i.test(c.n)).length);
  // guide documents them
  R.guideAI = await p.evaluate(() => { openGuide(); const n = [...document.querySelectorAll('#gdBody .gditem')].filter(e => /Transcript|filler|pauses|Captions|scenes|Beat sync|reframe/i.test(e.textContent)).length; closeOverlay(); return n; });
  // transcript Delete must never delete timeline clips when nothing is selected in the text
  R.deleteGuard = await p.evaluate(() => { const n = state.clips.length; $('#txBody').focus(); state.selection = state.clips[0].id;
    $('#txBody').dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })); return state.clips.length === n; });
  console.log(JSON.stringify(R, null, 1));
  const fails = [];
  for (const k in R) if (R[k] && typeof R[k] === 'object' && 'painted' in R[k]) {
    if (!R[k].painted) fails.push(k + ':not painted'); if (R[k].untooltipped && R[k].untooltipped.length) fails.push(k + ':untooltipped'); if (R[k].dupIds && R[k].dupIds.length) fails.push(k + ':dupIds');
  }
  if (R.menuItems.length < 7) fails.push('menu'); if (R.transcriptWords < 50) fails.push('transcript'); if (!(R.fillerCount >= 0)) fails.push('fillers');
  if (!R.captionClips) fails.push('captions'); if (R.palette < 8) fails.push('palette'); if (R.guideAI < 7) fails.push('guide'); if (!R.deleteGuard) fails.push('deleteGuard');
  console.log('pageerrors:', app.errors.length ? app.errors : '(none)');
  console.log(fails.length || app.errors.length ? 'FAIL: ' + fails.join(', ') : 'PASS');
  await app.close(); process.exit(fails.length || app.errors.length ? 1 : 0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
