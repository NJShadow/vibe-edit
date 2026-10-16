/* review-fixes.js — regression checks for bugs found in code review.
 * One section per reviewed area; each section boots its own fresh page, so
 * sections never share state. To add a section: SECTIONS.push([name, fn]).
 * Usage: node tests/review-fixes.js
 */
const { openApp } = require('./lib/fixture-page');
const R = {}, fails = [];
const check = (k, ok) => { R[k] = !!ok; if (!ok) fails.push(k); };
const SECTIONS = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ========================= section: timeline ========================= */
SECTIONS.push(['timeline', async (app) => {
  const p = app.page, E = (f, ...a) => p.evaluate(f, ...a), T = (k, ok) => check('timeline: ' + k, ok);
  await p.setViewport({ width: 1600, height: 1000 });
  await E(() => {
    window.RESET = (clips, opt = {}) => {
      state.media = state.media.filter(m => !m._fake);
      state.media.push({ id: 'mv', _fake: 1, type: 'video', name: 'v.mp4', duration: 20, w: 1920, h: 1080 });
      state.media.push({ id: 'ma', _fake: 1, type: 'audio', name: 'a.wav', duration: 20, w: 0, h: 0 });
      state.clips = clips.map(o => makeClip(Object.assign({}, o)));
      state.selection = null; state.selExtra = []; state.history = []; state.hIndex = -1; state.locked = {}; state.markers = [];
      state.pps = opt.pps || 50; state.snap = opt.snap !== false; state.time = opt.time || 0; state.tool = 'select'; setTool('select');
      state.rangeIn = state.rangeOut = null;
      pushHistory(); renderTimeline(); tlScroll.scrollLeft = 0;
    };
    window.C = id => state.clips.find(c => c.id === id);
    window.BOX = id => { const r = tracksHost.querySelector(`.clip[data-id="${id}"]`).getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
    window.ROWY = id => { const r = document.querySelector(`.track[data-id="${id}"]`).getBoundingClientRect(); return r.top + r.height / 2; };
    window.KEY = (key, o = {}) => dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key }, o)));
    window.LINKED = [{ id: 'v', type: 'video', mediaId: 'mv', track: 'V1', start: 2, duration: 4, linkId: 'L' }, { id: 'a', type: 'audio', mediaId: 'ma', track: 'A1', start: 2, duration: 4, linkId: 'L' }];
  });
  const drag = async (x0, y0, x1, y1, steps = 20) => { await p.mouse.move(x0, y0); await p.mouse.down(); await p.mouse.move(x1, y1, { steps }); await p.mouse.up(); await sleep(60); };
  const dragClip = async (id, dx, dy = 0, where = 'mid', steps = 30) => {
    const b = await E(i => BOX(i), id);
    const x = where === 'l' ? b.x + 2 : where === 'r' ? b.x + b.w - 2 : b.x + b.w / 2, y = b.y + b.h / 2;
    await drag(x, y, x + dx, typeof dy === 'string' ? await E(t => ROWY(t), dy) : y + dy, steps);
  };

  // 1. split of a linked clip splits the partner too; each side has its own link id; locked refuses
  const sp = await E(() => {
    RESET(LINKED.map(o => Object.assign({}, o, { start: 0 })), { time: 2 }); state.time = 2; selectClip('v'); KEY('s');
    const n = state.clips.length, right = state.clips.filter(c => c.start > 1.9);
    const ok = n === 4 && right.length === 2 && right[0].linkId === right[1].linkId && right[0].linkId !== 'L' && C('v').linkId === 'L' && C('a').linkId === 'L' && C('a').duration === 2;
    selectClip(right[0].id); state.selExtra = []; KEY('Delete');
    const afterDel = state.clips.map(c => c.id).sort().join();
    RESET([{ id: 'x', type: 'color', track: 'V1', start: 0, duration: 4 }], { time: 2 }); state.locked.V1 = true; state.time = 2; KEY('s');
    return { ok, afterDel, locked: state.clips.length };
  });
  T('1 split splits linked partner with own link id', sp.ok);
  T('1 deleting one split side keeps the other', sp.afterDel === 'a,v');
  T('1 split refused on locked track', sp.locked === 1);

  // 2. linked drag doesn't snap to its own partner's edges (smooth pointer drag, +100px = +2s)
  await E(() => RESET(LINKED));
  await dragClip('v', 100, 0, 'mid', 50);
  T('2 linked drag lands exactly', await E(() => Math.abs(C('v').start - 4) < 1e-6 && Math.abs(C('a').start - 4) < 1e-6));
  await E(() => RESET(LINKED));
  const trail = [];
  { const b = await E(() => BOX('v')); const x0 = b.x + b.w / 2, y = b.y + b.h / 2; await p.mouse.move(x0, y); await p.mouse.down();
    for (let i = 4; i <= 12; i += 2) { await p.mouse.move(x0 + i, y); trail.push(await E(() => +((C('v').start - 2) * 50).toFixed(1))); }
    await p.mouse.up(); await sleep(40); }
  T('2 linked drag follows the pointer (no jump to partner edges)', trail.join() === '4,6,8,10,12');

  // 3. locked tracks never move with a group; can't drop onto a locked track
  await E(() => { RESET([{ id: 'v', type: 'color', track: 'V1', start: 2, duration: 4 }, { id: 'm', type: 'audio', mediaId: 'ma', track: 'A2', start: 0, duration: 10 }]); state.locked.A2 = true; selectAllClips(); });
  await dragClip('v', 100, 0, 'mid', 5);
  T('3 select-all drag leaves locked track clip', await E(() => C('m').start === 0 && Math.abs(C('v').start - 4) < 1e-6));
  await E(() => { RESET([{ id: 'A', type: 'color', track: 'V1', start: 0, duration: 4 }]); state.locked.V2 = true; renderTimeline(); });
  await dragClip('A', 0, 'V2', 'mid', 10);
  T('3 no drop onto a locked track', await E(() => C('A').track === 'V1'));
  await E(() => { RESET(LINKED); state.locked.A1 = true; renderTimeline(); });
  await dragClip('v', 100, 0, 'mid', 5);
  T('3 linked pair with a locked half does not drift', await E(() => C('v').start === 2 && C('a').start === 2));

  // 4. slip on a linked clip slips the partner too
  await E(() => { RESET([{ id: 'A', type: 'video', mediaId: 'mv', start: 0, duration: 4, inPoint: 5, linkId: 'L1' }, { id: 'Aa', type: 'audio', mediaId: 'ma', track: 'A1', start: 0, duration: 4, inPoint: 5, linkId: 'L1' }]); setTool('slip'); });
  await dragClip('A', 50, 0, 'mid', 10);
  T('4 slip moves linked partner in-point', await E(() => Math.abs(C('A').inPoint - 4) < 1e-6 && Math.abs(C('Aa').inPoint - 4) < 1e-6));

  // 5. roll on linked clips rolls the partners' cut
  await E(() => { RESET([{ id: 'A', type: 'video', mediaId: 'mv', start: 0, duration: 4, linkId: 'L1' }, { id: 'B', type: 'video', mediaId: 'mv', start: 4, duration: 4, inPoint: 8, linkId: 'L2' },
    { id: 'Aa', type: 'audio', mediaId: 'ma', track: 'A1', start: 0, duration: 4, linkId: 'L1' }, { id: 'Ba', type: 'audio', mediaId: 'ma', track: 'A1', start: 4, duration: 4, inPoint: 8, linkId: 'L2' }]); setTool('roll'); });
  await dragClip('B', 50, 0, 'l', 10);
  T('5 roll moves the linked cut too', await E(() => ['A', 'Aa'].every(i => Math.abs(C(i).duration - 5) < 1e-6) && ['B', 'Ba'].every(i => Math.abs(C(i).start - 5) < 1e-6 && Math.abs(C(i).inPoint - 9) < 1e-6 && Math.abs(C(i).duration - 3) < 1e-6)));

  // 6. slide: a non-touching previous clip is left alone; the next clip's content stays put
  await E(() => { RESET([{ id: 'P', type: 'video', mediaId: 'mv', start: 0, duration: 2 }, { id: 'C', type: 'video', mediaId: 'mv', start: 5, duration: 2, inPoint: 5 }, { id: 'N', type: 'video', mediaId: 'mv', start: 7, duration: 3, inPoint: 10 }]); setTool('slide'); });
  await dragClip('C', 50, 0, 'mid', 10);
  T('6 slide leaves a non-adjacent neighbor and keeps next content', await E(() => C('P').duration === 2 && Math.abs(C('C').start - 6) < 1e-6
    && Math.abs(C('N').start - 8) < 1e-6 && Math.abs(C('N').inPoint - 11) < 1e-6 && Math.abs(srcTimeFor(C('N'), 9) - 12) < 1e-6));
  await E(() => { RESET([{ id: 'P', type: 'video', mediaId: 'mv', start: 0, duration: 2, inPoint: 17 }, { id: 'C', type: 'color', start: 2, duration: 2 }]); setTool('slide'); });
  await dragClip('C', 150, 0, 'mid', 10);
  T('6 slide limits the previous clip to its source', await E(() => C('P').inPoint + C('P').duration <= 20 + 1e-6 && C('C').start <= 3 + 1e-6));

  // 7/8. ripple delete: non-adjacent selection, and linked partner on a locked track
  const rp = await E(() => {
    RESET([{ id: 'A', type: 'color', start: 0, duration: 2 }, { id: 'B', type: 'color', start: 2, duration: 3 }, { id: 'C', type: 'color', start: 5, duration: 2 }, { id: 'D', type: 'color', start: 7, duration: 2 }]);
    state.selection = 'A'; state.selExtra = ['C']; deleteSelected(true);
    const a = [C('B').start, C('D').start].join();
    RESET([{ id: 'v', type: 'video', mediaId: 'mv', track: 'V1', start: 0, duration: 4, linkId: 'L' }, { id: 'a', type: 'audio', mediaId: 'ma', track: 'A1', start: 0, duration: 4, linkId: 'L' },
      { id: 'v2', type: 'video', mediaId: 'mv', track: 'V1', start: 4, duration: 4, linkId: 'M' }, { id: 'a2', type: 'audio', mediaId: 'ma', track: 'A1', start: 4, duration: 4, linkId: 'M' }]);
    state.locked.A1 = true; selectClip('v'); deleteSelected(true);
    return { a, sync: C('v2').start === C('a2').start };
  });
  T('7 ripple closes each deleted span separately', rp.a === '0,3');
  T('8 ripple keeps a pair with a locked half in sync', rp.sync);

  // 9. close gap moves linked partners; no gap badge on a locked track
  const cg = await E(() => {
    RESET(LINKED.map(o => Object.assign({}, o, { start: 3 })));
    document.querySelector('.track[data-id="V1"] .gapbadge').click();
    const moved = C('v').start === 0 && C('a').start === 0;
    RESET([{ id: 'v', type: 'color', track: 'V1', start: 3, duration: 4 }]); state.locked.V1 = true; renderTimeline();
    const badge = !!document.querySelector('.track[data-id="V1"] .gapbadge');
    closeGap('V1', 0, 3);
    return { moved, badge, still: C('v').start === 3 };
  });
  T('9 close gap moves the linked partner', cg.moved);
  T('9 no close-gap on a locked track', !cg.badge && cg.still);

  // 10. duplicate: unlinked copy in a free spot
  const du = await E(() => {
    RESET([{ id: 'A', type: 'color', start: 0, duration: 4, linkId: 'L', groupId: 'G' }, { id: 'B', type: 'color', start: 4, duration: 4 }]); state.selection = 'A'; state.selExtra = [];
    duplicateSelected(); const d = state.clips[2];
    return !d.linkId && !d.groupId && d.start >= 8 - 1e-6;
  });
  T('10 duplicate drops link/group and does not overlap', du);

  // 11. Ctrl+X on a linked clip copies the pair; paste brings both back, linked to each other
  const cx = await E(() => {
    RESET(LINKED); selectClip('v'); KEY('x', { ctrlKey: true });
    const cut = state.clips.length; pasteClip(0);
    const cl = state.clips;
    return cut === 0 && cl.length === 2 && cl[0].linkId && cl[0].linkId === cl[1].linkId && cl[0].linkId !== 'L' && cl.map(c => c.type).sort().join() === 'audio,video';
  });
  T('11 cut/paste of a linked clip keeps the pair', cx);

  // 12. nudge keys: Alt+Arrow moves partners, respects locks; ArrowUp for adjustment layers and locks
  const nk = await E(() => {
    RESET(LINKED); selectClip('v'); KEY('ArrowRight', { altKey: true, shiftKey: true });
    const pair = Math.abs(C('v').start - C('a').start) < 1e-9 && C('v').start > 2;
    RESET([{ id: 'v', type: 'color', track: 'V1', start: 3, duration: 4 }]); state.locked.V1 = true; selectClip('v');
    KEY('ArrowRight', { altKey: true }); KEY('ArrowUp');
    const lock = C('v').start === 3 && C('v').track === 'V1';
    RESET([{ id: 'A', type: 'adjust', track: 'V1', start: 0, duration: 4 }]); selectClip('A'); KEY('ArrowUp');
    const adj = C('A').track === 'V2';
    RESET([{ id: 'A', type: 'color', track: 'V1', start: 0, duration: 4 }]); state.locked.V2 = true; selectClip('A'); KEY('ArrowUp');
    return { pair, lock, adj, intoLocked: C('A').track === 'V1' };
  });
  T('12 Alt+Arrow moves the linked partner', nk.pair);
  T('12 nudges respect locked tracks', nk.lock && nk.intoLocked);
  T('12 ArrowUp moves an adjustment layer', nk.adj);

  // 13. a linked clip can be dragged to another track (its sound stays on its own)
  await E(() => RESET(LINKED));
  await dragClip('v', 0, 'V2', 'mid', 10);
  T('13 linked clip changes track, partner keeps its track', await E(() => C('v').track === 'V2' && C('a').track === 'A1' && C('v').start === 2 && C('a').start === 2));
  await E(() => { RESET([{ id: 'x', type: 'color', track: 'V1', start: 0, duration: 2 }, { id: 'y', type: 'color', track: 'V1', start: 3, duration: 2 }, { id: 't', type: 'text', track: 'TX', start: 0, duration: 2 }]); state.selection = 'x'; state.selExtra = ['y', 't']; renderTimeline(); });
  await dragClip('x', 0, 'V2', 'mid', 10);
  T('13 multi-selection changes track together', await E(() => C('x').track === 'V2' && C('y').track === 'V2' && C('t').track === 'TX'));

  // 14. trimming a grouped clip trims only that clip
  await E(() => { RESET([{ id: 'A', type: 'color', track: 'V1', start: 0, duration: 4 }, { id: 'T', type: 'text', track: 'TX', start: 6, duration: 3 }]); state.selection = 'A'; state.selExtra = ['T']; groupSelected(); selectClip(null); });
  await dragClip('A', -50, 0, 'r', 5);
  T('14 group trim trims only the dragged clip', await E(() => Math.abs(C('A').duration - 3) < 1e-6 && C('T').duration === 3 && C('T').start === 6));

  // 15. N = roll tool, Shift+N = snapping, docs agree
  const nn = await E(() => {
    RESET([]); const s0 = state.snap; KEY('N', { shiftKey: true }); const s1 = state.snap; KEY('n');
    return { toggled: s0 !== s1, roll: state.tool === 'roll', tip: /Shift\+N/.test($('#snapBtn').title),
      sheet: SHORTCUTS.some(r => r[0] === 'Toggle snapping' && r[1] === 'Shift N'), pal: COMMANDS.some(c => c.n === 'Toggle snapping' && c.k === 'Shift N') };
  });
  T('15 Shift+N toggles snapping, N is Roll, docs agree', nn.toggled && nn.roll && nn.tip && nn.sheet && nn.pal);

  // 16. removing a track forgets its solo/lock/hide flags
  const rt = await E(() => {
    RESET([{ id: 'a', type: 'audio', mediaId: 'ma', track: 'A1', start: 0, duration: 4 }]);
    addTrack('audio'); const id = TRACKS.filter(t => t.kind === 'audio').pop().id; state.solo[id] = true; state.locked[id] = true; state.hidden[id] = true;
    removeTrack(id); const clean = !state.solo[id] && !state.locked[id] && !state.hidden[id];
    state.solo.A9 = true; const stale = !trackMuted('A1'); delete state.solo.A9;
    return clean && stale;
  });
  T('16 removeTrack clears solo/lock/hide; stale solo mutes nothing', rt);

  // 17. redo onto a removed track brings the track back
  const rd = await E(() => {
    RESET([{ id: 'v', type: 'color', track: 'V1', start: 0, duration: 4 }]);
    addTrack('video'); const nt = TRACKS.find(t => t.kind === 'video' && !['V1', 'V2'].includes(t.id)).id;
    pushHistory(); C('v').track = nt; renderTimeline(); undo(); removeTrack(nt); redo();
    const ok = !!trackOf(C('v').track) && document.querySelectorAll('.clip').length === 1;
    // tidy: move the clip back and drop the track
    C('v').track = 'V1'; removeTrack(nt); return ok;
  });
  T('17 redo re-creates a removed track', rd);

  // 18. audio gain is one clean undo step
  const ag = await E(async () => {
    RESET([{ id: 'v', type: 'audio', mediaId: 'ma', track: 'A1', start: 0, duration: 4 }]);
    selectClip('v'); pushHistory(); C('v').start = 5; renderTimeline();
    audioGainDialog(); $('#agVal').value = -6; $('#agGo').click(); await new Promise(r => setTimeout(r, 50));
    undo(); return C('v').start === 5 && C('v').props.volume === 1;
  });
  T('18 undo after audio gain reverts only the gain', ag);

  // 19. freeze frame is a single undo step
  const fz = await E(() => {
    RESET([{ id: 'A', type: 'video', mediaId: 'mv', start: 0, duration: 4 }], { time: 2 }); state.time = 2; selectClip('A');
    KEY('F', { shiftKey: true }); const n = state.clips.length; undo();
    return n === 2 && state.clips.length === 1 && state.clips[0].duration === 4;
  });
  T('19 freeze frame undoes in one step', fz);

  // 20. keyboard zoom near the end keeps the playhead in view
  const zm = await E(async () => {
    RESET([{ id: 'A', type: 'color', start: 0, duration: 200 }], { pps: 50 }); setTime(195); await new Promise(r => requestAnimationFrame(r));
    tlScroll.scrollLeft = tlScroll.scrollWidth; const x0 = 195 * state.pps - tlScroll.scrollLeft;
    for (let i = 0; i < 3; i++) KEY('='); await new Promise(r => setTimeout(r, 100));
    const x1 = 195 * state.pps - tlScroll.scrollLeft; return Math.abs(x1 - x0) < 2;
  });
  T('20 zoom keeps the playhead anchored near the end', zm);

  // a. box selection (real pointer), click on empty space still deselects
  await E(() => RESET([{ id: 'x', type: 'color', track: 'V1', start: 1, duration: 2 }, { id: 'y', type: 'color', track: 'V2', start: 2, duration: 2 }, { id: 'z', type: 'color', track: 'V1', start: 10, duration: 2 }, { id: 'a', type: 'audio', mediaId: 'ma', track: 'A1', start: 1, duration: 2 }]));
  { const bx = await E(() => BOX('x')), by = await E(() => BOX('y'));
    await drag(bx.x - 20, by.y + 3, bx.x + bx.w + 10, bx.y + bx.h - 3, 10); }   // from empty V2 space down into V1
  const mq = await E(() => ({ sel: selectedIds().sort().join(), t: state.time, boxGone: !document.querySelector('.marquee') }));
  T('a box selection selects intersecting clips', mq.sel === 'x,y' && mq.t === 0 && mq.boxGone);
  { const bx = await E(() => BOX('x')); await p.mouse.click(bx.x + bx.w + 200, bx.y + bx.h / 2); await sleep(40); }
  T('a click on empty space still deselects and seeks', await E(() => selectedIds().length === 0 && state.time > 3));

  // b. markers: Shift+M adds, right-click on the ruler deletes
  await E(() => { RESET([{ id: 'x', type: 'color', track: 'V1', start: 0, duration: 10 }]); state.time = 4; KEY('M', { shiftKey: true }); });
  const mk1 = await E(() => state.markers.length === 1 && state.markers[0].t === 4 && state.markers[0].type === 'user' && state.clips.length === 1);
  { const x = await E(() => tlScroll.getBoundingClientRect().left + TL_PAD + 4 * state.pps - tlScroll.scrollLeft), y = await E(() => $('#ruler').getBoundingClientRect().top + 13);
    await p.mouse.click(x + 2, y, { button: 'right' }); await sleep(40); }
  T('b Shift+M adds a marker; right-click deletes it', mk1 && await E(() => state.markers.length === 0 && COMMANDS.some(c => c.n === 'Add marker') && COMMANDS.some(c => c.n === 'Clear all markers')));

  // c. O before I makes the range between the two points
  T('c O before I sets the range between them', await E(() => {
    RESET([{ id: 'A', type: 'color', start: 0, duration: 10 }]); state.time = 6; KEY('i'); state.time = 3; KEY('o');
    const r1 = state.rangeIn === 3 && state.rangeOut === 6;
    state.rangeIn = state.rangeOut = null; state.time = 3; KEY('o'); state.time = 7; KEY('i');
    return r1 && state.rangeIn === 3 && state.rangeOut === 7;
  }));

  // e. adding media never snaps into an overlap
  T('e addMediaToTimeline does not snap into an overlap', await E(() => {
    RESET([{ id: 'A', type: 'color', track: 'V1', start: 0, duration: 4.1 }]); state.time = 4;
    addMediaToTimeline(state.media.find(m => m.id === 'mv'), 1, 'V1');
    const n = state.clips.find(c => c.id !== 'A'); return n.start >= 4.1 - 1e-6;
  }));

  // f. paste an adjustment layer onto a targeted track
  T('f paste to a targeted track accepts adjustment layers', await E(() => {
    RESET([{ id: 'A', type: 'adjust', track: 'V1', start: 0, duration: 4 }]); selectClip('A'); copySelected();
    pasteClip(10, 'V2'); return state.clips.some(c => c.id !== 'A' && c.track === 'V2');
  }));

  T('no page errors', app.errors.length === 0);
  if (app.errors.length) R['timeline: errors'] = app.errors.slice(0, 5);
}]);

/* ========================= section: audio ========================= */
SECTIONS.push(['audio', async (app) => {
  const p = app.page, E = (f, ...a) => p.evaluate(f, ...a), T = (k, ok) => check('audio: ' + k, ok);
  const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
  const { addWavMedia } = require('./lib/fixture-page');
  const FF = path.join(__dirname, '..', 'desktop', 'bin', 'ffmpeg' + (process.platform === 'win32' ? '.exe' : ''));
  const { buildAudioFilter } = require('../desktop/audio-filter.js');
  const dir = path.join(__dirname, 'out', 'audio-fix'); fs.mkdirSync(dir, { recursive: true });
  const wav = (name, sec, fn) => { const SR = 48000, n = SR * sec, b = Buffer.alloc(44 + n * 2);
    b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
    b.writeUInt32LE(SR, 24); b.writeUInt32LE(SR * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
    for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, fn(i / SR))) * 32767), 44 + i * 2);
    const f = path.join(dir, name); fs.writeFileSync(f, b); return f; };
  const F = { dc: wav('dc.wav', 10, () => 0.5), ramp: wav('ramp.wav', 10, t => t / 10 * 0.9), sine: wav('sine.wav', 10, t => 0.5 * Math.sin(2 * Math.PI * 440 * t)),
    kick: wav('kick.wav', 6, t => { const q = t % 0.5; return q < 0.15 ? 0.9 * Math.sin(2 * Math.PI * 60 * q) * Math.exp(-q * 30) : 0; }) };
  const ids = {};
  for (const k in F) ids[k] = await addWavMedia(p, F[k], { name: k + '.wav', id: 'au_' + k });
  ids.vid = await addWavMedia(p, F.ramp, { name: 'v.wav', type: 'video', id: 'au_vid' });
  await E((F) => {
    for (const m of state.media) if (m.id.startsWith('au_')) { els[m.id] = new Audio(m.url); m.hasAudio = true; m.fsFile = F[m.id.slice(3)] || F.ramp; }
    window.AR = () => { state.clips = []; state.muted = {}; state.solo = {}; state.markers = []; };
    window.AA = o => { const c = makeClip(Object.assign({ type: 'audio', track: 'A1', name: 'x' }, o, { props: Object.assign(defaultProps(), o.props || {}) })); if (o.kf) c.kf = o.kf; if (o.freeze) { c.freeze = true; c.freezeAt = o.freezeAt; } state.clips.push(c); return c; };
    window.MIX = async (D, ch) => { const b = await renderAudioOffline(D, 48000); return b ? b.getChannelData(ch || 0) : null; };
    window.AT = (d, t) => { const i = Math.round(t * 48000); let s = 0, n = 0; for (let j = i - 24; j <= i + 24; j++)if (j >= 0 && j < d.length) { s += d[j]; n++; } return s / n; };
    window.RMSDB = (d, a, b) => { let s = 0, n = 0; for (let i = Math.round(a * 48000); i < Math.round(b * 48000); i++) { s += d[i] * d[i]; n++; } return 10 * Math.log10(s / n + 1e-24); };
    window.HZ = (d, a, b) => { let z = 0; for (let i = Math.round(a * 48000) + 1; i < Math.round(b * 48000); i++)if (d[i - 1] < 0 && d[i] >= 0) z++; return z / (b - a); };
  }, Object.fromEntries(Object.entries(F).map(([k, v]) => [k, v])));
  const ffRun = (spec, ch) => { spec.clips.forEach(c => { c.channels = 1; }); const af = buildAudioFilter(spec, 0), out = path.join(dir, 'o.f32');
    execFileSync(FF, ['-y', '-v', 'error', ...af.inputs, '-filter_complex', af.filter, '-map', af.outLabel, '-t', String(spec.duration), '-ar', '48000', '-ac', '2', '-f', 'f32le', out]);
    const b = fs.readFileSync(out), f = new Float32Array(b.buffer, b.byteOffset, b.length / 4), L = new Float32Array(f.length / 2);
    for (let i = 0; i < L.length; i++)L[i] = f[2 * i + (ch || 0)]; return L; };
  const at = (d, t) => { const i = Math.round(t * 48000); let s = 0, n = 0; for (let j = i - 24; j <= i + 24; j++)if (j >= 0 && j < d.length) { s += d[j]; n++; } return s / n; };
  const rmsdb = (d, a, b) => { let s = 0, n = 0; for (let i = Math.round(a * 48000); i < Math.round(b * 48000); i++) { s += d[i] * d[i]; n++; } return 10 * Math.log10(s / n + 1e-24); };
  const url = f => 'file://' + f;

  // 1. FFmpeg record-style speed: source time = in + speed·t, nothing past the clip
  if (fs.existsSync(FF)) {
    let ok = true;
    for (const sp of [2, 0.5]) {
      const d = ffRun({ clips: [{ url: url(F.ramp), start: 0, inPoint: 1, duration: 2, speed: sp, preservePitch: false, volume: 1, fadeIn: 0, fadeOut: 0, fx: {} }], duration: 4 });
      for (const t of [0.2, 1, 1.8]) ok = ok && Math.abs(at(d, t) - (1 + sp * t) / 10 * 0.9) < 0.004;
      ok = ok && Math.abs(at(d, 2.5)) < 1e-3 && Math.abs(at(d, 3.5)) < 1e-3;
    }
    T('1 FFmpeg pitch-changing speed maps source time and stays inside the clip', ok);
    // 3. FFmpeg mix vs browser mix: levels per effect (mono source, spec built by the app)
    const cases = { none: {}, echo30: { aEcho: 30 }, reverb30: { aReverb: 30 }, distort50: { aDistort: 50 }, pan50: { aPan: 50 }, panL100: { aPan: -100 }, compress50: { aCompress: 50 }, muffle50: { aMuffle: 50 }, pitch3: { aPitch: 3 } };
    const br = await E(async (cases, sineFile) => { const out = {}; window.vibeNative = window.vibeNative || {};
      for (const k in cases) { AR(); AA({ mediaId: 'au_sine', start: 0, duration: 3, props: cases[k] });
        const b = await renderAudioOffline(3, 48000); out[k] = [RMSDB(b.getChannelData(0), 1, 2), RMSDB(b.getChannelData(1), 1, 2)];
        const m = state.media.find(x => x.id === 'au_sine'); m.proxyPath = 'file://' + sineFile; out[k + '_spec'] = buildAudioMixSpec(3); delete m.proxyPath; }
      return out; }, cases, F.sine);
    const diffs = {};
    for (const k in cases) { const L = ffRun(br[k + '_spec'], 0), R = ffRun(br[k + '_spec'], 1);
      diffs[k] = [rmsdb(L, 1, 2) - br[k][0], Math.max(-100, rmsdb(R, 1, 2)) - Math.max(-100, br[k][1])].map(x => +x.toFixed(2)); }
    R['audio: ffmpeg-browser dB'] = diffs;
    // (the browser reverb's impulse is random noise, so its level varies a little per run)
    T('3 FFmpeg and browser mixes agree within 1.5 dB for each effect (reverb 2.5)', Object.entries(diffs).every(([k, d]) => d.every(x => Math.abs(x) <= (k === 'reverb30' ? 2.5 : 1.5))));
    const pz = ffRun({ clips: [{ url: url(F.sine), start: 0, inPoint: 0, duration: 3, speed: 1, volume: 1, fadeIn: 0, fadeOut: 0, fx: { pitch: 3 } }], duration: 3 });
    let z = 0; for (let i = 48001; i < 96000; i++)if (pz[i - 1] < 0 && pz[i] >= 0) z++;
    T('1b FFmpeg pitch +3 gives 523 Hz', Math.abs(z - 523) <= 2);
  } else R['audio: ffmpeg'] = 'skipped (no desktop/bin/ffmpeg)';

  // 2. Pitch in the browser mix (440 Hz +3 → 523 Hz, −5 → 330 Hz)
  const pit = await E(async () => { const o = {}; for (const s of [3, -5]) { AR(); AA({ mediaId: 'au_sine', start: 0, duration: 3, props: { aPitch: s } }); o[s] = HZ(await MIX(3), 1, 2); } return o; });
  T('2 offline mix applies Pitch (+3 → 523 Hz, −5 → 330 Hz)', Math.abs(pit[3] - 523) <= 3 && Math.abs(pit[-5] - 330) <= 3);

  // 4. detach audio: video muted (not volume 0), kf/pan/fx/mute move to the audio clip
  const dt = await E(async () => { AR();
    const v = AA({ mediaId: 'au_vid', type: 'video', track: 'V1', start: 0, duration: 3, props: { aPan: -100, aBass: 10, aNormalize: true }, kf: { volume: [{ t: 0, v: 1 }, { t: 3, v: 0.5 }] } }); v.kfEaseMode = 'linear';
    const before = AT(await MIX(3), 1); v.props.aNormalize = false; const b2 = AT(await MIX(3), 1); detachAudio(v); const a = state.clips.find(c => c.type === 'audio');
    const after = AT(await MIX(3), 1);
    AR(); const v2 = AA({ mediaId: 'au_vid', type: 'video', track: 'V1', start: 0, duration: 3, props: { muteClip: true } }); detachAudio(v2);
    return { b2, after, vm: v.props.muteClip, vkf: !!(v.kf && v.kf.volume), akf: !!(a.kf && a.kf.volume), ease: a.kfEaseMode, pan: a.props.aPan, bass: a.props.aBass, mute2: state.clips.find(c => c.type === 'audio').props.muteClip, silent2: await MIX(3) }; });
  T('4 detach audio mutes the video and moves volume keys/pan/effects/mute to the audio clip',
    dt.vm && !dt.vkf && dt.akf && dt.ease === 'linear' && dt.pan === -100 && dt.bass === 10 && Math.abs(dt.after - dt.b2) < 0.01 && dt.mute2 === true && dt.silent2 === null);

  // 5. time-stretch keeps the tail (no gap at a cut) and very short clips
  const ts = await E(async () => { const o = {}; const mn = (d, a, b) => { let m = 9; for (let i = Math.round(a * 48000); i < Math.round(b * 48000); i++)m = Math.min(m, d[i]); return m; };
    for (const sp of [1.3, 0.7]) { AR(); AA({ mediaId: 'au_dc', start: 0, duration: 2, props: { speed: sp } }); AA({ mediaId: 'au_dc', start: 2, duration: 2, inPoint: 2 * sp, props: { speed: sp } }); o['seam' + sp] = mn(await MIX(4), 1.8, 2.2); }
    AR(); AA({ mediaId: 'au_dc', start: 0.5, duration: 0.04, props: { speed: 1.5 } }); o.short = mn(await MIX(1), 0.5, 0.54); return o; });
  T('5 pitch-kept speed leaves no gap at a cut and short clips play', ts['seam1.3'] > 0.45 && ts['seam0.7'] > 0.45 && ts.short > 0.45);

  // 6. overlapping fades follow fadeFactor
  const fd = await E(async () => { AR(); const c = AA({ mediaId: 'au_dc', start: 0, duration: 2, props: { fadeIn: 1.5, fadeOut: 1.5 } }); const d = await MIX(3);
    return [0.25, 0.75, 1, 1.25, 1.75].map(t => Math.abs(AT(d, t) - 0.5 * fadeFactor(c, t))); });
  T('6 overlapping fades match the preview curve', fd.every(x => x < 0.003));

  // 7. normalize loudness in the browser mix: −16 LUFS (sine: ≈ −18.3 dB RMS per channel)
  const nm = await E(async () => { AR(); AA({ mediaId: 'au_sine', start: 0, duration: 2, props: { volume: 0.1, aNormalize: true } }); return RMSDB(await MIX(2), 0.5, 1.5); });
  T('7 normalize brings the clip to −16 LUFS like FFmpeg loudnorm', Math.abs(nm - (-18.3)) < 1);

  // 8. same media on two tracks at once: the element no longer ping-pongs; the second clip gets its own element
  const px = await E(async () => { ensureAudioGraph(); const el = els.au_ramp; const seeks = [];
    const d = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
    Object.defineProperty(el, 'currentTime', { get() { return d.get.call(this); }, set(v) { seeks.push(v); d.set.call(this, v); }, configurable: true });
    AR(); AA({ mediaId: 'au_ramp', track: 'A1', start: 0, duration: 4 }); const c2 = AA({ mediaId: 'au_ramp', track: 'A2', start: 0, duration: 4, inPoint: 5, props: { volume: 0.2 } });
    state.time = 1; state.playing = true; for (let i = 0; i < 4; i++) { syncMediaPlayback(); await new Promise(r => setTimeout(r, 30)); }
    const aux = _auxEls[c2.id], n = audioNodes['aux:' + c2.id];
    const r = { far: seeks.filter(v => v > 4).length, aux: !!aux, auxT: aux ? aux.currentTime : -1, g: n ? n.gain.gain.value : -1 };
    state.playing = false; syncMediaPlayback(); r.paused = aux ? aux.paused : null; AR(); syncMediaPlayback(); r.dropped = !_auxEls[c2.id];
    delete el.currentTime; return r; });
  T('8 a second concurrent clip of the same media plays on its own element', px.far === 0 && px.aux && px.auxT > 5 && Math.abs(px.g - 0.2) < 1e-6 && px.paused && px.dropped);

  // 9. J/L cuts keep sound and picture in sync (speed-aware, clamped to the source)
  const jl = await E(() => { const run = (kind, cutIn, speed) => { AR();
      AA({ mediaId: 'au_vid', type: 'video', track: 'V1', start: 0, duration: 3, inPoint: 4, props: { fadeIn: 0.5 } });
      const b = AA({ mediaId: 'au_vid', type: 'video', track: 'V1', start: 3, duration: 3, inPoint: cutIn, props: { speed } });
      state.time = 3; makeSplitEdit(kind); const au = state.clips.filter(c => c.type === 'audio'); const t = 4.5;
      const aa = au.find(c => c.start <= t && clipEnd(c) > t && c.mediaId === b.mediaId && Math.abs(srcTimeFor(c, t) - srcTimeFor(b, t)) < 1e-6);
      return { ok: !!aa && au.every(c => c.inPoint >= -1e-9), fade: au.some(c => c.props.fadeIn === 0.5) }; };
    return [run('J', 2, 1), run('J', 0.3, 1), run('J', 2, 2), run('L', 2, 2)]; });
  T('9 J/L cuts stay in sync with speed and short heads, carrying fades', jl.every(r => r.ok && r.fade));

  // 10. freeze frames are silent everywhere
  const fz = await E(async () => { AR(); const f = AA({ mediaId: 'au_ramp', start: 0, duration: 3, inPoint: 2, freeze: true, freezeAt: 2 });
    state.time = 0.5; state.playing = true; syncMediaPlayback(); const r = { mix: await MIX(3), paused: els.au_ramp.paused, vol: audibleVol(f) };
    state.playing = false; syncMediaPlayback(); return r; });
  T('10 freeze-frame clips have no sound', fz.mix === null && fz.paused && fz.vol === 0);

  // 11. beat markers on a reversed clip land on the reversed hits
  const bt = await E(async () => { AR(); const c = AA({ mediaId: 'au_kick', start: 0, duration: 2, inPoint: 0.2, props: { reverse: true } });
    await detectBeatsForClip(c, 55); return state.markers.map(m => m.t); });
  T('11 beat markers are reverse-aware', bt.length >= 3 && bt.every(t => Math.abs(((0.2 + 2 - t) % 0.5 + 0.5) % 0.5) < 0.03 || Math.abs(((0.2 + 2 - t) % 0.5 + 0.5) % 0.5 - 0.5) < 0.03));

  // 12/13. remux sees a muted video track; the meter follows volume keys and sums clips
  const mt = await E(() => { AR(); state.clips.push(makeClip({ type: 'video', track: 'V1', start: 0, duration: 2, mediaId: 'au_dc' })); state.muted.V1 = true;
    const rs = remuxEligibility().reasons; AR();
    const m = state.media.find(x => x.id === 'au_dc'); m.peaks = { peak: new Array(600).fill(0.5), rms: new Array(600).fill(0.5), dur: 10 };
    AA({ mediaId: 'au_dc', start: 0, duration: 4, kf: { volume: [{ t: 0, v: 0 }, { t: 4, v: 1 }] } }); const m0 = meterLevelAt(0.05).l;
    AR(); AA({ mediaId: 'au_dc', track: 'A1', start: 0, duration: 4 }); AA({ mediaId: 'au_dc', track: 'A2', start: 0, duration: 4 }); const two = meterLevelAt(1).l;
    AR(); AA({ mediaId: 'au_dc', start: 0, duration: 4, freeze: true, freezeAt: 1 }); const fr = meterLevelAt(1).l;
    return { rs, m0, two, fr }; });
  T('12 remux lists a muted video track', mt.rs.some(s => /muted/.test(s)));
  T('13 meter follows volume keys, sums clips, skips freeze frames', mt.m0 < 0.01 && Math.abs(mt.two - 1) < 1e-6 && mt.fr === 0);

  // a. reversed clips are heard in the preview
  const rv = await E(async () => { AR(); const c = AA({ mediaId: 'au_ramp', start: 0, duration: 3, inPoint: 1, props: { reverse: true } });
    await ensureDecodedBuffer('au_ramp', 48000); ensureAudioGraph(); state.time = 0.5; state.playing = true; syncMediaPlayback();
    const v = _revVoices[c.id]; const r = { voice: !!v, g: v ? v.gain.gain.value : -1, pos: v ? v.pos : -1 };
    state.playing = false; syncMediaPlayback(); r.stopped = !_revVoices[c.id]; return r; });
  T('a reversed clips play their sound in the preview', rv.voice && rv.g === 1 && Math.abs(rv.pos - 0.5) < 0.01 && rv.stopped);

  // b. waveforms: global normalization for the zoomed-in view; reversed clips mirrored
  const wv = await E(async () => { await ensureDecodedBuffer('au_ramp', 48000); const m = state.media.find(x => x.id === 'au_ramp');
    m.peaks = { peak: new Float32Array(600).map((_, i) => Math.min(1, i / 600 * 1.08)), rms: new Float32Array(600).map((_, i) => i / 600 * 0.6), dur: 10 };
    const pps0 = state.pps; state.pps = 400; const H = 40;
    const col = (cv, x) => { const g = cv.getContext('2d').getImageData(Math.round(x * cv.width), 0, 1, cv.height).data; let n = 0; for (let i = 3; i < g.length; i += 4)if (g[i] > 0) n++; return n / cv.height; };
    AR(); const q = AA({ mediaId: 'au_ramp', start: 0, duration: 1, inPoint: 0 }); const cv1 = document.createElement('canvas'); drawWave(cv1, q, H);
    const r = AA({ mediaId: 'au_ramp', start: 2, duration: 1, inPoint: 8, props: { reverse: true } }); const cv2 = document.createElement('canvas'); drawWave(cv2, r, H);
    state.pps = pps0; return { quiet: col(cv1, 0.9), revL: col(cv2, 0.05), revR: col(cv2, 0.95) }; });
  T('b zoomed waveform keeps the source-wide scale; reversed clips are mirrored', wv.quiet < 0.3 && wv.revL > wv.revR);

  // c. audio-only export renders the mix once
  const ao = await E(async () => { AR(); AA({ mediaId: 'au_sine', start: 0, duration: 1 }); let n = 0; const orig = renderAudioOffline;
    window.renderAudioOffline = async (...a) => { n++; return orig(...a); };
    const nv = window.vibeNative; window.vibeNative = Object.assign({}, nv || {}, { encodeAudio: async () => ({ ok: true, path: 'x.wav' }) });
    try { await renderAudioOnly({ ffmpeg: true, ffTarget: 'wav' }); } catch (e) { n = -1; }
    window.renderAudioOffline = orig; window.vibeNative = nv; state.exporting = false; return n; });
  T('c audio-only export renders the mix once', ao === 1);

  T('no page errors', app.errors.length === 0);
  if (app.errors.length) R['audio: errors'] = app.errors.slice(0, 5);
}]);

/* ========================= section: picture ========================= */
SECTIONS.push(['picture', async (app) => {
  const p = app.page, E = (f, ...a) => p.evaluate(f, ...a), T = (k, ok) => check('picture: ' + k, ok);
  await p.setViewport({ width: 1600, height: 1000 });
  await E(() => {
    window.MK = (id, w, h, draw) => { state.media = state.media.filter(m => m.id !== id); const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d');
      if (draw) draw(g, w, h); else { g.fillStyle = '#d33'; g.fillRect(0, 0, w, h); } state.media.push({ id, type: 'image', name: id, duration: 10, w, h, el: c }); return c; };
    window.FILL = col => (g, w, h) => { g.fillStyle = col; g.fillRect(0, 0, w, h); };
    window.PX = (x, y) => Array.from(document.getElementById('preview').getContext('2d').getImageData(Math.round(x), Math.round(y), 1, 1).data.slice(0, 3));
    window.FR = t => { setTime(t); drawFrame(); };
    window.PROJ = (w, h) => { state.project.w = w; state.project.h = h; syncProjectInputs(); };
    window.SNAP = () => { const c = document.getElementById('preview'); return c.getContext('2d').getImageData(0, 0, c.width, c.height).data; };
    window.DIF = (a, b) => { let d = 0; for (let i = 0; i < a.length; i += 40) d += Math.abs(a[i] - b[i]); return d; };
    window.SET = (clips, sel) => { state.clips = clips; state.selection = sel ? sel.id : null; state.history = []; state.hIndex = -1; pushHistory(); renderTimeline(); renderInspector(); };
    PROJ(1920, 1080); state.project.bg = '#000000';
  });

  // 1. stabilization indexes by source time: a split piece / trimmed clip corrects like the whole
  const st = await E(() => { MK('sv', 640, 360); state.media.find(m => m.id === 'sv').type = 'video';
    const n = 180, a = k => [...Array(n)].map((_, i) => k * i);
    const c = makeClip({ type: 'video', track: 'V1', start: 0, duration: 6, mediaId: 'sv', inPoint: 1 });
    c.stab = { fps: 30, n, dx: a(0.001), dy: a(-0.0005), rot: a(0), sc: [...Array(n)].map(() => 1), st: a(1 / 30).map(v => v + 1) };
    c.props.stabMode = 'none'; SET([c]);
    const whole = [2.5, 4, 5.5].map(t => _stabCorrection(c, t).dx);
    state.time = 2; splitClip(c, 2); const b = state.clips.find(x => x.start >= 1.99);
    const split = [2.5, 4, 5.5].map(t => _stabCorrection(b, t).dx);
    b.start += 0.5; b.inPoint += 0.5; b.duration -= 0.5;   // trim the head
    const trim = [4, 5.5].map(t => _stabCorrection(b, t).dx);
    b.props.speed = 2; const sped = _stabCorrection(b, 3).dx;   // 0.5 s into the piece at 2× = source 3.5+1 = 4.5 = the whole clip at 3.5
    return { whole, split, trim, sped, want: _stabCorrection(c, 3.5).dx }; });
  T('1 stabilization follows split pieces', st.split.every((v, i) => Math.abs(v - st.whole[i]) < 1e-9));
  T('1 stabilization follows trims and speed changes', Math.abs(st.trim[0] - st.whole[1]) < 1e-9 && Math.abs(st.trim[1] - st.whole[2]) < 1e-9 && Math.abs(st.sped - st.want) < 1e-9);

  // 2. blur and pixelate look the same at every render size
  const fx = await E(() => { MK('half', 1920, 1080, (g, w, h) => { g.fillStyle = '#000'; g.fillRect(0, 0, w, h); g.fillStyle = '#fff'; g.fillRect(w / 2, 0, w / 2, h); });
    const c = makeClip({ type: 'image', track: 'V1', start: 0, duration: 6, mediaId: 'half' }); SET([c]); c.props.blur = 8;
    const cv0 = document.getElementById('preview');
    const edge = (W, H) => { cv0.width = W; cv0.height = H; FR(1); let a = -1, b = -1; for (let x = Math.round(W * 0.3); x < W * 0.7; x++) { const v = PX(x, H / 2)[0]; if (a < 0 && v > 12) a = x; if (v < 243) b = x; } return (b - a) / W; };
    const blur = [edge(1920, 1080), edge(960, 540), edge(3840, 2160)];
    c.props.blur = 0; c.props.pixelate = 60;
    MK('ramp', 1920, 1080, (g, w, h) => { const gr = g.createLinearGradient(0, 0, w, 0); gr.addColorStop(0, '#000'); gr.addColorStop(1, '#fff'); g.fillStyle = gr; g.fillRect(0, 0, w, h); }); c.mediaId = 'ramp';
    const cells = (W, H) => { cv0.width = W; cv0.height = H; FR(1); let n = 0, prev = null; for (let x = 0; x < W; x++) { const v = PX(x, H / 2)[0]; if (v !== prev) n++; prev = v; } return n; };
    const pix = [cells(1920, 1080), cells(960, 540), cells(3840, 2160)];
    syncProjectInputs(); return { blur, pix }; });
  T('2 blur width is resolution independent', Math.max(...fx.blur) / Math.min(...fx.blur) < 1.25);
  T('2 pixelate cell count is resolution independent', Math.max(...fx.pix) - Math.min(...fx.pix) <= 3);

  // 3-5. transitions sized to the clip, only over the clip, not mirrored by a flip
  const tr = await E(() => { MK('blue', 1920, 1080, FILL('#00f')); MK('red', 1920, 1080, FILL('#f00'));
    const a = makeClip({ type: 'image', track: 'V1', start: 0, duration: 6, mediaId: 'blue' }), b = makeClip({ type: 'image', track: 'V2', start: 1, duration: 4, mediaId: 'red' });
    Object.assign(b.props, { scale: 0.5, x: 25, rotation: 20, transIn: 'fadeblack', transInDur: 1 }); SET([a, b]);
    FR(1.5); const fb = { bg: PX(700, 540), bgTop: PX(700, 50), pip: PX(1440, 540) };
    b.props.transIn = 'fadewhite'; FR(1.5); const fw = PX(700, 540);
    Object.assign(b.props, { rotation: 0, transIn: 'wipeR' });
    const wipe = [1.25, 1.5, 1.75].map(t => { FR(t); let n = 0; for (let x = 960; x < 1920; x += 8) if (PX(x, 540)[0] > 200) n++; return n / 120; });
    Object.assign(b.props, { scale: 1, x: 0 }); FR(1.3); const plain = [PX(100, 540)[0] > 200, PX(1800, 540)[0] > 200];
    b.props.flipH = true; FR(1.3); const flip = [PX(100, 540)[0] > 200, PX(1800, 540)[0] > 200];
    return { fb, fw, wipe, plain, flip }; });
  T('3 fade through black/white leaves the background alone', tr.fb.bg.join() === '0,0,255' && tr.fb.bgTop.join() === '0,0,255' && tr.fw.join() === '0,0,255' && Math.abs(tr.fb.pip[0] - 127) < 6);
  T('4 wipe is sized to the clip box', Math.abs(tr.wipe[0] - 0.25) < 0.05 && Math.abs(tr.wipe[1] - 0.5) < 0.05 && Math.abs(tr.wipe[2] - 0.75) < 0.05);
  T('5 wipe on a flipped clip runs the same way', tr.plain.join() === 'true,false' && tr.flip.join() === 'true,false');

  // 6. overlapping In/Out transitions don't jump
  const ov = await E(() => { MK('white', 1920, 1080, FILL('#fff'));
    const c = makeClip({ type: 'image', track: 'V1', start: 0, duration: 2, mediaId: 'white' }); Object.assign(c.props, { transIn: 'dissolve', transInDur: 1.5, transOut: 'dissolve', transOutDur: 1.5 }); SET([c]);
    let prev = null, jump = 0, peak = 0; for (let t = 0.02; t < 2; t += 0.02) { FR(t); const v = PX(960, 540)[0]; if (prev != null) jump = Math.max(jump, Math.abs(v - prev)); prev = v; peak = Math.max(peak, v); } return { jump, peak }; });
  T('6 overlapping In and Out transitions are continuous', ov.jump < 12 && ov.peak > 240);

  // 7. titles play transitions; meme/visualizer don't offer controls that do nothing
  const t7 = await E(() => { const out = {};
    const bg = makeClip({ type: 'color', track: 'V1', start: 0, duration: 6, color: '#204080' });
    const t = makeClip({ type: 'text', track: 'TX', start: 0, duration: 6 }); SET([bg, t], t);
    FR(0.3); const n = SNAP(); t.props.transIn = 'wipeR'; t.props.transInDur = 1; FR(0.3); const w = SNAP(); t.props.transIn = 'fadeblack'; FR(0.3); const f = SNAP();
    out.text = DIF(n, w) > 0 && DIF(n, f) > 0;
    for (const ty of ['meme', 'viz']) { const c = makeClip({ type: ty, track: ty === 'meme' ? 'TX' : 'V2', start: 0, duration: 6 }); SET([bg, c], c); state.inspTab = 'clip'; renderInspector();
      const secs = [...document.querySelectorAll('#inspBody .accSec')].map(s => s.dataset.sec); out[ty] = !secs.includes('motion') && !secs.includes('trans'); }
    return out; });
  T('7 text clips play transitions', t7.text);
  T('7 meme/visualizer hide Motion and Transitions', t7.meme && t7.viz);

  // gizmo helpers
  const setupG = (props, iw = 1920, ih = 1080, W = 1920, H = 1080, kf) => E((props, iw, ih, W, H, kf) => { PROJ(W, H); MK('g', iw, ih, (g, w, h) => { g.fillStyle = '#0a0'; g.fillRect(0, 0, w / 2, h); g.fillStyle = '#00f'; g.fillRect(w / 2, 0, w / 2, h); });
    const c = makeClip({ type: 'image', track: 'V1', start: 0, duration: 6, mediaId: 'g' }); Object.assign(c.props, props); if (kf) c.kf = kf; SET([c], c); FR(1); }, props, iw, ih, W, H, kf);
  const edges = () => E(() => { const b = clipBoxCanvas(state.clips[0]); return { L: b.cx0 - b.dw / 2, R: b.cx0 + b.dw / 2, T: b.cy0 - b.dh / 2, B: b.cy0 + b.dh / 2, p: Object.assign({}, state.clips[0].props), kf: state.clips[0].kf, hist: state.history.length }; });
  const hpos = h => E(h => { const b = document.querySelector('#gizmo [data-h="' + h + '"]').getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; }, h);
  const drag = async (h, dx, dy, opt = {}) => { const r = await hpos(h); await p.mouse.move(r.x, r.y); await p.mouse.down(); if (opt.shift) await p.keyboard.down('Shift');
    for (let i = 1; i <= 6; i++) await p.mouse.move(r.x + dx * i / 6, r.y + dy * i / 6); await p.mouse.up(); if (opt.shift) await p.keyboard.up('Shift'); await sleep(30); return r; };
  const near = (a, b, e = 1.5) => Math.abs(a - b) < e;

  // 8. crop drag keeps the opposite edge (re-fit), writes keyed x, swaps sides when flipped
  await setupG({}, 1440, 1080); let a0 = await edges(); await drag('n', 0, 60); let a1 = await edges();
  T('8 crop drag on a 4:3 clip keeps the other edges', near(a0.L, a1.L) && near(a0.R, a1.R) && near(a0.B, a1.B) && a1.T > a0.T + 20);
  await setupG({}, 1920, 1080, 1080, 1920); a0 = await edges(); await drag('e', -60, 0); a1 = await edges();
  T('8 crop drag in a portrait frame keeps the other edges', near(a0.L, a1.L) && near(a0.T, a1.T) && near(a0.B, a1.B) && a1.R < a0.R - 20);
  await setupG({ scale: 0.5 }, 1920, 1080, 1920, 1080, { x: [{ t: 0, v: 0 }, { t: 5, v: 0.0001 }] }); a0 = await edges(); await drag('e', -60, 0); a1 = await edges();
  T('8 crop drag writes position through keyframes', a1.p.x === 0 && a1.kf.x.length > 2 && near(a0.L, a1.L) && a1.R < a0.R - 20);
  await setupG({ flipH: true, scale: 0.6 }); await drag('e', -60, 0); a1 = await edges();
  const fl = await E(() => { FR(1); let R = -1; for (let x = 0; x < 1920; x++) { const c = PX(x, 540); if (c[1] > 100 || c[2] > 100) R = x; } return { R, col: PX(R - 5, 540) }; });
  T('8 crop drag on a flipped clip crops the side you drag', a1.p.cropL > 0.05 && a1.p.cropR === 0 && near(fl.R, a1.R, 3));

  // 9. corner-pin handles on a flipped clip sit on the drawn corner
  await setupG({ cornerPin: 1, cpTLy: 30, flipH: true });
  const cp = await E(() => { const h = document.querySelector('#gizmo [data-h="pTL"]').getBoundingClientRect(), gz = document.getElementById('gizmo').getBoundingClientRect(); return (h.x + h.width / 2 - gz.x) / gz.width; });
  const cpA = await edges(); await drag('pTL', 0, 40); const cpB = await edges();
  T('9 corner-pin handle mirrored on flipped clips', near(cp, 1, 0.02) && cpB.p.cpTLy > cpA.p.cpTLy + 3);

  // 10. gizmo follows keyframed rotation; rotation handle: one undo step, Shift snaps
  await setupG({ scale: 0.5 }, 1920, 1080, 1920, 1080, { rotation: [{ t: 0, v: 0 }, { t: 2, v: 90 }] });
  const rotT = await E(() => { FR(2); return document.getElementById('gizmo').style.transform; });
  T('10 gizmo box follows keyframed rotation', rotT === 'rotate(90deg)');
  await setupG({ scale: 0.5 }); const h0 = (await edges()).hist; await drag('rot', 120, 90, { shift: true }); const rr = await edges();
  T('10 rotation handle rotates (Shift snaps to 15°) in one undo step', rr.p.rotation !== 0 && rr.p.rotation % 15 === 0 && rr.hist === h0 + 1);

  // 11. gizmo box on left/right-aligned text covers the letters
  const al = await E(() => { PROJ(1920, 1080); const t = makeClip({ type: 'text', track: 'TX', start: 0, duration: 6 }); Object.assign(t.text, { content: 'Hello world', align: 'left', shadow: false }); SET([t], t); FR(1);
    const d = SNAP(); let a = 1e9, b = -1; for (let y = 0; y < 1080; y += 2) for (let x = 0; x < 1920; x += 2) { const i = (y * 1920 + x) * 4; if (d[i] > 200 && d[i + 1] > 200 && d[i + 2] > 200) { a = Math.min(a, x); b = Math.max(b, x); } }
    const bx = clipBoxCanvas(t); const r = { text: [a, b], box: [bx.cx0 - bx.dw / 2, bx.cx0 + bx.dw / 2] };
    t.text.align = 'right'; FR(1); const bx2 = clipBoxCanvas(t); r.rbox = [bx2.cx0 - bx2.dw / 2, bx2.cx0 + bx2.dw / 2]; return r; });
  T('11 gizmo box on aligned text sits on the letters', al.box[0] <= al.text[0] + 2 && al.box[1] >= al.text[1] - 2 && al.box[0] > al.text[0] - 30 && near(al.rbox[1], 960, 2));

  // 12. black-bar removal: dark scene untouched, dark letterbox found
  const bb = await E(async () => { MK('dark', 1920, 1080, (g, w, h) => { g.fillStyle = '#0c0c10'; g.fillRect(0, 0, w, h); g.fillStyle = '#303030'; g.fillRect(800, 400, 300, 200); });
    MK('lb', 1920, 1080, (g, w, h) => { g.fillStyle = '#000'; g.fillRect(0, 0, w, h); g.fillStyle = '#101418'; g.fillRect(0, 140, w, 800); g.fillStyle = '#888'; g.fillRect(900, 500, 100, 80); });
    const c = makeClip({ type: 'image', track: 'V1', start: 0, duration: 6, mediaId: 'dark' }); SET([c], c); await autoRemoveBlackBars(c);
    const dark = c.props.cropT + c.props.cropB + c.props.cropL + c.props.cropR; c.mediaId = 'lb'; await autoRemoveBlackBars(c);
    return { dark, T: c.props.cropT, B: c.props.cropB, L: c.props.cropL }; });
  T('12 black-bar removal leaves dark scenes alone and finds dark letterboxes', bb.dark === 0 && near(bb.T, 140 / 1080, 0.005) && near(bb.B, 140 / 1080, 0.005) && bb.L === 0);

  // 13. chroma Pick samples the clip's source, not the composited preview
  for (const props of [{ chroma: true, brightness: 140 }, { chroma: true, chromaColor: '#ff00ff' }]) {
    await E(props => { MK('bgm', 1920, 1080, FILL('#f0f')); MK('gs', 1920, 1080, (g, w, h) => { g.fillStyle = '#20b030'; g.fillRect(0, 0, w, h); g.fillStyle = '#c08060'; g.fillRect(760, 340, 400, 400); });
      const b = makeClip({ type: 'image', track: 'V1', start: 0, duration: 6, mediaId: 'bgm' }), c = makeClip({ type: 'image', track: 'V2', start: 0, duration: 6, mediaId: 'gs' });
      Object.assign(c.props, props, { scale: 0.8, x: 5, flipH: true }); SET([b, c], c); FR(1); startChromaPick(c); }, props);
    const r = await E(() => { const b = document.getElementById('preview').getBoundingClientRect(); return { x: b.x + b.width * 0.3, y: b.y + b.height * 0.25 }; });
    await p.mouse.click(r.x, r.y); await sleep(30);
    T('13 chroma pick gets the source key color (' + (props.brightness ? 'brightened' : 'already keyed') + ')', await E(() => state.clips[1].props.chromaColor === '#20b030'));
  }

  // 14. motion tracking of flipped footage: a synthetic "video" whose frame follows currentTime
  const trk = {};
  for (const flip of [false, true]) {
    trk[flip] = await E(async flip => { PROJ(1920, 1080); state.project.fps = 25;
      const el = document.createElement('canvas'); el.width = 320; el.height = 180; let ct = 0;
      const paint = () => { const g = el.getContext('2d'); g.fillStyle = '#345'; g.fillRect(0, 0, 320, 180); const x0 = 60 + 60 * ct;
        for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { g.fillStyle = (i + j) % 2 ? '#fc3' : '#a20'; g.fillRect(x0 + i * 5, 80 + j * 5, 5, 5); } };
      Object.defineProperty(el, 'currentTime', { get: () => ct, set: v => { ct = v; paint(); }, configurable: true }); el.play = () => Promise.resolve(); el.pause = () => {}; paint();
      state.media = state.media.filter(m => m.id !== 'tv'); state.media.push({ id: 'tv', type: 'video', name: 'tv', duration: 5, w: 320, h: 180, srcFps: 25 }); els.tv = el;
      const v = makeClip({ type: 'video', track: 'V1', start: 0, duration: 3, mediaId: 'tv' }); v.props.flipH = flip;
      const t = makeClip({ type: 'text', track: 'TX', start: 0, duration: 3 }); Object.assign(t.text, { content: 'o', size: 40 });
      const X = tt => { const sx = (60 + 60 * tt + 10) * 6; return flip ? 1920 - sx : sx; };
      t.props.x = (X(0.5) - 960) / 1920 * 100; SET([v, t], t); setTime(0.5); drawFrame();
      const ot = window.toast; window.toast = () => {}; try { await trackMotion(t); } finally { window.toast = ot; }
      return [1, 1.5, 2].map(tt => Math.abs(liveProps(t, tt).x - (X(tt) - 960) / 1920 * 100)); }, flip);
  }
  T('14 motion tracking follows flipped footage', Math.max(...trk[true]) < 2 && trk[true].every((v, i) => Math.abs(v - trk[false][i]) < 0.05));

  // 15. crop frame to region remaps adjustment regions and visualizers
  const cr = await E(() => { PROJ(1920, 1080); MK('v', 1920, 1080, FILL('#246'));
    const v = makeClip({ type: 'image', track: 'V1', start: 0, duration: 6, mediaId: 'v' }), a = makeClip({ type: 'adjust', track: 'V2', start: 0, duration: 6 }), z = makeClip({ type: 'viz', track: 'V3', start: 0, duration: 6 });
    Object.assign(a.props, { region: true, regionW: 10, regionH: 15, x: 25, y: 0 }); a.kf = { x: [{ t: 0, v: 25 }, { t: 5, v: 20 }] }; Object.assign(z.props, { x: 25, y: 10, vizW: 40, vizH: 20 });
    SET([v, a, z]); FR(1); const b0 = clipBoxCanvas(a), z0 = clipBoxCanvas(z);
    openProjectCrop(); projCrop = { x: 960, y: 0, w: 960, h: 1080 }; applyProjectCrop(); FR(1); const b1 = clipBoxCanvas(a), z1 = clipBoxCanvas(z);
    return { a: [b0.cx0 - 960, b0.dw, b0.dh, b1.cx0, b1.dw, b1.dh], z: [z0.cx0 - 960, z0.cy0, z0.dw, z1.cx0, z1.cy0, z1.dw], kf: a.kf.x[1].v }; });
  T('15 crop to region keeps adjustment regions on their pixels', near(cr.a[0], cr.a[3]) && near(cr.a[1], cr.a[4]) && near(cr.a[2], cr.a[5]) && near(cr.kf, (20 / 100 * 1920 + 960 - 960 - 480) / 960 * 100, 0.01));
  T('15 crop to region keeps visualizers on their pixels', near(cr.z[0], cr.z[3]) && near(cr.z[1], cr.z[4]) && near(cr.z[2], cr.z[5]));

  // 16. titles fit portrait frames and wrap; landscape size unchanged
  const tx = await E(() => { MK('v', 1920, 1080, FILL('#246'));
    const t = makeClip({ type: 'text', track: 'TX', start: 0, duration: 6 }); Object.assign(t.text, { content: 'Welcome to my channel', shadow: false }); SET([makeClip({ type: 'image', track: 'V1', start: 0, duration: 6, mediaId: 'v' }), t]);
    const meas = () => { const c = document.getElementById('preview'), W = c.width, H = c.height, d = SNAP(); let a = 1e9, b = -1, y0 = 1e9, y1 = -1;
      for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4; if (d[i] > 240 && d[i + 1] > 240 && d[i + 2] > 240) { a = Math.min(a, x); b = Math.max(b, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); } } return { W, a, b, h: y1 - y0 }; };
    PROJ(1920, 1080); FR(1); const land = meas(); const sz = _textScale(1920, 1080);
    PROJ(1080, 1920); FR(1); const port = meas();
    PROJ(1920, 1080); t.text.content = 'This is a much longer title that would run far off both edges of the frame in any project'; FR(1); const wrap = meas();
    t.text.wrap = false; FR(1); const nowrap = meas(); return { land, sz, port, wrap, nowrap }; });
  T('16 landscape title size unchanged', tx.sz === 1 && tx.land.b - tx.land.a > 1000 && tx.land.b - tx.land.a < 1150);
  T('16 portrait title fits the frame', tx.port.a > 20 && tx.port.b < tx.port.W - 20);
  T('16 long titles wrap inside the frame (optional)', tx.wrap.a > 20 && tx.wrap.b < 1900 && tx.wrap.h > 150 && tx.nowrap.b - tx.nowrap.a > 1850 && tx.nowrap.h < 120);

  // 17. shake is deterministic (same frame twice = same picture)
  const sk = await E(() => { MK('red', 1920, 1080, FILL('#f00')); const c = makeClip({ type: 'image', track: 'V1', start: 0, duration: 6, mediaId: 'red' }); Object.assign(c.props, { scale: 0.5, motion: 'shake' }); SET([c]);
    const r = []; for (const m of ['shake', 'vibrate', 'glitch']) { c.props.motion = m; FR(1.2); const a = SNAP(); FR(2); FR(1.2); const b = SNAP(); r.push(DIF(a, b)); } return r; });
  T('17 shake/vibrate/glitch identical on redraw', sk.every(v => v === 0));

  // extras: viz gizmo beyond 100%, overlay FX keyframed opacity, background color undo, same-track crossfade
  const ex = await E(() => { PROJ(1920, 1080);
    const z = makeClip({ type: 'viz', track: 'V2', start: 0, duration: 6 }); z.props.vizW = 200; SET([z], z); const zw = clipBoxCanvas(z).dw;
    const bg = makeClip({ type: 'color', track: 'V1', start: 0, duration: 6, color: '#204080' });
    const o = makeClip({ type: 'overlay', track: 'TX', start: 0, duration: 6, effect: Object.keys(OVERLAYS)[0], ov: ovDefaults(Object.keys(OVERLAYS)[0]) });
    SET([bg]); FR(1); const none = SNAP(); SET([bg, o]); o.kf = { opacity: [{ t: 0, v: 0 }, { t: 5, v: 0 }] }; FR(1); const kf0 = SNAP();
    return { zw, ovOff: DIF(none, kf0) }; });
  T('extra visualizer gizmo box follows widths over 100%', near(ex.zw, 3840));
  T('extra overlay FX on a title track honors keyframed opacity', ex.ovOff === 0);
  const bgU = await E(() => { SET([]); const pj = state.project; pj.bg = '#000000'; state.history = []; state.hIndex = -1; pushHistory();
    renderInspector(); const el = document.getElementById('pjBg');
    if (!el) return { found: false };
    const n0 = state.history.length; for (const c of ['#101010', '#202020', '#303030']) { el.value = c; el.dispatchEvent(new Event('input')); } el.dispatchEvent(new Event('change'));
    const n1 = state.history.length; undo(); return { found: true, steps: n1 - n0, after: state.project.bg }; });
  T('extra background color change is one undo step', bgU.found && bgU.steps === 1 && bgU.after === '#000000');
  const xf = await E(() => { MK('a', 64, 36, FILL('#f00')); MK('b', 64, 36, FILL('#00f'));
    const a = makeClip({ type: 'image', track: 'V1', start: 0, duration: 3, mediaId: 'a' }), b = makeClip({ type: 'image', track: 'V1', start: 3, duration: 3, mediaId: 'b' });
    b.props.transIn = 'dissolve'; b.props.transInDur = 1; SET([a, b]); FR(3.5); return PX(960, 540); });
  T('UX same-track dissolve after a photo crossfades (no dip to black)', near(xf[0], 128, 6) && near(xf[2], 128, 6));

  T('no page errors', app.errors.length === 0);
  if (app.errors.length) R['picture: errors'] = app.errors.slice(0, 5);
}]);

/* ========================= section: io (import / export / projects) ========================= */
SECTIONS.push(['io', async (app) => {
  const p = app.page, E = (f, ...a) => p.evaluate(f, ...a), T = (k, ok) => check('io: ' + k, ok);
  await p.setViewport({ width: 1600, height: 1000 });
  await E(() => {
    window.sleep = ms => new Promise(r => setTimeout(r, ms));
    window.TOASTS = () => [...document.querySelectorAll('.toast')].map(t => t.textContent);
    window.CLR = () => document.querySelectorAll('.toast').forEach(t => t.remove());
    window.__dl = []; const oc = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () { if (this.download) { window.__dl.push(this.download); return; } return oc.call(this); };
    window.COL = (t, s, d, c) => makeClip({ type: 'color', track: t, start: s, duration: d, props: Object.assign(defaultProps('color'), { color: c || '#ff0000' }) });
    window.FRESH = () => { delete window.vibeNative; FF_AVAILABLE = false; closeOverlay(true); doNewProject(); CLR(); state.exportSource = 'full'; state.exportSourceRemember = false; };
    window.WAITX = async (ms = 20000) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (!exportInFlight()) return true; await sleep(50); } return false; };
  });

  // 1. probe facts + proxied survive save/reopen; relink converts instead of loading the original;
  //    a >600 MB original that needs no conversion relinks from its path
  const r1 = await E(async () => {
    FRESH();
    const m = { id: 'pm', type: 'video', name: 'cam', ext: 'MP4', url: 'blob:x', duration: 20, w: 640, h: 360, size: 123, proxied: true,
      sourcePath: '/v/cam.mp4', srcGop: 2, srcBrowserOk: true, srcHeight: 1080, srcVideoCodec: 'h264', hasAudio: true, audioTrack: 1, subTrack: 0 };
    state.media = [m]; state.clips = [makeClip({ type: 'video', track: 'V1', start: 0, duration: 5, mediaId: 'pm' })];
    const js = serializeProject(), saved = JSON.parse(js).media[0];
    doNewProject();
    const calls = [];
    FF_AVAILABLE = true;
    window.vibeNative = { statPath: async () => ({ ok: true, exists: true, size: 123 }), readPath: async () => { calls.push('read'); return { ok: false, tooLarge: true }; },
      probeDuration: async () => ({ ok: true, duration: 20 }), makeProxy: async (p, j, o) => { calls.push('proxy:' + JSON.stringify(o || {})); return { ok: false }; } };
    const auto = window.autoRelinkMissing; window.autoRelinkMissing = async () => {};
    loadProjectJSON(js, '/p/x.vibe');
    window.autoRelinkMissing = auto;
    const ph = state.media[0];
    const phInfo = { proxied: ph.proxied, gop: ph.srcGop, a: ph.audioTrack, s: ph.subTrack, missing: ph.missing };
    const cl = setInterval(() => { const b = document.querySelector('#cvGo'); if (b) b.click(); }, 50);
    await tryRelinkOne(ph); clearInterval(cl);
    // an untouched big original: path B with tooLarge → load from its path
    const big = { id: 'bg', type: 'audio', name: 'big', ext: 'WAV', duration: 3, size: 7e8, missing: true, sourcePath: '/v/big.wav' };
    state.media.push(big);
    const lm = window.loadMediaEl; window.loadMediaEl = async (t, u) => { calls.push('load:' + u); return document.createElement('audio'); };
    const ok = await tryRelinkOne(big); window.loadMediaEl = lm;
    return { keys: ['srcGop', 'srcBrowserOk', 'srcHeight', 'srcVideoCodec', 'hasAudio', 'audioTrack', 'subTrack'].every(k => k in saved), phInfo, calls, ok, bigUrl: big.url, bigMissing: !!big.missing };
  });
  T('1 probe facts (gop, codec, tracks…) are saved with the project', r1.keys);
  T('1 reopened placeholder keeps proxied + probe facts', r1.phInfo.proxied === true && r1.phInfo.gop === 2 && r1.phInfo.a === 1 && r1.phInfo.s === 0 && r1.phInfo.missing);
  T('1 relink of a proxied file re-converts (with its track) instead of reading the original', r1.calls[0] && r1.calls[0].startsWith('proxy:') && /"audioTrack":1/.test(r1.calls[0]) && !r1.calls.slice(0, 1).includes('read'));
  T('1 a >600 MB original relinks from its path', r1.ok === true && /^file:/.test(r1.bigUrl || '') && !r1.bigMissing && r1.calls.some(c => c.startsWith('load:file:')));

  // 2 + 3. ranged FFmpeg export: audio built for R0..R1 only, duration = range; chosen track read from the original
  const r2 = await E(async () => {
    FRESH(); FF_AVAILABLE = true;
    let got = null;
    window.vibeNative = { mixAudioFromFiles: true, encodeMp4: async (ab, o) => { got = o; return { ok: true, path: '/x/out.mp4' }; }, cancelEncode: async () => ({}), onEncodeProgress: () => () => {} };
    const m = { id: 'am', type: 'video', name: 'mv', url: 'blob:y', duration: 30, w: 320, h: 180, size: 5, proxied: true, proxyPath: 'file:///tmp/vibe-proxy-1.mp4', sourcePath: '/v/orig.mkv', trim: { start: 4, duration: 30 }, audioTrack: 2 };
    state.media = [m]; els.am = document.createElement('video');
    const v = makeClip({ type: 'video', track: 'V1', start: 0, duration: 10, mediaId: 'am' }); v.inPoint = 1;
    const late = makeClip({ type: 'video', track: 'V2', start: 8, duration: 2, mediaId: 'am' });
    state.clips = [v, late]; renderTimeline();
    state.rangeIn = 2; state.rangeOut = 5;
    renderPrecise({ name: 't', w: 64, h: 36, fps: 10, mbps: 1, ffmpeg: true, ffTarget: 'mp4-h264' });
    await sleep(100); await WAITX(30000);
    for (let i = 0; i < 100 && !got; i++) await sleep(50);
    const sp = got && got.audioSpec;
    const sub = hqCandidate(Object.assign({}, m, { subTrack: 0 }));
    const dec = await _hqDecodeAudio(m, 48000);
    delete els.am;
    return { dur: got && got.durationSec, from: sp && sp.from, sd: sp && sp.duration, n: sp && sp.clips.length, clip: sp && sp.clips[0], sub, dec };
  });
  T('2 ranged FFmpeg export: duration is the range', Math.abs(r2.dur - 3) < 1e-6);
  T('2 ranged FFmpeg export: audio spec starts at the In point and skips clips outside', r2.from === 2 && Math.abs(r2.sd - 3) < 1e-6 && r2.n === 1);
  T('3 full-quality audio reads the track chosen at import, at the window offset', r2.clip && r2.clip.aTrack === 2 && /orig\.mkv/.test(r2.clip.url) && Math.abs(r2.clip.inPoint - 5) < 1e-6);
  T('3 burned subtitles keep the proxy picture; the browser never decodes a non-default track', r2.sub === null && r2.dec === null);

  // 4. relink by name+size honors the placeholder's window and re-points detached audio; refuses when it doesn't cover
  const r4 = await E(async () => {
    FRESH();
    const mk = (id, trim, dur) => ({ id, type: 'video', name: 'news', ext: 'MP4', duration: dur, w: 64, h: 36, size: 77, url: 'blob:z' + id, trim });
    const ph = Object.assign(mk('ph', { start: 10, duration: 10 }, 10), { missing: true, url: null });
    const det = { id: 'd1', type: 'audio', name: 'news (audio)', duration: 10, size: 0, fromMedia: 'ph' };
    const cv = Object.assign(makeClip({ type: 'video', track: 'V1', start: 0, duration: 4, mediaId: 'ph' }), { inPoint: 2 });
    const ca = Object.assign(makeClip({ type: 'audio', track: 'A1', start: 0, duration: 4, mediaId: 'd1' }), { inPoint: 2 });
    state.media = [ph, det, mk('full', null, 60)]; state.clips = [cv, ca];
    relinkAfterImport();
    const a = { v: [cv.mediaId, cv.inPoint], a: [ca.mediaId, ca.inPoint], det: det.fromMedia, phGone: !state.media.some(m => m.id === 'ph') };
    // a window that does not cover the clip: refuse
    const ph2 = Object.assign(mk('ph2', { start: 50, duration: 10 }, 10), { missing: true, url: null, name: 'other' });
    const c2 = Object.assign(makeClip({ type: 'video', track: 'V2', start: 0, duration: 4, mediaId: 'ph2' }), { inPoint: 2 });
    state.media.push(ph2, Object.assign(mk('part', { start: 0, duration: 20 }, 20), { name: 'other' })); state.clips.push(c2);
    relinkAfterImport();
    return { a, refused: c2.mediaId === 'ph2' && c2.inPoint === 2, toast: TOASTS().some(t => /Not relinked/.test(t)) };
  });
  T('4 relink of a trimmed placeholder offsets in-points by the window', r4.a.v[0] === 'full' && r4.a.v[1] === 12 && r4.a.a[1] === 12 && r4.a.phGone);
  T('4 detached audio follows the relinked parent', r4.a.a[0] === 'd1' && r4.a.det === 'full');
  T('4 a window that does not cover the clips is refused, with a note', r4.refused && r4.toast);

  // 5. abandoning a Precise render does not discard the next Fast export
  const r5 = await E(async () => {
    FRESH(); state.clips = [COL('V1', 0, 1.2)]; renderTimeline(); window.__dl = [];
    renderPrecise({ name: 'p', w: 160, h: 90, fps: 30, mbps: 1 });
    for (let i = 0; i < 200 && !document.querySelector('#pAbort'); i++) await sleep(20);
    await sleep(150); document.querySelector('#pAbort').click(); await sleep(50); document.querySelector('#abYes').click();
    await WAITX(); CLR();
    state.clips = [COL('V1', 0, 3)]; renderTimeline();
    const fm = supportedFormats();
    startExport({ name: 'fast', w: 320, h: 180, fps: 30, mbps: 2 }, fm[0][1]);
    await sleep(300); await WAITX(); await sleep(600);
    return { dl: window.__dl.slice(), toasts: TOASTS() };
  });
  T('5 a Fast export after an abandoned Precise render is saved, not discarded', r5.dl.length === 1 && !r5.toasts.some(t => /discarded/i.test(t)));

  // 6 + 7 + 8. the FFmpeg stage is protected; Cancel during the audio mix stops it before FFmpeg; odd sizes rounded
  const r6 = await E(async () => {
    FRESH(); FF_AVAILABLE = true;
    let calls = 0, lastOpts = null;
    window.vibeNative = { mixAudioFromFiles: true, encodeMp4: async (ab, o) => { calls++; lastOpts = o; await sleep(1500); return { ok: true, path: '/x/out.mp4' }; },
      cancelEncode: async () => ({ ok: true }), onEncodeProgress: () => () => {} };
    state.clips = [COL('V1', 0, 0.5)]; renderTimeline();
    const cfg = { name: 'p', w: 161, h: 91, fps: 30, mbps: 1, ffmpeg: true, ffTarget: 'mp4-h264' };
    renderPrecise(cfg);
    for (let i = 0; i < 400 && !calls; i++) await sleep(20);
    const during = { inFlight: exportInFlight(), dlg: !!document.querySelector('#encCancel') };
    dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true }));
    await sleep(100);
    const after = { dlg: !!document.querySelector('#encCancel'), newDlg: !!document.querySelector('#npDiscard, #acAlt') };
    await WAITX();
    // Cancel pressed while the audio is still mixing
    CLR(); calls = 0;
    const mw = window.mixToWavBuffer; window.mixToWavBuffer = async () => { await sleep(600); return null; };
    vibeNative.mixAudioFromFiles = false;
    renderPrecise({ name: 'p', w: 160, h: 90, fps: 30, mbps: 1, ffmpeg: true, ffTarget: 'mp4-h264' });
    for (let i = 0; i < 400 && !document.querySelector('#encCancel'); i++) await sleep(10);
    document.querySelector('#encCancel').click();
    await WAITX(); window.mixToWavBuffer = mw;
    return { during, after, even: [cfg.w, cfg.h], jobId: !!(lastOpts && lastOpts.jobId), earlyCalls: calls, toasts: TOASTS(),
      err: _ffErrorText('frame=1\n[libx264 @ 0x1] width not divisible by 2 (641x361)\nError initializing output stream 0:0 -- Error while opening encoder'),
      err2: _ffErrorText('Stream mapping:\n  Stream #0:0 -> #0:0\n[out#0/mp4 @ 0x2] Error opening output /x/y.mp4: No such file or directory\n') };
  });
  T('6 while FFmpeg encodes, the export counts as in flight', r6.during.inFlight && r6.during.dlg);
  T('6 Esc / Ctrl+N cannot interrupt the encode stage', r6.after.dlg && !r6.after.newDlg);
  T('7 Cancel pressed before FFmpeg starts is honored (encode never called)', r6.earlyCalls === 0 && r6.toasts.some(t => /cancell?ed/i.test(t)));
  T('7 each encode carries a job id for cancelling', r6.jobId);
  T('8 odd sizes are rounded to even before rendering', r6.even[0] === 162 && r6.even[1] === 92);
  T('8 FFmpeg errors read as a sentence, not a log', /even number of pixels/.test(r6.err) && r6.err2.length < 170 && /No such file/.test(r6.err2));

  // 9. keyframes every ~2 s at non-integer frame rates
  const r9 = await E(async () => {
    FRESH(); state.clips = [COL('V1', 0, 4.2)]; renderTimeline();
    let keys = 0; const enc = VideoEncoder.prototype.encode;
    VideoEncoder.prototype.encode = function (f, o) { if (o && o.keyFrame) keys++; return enc.call(this, f, o); };
    renderPrecise({ name: 'k', w: 160, h: 90, fps: 29.97, mbps: 1 });
    await sleep(100); await WAITX(60000);
    VideoEncoder.prototype.encode = enc;
    return keys;
  });
  T('9 keyframes are placed at 29.97 fps (every ~2 s)', r9 >= 3);

  // 10 + 11. saving inside a compound writes the outer range/playhead; a new project resets everything
  const r10 = await E(async () => {
    FRESH();
    const a = COL('V1', 0, 4), b = COL('V2', 1, 2, '#00ff00'), c = COL('V1', 5, 3, '#0000ff');
    state.clips = [a, b, c]; renderTimeline(); setTime(6.5);
    state.rangeIn = 5; state.rangeOut = 7; state.selection = a.id; state.selExtra = [b.id];
    const cmp = proMakeCompound(); proOpenCompound(cmp);
    const js = JSON.parse(serializeProject());
    proCloseCompound();
    state.markers = [{ t: 2, type: 'user' }]; state.solo = { A1: true }; state.locked = { V2: true }; state.selExtra = ['x'];
    doNewProject();
    return { r: [js.rangeIn, js.rangeOut], time: js.time, after: [state.rangeIn, state.rangeOut, state.markers.length, Object.keys(state.solo).length, Object.keys(state.locked).length, state.selExtra.length] };
  });
  T('10 save inside a compound keeps the outer In/Out and playhead', r10.r[0] === 5 && r10.r[1] === 7 && Math.abs(r10.time - 6.5) < 1e-6);
  T('11 new project clears range, markers, solo, locks and selection', r10.after.every(v => v === null || v === 0));

  // 12. removing used media asks first (in-app), and undo brings back working clips
  const r12 = await E(async () => {
    FRESH();
    const cv = document.createElement('canvas'); cv.width = 64; cv.height = 36;
    state.media = [{ id: 'im', type: 'image', name: 'pic', w: 64, h: 36, duration: 5, el: cv, url: 'blob:pic' }];
    state.clips = [makeClip({ type: 'image', track: 'V1', start: 0, duration: 3, mediaId: 'im' })];
    state.history = []; state.hIndex = -1; pushHistory(); renderTimeline(); renderBin();
    document.querySelector('#binList .bin-x').click(); await sleep(100);
    const asked = !!document.querySelector('#acYes'), stillThere = state.clips.length === 1;
    document.querySelector('#acNo').click(); await sleep(50);
    const kept = state.clips.length === 1 && state.media.length === 1;
    document.querySelector('#binList .bin-x').click(); await sleep(100);
    document.querySelector('#acYes').click(); await sleep(100);
    const gone = state.clips.length === 0 && state.media.length === 0;
    undo(); await sleep(50);
    return { asked, stillThere, kept, gone, back: state.clips.length === 1 && state.media.some(m => m.id === 'im' && m.el === cv) };
  });
  T('12 removing media used by clips asks first (in-app dialog)', r12.asked && r12.stillThere && r12.kept);
  T('12 undo after removal restores the clips AND their media', r12.gone && r12.back);

  // 13. file kind from the extension when the MIME type is missing or wrong
  const r13 = await E(() => ['x.dav', 'x.mts', 'x.alac', 'x.opus', 'x.m2ts', 'x.flv'].map(n => importKindOf(new File([new Uint8Array(4)], n, { type: '' })))
    .concat([importKindOf(new File([new Uint8Array(4)], 'x.ts', { type: 'text/vnd.trolltech.linguist' })), importKindOf(new File([new Uint8Array(4)], 'x.txt', { type: 'text/plain' }))]));
  T('13 files are recognized by extension when the MIME type is missing', r13.join() === 'video,video,audio,audio,video,video,video,');

  // 14. audio-only formats skip the frames, honor the range, and show progress + cancel while encoding
  const r14 = await E(async () => {
    FRESH(); FF_AVAILABLE = true;
    let got = null, wavLen = 0, during = null;
    window.vibeNative = { encodeAudio: async (w, o) => { got = o; wavLen = w.byteLength; during = { inFlight: exportInFlight(), dlg: !!document.querySelector('#encCancel') }; await sleep(200); return { ok: true, path: '/x/a.opus' }; },
      cancelEncode: async () => ({}), onEncodeProgress: () => () => {} };
    const sr = 48000, n = sr * 6, ab = new AudioContext().createBuffer(1, n, sr); const ch = ab.getChannelData(0); for (let i = 0; i < n; i++) ch[i] = Math.sin(i / 20) * 0.3;
    const wav = (() => { const b = new ArrayBuffer(44 + n * 2), d = new DataView(b), w = (o, s) => { for (let i = 0; i < s.length; i++) d.setUint8(o + i, s.charCodeAt(i)); };
      w(0, 'RIFF'); d.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); d.setUint32(16, 16, true); d.setUint16(20, 1, true); d.setUint16(22, 1, true); d.setUint32(24, sr, true); d.setUint32(28, sr * 2, true); d.setUint16(32, 2, true); d.setUint16(34, 16, true); w(36, 'data'); d.setUint32(40, n * 2, true);
      for (let i = 0; i < n; i++) d.setInt16(44 + i * 2, ch[i] * 32767, true); return b; })();
    const url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
    const el = new Audio(url); await new Promise(r => { el.onloadedmetadata = r; });
    state.media = [{ id: 'au', type: 'audio', name: 'tone', url, duration: 6, w: 0, h: 0 }]; els.au = el;
    state.clips = [makeClip({ type: 'audio', track: 'A1', start: 0, duration: 6, mediaId: 'au' })]; renderTimeline();
    state.rangeIn = 1; state.rangeOut = 3;
    let frames = 0; const enc = VideoEncoder.prototype.encode; VideoEncoder.prototype.encode = function (f, o) { frames++; return enc.call(this, f, o); };
    await renderPrecise({ name: 'Audio', w: 64, h: 36, fps: 30, mbps: 1, ffmpeg: true, ffTarget: 'opus', audio: { kbps: 128 } });
    await WAITX(); VideoEncoder.prototype.encode = enc;
    delete els.au;
    return { target: got && got.target, dur: got && got.durationSec, secs: (wavLen - 44) / 8 / 96000, frames, during, labels: [FF_TARGET_LABEL.opus, FF_TARGET_EXT.alac] };
  });
  T('14 Opus/OGG/AC-3/ALAC/AIFF render no video frames', r14.target === 'opus' && r14.frames === 0 && r14.labels[0] && r14.labels[1] === 'm4a');
  T('14 audio-only export honors the In/Out range', Math.abs(r14.dur - 2) < 1e-6 && Math.abs(r14.secs - 2) < 0.01);
  T('14 audio encode shows progress + Cancel and is protected', r14.during && r14.during.inFlight && r14.during.dlg);

  // 15. the Fast engine records only the In/Out range
  const r15 = await E(async () => {
    FRESH(); state.clips = [COL('V1', 0, 6)]; renderTimeline(); window.__dl = [];
    state.rangeIn = 2; state.rangeOut = 4.5;
    const t0 = performance.now(); let minT = 1e9;
    const iv = setInterval(() => { if (exportUI.active) minT = Math.min(minT, state.time); }, 5);
    startExport({ name: 'fast', w: 320, h: 180, fps: 30, mbps: 2 }, supportedFormats()[0][1]);
    await sleep(200); await WAITX(); clearInterval(iv);
    await sleep(800); return { secs: (performance.now() - t0) / 1000, minT, dl: window.__dl.length, t: TOASTS() };
  });
  T('15 Fast export records only the range', r15.dl === 1 && r15.minT >= 2 - 1e-6 && r15.secs < 5.5);


  // UX a + b: Back returns to the export settings; the dialog shows the range and can export the whole timeline
  const ra = await E(async () => {
    FRESH();
    state.media = [{ id: 'm1', type: 'video', name: 'clip', ext: 'MP4', url: 'blob:x', duration: 10, w: 640, h: 360, size: 1, proxied: true, sourcePath: '/x/clip.mp4', srcFps: 30 }];
    state.clips = [makeClip({ type: 'video', track: 'V1', start: 0, duration: 5, mediaId: 'm1' })]; renderTimeline();
    state.rangeIn = 1; state.rangeOut = 2;
    await openExport(); await sleep(200);
    const label = document.querySelector('#mGo').textContent, rangeRow = [...document.querySelectorAll('#expSum .xr')].some(x => /Range/.test(x.textContent));
    const len = [...document.querySelectorAll('#expSum .xr')].map(x => x.textContent).find(t => /Length/.test(t));
    document.querySelector('#xRange').click(); await sleep(50);
    const labelFull = document.querySelector('#mGo').textContent;
    document.querySelector('#xRange').click(); await sleep(50);
    document.querySelector('#mGo').click(); await sleep(300);
    const asked = !!document.querySelector('#esCancel');
    document.querySelector('#esCancel').click(); await sleep(200);
    const back = !!document.querySelector('#mGo') && $('#overlay').classList.contains('show');
    // the restored dialog still works
    document.querySelector('#mCancel').click(); await sleep(50);
    return { label, rangeRow, len, labelFull, asked, back, closed: !$('#overlay').classList.contains('show') };
  });
  T('UX a Back in the source question returns to the export settings', ra.asked && ra.back && ra.closed);
  T('UX b the Export dialog shows the range length and can export the whole timeline', /range/.test(ra.label) && /0:01/.test(ra.label) && ra.rangeRow && /0:01/.test(ra.len || '') && /0:05/.test(ra.labelFull) && !/range/.test(ra.labelFull));

  // UX c: opening a project asks to save unsaved work, and the bin holds only that project's media
  const rc = await E(async () => {
    FRESH();
    const cv = document.createElement('canvas');
    state.media = [{ id: 'keep', type: 'image', name: 'same', size: 9, w: 8, h: 8, duration: 5, el: cv }, { id: 'old', type: 'image', name: 'unrelated', size: 3, w: 8, h: 8, duration: 5, el: cv }];
    state.clips = [makeClip({ type: 'image', track: 'V1', start: 0, duration: 2, mediaId: 'old' })];
    const dirty = projectDirty();
    let opened = 0; window.vibeNative = { openProject: async () => { opened++; return { cancelled: true }; } };
    openProjectPicker(); await sleep(100);
    const asked = !!document.querySelector('#acAlt'); document.querySelector('#acNo').click(); await sleep(50);
    const stayed = opened === 0;
    delete window.vibeNative;
    const proj = { app: APP_ID, version: 1, name: 'b', project: { w: 640, h: 360, fps: 30, bg: '#000000' }, media: [{ id: 'S1', type: 'image', name: 'same', size: 9, w: 8, h: 8, duration: 5 }],
      clips: [makeClip({ type: 'image', track: 'V1', start: 0, duration: 2, mediaId: 'S1' })] };
    const ar = window.autoRelinkMissing; window.autoRelinkMissing = async () => {};
    loadProjectJSON(JSON.stringify(proj), 'b.vibe'); window.autoRelinkMissing = ar;
    return { dirty, asked, stayed, bin: state.media.map(m => m.id).join(), clip: state.clips[0].mediaId, clean: !projectDirty() };
  });
  T('UX c opening a project offers to save unsaved changes first', rc.dirty && rc.asked && rc.stayed);
  T('UX c the opened project reuses identical media and drops unrelated media', rc.bin === 'keep' && rc.clip === 'keep' && rc.clean);

  // UX e: no original-audio decode when FFmpeg mixes from the files
  const re = await E(async () => {
    FRESH(); FF_AVAILABLE = true;
    window.vibeNative = { mixAudioFromFiles: true };
    const m = { id: 'em', type: 'video', name: 'e', url: 'blob:e', duration: 10, w: 64, h: 36, proxied: true, sourcePath: '/v/e.mp4', proxyPath: 'file:///tmp/vibe-proxy-2.mp4', srcGop: 0.1, srcBrowserOk: false };
    state.media = [m]; els.em = document.createElement('video');
    state.clips = [makeClip({ type: 'video', track: 'V1', start: 0, duration: 3, mediaId: 'em' })];
    let dec = 0; const d0 = window._hqDecodeAudio; window._hqDecodeAudio = async () => { dec++; return null; };
    await beginFullQualityExport(() => {}, { audio: !_ffDirectAudio() });
    const a = dec; await beginFullQualityExport(() => {}, {}); const b = dec;
    window._hqDecodeAudio = d0; endFullQualityExport(); delete els.em;
    return { direct: _ffDirectAudio !== undefined, a, b };
  });
  T('UX e the originals’ audio is not decoded when FFmpeg mixes it', re.a === 0 && re.b === 1);

  // UX f: Ctrl+S saves in place; Ctrl+Shift+S asks
  const rf = await E(async () => {
    FRESH(); const calls = [];
    window.vibeNative = { saveProject: async (j, n) => { calls.push('as'); return { ok: true, path: '/p/new.vibe' }; }, saveProjectTo: async (j, pth) => { calls.push('to:' + pth); return { ok: true, path: pth }; } };
    state.clips = [COL('V1', 0, 1)];
    dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true })); await sleep(50);
    dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true })); await sleep(50);
    dispatchEvent(new KeyboardEvent('keydown', { key: 'S', ctrlKey: true, shiftKey: true })); await sleep(50);
    return { calls, tip: document.querySelector('#saveBtn').title, sheet: SHORTCUTS.some(s => /Save project as/.test(s[0])) };
  });
  T('UX f Ctrl+S saves over the project file, Ctrl+Shift+S saves as', rf.calls.join() === 'as,to:/p/new.vibe,as' && /Ctrl\+Shift\+S/.test(rf.tip) && rf.sheet);

  // UX g: container-only export is named after the project / media
  const rg = await E(async () => {
    FRESH(); FF_AVAILABLE = true; let sug = null;
    window.vibeNative = { remuxExport: async o => { sug = o.suggest; return { ok: true }; }, keyLead: async () => ({ lead: 0 }), listEncoders: async () => ({}) };
    state.media = [{ id: 'rm', type: 'video', name: 'Holiday clip', ext: 'MP4', url: 'blob:r', duration: 10, w: 64, h: 36, size: 1, sourcePath: '/v/holiday.mp4', srcFps: 30 }];
    state.clips = [makeClip({ type: 'video', track: 'V1', start: 0, duration: 5, mediaId: 'rm' })]; renderTimeline();
    await openExport(); await sleep(100);
    document.querySelector('[data-advmode="remux"]').click(); await sleep(50);
    document.querySelector('#mGo').click(); await sleep(200);
    return sug;
  });
  T('UX g container-only export defaults to the media / project name', rg === 'Holiday-clip');

  // UX h: the convert dialog's Cancel skips the file, as its tooltip says
  const rh = await E(async () => {
    FRESH(); FF_AVAILABLE = true;
    window.vibeNative = { pathForFile: () => '/v/x.mkv', probeStreams: async () => ({ ok: true, video: ['hevc'], audio: ['aac'], fps: 30, height: 720, gop: 0.2 }),
      probeTracks: async () => ({ audio: [], subs: [] }), probeDuration: async () => ({ ok: true, duration: 10 }), makeProxy: async () => ({ ok: false }), hasFFmpeg: async () => true };
    const f = new File([new Uint8Array(100)], 'x.mkv', { type: 'video/x-matroska' });
    const pr = importFiles([f]);
    for (let i = 0; i < 100 && !document.querySelector('#cvCancel'); i++) await sleep(20);
    const tip = document.querySelector('#cvCancel').title;
    document.querySelector('#cvCancel').click(); await pr;
    return { tip, bin: state.media.length, toasts: TOASTS() };
  });
  T('UX h Cancel in the convert dialog skips the file (no RELINK placeholder left)', /nothing is imported/.test(rh.tip) && rh.bin === 0 && rh.toasts.some(t => /Skipped x\.mkv/.test(t)));

  // UX j: exporting from inside a compound exports the main timeline
  const rj = await E(async () => {
    FRESH();
    const a = COL('V1', 0, 2), b = COL('V2', 0, 2, '#00ff00'), c = COL('V1', 3, 3, '#0000ff'); state.clips = [a, b, c]; renderTimeline();
    state.selection = a.id; state.selExtra = [b.id]; const cmp = proMakeCompound(); proOpenCompound(cmp);
    await openExport(); await sleep(100);
    const r = { inside: proInsideCompound(), label: document.querySelector('#mGo').textContent };
    closeOverlay(true); return r;
  });
  T('UX j Export from inside a compound leaves it and exports the main timeline', !rj.inside && /0:06/.test(rj.label));

  // UX k + i + d (static): launcher pauses on failure; quit prompt words; temp clean-up
  const fs = require('fs'), path = require('path');
  const cmd = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'Start Vibe Edit.cmd'), 'utf8');
  const mainJs = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'main.js'), 'utf8');
  T('UX k the launcher pauses after a failed start', /call npm start\s*\r?\nif errorlevel 1 \([\s\S]*pause/.test(cmd));
  T('UX i the quit prompt talks about unsaved changes and running exports', !/Unexported edits/.test(mainJs) && /unsaved changes/.test(mainJs) && /export is still running/.test(mainJs));
  T('UX d temp files are cleaned (session on quit, stale on start)', /will-quit/.test(mainJs) && /cleanStaleTemps/.test(mainJs) && /tempPath\(opts && opts\.hq \? 'hq'/.test(mainJs));   // run for real by desktop-quit.js

  T('no page errors', app.errors.length === 0);
  if (app.errors.length) R['io: errors'] = app.errors.slice(0, 5);
}]);

/* ========================= section: ai (AI tools) ========================= */
SECTIONS.push(['ai', async (app) => {
  const p = app.page, E = (f, ...a) => p.evaluate(f, ...a), T = (k, ok) => check('ai: ' + k, ok);
  const fs = require('fs'), path = require('path');
  const { addWavMedia } = require('./lib/fixture-page');
  await p.setViewport({ width: 1600, height: 950 });
  const truth = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'long.json'))).words;
  const tw = truth.map((w, i) => [w.w + ((!truth[i + 1] || truth[i + 1].seg !== w.seg) ? '.' : ''), +w.s.toFixed(3), +w.e.toFixed(3)]);
  const id = await addWavMedia(p, path.join(__dirname, 'fixtures', 'long.wav'), { name: 'long.wav' });
  await E(async (id, tw, segs) => {
    const m = state.media.find(x => x.id === id); window.M = m; window.TW = tw; window.SEGS = segs;
    m.transcript = { v: 1, model: 'gt', words: tw.map(w => w.slice()), covered: [[0, m.duration]], lag: 0 };
    await aiEnsureEnvelope(m);
    window.VOICE = (o = {}) => makeClip(Object.assign({ type: 'audio', track: 'A1', start: 0, duration: m.duration, mediaId: m.id, name: 'voice' }, o));
    window.RESET = (clips) => {
      m.transcript = { v: 1, model: 'gt', words: TW.map(w => w.slice()), covered: [[0, m.duration]], lag: 0 };
      state.clips = clips; state.locked = {}; state.selection = null; state.selExtra = []; state.markers = [];
      state.history = []; state.hIndex = -1; pushHistory();
      if (TX.review) aiTxEndReview();
      TX.lastPtr = null; aiShowTab('tx'); aiTxRebuild(true); renderTimeline();
    };
    window.TOASTS = () => [...document.querySelectorAll('#toasts .toast')].map(e => e.textContent);
    window.CLEARTOASTS = () => document.querySelectorAll('#toasts .toast').forEach(e => e.remove());
    window.IDX = w => TX.list.findIndex(x => x.w === w);
    window.sleep = ms => new Promise(r => setTimeout(r, ms));
  }, id, tw, truth.map(w => w.seg));
  const box = async sel => { const b = await (await p.$(sel)).boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2]; };
  const click = async sel => { const [x, y] = await box(sel); await p.mouse.click(x, y); await sleep(120); };

  // 1. Delete with focus on a selection-bar button cuts the WORDS, not the selected clip
  await E(() => { RESET([VOICE(), makeClip({ type: 'color', track: 'V1', start: 0, duration: 10, name: 'bg' })]); state.selection = state.clips[1].id; renderTimeline(); });
  await click('#txBody .tw[data-i="3"]'); await click('#txPlaySel'); await E(() => setPlaying(false));
  const f1 = await E(() => document.activeElement.id);
  await p.keyboard.press('Delete'); await p.waitForFunction(() => TX.list.length === 115 && !TX.dirty, { timeout: 4000 }).catch(() => {}); await sleep(100);
  const r1 = await E(() => ({ bg: state.clips.filter(c => c.name === 'bg').length, words: TX.list.length }));
  T('1 Delete after the Play button cuts the selected word (not the timeline clip); focus back on the transcript', f1 === 'txBody' && r1.bg >= 1 && r1.words === 115);
  // … but after clicking a clip on the timeline, Delete deletes that clip
  await E(() => { RESET([VOICE(), makeClip({ type: 'color', track: 'V1', start: 0, duration: 10, name: 'bg' })]); });
  await click('#txBody .tw[data-i="3"]');
  await E(() => tlScroll.scrollLeft = 0); await sleep(50);
  const bgId = await E(() => state.clips.find(c => c.name === 'bg').id);
  await click(`#tracksHost .clip[data-id="${bgId}"]`);
  await p.keyboard.press('Delete'); await sleep(300);
  const r1b = await E(() => ({ bg: state.clips.filter(c => c.name === 'bg').length, words: TX.list.length }));
  T('1 after clicking a timeline clip, Delete deletes the clip as before', r1b.bg === 0 && r1b.words === 116);
  // search: Enter selects the match and focuses the transcript; Delete cuts it; Esc returns focus
  await E(() => RESET([VOICE()]));
  await click('#txSearch'); await p.keyboard.type('channel'); await p.keyboard.press('Enter'); await sleep(100);
  const s1 = await E(() => ({ sel: TX.sel, act: document.activeElement.id }));
  await p.keyboard.press('Delete'); await p.waitForFunction(() => TX.list.length === 115 && !TX.dirty, { timeout: 4000 }).catch(() => {}); await sleep(100);
  const s2 = await E(() => TX.list.some(x => /channel/.test(x.w)));
  T('1 search Enter selects the match, focus moves to the transcript and Delete cuts it', s1.act === 'txBody' && s1.sel && !s2);
  await E(() => { $('#txSearch').value = ''; aiTxSearch(false); });
  // Shift+Arrow extends the selection
  await E(() => RESET([VOICE()]));
  await click('#txBody .tw[data-i="2"]');
  await p.keyboard.down('Shift'); await p.keyboard.press('ArrowRight'); await p.keyboard.press('ArrowRight'); await p.keyboard.up('Shift');
  T('UX Shift+ArrowRight extends the word selection', JSON.stringify(await E(() => TX.sel)) === '[2,4]');

  // 2. words on a locked track: refused, nothing moves
  await E(() => { RESET([VOICE(), makeClip({ type: 'color', track: 'V1', start: 0, duration: 46, name: 'pic' })]); state.locked = { A1: true }; });
  await click('#txBody .tw[data-i="1"]'); await p.keyboard.press('Delete'); await sleep(300);
  const r2 = await E(() => ({ n: state.clips.length, d: state.clips.map(c => c.duration.toFixed(2)).join(), t: TOASTS().join('|') }));
  // linked partner locked
  const r2b = await E(async () => {
    const a = VOICE({ linkId: 'L' }), v = makeClip({ type: 'video', track: 'V1', start: 0, duration: M.duration, mediaId: M.id, name: 'v', linkId: 'L' }); v.props.volume = 0;
    RESET([a, v]); state.locked = { V1: true };
    TX.anchor = 1; aiTxSetSel(1, 1); await aiTxDeleteSelection();
    return state.clips.length === 2 && state.clips.every(c => Math.abs(c.duration - M.duration) < 1e-6);
  });
  T('2 cutting words on a locked track (or with a locked linked partner) is refused with a message', r2.n === 2 && /locked track/.test(r2.t) && r2b);

  // 3 + 4. captions follow transcript cuts; toast counts what was really added
  await E(() => { RESET([VOICE()]); CLEARTOASTS(); });
  await click('#txCaps'); await p.waitForSelector('#capGo'); await click('#capGo');
  const c0 = await E(() => state.clips.filter(c => c.isCaption).map(c => c.text.content));
  await click('#txBody .tw[data-i="1"]'); await p.keyboard.press('Delete'); await sleep(400);
  const c1 = await E(() => state.clips.filter(c => c.isCaption).sort((a, b) => a.start - b.start).map(c => c.text.content));
  T('3 a deleted word disappears from its burned-in caption (pieces joined)', c0[0] === 'Welcome back to the channel.' && c1[0] === 'Welcome to the channel.' && c1.length === c0.length);
  const c2 = await E(async () => {  // fillers + pauses keep them in step too
    const before = state.clips.filter(c => c.isCaption).length;
    const act = aiTimelineActivity(['A1'], 0), cuts = aiNormalizeRanges(aiPauseCuts(aiFindPauses(act, 0.6), 0.25));
    aiCutFollowCaptions(cuts);
    const L = aiTimelineWords().filter(x => x.k === 'w'), caps = state.clips.filter(c => c.isCaption);
    const text = caps.sort((a, b) => a.start - b.start).map(c => c.text.content).join(' '), spoken = L.map(x => x.w).join(' ');
    return { ok: text === spoken, same: caps.length === before, cuts: cuts.length };
  });
  T('3 after pause removal the captions still hold exactly the spoken words, in order', c2.ok && c2.same && c2.cuts > 3);
  await E(() => { RESET([VOICE(), makeClip({ type: 'text', track: TRACKS.find(t => t.kind === 'text').id, start: 0, duration: 10, name: 'My title' })]); CLEARTOASTS(); });
  await click('#txCaps'); await p.waitForSelector('#capGo');
  await E(() => { const s = document.getElementById('capTrack'); s.value = TRACKS.find(t => t.kind === 'text').id; });   // sweep2: the default now avoids a track holding titles — pick it on purpose
  await click('#capGo');
  const r4 = await E(() => ({ n: state.clips.filter(c => c.isCaption).length, t: TOASTS().join('|') }));
  T('4 caption toast reports the clips actually added and the skipped lines', new RegExp('^' + r4.n + ' captions added — \\d+ skipped').test(r4.t));

  // 5. a "keep" choice in the filler review survives an edit that shifts indices
  const r5 = await E(async () => {
    RESET([VOICE()]);
    M.transcript.words.push(['uh', 6.0, 6.05]); M.transcript.words.sort((a, b) => a[1] - b[1]); TX.rev++; aiTxRebuild(true);
    aiTxStartReview();
    const i = [...TX.review.idx].find(j => TX.list[j].w === 'uh'); aiTxToggleReview(i);
    pushHistory(); const c = state.clips[0]; c.inPoint = 1.25; c.duration -= 1.25; renderTimeline(); aiTxRebuild();
    const j = [...TX.review.idx].find(k => TX.list[k].w === 'uh');
    const kept = document.querySelector(`#txBody .tw[data-i="${j}"]`).classList.contains('rvoff');
    const firstWord = TX.list[0].w; aiTxEndReview(); return { kept, shifted: firstWord !== 'Welcome' };
  });
  T('5 filler review keeps the user’s choice after an edit shifts the list', r5.kept && r5.shifted);

  // 6. renderTimeline / playback / clip selection keep the transcript selection (no rebuild)
  const r6 = await E(() => {
    RESET([VOICE(), makeClip({ type: 'color', track: 'V1', start: 0, duration: 5, name: 'bg' })]);
    TX.anchor = 2; aiTxSetSel(2, 9);
    let n = 0; const o = aiTimelineWords; aiTimelineWords = function () { n++; return o.apply(this, arguments); };
    renderTimeline(); aiAfterTimeline(); selectClip(state.clips[1].id);
    aiTimelineWords = o;
    const a = JSON.stringify(TX.sel);
    // a real edit elsewhere: rebuilt, selection restored by word keys
    pushHistory(); state.clips[0].start = 1; renderTimeline(); aiTxRebuild();
    return { a, n, b: JSON.stringify(TX.sel), words: TX.list.slice(TX.sel[0], TX.sel[1] + 1).map(x => x.w).join(' ') };
  });
  T('6 renderTimeline/clip selection keep the transcript selection without rebuilding; real edits restore it by word', r6.a === '[2,9]' && r6.n === 0 && r6.b === '[2,9]' && /^to the channel/.test(r6.words));

  // 7. deleting a word that a split cut through the middle removes all of it
  const r7 = await E(() => {
    const c0 = VOICE(); RESET([c0]);
    const a = aiClipSub(c0, 0, 1.1), b = aiClipSub(c0, 1.1, clipEnd(c0)); b.id = uid(); state.clips = [a, b];
    const L = aiTimelineWords(), i = L.findIndex(x => x.w === 'back');
    aiRippleCut(aiRangesForEntries(L, [i]));
    const surv = []; for (const c of state.clips) { const o = [Math.max(c.inPoint, 0.97), Math.min(c.inPoint + c.duration, 1.262)]; if (o[1] > o[0] + 0.01) surv.push(o); }
    return surv.length;
  });
  T('7 a word split by a cut is deleted whole', r7 === 0);
  // 8. deleting across a split removes the pause between the words like on an unsplit clip
  const r8 = await E(() => {
    const c0 = VOICE(); RESET([c0]);
    const L0 = aiTimelineWords(), i = L0.findIndex(x => x.w === 'channel.'), r0 = aiRangeForWords(L0, i, i + 1);
    const a = aiClipSub(c0, 0, 2.5), b = aiClipSub(c0, 2.5, clipEnd(c0)); b.id = uid(); state.clips = [a, b];
    const L = aiTimelineWords(), j = L.findIndex(x => x.w === 'channel.'), rs = aiRangesForEntries(L, [j, j + 1]);
    return rs.length === 1 && Math.abs(rs[0][0] - r0[0]) < 1e-6 && Math.abs(rs[0][1] - r0[1]) < 1e-6;
  });
  T('8 a cut across a split clip removes the pause between the deleted words', r8);
  // UX: pause chip at a split is shown; between two separate clips its Delete closes the whole gap
  const r8b = await E(async () => {
    const c0 = VOICE(); RESET([c0]);
    const a = aiClipSub(c0, 0, 2.5), b = aiClipSub(c0, 2.5, clipEnd(c0)); b.id = uid(); state.clips = [a, b]; aiTxRebuild(true);
    const chip = !!document.querySelector(`#txBody .tx-pause[data-gap="${IDX('Today')}"]`);
    // separate clips with an empty 0.3 s timeline gap: "channel." ... | gap | "Today"
    const A = VOICE({ duration: 2.2 }), B = VOICE({ start: 2.5, inPoint: 2.9, duration: 10 }); RESET([A, B]);
    const k = IDX('Today'), gap0 = TX.list[k].t0 - TX.list[k - 1].t1;
    const chip2 = !!document.querySelector(`#txBody .tx-pause[data-gap="${k}"]`);
    TX.pauseSel = k; await aiTxDeleteSelection();
    const L = aiTimelineWords(), m = L.findIndex(x => x.w === 'Today');
    return { chip, chip2, gap0, gap1: L[m].t0 - L[m - 1].t1, empty: state.clips.length === 2 && Math.abs(clipEnd(state.clips[0]) - state.clips[1].start) < 1e-6 };
  });
  T('UX pause chips across clip cuts; Delete closes the whole gap', r8b.chip && r8b.chip2 && r8b.gap0 > 0.5 && r8b.gap1 < 0.4 && r8b.empty);

  // 9. re-transcribe: cancel keeps the old transcript (and labels); success swaps and carries labels
  const r9 = await E(async () => {
    RESET([VOICE()]);
    const tr = M.transcript; tr.speakers = { byT: tr.words.map(w => [+w[1].toFixed(3), 0]), n: 1, names: ['Ann'], k: 0 }; _proSpkIndex(tr, true);
    const real = aiTranscribe;
    aiTranscribe = async (r, sp, prog, o) => { await sleep(30); throw new Error('cancelled'); };
    await aiRetranscribe([M]);
    const kept = M.transcript === tr && M.transcript.words.length === 116 && M.transcript.speakers.names[0] === 'Ann' && TX.list.length === 116;
    aiTranscribe = async (r, sp, prog, o) => { o.fresh.out = { v: 1, model: 'x', words: TW.map(w => [w[0], w[1] + 0.02, w[2]]), covered: [[0, 46]] }; return { added: 116 }; };
    await aiRetranscribe([M]);
    aiTranscribe = real;
    return { kept, swapped: M.transcript !== tr && M.transcript.words[0][1] > 0.01, spk: proSpeakerOf(aiTimelineWords()[3]) && proSpeakerOf(aiTimelineWords()[3]).name === 'Ann' };
  });
  T('9 re-transcribe: cancel keeps the old transcript + labels; success swaps in the new one', r9.kept && r9.swapped && r9.spk);

  // 10 + 11. "This paragraph is X" relabels just that paragraph; speaker edits undo with Ctrl+Z
  await E(() => {
    RESET([VOICE()]);
    const tr = M.transcript; tr.speakers = { byT: tr.words.map((w, i) => [+w[1].toFixed(3), SEGS[i] >= 6 && SEGS[i] <= 9 ? 1 : 0]), n: 2, names: ['Ann', 'Bob'], k: 2 }; _proSpkIndex(tr, true);
    TX.rev++; aiTxRebuild(true); pushHistory();
  });
  const paras = () => E(() => [...document.querySelectorAll('#txBody .tx-p .tx-spk')].map(b => b.textContent));
  const p0 = await paras();
  await E(() => { const b = document.querySelectorAll('#txBody .tx-p .tx-spk')[2]; proAssignParagraph(+b.dataset.i, 1); });
  const p1 = await paras();
  await E(() => document.activeElement.blur());
  await p.keyboard.down('Control'); await p.keyboard.press('z'); await p.keyboard.up('Control'); await sleep(300);
  const p2 = await paras();
  await E(() => proMergeSpeaker(M, 1, 0)); const p3 = await paras();
  await p.keyboard.down('Control'); await p.keyboard.press('z'); await p.keyboard.up('Control'); await sleep(300);
  const p4 = await paras();
  T('10 "This paragraph is Bob" stops at the paragraph end', p0.length === 4 && JSON.stringify(p1) === '["Ann","Bob","Ann"]');
  T('11 speaker relabel and merge are undone by Ctrl+Z', JSON.stringify(p2) === JSON.stringify(p0) && !p3.includes('Bob') && JSON.stringify(p4) === JSON.stringify(p0));

  // 12. scene detection: cancel stops before the second FFmpeg pass
  const mainJs = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'main.js'), 'utf8');
  let r12 = /cancelledScenes\.add\(jobId\)/.test(mainJs) && /cancelled: true/.test(mainJs);
  const ffBin = ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg'].find(f => fs.existsSync(f));
  if (ffBin && r12) {
    const os = require('os'), Module = require('module'), { execFileSync } = require('child_process');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 've-scn-')); fs.mkdirSync(path.join(tmp, 'bin')); fs.symlinkSync(ffBin, path.join(tmp, 'bin', 'ffmpeg'));
    const oldRes = process.resourcesPath; process.resourcesPath = tmp; const handlers = {}, sent = [];
    const stub = { app: { getVersion: () => 't', whenReady: () => new Promise(() => {}), on() {}, commandLine: { appendSwitch() {} } }, BrowserWindow: function () {}, dialog: {}, Menu: { setApplicationMenu() {}, buildFromTemplate() { return {}; } }, shell: {}, ipcMain: { handle: (c, f) => { handlers[c] = f; }, on() {} } };
    const load = Module._load; Module._load = function (r) { if (r === 'electron') return stub; return load.apply(this, arguments); };
    const mp = require.resolve('../desktop/main.js'); delete require.cache[mp];
    try { require(mp); } finally { Module._load = load; process.resourcesPath = oldRes; }
    const vid = path.join(tmp, 'long.mp4');
    execFileSync(ffBin, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=60', '-c:v', 'libx264', '-g', '30', '-preset', 'ultrafast', vid]);
    const ev = { sender: { send: (c, d) => sent.push([c, d]) } };
    const pr = handlers['ffmpeg:scenes'](ev, { input: vid, jobId: 'J' });
    await sleep(100); await handlers['ffmpeg:cancelScenes'](ev, 'J');
    const t0 = Date.now(), r = await pr;
    r12 = r.cancelled === true && !r.ok && sent.length === 0 && Date.now() - t0 < 3000;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
  T('12 cancelling scene detection stops before the second FFmpeg pass and reports cancelled', r12);

  // 13. after a reopen (no envelope) the filler review rebuilds it and finds the unwritten ums
  const r13 = await E(async () => {
    RESET([VOICE()]);
    M.transcript.words = M.transcript.words.filter(w => !/^(Um|Uh)/.test(w[0])); TX.rev++; aiTxRebuild(true);
    const withEnv = aiTimelineWords().filter(x => x.k === 's').length;
    delete _aiEnv[M.id]; TX.rev++; aiTxRebuild(true);
    const noEnv = TX.list.filter(x => x.k === 's').length;
    aiTxStartReview(); if (_aiEnvBg) await _aiEnvBg;
    const after = TX.list.filter(x => x.k === 's').length; aiTxEndReview();
    return { withEnv, noEnv, after };
  });
  T('13 Fillers rebuilds the missing loudness data in the background (unwritten ums found again)', r13.withEnv > 0 && r13.noEnv === 0 && r13.after === r13.withEnv);

  // 14. extending a clip: the new span is widened back to a pause and replaces the old words there
  const r14 = await E(() => {
    const db = new Float32Array(3000).fill(-20); for (let f = 1180; f < 1210; f++) db[f] = -80;   // a pause at 11.8–12.1 s
    const env = { db, hop: 0.01, dur: 30, auto: -40, floor: -80, loud: -20 };
    const w = aiWidenSeams(env, [[14.3, 30]], [[0, 14.3]]);
    const none = aiWidenSeams(env, [[20, 30]], [[0, 14.3]]);
    return { a: w[0][0], none: none[0][0] };
  });
  T('14 a new span continuing a transcribed one starts again at the pause before the seam', r14.a > 11.8 && r14.a < 12.1 && r14.none === 20);

  // smaller: beat snap rolls linked audio; compound message; reframe on reversed clips
  const r15 = await E(() => {
    const V1 = makeClip({ type: 'video', track: 'V1', start: 0, duration: 4, mediaId: M.id, name: 'v1', linkId: 'L1' }), A1 = makeClip({ type: 'audio', track: 'A1', start: 0, duration: 4, mediaId: M.id, name: 'a1', linkId: 'L1' });
    const V2 = makeClip({ type: 'video', track: 'V1', start: 4, duration: 4, mediaId: M.id, name: 'v2', linkId: 'L2' }), A2 = makeClip({ type: 'audio', track: 'A1', start: 4, duration: 4, mediaId: M.id, name: 'a2', linkId: 'L2' });
    V2.inPoint = A2.inPoint = 10; state.clips = [V1, A1, V2, A2];
    const beats = []; for (let t = 0; t < 10; t += 0.5) beats.push(t + 0.2);
    aiSnapCutsToBeats([V1, V2], beats);
    return Math.abs(clipEnd(A1) - 4.2) < 1e-6 && Math.abs(A2.start - 4.2) < 1e-6 && Math.abs(A2.inPoint - V2.inPoint) < 1e-6;
  });
  T('beat sync "Snap my cuts" rolls the linked audio with the picture', r15);
  const r16 = await E(() => {
    RESET([VOICE()]); state.selection = state.clips[0].id; state.selExtra = []; proMakeCompound(); aiShowTab('tx'); aiTxRebuild(true);
    const msg = /inside a compound clip/.test($('#txBody').textContent); CLEARTOASTS(); aiCaptionsDialog(); return msg && TOASTS().some(t => /inside a compound clip/.test(t));
  });
  T('transcript tab and Captions explain that the speech is inside a compound clip', r16);
  const r17 = await E(() => {
    const c = makeClip({ type: 'video', track: 'V1', start: 0, duration: 10, mediaId: M.id, name: 'rev' }); c.props.reverse = true; c.inPoint = 0;
    const plan = { w: 1920, h: 1080, shots: [{ t0: 0, keysX: [[0, 0.2]], keysY: [[0, 0.5]] }, { t0: 6, keysX: [[6, 0.8]], keysY: [[6, 0.5]] }] };
    aiApplyReframe(c, plan, 1080, 1920);
    const X = c.kf.x, g = aiCoverGeom(1920, 1080, 1080, 1920), xs = v => aiSubjectToXY(g, v, 0.5, 1080, 1920).x;
    // source 6–10 (subject at 0.8) plays first on the timeline (0–4 s), then source 0–6 (0.2)
    return Math.abs(X[0].v - xs(0.8)) < 0.01 && Math.abs(kfEval(X, 2) - xs(0.8)) < 0.01 && Math.abs(kfEval(X, 7) - xs(0.2)) < 0.01;
  });
  T('auto-reframe on a reversed clip places each shot’s framing in timeline order', r17);

  // UX: pauses dialog keeps the Leave slider honest and stays open for "Hear first pause"
  await E(() => { RESET([VOICE()]); });
  await click('#txPauses'); await p.waitForSelector('#apStrip'); await sleep(200);
  const r18 = await E(async () => {
    const mi = $('#apMin'), ke = $('#apKeep'); mi.value = 0.3; mi.oninput(); ke.value = 1; ke.oninput();
    const sliderOk = Math.abs(+ke.value - 0.25) < 1e-6 && /0\.25/.test($('#apKeepV').textContent);
    $('#apPlay').click(); await sleep(100);
    const open = $('#overlay').classList.contains('show') && !!$('#apStrip') && +$('#apMin').value === 0.3;
    setPlaying(false); closeOverlay(); return { sliderOk, open };
  });
  T('UX pauses: Leave slider follows its clamped value; Hear first pause keeps the dialog and its settings', r18.sliderOk && r18.open);
  // UX: fillers badge / sounds off by default; beat sync picks music over the voice; one "Captions" name
  const r19 = await E(() => {
    RESET([VOICE()]);
    const badge = +($('#txFillN').textContent || 0), real = TX.list.filter(x => x.filler === 'um' || x.filler === 'repeat').length;
    aiTxStartReview(); const soundsOff = !$('#rvSnd').checked && [...TX.review.idx].every(i => TX.list[i].k === 'w'); aiTxEndReview();
    const pal = COMMANDS.filter(c => /caption/i.test(c.n)).map(c => c.n);
    return { badge: badge === real, soundsOff, pal, bin: $('#transcribeBtn').textContent.trim() };
  });
  T('UX Fillers badge counts real fillers only; unwritten sounds are off by default', r19.badge && r19.soundsOff);
  T('UX one "Captions" name in the palette and on the bin button', JSON.stringify(r19.pal) === '["Captions…"]' && r19.bin === 'Captions');
  const r20 = await E(async () => {
    const music = makeClip({ type: 'audio', track: 'A2', start: 0, duration: 30, mediaId: 'mus', name: 'song' });
    state.media.push({ id: 'mus', type: 'audio', name: 'song.wav', duration: 30, w: 0, h: 0 });
    RESET([VOICE(), music]);
    const real = aiBeatsOfClip; aiBeatsOfClip = async () => [];
    aiBeatSyncDialog(); await sleep(50); aiBeatsOfClip = real;
    const v = $('#bsSrc').value, unit = !!document.querySelector('#overlay .bs-unit'); closeOverlay(); return v === music.id && unit;
  });
  T('UX beat sync picks the music, not the (longer) voice; "beats" after Cut every', r20);

  T('no page errors', app.errors.length === 0);
  if (app.errors.length) R['ai: errors'] = app.errors.slice(0, 5);
}]);

/* ========================= section: pro (Pro tools) ========================= */
SECTIONS.push(['pro', async (app) => {
  const p = app.page, E = (f, ...a) => p.evaluate(f, ...a), T = (k, ok) => check('pro: ' + k, ok);
  const path = require('path');
  const { addWavMedia } = require('./lib/fixture-page');
  await p.setViewport({ width: 1600, height: 1000 });
  const voiceId = await addWavMedia(p, path.join(__dirname, 'fixtures', 'long.wav'), { name: 'voice.wav' });
  const musicId = await addWavMedia(p, path.join(__dirname, 'fixtures', 'music120.wav'), { name: 'music.wav' });
  await E((voiceId, musicId) => {
    window.VID = voiceId; window.MID = musicId; window.TOASTS = [];
    for (const id of [voiceId, musicId]) { const m = state.media.find(x => x.id === id); els[id] = new Audio(m.url); m.hasAudio = true; }
    const ot = window.toast; window.toast = (m, k, ms) => { TOASTS.push([String(m), k || '']); return ot(m, k, ms); };
    window.LAST = () => TOASTS[TOASTS.length - 1] || ['', ''];
    window.IMG = () => { const W = 160, H = 90, c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d');
      const gr = g.createLinearGradient(0, 0, W, 0); gr.addColorStop(0, '#203040'); gr.addColorStop(1, '#e0a080'); g.fillStyle = gr; g.fillRect(0, 0, W, H); return c; };
    window.RESET = (clips) => {
      state.media = state.media.filter(m => m.id === VID || m.id === MID);
      state.media.push({ id: 'img', type: 'image', name: 'grad', duration: 10, w: 160, h: 90, el: IMG() });
      state.media.push({ id: 'vm', type: 'video', name: 'v.mp4', duration: 30, w: 64, h: 36, url: 'blob:none' });
      if (typeof proInsideCompound === 'function') while (proInsideCompound()) proCloseCompound();
      state.clips = clips; state.locked = {}; state.selection = null; state.selExtra = []; state.markers = [];
      state.history = []; state.hIndex = -1; pushHistory(); state.inspTab = 'clip'; TOASTS.length = 0;
      try { closeOverlay(); } catch (e) { }
    };
    window.SNAP = () => { drawFrame(); const cv = document.getElementById('preview'); return cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; };
    window.DIFF = (A, B) => { let m = 0; for (let i = 0; i < A.length; i++) m = Math.max(m, Math.abs(A[i] - B[i])); return m; };
    window.RMS = async (D) => { const b = await renderAudioOffline(D, 48000); if (!b) return 0; const d = b.getChannelData(0); let s = 0; for (let i = 0; i < d.length; i++) s += d[i] * d[i]; return Math.sqrt(s / d.length); };
    window.OPEN_SECS = () => document.querySelectorAll('#inspBody .sec').forEach(s => { if (s.classList.contains('collapsed')) s.querySelector('h4').click(); });
  }, voiceId, musicId);
  const click = async sel => { await E(s => { const e = document.querySelector(s); e && e.scrollIntoView({ block: 'center' }); }, sel); const el = await p.$(sel); const bb = el && await el.boundingBox(); if (!bb) return false; await p.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2); await sleep(50); return true; };

  // 1 + 2. LUT / speed-ramp reset links do their own job; the Intensity arrow resets to 100%
  await E(() => {
    const v = makeClip({ type: 'video', track: 'V1', start: 0, duration: 10, mediaId: 'vm' }); RESET([v]);
    state.selection = v.id; state.time = 100; proRampApply(v, 'hero'); v.props.lutId = proBuiltinLutId('mono'); v.props.lutAmt = 100; v.props.brightness = 140;
    renderInspector(); OPEN_SECS();
  });
  await click('[data-lutreset]');
  const r1a = await E(() => { const v = state.clips[0]; return { lut: v.props.lutId || null, bri: v.props.brightness, ramp: !!v.ramp }; });
  await E(() => OPEN_SECS()); await click('[data-rampreset]');
  const r1b = await E(() => { const v = state.clips[0]; return { ramp: !!v.ramp, bri: v.props.brightness }; });
  T('1 LUT reset removes the LUT only (look and ramp kept)', r1a.lut === null && r1a.bri === 140 && r1a.ramp);
  T('1 speed-ramp reset removes the ramp only (look kept)', !r1b.ramp && r1b.bri === 140);
  await E(() => { const v = state.clips[0]; v.props.lutId = proBuiltinLutId('mono'); v.props.lutAmt = 60; renderInspector(); OPEN_SECS(); });
  const changed = await E(() => document.querySelector('.rst[data-rstk=lutAmt]').classList.contains('changed'));
  await click('.rst[data-rstk=lutAmt]');
  const amt = await E(() => ({ amt: state.clips[0].props.lutAmt, def: defaultProps().lutAmt, hint: !!HINTS.lutAmt }));
  T('2 LUT Intensity reset arrow shows changed and resets to 100%', changed && amt.amt === 100 && amt.def === 100 && amt.hint);

  // 3. detach audio of a ducked clip: the volume keys and ducking move to the audio clip
  const r3 = await E(() => {
    const v = makeClip({ type: 'video', track: 'V1', start: 0, duration: 10, mediaId: 'vm' }); RESET([v]);
    v.kf = { volume: [{ t: 0, v: 1 }, { t: 2, v: 0.25 }, { t: 6, v: 0.25 }, { t: 8, v: 1 }] }; v.duck = { prev: null, sig: _proVolSig(v) };
    detachAudio(v); const a = state.clips.find(c => c.type === 'audio');
    return { vv: liveProps(v, 4).volume, av: liveProps(a, 4).volume, duck: !!a.duck, vkf: !!(v.kf && v.kf.volume), vduck: !!v.duck };
  });
  T('3 detach audio moves volume keys + ducking to the audio clip', r3.vv === 1 && Math.abs(r3.av - 0.25) < 1e-6 && r3.duck && !r3.vkf && !r3.vduck);

  // 4. compound "Preserve pitch" off reaches the sound inside (virtual clips + the mix)
  const r4 = await E(async () => {
    const a = makeClip({ type: 'audio', track: 'A1', start: 0, duration: 6, mediaId: MID }); RESET([a]);
    state.selection = a.id; const cmp = proMakeCompound(); cmp.props.speed = 2; cmp.duration = 3; proCmpTouched();
    const on = playClips().find(x => x.type === 'audio').props.preservePitch !== false;
    const mixOf = async () => { const b = await renderAudioOffline(3, 48000); return b.getChannelData(0).slice(0, 48000 * 2); };
    const A = await mixOf(); cmp.props.preservePitch = false; proCmpTouched();
    const off = playClips().find(x => x.type === 'audio').props.preservePitch;
    const B = await mixOf(); let d = 0; for (let i = 0; i < A.length; i += 7) d = Math.max(d, Math.abs(A[i] - B[i]));
    return { on, off, d };
  });
  T('4 compound Preserve pitch off: inner sound plays record-style (virtual clip + rendered mix differ)', r4.on && r4.off === false && r4.d > 0.05);

  // 5. auto-duck: music inside a compound is guessed as music and ducked via the compound's volume keys
  const r5 = await E(async () => {
    const vm = state.media.find(m => m.id === VID), mm = state.media.find(m => m.id === MID), D = Math.min(vm.duration, mm.duration);
    const v = makeClip({ type: 'audio', track: 'A1', start: 0, duration: D, mediaId: VID }), m = makeClip({ type: 'audio', track: 'A2', start: 0, duration: D, mediaId: MID });
    RESET([v, m]); await aiEnsureEnvelopesForTracks(['A1', 'A2']);
    state.selection = m.id; const cmp = proMakeCompound();
    const roles = proGuessRoles();
    const r = proApplyDucking(['A1'], [cmp.track], { db: -12 });
    const iv = r.intervals.find(([a, b]) => b - a > 1), mid = iv ? (iv[0] + iv[1]) / 2 : 0;
    const vc = playClips().find(x => x.mediaId === MID), duckedVol = liveProps(vc, mid).volume;
    // and the dialog agrees
    await COMMANDS.find(c => /Auto-duck/.test(c.n)).f(); for (let i = 0; i < 40 && !/dip/.test((($('#dkStats') || {}).textContent) || ''); i++) await new Promise(r => setTimeout(r, 100));
    const stats = ($('#dkStats') || {}).textContent || '', go = !$('#dkGo').disabled; closeOverlay();
    const undo = proUnduckClip(cmp);
    return { roles, clips: r.clips, onCmp: !!(cmp.kf && cmp.kf.volume) || undo, duckedVol, stats, go, cmpTrack: cmp.track };
  });
  T('5 auto-duck guesses a music compound as music and the voice track as voice', r5.roles[r5.cmpTrack] === 'music' && r5.roles.A1 === 'voice');
  T('5 auto-duck ducks music inside a compound (keys on the compound reach the sound)', r5.clips === 1 && r5.onCmp && r5.duckedVol < 0.3 && /dip/.test(r5.stats) && r5.go);

  // 6. break apart carries look / LUT / fades / opacity keys, and names what it can't
  const r6 = await E(() => {
    const a = makeClip({ type: 'image', track: 'V1', start: 0, duration: 3, mediaId: 'img' }); RESET([a]);
    state.selection = a.id; const cmp = proMakeCompound();
    Object.assign(cmp.props, { lutId: proBuiltinLutId('mono'), lutAmt: 80, brightness: 150, saturate: 0, exposure: 0.5, fadeIn: 1, fadeOut: 0.5 });
    cmp.kf = { opacity: [{ t: 0, v: 0.2 }, { t: 2, v: 1 }] };
    state.time = 1.2; const before = SNAP();
    const out = proBreakCompound(cmp), b = out[0], after = SNAP(), t1 = LAST();
    const ok1 = b.props.lutId === cmp.props.lutId && b.props.lutAmt === 80 && b.props.brightness === 150 && b.props.saturate === 0 && b.props.exposure === 0.5
      && b.props.fadeIn === 1 && b.props.fadeOut === 0.5 && Math.abs(liveProps(b, 1).opacity - kfEval(cmp.kf.opacity, 1, 'smooth')) < 1e-6;
    // an inner clip with its own look: the compound's look can't be carried → a warning naming it
    const c2 = makeClip({ type: 'color', track: 'V1', start: 0, duration: 3 }); c2.props.contrast = 130; RESET([c2]);
    state.selection = c2.id; const k2 = proMakeCompound(); k2.props.brightness = 60; proBreakCompound(k2); const t2 = LAST();
    return { ok1, same: DIFF(before, after), t1, t2 };
  });
  T('6 break apart carries LUT/look/fades/opacity keys (same picture) with a success message', r6.ok1 && r6.same <= 6 && r6.t1[1] === 'ok');
  T('6 break apart warns about what it couldn’t carry over', r6.t2[1] === 'err' && /couldn’t carry over.*look/.test(r6.t2[0]));

  // 7. break apart / open refuse on a locked track (incl. the Ctrl+Alt+G shortcut)
  const r7 = await E(() => {
    const a = makeClip({ type: 'color', track: 'V1', start: 0, duration: 3 }); RESET([a]);
    state.selection = a.id; const cmp = proMakeCompound(); state.locked[cmp.track] = true; state.selection = cmp.id;
    document.activeElement && document.activeElement.blur && document.activeElement.blur();
    dispatchEvent(new KeyboardEvent('keydown', { key: 'g', ctrlKey: true, altKey: true }));
    const kept = state.clips.length === 1 && state.clips[0].type === 'compound', t1 = LAST();
    proOpenCompound(cmp); const inside = proInsideCompound(), t2 = LAST();
    return { kept, t1, inside, t2 };
  });
  T('7 break apart / edit inside refuse on a locked track', r7.kept && r7.t1[1] === 'err' && !r7.inside && r7.t2[1] === 'err');

  // 8 + UX4. Paste attributes → Speed: no ramp on a freeze frame; compounds get the speed; smoothing comes along
  const r8 = await E(() => {
    const src = makeClip({ type: 'video', track: 'V1', start: 0, duration: 6, mediaId: 'vm' });
    const frz = makeClip({ type: 'video', track: 'V1', start: 10, duration: 3, mediaId: 'vm' }); frz.freeze = true; frz.freezeAt = 4;
    const base = makeClip({ type: 'video', track: 'V2', start: 30, duration: 4, mediaId: 'vm' });
    const plain = makeClip({ type: 'video', track: 'V1', start: 40, duration: 4, mediaId: 'vm' });
    RESET([src, frz, base, plain]); state.time = 100; proRampApply(src, 'flashIn'); src.props.frameBlend = true; src.props.motionBlur = 180;
    state.selection = src.id; copySelected();
    state.selection = base.id; const cmp = proMakeCompound();
    state.selection = frz.id; state.selExtra = [cmp.id, plain.id];
    pasteAttrsDialog(); const sp = document.querySelector('#overlay [data-pa=speed]'); sp.checked = true; document.getElementById('paApply').click();
    return { frz: !frz.ramp && frz.duration === 3 && (frz.props.speed || 1) === 1, cmp: Math.abs(cmp.props.speed - src.props.speed) < 1e-9 && !cmp.ramp && cmp.props.frameBlend && cmp.props.motionBlur === 180,
      plain: !!plain.ramp && plain.props.frameBlend && plain.props.motionBlur === 180, t: LAST() };
  });
  T('8 paste Speed skips freeze frames (no ramp), applies to compounds, and says what it skipped', r8.frz && r8.cmp && /pasted onto 2 clips/.test(r8.t[0]) && /skipped on 1/.test(r8.t[0]));
  T('UX4 paste Speed carries frame blending and motion blur', r8.plain && r8.cmp);

  // 9. compound names use the lowest free number
  const r9 = await E(() => {
    const mk = s => makeClip({ type: 'color', track: 'V1', start: s, duration: 2 }); RESET([mk(0), mk(3), mk(6)]);
    const names = []; for (const c of [...state.clips]) { state.selection = c.id; state.selExtra = []; names.push(proMakeCompound().name); }
    proBreakCompound(state.clips.find(c => c.name === 'Compound 2')); const c4 = mk(9); state.clips.push(c4); state.selection = c4.id; names.push(proMakeCompound().name);
    return names.join();
  });
  T('9 compound names: lowest free number', r9 === 'Compound 1,Compound 2,Compound 3,Compound 2');

  // UX1. compound inspector: no dead controls; Color grading + Audio (volume, mute) that work
  const r10 = await E(async () => {
    const im = makeClip({ type: 'image', track: 'V1', start: 0, duration: 4, mediaId: 'img' }), a = makeClip({ type: 'audio', track: 'A1', start: 0, duration: 4, mediaId: MID });
    RESET([im, a]); state.selection = im.id; state.selExtra = [a.id]; const cmp = proMakeCompound(); state.selection = cmp.id; renderInspector();
    const secs = [...document.querySelectorAll('#inspBody .sec > h4')].map(h => h.childNodes[0].textContent.trim());
    const keys = [...document.querySelectorAll('#inspBody [data-k]')].map(e => e.dataset.k);
    const dead = ['vignette', 'fade', 'grain', 'transInDur', 'transOutDur', 'motionAmount'].filter(k => keys.includes(k));
    const noDeadUi = !document.getElementById('trackBtn') && !document.getElementById('motionSel') && !document.getElementById('transIn');
    state.time = 1; const s0 = SNAP(); cmp.props.exposure = 1; const s1 = SNAP(); cmp.props.exposure = 0;
    const rms1 = await RMS(4); cmp.props.volume = 0.5; const rms2 = await RMS(4);
    renderInspector(); const mu = document.getElementById('cmpMute'); mu.checked = true; mu.onchange(); const rms3 = await RMS(4);
    return { secs, dead, noDeadUi, grade: DIFF(s0, s1), vol: !!document.querySelector('#inspBody input[data-k=volume]'), ratio: rms2 / rms1, muted: rms3, muteFlag: !!cmp.props.muteClip };
  });
  T('UX1 compound inspector hides dead controls (Motion, Transitions, Vignette, Fade, Grain)', !r10.secs.includes('Motion') && !r10.secs.includes('Transitions') && !r10.dead.length && r10.noDeadUi);
  T('UX1 compound Color grading section changes the picture', r10.secs.includes('Color grading') && r10.grade > 20);
  T('UX1 compound Audio section: Volume halves the sound, Mute silences it', r10.secs.includes('Audio') && r10.vol && Math.abs(r10.ratio - 0.5) < 0.03 && r10.muted < 1e-4 && r10.muteFlag);

  // UX2. proxy commands in the browser copy say why
  const r11 = await E(async () => {
    RESET([]); state.media.push({ id: 'k4', type: 'video', name: '4k.mp4', duration: 30, w: 3840, h: 2160, url: 'blob:none', size: 500e6 });
    await proMakeHeavyProxies(); const a = LAST()[0]; await proAllOriginals(false); const b = LAST()[0]; await proAllOriginals(true); const c = LAST()[0];
    return { a, b, c };
  });
  T('UX2 proxy commands: "needs the desktop app (FFmpeg)" / "No proxies yet"', /needs the desktop app \(FFmpeg\)/.test(r11.a) && /No proxies yet/.test(r11.b) && /No proxies yet/.test(r11.c));

  // UX3. palette feedback + shortcuts
  const r12 = await E(() => {
    const v = makeClip({ type: 'video', track: 'V1', start: 0, duration: 4, mediaId: 'vm' }); RESET([v]);
    const rm = COMMANDS.find(c => c.n === 'Speed ramp: remove');
    rm.f(); const t0 = LAST()[0]; state.selection = v.id; rm.f(); const t1 = LAST()[0];
    state.time = 100; proRampApply(v, 'hero'); rm.f(); const t2 = LAST()[0], gone = !v.ramp;
    const mk = COMMANDS.find(c => /^Make compound/.test(c.n));
    openShortcuts(); const sheet = $('#overlay').textContent; closeOverlay();
    return { t0, t1, t2, gone, k: mk.k, sheet: /Ctrl\s*Alt\s*G/.test(sheet.replace(/\s+/g, ' ')) && /Leave a compound clip\s*Esc/.test(sheet) };
  });
  T('UX3 "Speed ramp: remove" gives feedback (nothing selected / no ramp / removed)', /Select/.test(r12.t0) && /no speed ramp/.test(r12.t1) && /removed/.test(r12.t2) && r12.gone);
  T('UX3 Ctrl+Alt+G shown on Make compound; Shortcuts sheet lists Ctrl+Alt+G and Esc', r12.k === 'Ctrl Alt G' && r12.sheet);

  // UX5. smoothing on a slowed compound reaches the video inside
  const r13 = await E(() => {
    const v = makeClip({ type: 'video', track: 'V1', start: 0, duration: 4, mediaId: 'vm' }); RESET([v]); state.media.find(m => m.id === 'vm').srcFps = 30;
    state.selection = v.id; const cmp = proMakeCompound(); cmp.props.speed = 0.5; cmp.duration = 8; proCmpTouched(); state.selection = cmp.id; renderInspector();
    const ui = !!document.getElementById('pFrameBlend') && !!document.querySelector('#inspBody input[data-k=motionBlur]');
    const fb = document.getElementById('pFrameBlend'); fb.checked = true; fb.onchange();
    const inner = playClips().find(x => x.type === 'video'), plan = proBlendPlan(inner, 1.013);
    return { ui, fb: inner.props.frameBlend, n: plan ? plan.length : 0 };
  });
  T('UX5 compound Smoothing: frame blending applies to the slowed video inside', r13.ui && r13.fb && r13.n === 2);

  // UX6. guide wording: Jump centers on the playhead too
  const r14 = await E(() => { const g = GUIDE.find(s => s.s === 'Pro tools').items.find(i => i.t === 'Speed ramps'); return g.how.join(' '); });
  T('UX6 Speed ramps guide says Jump also centers on the playhead', /Hero moment, Bullet time and Jump center/.test(r14));

  T('no page errors', app.errors.length === 0);
  if (app.errors.length) R['pro: errors'] = app.errors.slice(0, 5);
}]);

/* ========================= section: ux (visual design review) ========================= */
SECTIONS.push(['ux', async (app) => {
  const p = app.page, E = (f, ...a) => p.evaluate(f, ...a), T = (k, ok) => check('ux: ' + k, ok);
  const fs = require('fs'), path = require('path');
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'vibe-edit.html'), 'utf8').replace(/<script type="text\/plain" id="vibeSpeakerModel">[\s\S]*?<\/script>/, '');
  await E(() => {
    window.THEME = t => { document.body.dataset.theme = t; };
    window.LUM = c => { const m = c.match(/[\d.]+/g).map(Number); const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]); };
    window.CR = (a, b) => { const x = LUM(a), y = LUM(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    window.VAR = (n, el) => { const d = document.createElement('div'); d.style.color = 'var(' + n + ')'; (el || document.body).appendChild(d); const c = getComputedStyle(d).color; d.remove(); return c; };
    window.IMG = () => { const c = document.createElement('canvas'); c.width = 320; c.height = 180; const g = c.getContext('2d'); g.fillStyle = '#446'; g.fillRect(0, 0, 320, 180); return c; };
    window.DEMO = () => {
      const cv = IMG(); const pk = new Float32Array(200).map((_, i) => Math.abs(Math.sin(i / 5)));
      state.media = [{ id: 'mi', type: 'image', name: 'still.png', duration: 5, w: 320, h: 180, el: cv, thumb: cv.toDataURL() },
        { id: 'ma', type: 'audio', name: 'voiceover.wav', duration: 6, peaks: { peak: pk, rms: pk.map(v => v * .6), dur: 6 } },
        { id: 'mv', type: 'video', name: 'clip.mp4', duration: 12, w: 1920, h: 1080, el: document.createElement('video'), hasAudio: true }];
      const tx = TRACKS.find(t => t.kind === 'text').id;
      const im = makeClip({ type: 'image', track: 'V1', start: 0, duration: 6, name: 'still.png', mediaId: 'mi' });
      const t = makeClip({ type: 'text', track: tx, start: 1, duration: 3, name: 'Hello' }); t.text.content = 'Hello';
      const au = makeClip({ type: 'audio', track: 'A1', start: 0, duration: 6, name: 'voiceover.wav', mediaId: 'ma' });
      const v = makeClip({ type: 'video', track: 'V2', start: 0, duration: 5, name: 'clip.mp4', mediaId: 'mv' });
      const tiny = makeClip({ type: 'image', track: 'V1', start: 7, duration: 0.3, name: 'tiny.png', mediaId: 'mi' });
      state.clips = [im, t, au, v, tiny]; state.selection = im.id; state.inspTab = 'clip';
      renderBin(); renderTimeline(); renderInspector(); drawFrame();
      return { im: im.id, t: t.id, au: au.id, v: v.id, tiny: tiny.id };
    };
    window.SEL = id => { state.selection = id; state.selExtra = []; state.inspTab = 'clip'; renderInspector();
      document.querySelectorAll('#inspBody .accSec.collapsed').forEach(x => x.classList.remove('collapsed')); };
  });
  const ids = await E(() => DEMO());

  // 1. transport fits its column at every width, in a dark and a light theme
  const tp = [];
  await E(() => { const st = document.createElement('style'); st.id = 'noColAnim'; st.textContent = '#main{transition:none!important}'; document.head.appendChild(st); });   // measure the settled layout, not the column animation
  for (const th of ['obsidian', 'daylight']) for (const [w, h] of [[1600, 950], [1400, 900], [1280, 720], [1100, 700], [1000, 700]]) {
    await p.setViewport({ width: w, height: h }); await E(t => { THEME(t); renderTimeline(); }, th); await sleep(150);
    tp.push(await E((w, th) => {
      const R = id => document.getElementById(id).getBoundingClientRect(), t = document.getElementById('transport'), c = document.getElementById('center');
      const vis = [...t.children].filter(e => getComputedStyle(e).display !== 'none' && !e.classList.contains('spacer'));
      return { w, th, fits: t.scrollWidth <= t.clientWidth + 1 && c.scrollWidth <= c.clientWidth + 1,
        inside: vis.every(e => { const b = e.getBoundingClientRect(), r = t.getBoundingClientRect(); return b.left >= r.left - 1 && b.right <= r.right + 1; }),
        play: Math.round(R('playBtn').width), meter: R('meter').right <= R('inspector').left, tc: R('tcode').width > 80,
        dbg: { t: [t.scrollWidth, t.clientWidth], c: [c.scrollWidth, c.clientWidth], out: vis.filter(e => { const b = e.getBoundingClientRect(), r = t.getBoundingClientRect(); return b.left < r.left - 1 || b.right > r.right + 1; }).map(e => (e.id || e.className) + ':' + Math.round(e.getBoundingClientRect().left) + '-' + Math.round(e.getBoundingClientRect().right)), tr: [Math.round(t.getBoundingClientRect().left), Math.round(t.getBoundingClientRect().right)], all: vis.map(e => (e.id || e.className) + ':' + Math.round(e.getBoundingClientRect().width)).join(' '), insp: Math.round(R('inspector').width), gap: getComputedStyle(t).gap } };
    }, w, th));
  }
  const tpBad = tp.filter(r => !(r.fits && r.inside && r.play >= 38 && r.meter && r.tc));
  T('1 transport fits (no overflow, play 40px, meter clear of the inspector) at 1600/1400/1280/1100/1000 in obsidian + daylight', tpBad.length === 0);
  if (tpBad.length) R['ux: transport bad'] = tpBad; R['ux: tp1000'] = tp.filter(r => r.w === 1000).map(r => r.th + ' ' + r.dbg.all + ' insp ' + r.dbg.insp + ' gap ' + r.dbg.gap);
  // 1b. no width in between overflows either (a container-query boundary once let the meter spill 12px)
  const tpSweep = [];
  for (const th of ['obsidian', 'daylight']) { await E(t => THEME(t), th);
    for (let w = 980; w <= 1180; w += 5) { await p.setViewport({ width: w, height: 720 }); await sleep(60);
      const r = await E(() => { const t = document.getElementById('transport'), tb = t.getBoundingClientRect(), m = document.getElementById('meter').getBoundingClientRect();
        return t.scrollWidth <= t.clientWidth + 1 && m.right <= tb.right + 1 && m.right <= document.getElementById('inspector').getBoundingClientRect().left; });
      if (!r) tpSweep.push(th + '@' + w); } }
  T('1b transport never overflows at any width 980-1180 (5px steps, obsidian + daylight)', tpSweep.length === 0);
  if (tpSweep.length) R['ux: transport sweep bad'] = tpSweep;
  await p.setViewport({ width: 1000, height: 700 }); await E(() => THEME('daylight')); await sleep(120);
  await E(() => document.getElementById('noColAnim').remove());
  const hide = await E(() => ({   // (the loop above ended at 1000px)
      fps: getComputedStyle(document.getElementById('fpsTag')).display, total: getComputedStyle(document.querySelector('#tcode .total')).display }));
  T('1 at 1000px the fps tag and total time step aside', hide.fps === 'none' && hide.total === 'none');
  await p.setViewport({ width: 1600, height: 950 }); await sleep(150);
  T('1 at 1600px everything in the transport shows', await E(() => getComputedStyle(document.getElementById('fpsTag')).display !== 'none' && getComputedStyle(document.querySelector('#tcode .total')).display !== 'none'));

  // LAYOUT. timeline height follows the window
  await p.setViewport({ width: 1280, height: 720 }); await sleep(150);
  const h720 = await E(() => document.getElementById('bottom').getBoundingClientRect().height);
  await p.setViewport({ width: 1600, height: 950 }); await sleep(150);
  const h950 = await E(() => document.getElementById('bottom').getBoundingClientRect().height);
  T('LAYOUT timeline is clamp(200px,36vh,316px): 259px at 720 high, 316px at 950', Math.abs(h720 - 259.2) < 2 && Math.abs(h950 - 316) < 1);

  // 2. scope boxes stay dark and labeled in a light theme; the track chooser has its own classes
  const sc = await E(async () => { THEME('daylight'); if (!scopesOn) document.getElementById('scopesBtn').click(); await new Promise(r => setTimeout(r, 300));
    const box = document.querySelector('#scopes .sc-box'), lab = box.querySelector('.sc-lab'), bg = getComputedStyle(box).backgroundColor;
    const mode = document.querySelector('#scopes .sc-modes button:not(.on)');
    const out = { dark: LUM(bg) < 0.02, lab: CR(getComputedStyle(lab).color.replace(/,\s*[\d.]+\)$/, ')'), bg), modeBg: mode ? getComputedStyle(mode.parentElement).backgroundColor : '' };
    const sheets = [...document.styleSheets].flatMap(s => [...s.cssRules]).map(r => r.cssText);
    out.clash = sheets.some(t => /^\.sc-box\s*\{[^}]*var\(--panel\)/.test(t)); out.trk = sheets.some(t => /^\.trk-box/.test(t));
    document.getElementById('scopesBtn').click(); return out; });
  T('2 scopes keep a dark box in daylight; no .sc-box clash with the track chooser (now .trk-*)', sc.dark && !sc.clash && sc.trk && !/rgb\(2[45]\d, 2[45]\d, 2[45]\d\)/.test(sc.modeBg));
  T('2 scope label is readable on its box', sc.lab >= 3.2);
  T('2 import track chooser markup uses .trk-* classes', /back\.className='trk-back'/.test(SRC) && !/class="sc-(row|title|btns|note|file|static)/.test(SRC));

  // 3. curve editor and ramp graph draw in the theme's accent (read from body[data-theme])
  const acc = await E(async (ids) => {
    const find = (cv, rgb) => { const g = cv.getContext('2d'), d = g.getImageData(0, 0, cv.width, cv.height).data; let n = 0;
      for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - rgb[0]) < 30 && Math.abs(d[i + 1] - rgb[1]) < 30 && Math.abs(d[i + 2] - rgb[2]) < 30 && d[i + 3] > 200) n++; return n; };
    const out = {};
    for (const [th, rgb] of [['daylight', [37, 99, 235]], ['obsidian', [255, 180, 84]]]) {
      THEME(th); const c = state.clips.find(x => x.id === ids.im); c.kf = { scale: [{ t: 0, v: 1 }, { t: 1, v: 1.4 }, { t: 2, v: 1.1 }] };
      SEL(c.id); proCurvesOpen(c, 'scale'); await new Promise(r => setTimeout(r, 500));
      const cv = document.querySelector('#overlay canvas'); out['curve_' + th] = cv ? find(cv, rgb) : -1; closeOverlay(true); c.kf = {};
      const v = state.clips.find(x => x.id === ids.v); proRampApply(v, 'hero'); SEL(v.id); await new Promise(r => setTimeout(r, 300));
      const rg = document.getElementById('rampGraph'); out['ramp_' + th] = rg ? find(rg, rgb) : -1; proRampRemove(v);
    }
    out.ticks = proNiceTicks(0.92, 1.48, 100).map(v => Math.round(v * 1000) / 1000).join(',');
    THEME('obsidian'); return out; }, ids);
  T('3 curve editor draws in the theme accent (daylight + obsidian)', acc.curve_daylight > 20 && acc.curve_obsidian > 20);
  T('3 speed-ramp graph draws in the theme accent (daylight + obsidian)', acc.ramp_daylight > 20 && acc.ramp_obsidian > 20);
  T('20 curve editor Y ticks are round values', acc.ticks === '1,1.1,1.2,1.3,1.4');

  // 4. FX overlay picker is a styled select
  const ov = await E(() => { const k = Object.keys(OVERLAYS)[0]; const o = makeClip({ type: 'overlay', track: 'TX', start: 20, duration: 4, name: OVERLAYS[k].name, effect: k, ov: ovDefaults(k) });
    state.clips.push(o); renderTimeline(); SEL(o.id); const s = document.getElementById('ovEffect');
    const r = { tsel: s.classList.contains('tsel'), h4: [...document.querySelectorAll('#inspBody .accSec>h4')].map(h => h.firstChild.textContent.trim()), dot: document.querySelector('.insp-clipname .dot').style.background };
    state.clips = state.clips.filter(x => x !== o); renderTimeline(); return r; });
  T('4 FX overlay effect picker has the .tsel style', ov.tsel);
  T('16 overlay section is called "FX overlay" (the +FX button, palette and section agree)', ov.h4.includes('FX overlay') && /Add an FX overlay/.test(SRC) && /Add FX overlay \(rain/.test(SRC));
  T('17 inspector dot has a color for overlay clips', !!ov.dot);

  // 5 + 13. shortcuts: one list, truthful keys, ? opens the sheet
  const kb = await E(async () => {
    const out = { snapTip: /Shift\+N/.test(document.getElementById('snapBtn').title), snapSheet: SHORTCUTS.some(r => r[0] === 'Toggle snapping' && r[1] === 'Shift N'),
      snapPal: COMMANDS.some(c => c.n === 'Toggle snapping' && c.k === 'Shift N'), snapGuide: GUIDE.some(s => s.items.some(i => i.how.some(h => /Shift\+N turns snapping/.test(h)))) };
    closeOverlay(true); document.body.focus();
    dispatchEvent(new KeyboardEvent('keydown', { key: '?', shiftKey: true, bubbles: true }));
    await new Promise(r => setTimeout(r, 150));
    out.qSheet = /Keyboard shortcuts/.test(document.querySelector('#overlay h3')?.textContent || '');
    const rows = [...document.querySelectorAll('#overlay .kbd-row')];
    const row = l => rows.find(r => r.querySelector('.kbd-lab').textContent === l);
    const mv = row('Move selected together'); out.plain = mv && mv.querySelectorAll('kbd').length === 0 && /drag any selected clip/.test(mv.textContent);
    out.noC = !rows.some(r => /Captions/.test(r.textContent));
    out.ssr = !!row('Slip / Slide / Roll tool') && row('Slip / Slide / Roll tool').querySelectorAll('kbd').length === 3;
    const ur = row('Undo / redo'); out.undoOneLine = ur && ur.getBoundingClientRect().height < 34 && ur.querySelector('.kbd-keys').getBoundingClientRect().height < 26;
    out.rowsOneLine = rows.every(r => r.querySelector('.kbd-keys').getBoundingClientRect().height < 26);
    out.qRow = !!row('Keyboard shortcuts (this list)');
    closeOverlay(true);
    out.palQ = COMMANDS.find(c => c.k === '?')?.f === openShortcuts;
    out.kbdTip = /\(\?\)/.test(document.getElementById('kbdBtn').title) && !/Press \?/.test(document.getElementById('helpGuideBtn').title);
    openGuide(); await new Promise(r => setTimeout(r, 100));
    out.guideRows = document.querySelectorAll('#gdseckbd .gdkbdrow').length === SHORTCUTS.length; closeOverlay(true);
    return out; });
  T('5 snapping is Shift+N in the tooltip, shortcut sheet, palette and Guide', kb.snapTip && kb.snapSheet && kb.snapPal && kb.snapGuide);
  T('13 ? opens the shortcut sheet (its button tooltip, the palette and the sheet say so; the Guide button no longer claims ?)', kb.qSheet && kb.qRow && kb.palQ && kb.kbdTip);
  T('13 plain-text entries are not drawn as keys; no nonexistent "C" for captions; Slip/Slide/Roll listed', kb.plain && kb.noC && kb.ssr);
  T('13 every shortcut row keeps its keys on one line (incl. Undo / redo)', kb.undoOneLine && kb.rowsOneLine);
  T('13 the Guide\'s Shortcuts section is built from the same list', kb.guideRows);

  // 6. native controls follow the theme
  const cs = await E(() => { const o = {}; for (const t of THEMES.map(x => x[0])) { THEME(t); o[t] = getComputedStyle(document.body).colorScheme; } THEME('obsidian'); return o; });
  T('6 color-scheme is light for daylight/paper/runner/dorfic and dark for every other theme',
    Object.entries(cs).every(([t, v]) => v === (['daylight', 'paper', 'runner', 'dorfic'].includes(t) ? 'light' : 'dark')));

  // 11 + 12. --warn defined and readable; --faint text reaches ~4:1 in every theme
  const con = await E(() => { const o = {}; for (const t of THEMES.map(x => x[0])) { THEME(t);
      const f = VAR('--faint'), w = VAR('--warn'), bgs = ['--bg', '--panel', '--panel2'].map(n => VAR(n).replace('color', ''));
      o[t] = { faint: Math.min(...bgs.map(b => CR(f, b))), warn: w && w !== 'rgba(0, 0, 0, 0)' ? CR(w, VAR('--panel')) : 0 }; }
    THEME('obsidian'); return o; });
  T('12 --faint text is at least 4:1 on bg/panel/panel2 in every theme', Object.values(con).every(x => x.faint >= 4));
  T('11 --warn is defined in every theme and readable on its panel (>= 4:1)', Object.values(con).every(x => x.warn >= 4));
  if (!Object.values(con).every(x => x.faint >= 4 && x.warn >= 4)) R['ux: contrast'] = con;

  // 7. checkbox rows share one style
  const ck = await E((ids) => { SEL(ids.au); const a = document.getElementById('aNormalize').closest('label'), b = document.getElementById('preservePitch').closest('label');
    const A = getComputedStyle(a), B = getComputedStyle(b); return { same: A.fontSize === B.fontSize && A.color === B.color && A.display === 'flex' && B.display === 'flex', cls: a.className }; }, ids);
  T('7 "Normalize loudness" row is styled like the other checkbox rows', ck.same && /ckrow/.test(ck.cls));

  // 8 + 20. audio clip names sit on a backing pill; very short clips show no name
  const cl = await E((ids) => { const d = document.querySelector(`.clip[data-id="${ids.au}"] .cname`), t = document.querySelector(`.clip[data-id="${ids.tiny}"]`);
    const bg = getComputedStyle(d).backgroundColor; return { pill: bg !== 'rgba(0, 0, 0, 0)' && !/, 0\)$/.test(bg), tiny: t.classList.contains('tiny') && getComputedStyle(t.querySelector('.cbody')).display === 'none' }; }, ids);
  T('8 audio clip name has a backing pill over the waveform', cl.pill);
  T('20 a clip too short for its name shows none (not single letters)', cl.tiny);

  // 9. inspector rows: labels and values on one line; center buttons compact
  const ins = await E((ids) => { const res = {};
    const oneLine = el => el && el.scrollWidth <= el.clientWidth + 1 && el.getBoundingClientRect().height < 20;
    SEL(ids.t); const lab = [...document.querySelectorAll('#inspBody .ctl>label')].filter(l => /Letter spacing|Line spacing/.test(l.textContent));
    res.text = lab.length === 2 && lab.every(oneLine);
    SEL(ids.im); const cb = ['centerHBtn', 'centerVBtn', 'centerBothBtn'].map(i => document.getElementById(i));
    res.center = cb.every(b => b && b.scrollWidth <= b.clientWidth + 1 && b.getBoundingClientRect().height < 34);
    SEL(ids.v); const vals = [...document.querySelectorAll('#inspBody .ctl>.val')];
    res.vals = vals.length > 10 && vals.every(v => v.getBoundingClientRect().height < 20 && v.scrollWidth <= v.clientWidth + 1);
    const ev = vals.find(v => /EV/.test(v.textContent)); res.ev = !!ev;
    return res; }, ids);
  T('9 text inspector: Letter/Line spacing labels fit on one line', ins.text);
  T('9 Center buttons are compact single-line buttons', ins.center);
  T('9 values (incl. "0.00 EV") never wrap or clip', ins.vals && ins.ev);
  const viz = await E(() => { document.getElementById('addVizBtn').click(); const id = state.selection; SEL(id);
    const rows = [...document.querySelectorAll('#inspBody .ctl')].filter(r => /Bass reactivity|High cut/.test(r.textContent));
    const ok = rows.length === 2 && rows.every(r => { const l = r.querySelector('label'), v = r.querySelector('.val'); return l.scrollWidth <= l.clientWidth + 1 && v.scrollWidth <= v.clientWidth + 1 && r.getBoundingClientRect().height < 30; });
    const grp = [...document.querySelectorAll('#inspBody .vizgrp')].map(x => x.textContent.trim().toLowerCase()), accg = [...document.querySelectorAll('#inspBody .accGroup')].map(x => x.textContent.trim().toLowerCase());
    const dot = document.querySelector('.insp-clipname .dot').style.background;
    const c = state.clips.find(x => x.id === id); state.clips = state.clips.filter(x => x !== c); renderTimeline();
    return { ok, dupLayout: grp.some(g => accg.includes(g)), dot: !!dot }; });
  T('9 visualizer: "Bass reactivity" and "16.0 kHz" stay on one line', viz.ok);
  T('17 visualizer sub-heading no longer repeats a group name (LAYOUT)', !viz.dupLayout && viz.dot);

  // 10. track header name fits
  const th = await E(() => { const n = document.querySelector('#headsInner .thead[data-id="TX"] .tname'); return { fit: n.scrollWidth <= n.clientWidth + 1, name: n.textContent }; });
  T('10 the TITLES track header shows its whole name', th.fit && th.name === 'TITLES');

  // 16. terminology
  const term = await E((ids) => { SEL(ids.t); const out = {};
    out.lbl = [...document.querySelectorAll('#inspBody .field>label')].map(l => l.textContent);
    out.talign = [...document.querySelectorAll('#inspBody .alignChip')].map(x => x.textContent).join('/');
    document.getElementById('addMemeBtn').click(); const mid = state.selection; SEL(mid);
    out.malign = [...document.querySelectorAll('#inspBody .mmAlign')].map(x => x.textContent).join('/');
    out.memeTrack = !!document.getElementById('trackBtn');
    out.memeFirst = document.querySelector('#inspBody .accSec').dataset.sec;
    state.clips = state.clips.filter(x => x.id !== mid); renderTimeline();
    out.plusT = document.querySelector('.addtrk[data-k="text"]').title;
    return out; }, ids);
  T('16 text animation labels are distinct from transitions (Entrance/Exit animation)', term.lbl.includes('Entrance animation') && term.lbl.includes('Exit animation') && !term.lbl.includes('In time'));
  T('16 text and meme alignment use the same Left/Center/Right labels', term.talign === 'Left/Center/Right' && term.malign === 'Left/Center/Right');
  T('16 +T, the Captions dialog and the Guide all say "titles track"', /titles track/.test(term.plusT) && /Which titles track \(TITLES\)/.test(SRC) && /Pick a titles track/.test(SRC) && !/Add text track/.test(SRC));
  T('17 meme bars offer no Track motion; Timing is the first section for every clip type', !term.memeTrack && term.memeFirst === 'timing');

  // 17. inspector grouping
  const grp = await E((ids) => { SEL(ids.v); const secs = [...document.querySelectorAll('#inspBody > *')];
    const heads = [...document.querySelectorAll('#inspBody .accGroup, #inspBody .accSec>h4, #inspBody .gsub, #inspBody .vizgrp')].map(h => (h.firstChild ? h.firstChild.textContent : h.textContent).trim().toLowerCase());
    const groups = [...document.querySelectorAll('#inspBody .accGroup')].map(h => h.textContent.trim().toLowerCase());
    const h4 = [...document.querySelectorAll('#inspBody .accSec>h4')].map(h => h.firstChild.textContent.trim().toLowerCase());
    const subs = [...document.querySelectorAll('#inspBody .gsub')].map(h => h.textContent.trim().toLowerCase());
    return { dupGroup: groups.filter(g => h4.includes(g)), dupSub: subs.filter(g => h4.includes(g) || groups.includes(g)), chips: document.querySelectorAll('#inspBody .sc-chip').length,
      first: document.querySelector('#inspBody .accSec').dataset.sec, timingGroup: groups.some(g => /timing/.test(g)) }; }, ids);
  T('17 no group header repeats a section title (Audio/Audio, Stylize/Stylize)', grp.dupGroup.length === 0 && grp.dupSub.length === 0);
  T('17 one Scopes chip per inspector', grp.chips === 1);
  T('17 Timing sits at the top and no bottom group is called "Timing"', grp.first === 'timing' && !grp.timingGroup);

  // 18. one secondary-button style; dialog actions on the right
  const btn = await E(async (ids) => { SEL(ids.v); const out = {};
    out.bordered = ['trackBtn', 'stabBtn'].map(i => document.getElementById(i)).concat([...document.querySelectorAll('#inspBody [data-flip]')])
      .every(b => { const c = getComputedStyle(b).borderTopColor; return b && c !== 'rgba(0, 0, 0, 0)' && !/, 0\)$/.test(c); });
    SEL(ids.au); audioGainDialog(); await new Promise(r => setTimeout(r, 300));
    const foot = document.querySelector('#overlay .modal-foot').getBoundingClientRect(), ap = document.getElementById('agGo').getBoundingClientRect();
    out.right = foot.right - ap.right < 40;
    const np = document.querySelector('#agMode [data-agm="norm"]'); out.np = np.getBoundingClientRect().height < 34 && np.scrollWidth <= np.clientWidth + 1;
    const cancel = document.getElementById('agCancel'); out.cancelBorder = getComputedStyle(cancel).borderTopColor !== 'rgba(0, 0, 0, 0)';
    closeOverlay(true);
    showCtx(100, 100, [{ label: 'A', fn: () => { } }, { label: 'B', kbd: 'Ctrl A', fn: () => { } }]); await new Promise(r => setTimeout(r, 250));
    const it = [...document.querySelectorAll('#ctxMenu .mitem')].map(x => Math.round(x.getBoundingClientRect().height)); out.menuSame = it.length === 2 && it[0] === it[1];
    hideCtx();
    openPalette(); await new Promise(r => setTimeout(r, 150));
    const ph = [...document.querySelectorAll('#overlay .pal-item')].slice(0, 12).map(x => Math.round(x.getBoundingClientRect().height));
    out.palSame = ph.length > 5 && ph.every(h => h === ph[0]); closeOverlay(true);
    return out; }, ids);
  T('18 text-link buttons in the inspector (Track motion, Stabilize, Flip) are bordered secondary buttons', btn.bordered);
  T('18 Audio gain: Cancel/Apply on the right, bordered Cancel, "Normalize peak" on one line', btn.right && btn.np && btn.cancelBorder);
  T('18 menu and palette rows are the same height with or without a shortcut', btn.menuSame && btn.palSame);

  // 19. snapshot preview never shows a broken image
  const ss = await E(async () => { snapshotDialog(); const i = document.getElementById('ssImg'), w = document.getElementById('ssWait');
    const early = { alt: i.getAttribute('alt'), hidden: getComputedStyle(i).display === 'none', wait: !!w && getComputedStyle(w).display !== 'none' };
    const t0 = performance.now(); for (let k = 0; k < 200 && !(i.naturalWidth > 0 && getComputedStyle(i).display !== 'none'); k++) await new Promise(r => setTimeout(r, 100)); early.ms = Math.round(performance.now() - t0); early.src = (i.src || '').slice(0, 12); early.nw = i.naturalWidth;
    early.shown = getComputedStyle(i).display !== 'none' && i.naturalWidth > 0 && getComputedStyle(w).display === 'none';
    closeOverlay(true); return early; });
  T('19 snapshot preview: alt="" and a "Rendering…" placeholder until the image is ready', ss.alt === '' && ss.hidden && ss.wait && ss.shown);
  if (!(ss.alt === '' && ss.hidden && ss.wait && ss.shown)) R['ux: ss'] = ss;

  // 20. wording
  T('20 American spelling / "99%" in UI text', !/Export cancelled|greyed out|Labelling speakers|speakers are labelled|labelled 99|99 %|'Cancelling|modelled on|Grey “/.test(SRC));
  T('20 FFmpeg hints do not point to a README', !/desktop README/.test(SRC));
  T('20 "Split here" no longer claims the B key', /\{label:'Split here',tip:/.test(SRC) && !/label:'Split here',kbd:'B'/.test(SRC));

  T('no page errors', app.errors.length === 0);
  if (app.errors.length) R['ux: errors'] = app.errors.slice(0, 5);
}]);

/* ========================= section: xfade =========================
 * Same-track In transitions between two VIDEO clips cross from the outgoing
 * clip continuing past its out point (its own hidden decoder), not from black.
 * ramp25.webm: 25 fps, frame k is a flat gray of level ≈ 20+2k, so the level
 * says exactly which source frame is showing. */
SECTIONS.push(['xfade', async (app) => {
  const p = app.page, E = (f, ...a) => p.evaluate(f, ...a), T = (k, ok) => check('xfade: ' + k, ok);
  const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
  const FF = path.join(__dirname, '..', 'desktop', 'bin', 'ffmpeg' + (process.platform === 'win32' ? '.exe' : ''));
  const dir = path.join(__dirname, 'out', 'xfade'); fs.mkdirSync(dir, { recursive: true });
  const blue = path.join(dir, 'blue.webm');
  execFileSync(FF, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x2050d0:s=64x36:r=25:d=4', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', '-b:v', '200k', blue]);
  const b64 = f => fs.readFileSync(f).toString('base64');
  await p.setViewport({ width: 1400, height: 900 });
  const setup = await E(async (ramp, blu) => {
    const mk = async (id, b) => { const url = URL.createObjectURL(new Blob([Uint8Array.from(atob(b), c => c.charCodeAt(0))], { type: 'video/webm' }));
      const el = await loadMediaEl('video', url); els[id] = el; _wireSeekRedraw(el);
      const m = { id, type: 'video', name: id, url, duration: el.duration, w: 64, h: 36, srcFps: 25 }; state.media.push(m); return m; };
    state.media = []; await mk('r', ramp); await mk('bl', blu);
    state.project.fps = 30; state.playing = false;
    const S = _pbSampler('r'), tmp = document.createElement('canvas'), lev = [];
    const g = cvs => cvs.getContext('2d').getImageData(Math.floor(cvs.width / 2), Math.floor(cvs.height / 2), 1, 1).data[1];
    for (let k = 0; k < 100; k++) { await _pbGrab(S, (k + 0.5) / 25, tmp); lev.push(g(tmp)); }
    const S2 = _pbSampler('bl'); await _pbGrab(S2, 1.5, tmp); const blueG = g(tmp);
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    window.XF = {
      lev, blueG, sleep,
      L: s => lev[Math.max(0, Math.min(99, Math.floor(s * 25 + 1e-6)))],
      px: (fx = 0.5) => { const c = document.getElementById('preview'); return c.getContext('2d').getImageData(Math.floor(c.width * fx), Math.floor(c.height / 2), 1, 1).data[1]; },
      set: (clips) => { for (const id of [..._xfUse.keys()]) _xfRelease(id); state.clips = clips.map(o => { const c = makeClip(Object.assign({ type: 'video', track: 'V1' }, o, { props: Object.assign(defaultProps(), o.props || {}) })); return c; });
        state.selection = null; state.selExtra = []; renderTimeline(); },
      idle: async () => { for (let i = 0; i < 100 && [...Object.values(els), ..._xfUse.values()].some(v => v.seeking); i++) await sleep(20); await sleep(150); },   // a seek the preview loop started must be presented before the next frame
      // paused preview, driven the way the UI drives it (scrub → syncMediaSeek; redraws → syncMediaPlayback)
      paused: async (t, fx) => { state.playing = false; state.exporting = false; setTime(t);
        for (let i = 0; i < 60; i++) { syncMediaPlayback(); await sleep(40); const all = [...Object.values(els), ..._xfUse.values()]; if (i > 2 && all.every(v => !v.seeking && v.readyState >= 2)) break; }
        await sleep(80); drawFrame(); return XF.px(fx); },
      // one frame of the Precise engine: exactly what renderPrecise does per frame
      precise: async (t, fx) => { await XF.idle(); state.exporting = true; state.time = t; try { await seekMediaExact(t); drawFrame(); return XF.px(fx); } finally { state.exporting = false; } },
    };
    return { lev: lev.slice(0, 5), blueG, steps: lev.slice(1).every((v, i) => v >= lev[i]) && lev[99] - lev[0] > 150 };
  }, b64(path.join(__dirname, 'fixtures', 'blend', 'ramp25.webm')), b64(blue));
  T('fixtures decode (ramp levels rise, blue measured)', setup.steps && setup.blueG > 40 && setup.blueG < 120);

  // 1. same media split in two: A = src 0..1.5, B = src 2..4 with a 1 s Dissolve In
  const same = await E(async () => {
    XF.set([{ id: 'A', mediaId: 'r', start: 0, duration: 1.5, inPoint: 0 }, { id: 'B', mediaId: 'r', start: 1.5, duration: 2, inPoint: 2, props: { transIn: 'dissolve', transInDur: 1 } }]);
    const t = 2.02, e = 0.52, want = (1 - e) * XF.L(2.02) + e * XF.L(2.52), black = e * XF.L(2.52);
    const out = { want, black };
    out.paused = await XF.paused(t);
    out.tail = _xfUse.has('A') && Math.abs(_xfUse.get('A').currentTime - 2.02) < 0.02 && els.r.currentTime > 2.4;
    for (const id of [..._xfUse.keys()]) _xfRelease(id); for (const u in _xfPool) delete _xfPool[u];   // cold start for the export
    out.precise = await XF.precise(t);
    out.precise2 = await XF.precise(1.83); out.want2 = (1 - 0.33) * XF.L(1.83) + 0.33 * XF.L(2.33);
    out.before = await XF.precise(1.2); out.wantBefore = XF.L(1.2);                   // A itself, untouched
    out.after = await XF.precise(2.8); out.wantAfter = XF.L(3.3);                     // transition over: B alone
    out.pairs = _xfPairs(2.02, 0).map(q => q.a.id + '>' + q.b.id).join();
    return out;
  });
  const near = (a, b, tol = 4) => typeof a === 'number' && Math.abs(a - b) <= tol;
  T('1 paused preview mid-Dissolve mixes A continued past its out point with B (not black)', near(same.paused, same.want) && Math.abs(same.paused - same.black) > 30 && same.tail);
  T('1 Precise export frame (cold decoder) is the same mix', near(same.precise, same.want) && near(same.precise2, same.want2));
  T('1 outside the transition nothing changes', near(same.before, same.wantBefore) && near(same.after, same.wantAfter) && same.pairs === 'A>B');

  // 2. different media: A = ramp, B = blue
  const diff = await E(async () => {
    XF.set([{ id: 'A', mediaId: 'r', start: 0, duration: 1.5, inPoint: 0.4 }, { id: 'B', mediaId: 'bl', start: 1.5, duration: 2, inPoint: 0, props: { transIn: 'dissolve', transInDur: 1 } }]);
    const e = 0.52, want = (1 - e) * XF.L(0.4 + 2.02) + e * XF.blueG;
    return { want, black: e * XF.blueG, paused: await XF.paused(2.02), precise: await XF.precise(2.02) };
  });
  T('2 different media: paused preview and Precise frame cross from A continued', near(diff.paused, diff.want) && near(diff.precise, diff.want) && Math.abs(diff.paused - diff.black) > 30);

  // 3. source runs out → last frame held; reverse continues backward; speed continues at speed; wipe shows both sides
  const more = await E(async () => {
    const out = {};
    XF.set([{ id: 'A', mediaId: 'r', start: 0, duration: 1.4, inPoint: 2.5 }, { id: 'B', mediaId: 'r', start: 1.4, duration: 2, inPoint: 0, props: { transIn: 'dissolve', transInDur: 1 } }]);
    out.runout = await XF.precise(1.9); out.wantRunout = 0.5 * XF.lev[99] + 0.5 * XF.L(0.5);
    out.runoutP = await XF.paused(1.9);
    XF.set([{ id: 'A', mediaId: 'r', start: 0, duration: 1.5, inPoint: 1, props: { reverse: true } }, { id: 'B', mediaId: 'r', start: 1.5, duration: 2, inPoint: 2, props: { transIn: 'dissolve', transInDur: 1 } }]);
    out.rev = await XF.precise(2.02); out.wantRev = 0.48 * XF.L(1 - 0.52) + 0.52 * XF.L(2.52);
    XF.set([{ id: 'A', mediaId: 'r', start: 0, duration: 0.75, inPoint: 0, props: { speed: 2 } }, { id: 'B', mediaId: 'r', start: 0.75, duration: 2, inPoint: 3, props: { transIn: 'dissolve', transInDur: 1 } }]);
    out.fast = await XF.precise(1.27); out.wantFast = 0.48 * XF.L(1.5 + 2 * 0.52) + 0.52 * XF.L(3.52);
    XF.set([{ id: 'A', mediaId: 'r', start: 0, duration: 1.5, inPoint: 0 }, { id: 'B', mediaId: 'bl', start: 1.5, duration: 2, inPoint: 0, props: { transIn: 'wipeL', transInDur: 1 } }]);
    out.wipeA = await XF.precise(2.02, 0.2); out.wipeB = await XF.precise(2.02, 0.8); out.wantWipeA = XF.L(2.02);
    return out;
  });
  T('3 the source running out holds A\'s last frame', near(more.runout, more.wantRunout) && near(more.runoutP, more.wantRunout));
  T('3 a reversed A keeps running backward', near(more.rev, more.wantRev));
  T('3 a 2x A keeps running at 2x', near(more.fast, more.wantFast));
  T('3 a wipe shows A continued on one side and B on the other', near(more.wipeA, more.wantWipeA) && near(more.wipeB, setup.blueG));

  // 4. compound clip holding the split pair; the full-quality span covers the handle
  const cmp = await E(async () => {
    XF.set([{ id: 'A', mediaId: 'r', start: 0, duration: 1.5, inPoint: 0 }, { id: 'B', mediaId: 'r', start: 1.5, duration: 2, inPoint: 2, props: { transIn: 'dissolve', transInDur: 1 } }]);
    state.selection = 'A'; state.selExtra = ['B']; const c = proMakeCompound();
    const want = 0.48 * XF.L(2.02) + 0.52 * XF.L(2.52);
    const out = { one: state.clips.length === 1 && !!c && c.type === 'compound', want, pairs: _xfPairs(2.02, 0).length };
    out.px = await XF.precise(2.02);
    XF.set([{ id: 'A', mediaId: 'r', start: 0, duration: 1.5, inPoint: 0 }, { id: 'B', mediaId: 'r', start: 1.5, duration: 1, inPoint: 0.2, props: { transIn: 'dissolve', transInDur: 1 } }]);
    const m = state.media.find(x => x.id === 'r'); out.span = _hqUsedSpan(m);
    // a clip on ANOTHER track ending at B's start is not continued (V2 over V1)
    XF.set([{ id: 'A', mediaId: 'r', track: 'V2', start: 0, duration: 1.5, inPoint: 0 }, { id: 'B', mediaId: 'r', start: 1.5, duration: 2, inPoint: 2, props: { transIn: 'dissolve', transInDur: 1 } }]);
    out.otherTrack = _xfPairs(2.02, 0).length === 0 && (await XF.precise(2.02)) < 0.52 * XF.L(2.52) + 4;
    return out;
  });
  T('4 inside a compound clip the crossfade is the same', cmp.one && cmp.pairs === 1 && near(cmp.px, cmp.want));
  T('4 full-quality export span includes the transition handle', cmp.span && Math.abs(cmp.span.duration - 6.5) < 1e-6);
  T('4 a clip on another track is not paired', cmp.otherTrack);

  // 5. playback: the second decoder runs in step and shows the mix; released afterwards
  const play = await E(async () => {
    XF.set([{ id: 'A', mediaId: 'r', start: 0, duration: 1.5, inPoint: 0 }, { id: 'B', mediaId: 'r', start: 1.5, duration: 2, inPoint: 2, props: { transIn: 'dissolve', transInDur: 1 } }]);
    await XF.paused(1.0);
    // record what each drawn frame shows, with the decoders' positions at that draw
    const samples = [], draw0 = window.drawFrame;
    window.drawFrame = function () { draw0(); const t = state.time; if (!state.playing || t < 1.6 || t > 2.42) return;
      const v = _xfUse.get('A'), e = t - 1.5, B = XF.L(els.r.currentTime);
      samples.push({ t: +t.toFixed(3), px: XF.px(), cur: v ? +v.currentTime.toFixed(3) : null, bcur: +els.r.currentTime.toFixed(3), playing: v ? !v.paused : false, seeking: !!(v && v.seeking) || els.r.seeking,
        want: v ? (1 - e) * XF.L(v.currentTime) + e * B : null, black: e * B }); };
    const t0 = performance.now(); setPlaying(true); state.rate = 0.5;   // half speed: enough drawn frames inside the 1 s transition on a slow machine
    try { while (state.playing && state.time < 2.9 && performance.now() - t0 < 12000) await XF.sleep(30); }
    finally { window.drawFrame = draw0; }
    setPlaying(false); state.rate = 1; await XF.sleep(50);
    return { samples, released: _xfUse.size === 0 };
  });
  const S = play.samples.filter(s => s.cur != null && !s.seeking);   // a decoder mid-resync shows its previous frame: its currentTime says nothing about the picture
  // A continues at src = t; B's own decoder should be at 2 + (t − 1.5): the continued one keeps up as well as the main one does
  const drift = Math.max(...S.map(s => Math.abs(s.cur - s.t))), bdrift = Math.max(...S.map(s => Math.abs(s.bcur - (s.t + 0.5))));
  const good = S.filter(s => Math.abs(s.px - s.want) <= 12 && s.px - s.black > 20).length;
  R['xfade: play drift'] = { continued: +drift.toFixed(3), main: +bdrift.toFixed(3), frames: S.length, good };
  T('5 playback: the continued decoder plays in step (drift < 0.25 s or no worse than the main decoder)', S.length >= 3 && drift < Math.max(0.25, bdrift + 0.1) && S.some(s => s.playing));
  T('5 playback: frames mid-transition are the mix, not a dip to black', S.length >= 3 && good >= S.length * 0.7);
  T('5 playback: decoder released after the transition', play.released);
  if (fails.some(f => f.startsWith('xfade: 5'))) R['xfade: play samples'] = play.samples.slice(0, 12);

  // 6. inspector hint describes the new behavior
  const hint = await E(() => { state.clips = [makeClip({ id: 'Q', type: 'video', mediaId: 'r', track: 'V1', start: 0, duration: 2 })]; state.selection = 'Q'; state.inspTab = 'clip'; renderInspector();
    const t = document.getElementById('inspBody').textContent; return /keeps playing past its end/.test(t) && !/otherwise it plays from black/.test(t) && !/use fades on overlapping clips/.test(document.getElementById('tlEmpty').textContent); });
  T('6 the Transitions hint and empty-timeline hint describe same-track crossfades', hint);

  // 7. (v4.10.2) the SAME file continuing under transitions on TWO tracks at the same instant: each continued
  //    clip gets its own hidden decoder (V2 is scaled to the middle, so the edge shows V1 and the center V2);
  //    idle decoders are reused, not piled up, and all are released once the transitions are over
  const two = await E(async () => {
    const V2 = { scale: 0.5 };
    XF.set([{ id: 'A1', mediaId: 'r', start: 0, duration: 1.5, inPoint: 0 }, { id: 'B1', mediaId: 'r', start: 1.5, duration: 2, inPoint: 2, props: { transIn: 'dissolve', transInDur: 1 } },
      { id: 'A2', mediaId: 'r', track: 'V2', start: 0, duration: 1.5, inPoint: 1.5, props: V2 }, { id: 'B2', mediaId: 'bl', track: 'V2', start: 1.5, duration: 2, inPoint: 0.2, props: Object.assign({ transIn: 'dissolve', transInDur: 1 }, V2) }]);
    const e = 0.52, w1 = (1 - e) * XF.L(2.02) + e * XF.L(2.52), w2 = (1 - e) * XF.L(3.52) + e * XF.blueG;   // (B2 is another file: two clips of one file on two tracks share its main decoder — not what this checks)
    const out = { w1, w2 };
    for (const id of [..._xfUse.keys()]) _xfRelease(id); for (const u in _xfPool) delete _xfPool[u];
    out.p1 = await XF.precise(2.02, 0.1); out.p2 = await XF.precise(2.02, 0.5);
    out.q1 = await XF.paused(2.02, 0.1); out.q2 = XF.px(0.5);
    const a1 = _xfUse.get('A1'), a2 = _xfUse.get('A2');
    out.distinct = !!a1 && !!a2 && a1 !== a2; out.cur = [a1 && +a1.currentTime.toFixed(3), a2 && +a2.currentTime.toFixed(3)];
    const count = () => _xfUse.size + Object.values(_xfPool).reduce((n, l) => n + l.length, 0);
    const seen = new Set([a1, a2]);
    for (const t of [1.9, 2.2, 1.0, 2.1, 0.5, 2.3]) { await XF.precise(t); await XF.paused(t); for (const v of _xfUse.values()) seen.add(v); }
    out.maxEls = seen.size; out.total = count();
    await XF.paused(1.0); out.released = _xfUse.size === 0; out.idle = count();
    return out;
  });
  R['xfade: two tracks'] = two;
  T('7 same file under transitions on two tracks at once: each shows its own continued picture (Precise + paused)', near(two.p1, two.w1) && near(two.p2, two.w2) && near(two.q1, two.w1) && near(two.q2, two.w2));
  T('7 two separate hidden decoders at the right source times', two.distinct && Math.abs(two.cur[0] - 2.02) < 0.02 && Math.abs(two.cur[1] - 3.52) < 0.02);
  T('7 decoders are reused (never more than two) and released after the transitions', two.maxEls === 2 && two.total <= 2 && two.released && two.idle <= 2);

  R['xfade: values'] = { same, diff, more, cmp: { px: cmp.px, want: cmp.want, span: cmp.span } };
  T('no page errors', app.errors.length === 0);
  if (app.errors.length) R['xfade: errors'] = app.errors.slice(0, 5);
}]);

/* ========================= section: chroma =========================
 * clipSourceMap: the canvas <-> source mapping behind the chroma-key "Pick from
 * frame" and motion tracking inverts the WHOLE draw chain (position, rotation,
 * scale, motion, stabilization, flip, crop, corner pin, proxy-size element).
 * Ground truth is the pixel actually drawn on the preview under the click. */
SECTIONS.push(['chroma', async (app) => {
  const p = app.page, E = (f, ...a) => p.evaluate(f, ...a), T = (k, ok) => check('chroma: ' + k, ok);
  const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
  await p.setViewport({ width: 1600, height: 1000 });
  await E(() => {
    // 6×4 grid of distinct colors (quadrants and more): cell (i,j) = (20+40i, 20+60j, 40|200)
    window.GRID = (g, w, h) => { for (let i = 0; i < 6; i++) for (let j = 0; j < 4; j++) { g.fillStyle = `rgb(${20 + 40 * i},${20 + 60 * j},${(i + j) % 2 ? 200 : 40})`; g.fillRect(Math.round(i * w / 6), Math.round(j * h / 4), Math.ceil(w / 6), Math.ceil(h / 4)); } };
    window.MK = (id, w, h, draw) => { state.media = state.media.filter(m => m.id !== id); const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h); state.media.push({ id, type: 'image', name: id, duration: 10, w, h, el: c }); return c; };
    window.CV = () => document.getElementById('preview');
    window.PXA = (x, y, r = 0) => { const d = CV().getContext('2d').getImageData(Math.round(x) - r, Math.round(y) - r, 2 * r + 1, 2 * r + 1).data; const o = []; for (let i = 0; i < d.length; i += 4) o.push([d[i], d[i + 1], d[i + 2]]); return o; };
    window.SET = (clips, sel) => { state.clips = clips; state.selection = sel ? sel.id : null; state.history = []; state.hIndex = -1; pushHistory(); renderTimeline(); renderInspector(); };
    state.project.w = 1920; state.project.h = 1080; syncProjectInputs(); state.project.bg = '#000000';
    // canvas points well inside one grid cell (in source pixels) whose drawn 9×9 neighborhood is flat
    window.POINTS = (c, t, cw, ch, want = 10) => { const map = clipSourceMap(c, t), W = CV().width, H = CV().height, out = [];
      for (let Y = 30; Y < H - 30; Y += 41) for (let X = 30; X < W - 30; X += 43) { const s = map.toSource(X, Y);
        if (!s.inside || s.u < 0.04 || s.u > 0.96 || s.v < 0.04 || s.v > 0.96) continue;
        const fx = s.x / cw - Math.floor(s.x / cw), fy = s.y / ch - Math.floor(s.y / ch); if (fx < 0.3 || fx > 0.7 || fy < 0.3 || fy > 0.7) continue;
        const n = PXA(X, Y, 4), c0 = n[40]; if (n.some(q => Math.abs(q[0] - c0[0]) + Math.abs(q[1] - c0[1]) + Math.abs(q[2] - c0[2]) > 6)) continue;
        out.push({ X, Y, drawn: c0, cell: [Math.floor(s.x / cw), Math.floor(s.y / ch)] }); }
      // spread: every k-th, and make sure several different cells are covered
      const k = Math.max(1, Math.floor(out.length / want)); return out.filter((_, i) => i % k === 0).slice(0, want); };
    window.HEX = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  });
  // click the preview at canvas point (X,Y) with the real mouse, in pick mode
  const pick = async (id, X, Y) => {
    const r = await E((id, X, Y) => { const c = state.clips.find(q => q.id === id); c.props.chromaColor = '#123456'; startChromaPick(c);
      const b = CV().getBoundingClientRect(); return { x: b.left + X / CV().width * b.width, y: b.top + Y / CV().height * b.height }; }, id, X, Y);
    await p.mouse.click(r.x, r.y); await sleep(20);
    return E(id => { const c = state.clips.find(q => q.id === id); return { hex: c.props.chromaColor, still: !!chromaPicking }; }, id);
  };
  const close = (a, b, e = 8) => a && b && a.every((v, i) => Math.abs(v - b[i]) <= e);

  // 1. image: rotation + flip + scale + crop + motion + stabilization + corner pin
  const setupImg = () => E(() => { MK('q', 960, 640, GRID);
    const c = makeClip({ id: 'CQ', type: 'image', track: 'V1', start: 0, duration: 6, mediaId: 'q' });
    Object.assign(c.props, { rotation: 17, flipH: true, scale: 0.72, x: 6, y: -4, cropL: 0.08, cropT: 0.05, motion: 'kenBurns',
      cornerPin: 1, cpTLx: 8, cpTLy: 5, cpTRx: -6, cpTRy: 10, cpBRx: -4, cpBRy: -7, cpBLx: 10, cpBLy: -3, stabMode: 'none', stabZoom: 1.15 });
    const n = 180; c.stab = { fps: 30, n, dx: [...Array(n)].map((_, i) => i * 0.0008), dy: [...Array(n)].map((_, i) => -i * 0.0006), rot: [...Array(n)].map((_, i) => i * 0.002), sc: [...Array(n)].map((_, i) => 1 + i * 0.001) };
    SET([c], c); setTime(2); drawFrame();
    const cr = _stabCorrection(c, 2); return { stab: cr && Math.abs(cr.dx) > 0.01 && Math.abs(cr.rot) > 0.05, pin: cornerPinOn(c.props) }; });
  const img = await setupImg();
  T('1 setup: stabilization and corner pin are active', img.stab && img.pin);
  const pts = await E(() => POINTS(state.clips[0], 2, 160, 160));
  const res1 = [];
  for (const q of pts) { const r = await pick('CQ', q.X, q.Y); res1.push({ q, r }); await E(() => { setTime(2); drawFrame(); }); }
  const cells1 = new Set(pts.map(q => q.cell.join())).size;
  const bad1 = res1.filter(({ q, r }) => !close(HEXJ(r.hex), q.drawn));
  function HEXJ(h) { return h && /^#[0-9a-f]{6}$/i.test(h) ? [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)) : null; }
  R['chroma: image picks'] = { points: pts.length, cells: cells1, bad: bad1.slice(0, 4).map(({ q, r }) => ({ X: q.X, Y: q.Y, drawn: q.drawn, picked: r.hex })) };
  T('1 enough test points over several grid cells', pts.length >= 6 && cells1 >= 4);
  T('1 pick = the color drawn under the click (corner pin, rotation, flip, motion, stabilization, crop)', bad1.length === 0);
  T('1 pick mode ends after a successful pick', res1.every(({ r }) => !r.still));

  // 2. the mapping itself: round trip, and source cell centers land on their own color
  const mp = await E(() => { const c = state.clips[0]; setTime(2); drawFrame(); const map = clipSourceMap(c, 2); let err = 0, hits = 0, tot = 0;
    for (let i = 0; i < 6; i++) for (let j = 0; j < 4; j++) { const sx = (i + 0.5) * 160, sy = (j + 0.5) * 160; if (sx < 960 * 0.08 + 20 || sy < 640 * 0.05 + 20) continue;
      const k = map.toCanvas(sx, sy), b = map.toSource(k.X, k.Y); err = Math.max(err, Math.hypot(b.x - sx, b.y - sy));
      if (k.X < 5 || k.Y < 5 || k.X > 1915 || k.Y > 1075) continue; tot++;
      const d = PXA(k.X, k.Y)[0], want = [20 + 40 * i, 20 + 60 * j, (i + j) % 2 ? 200 : 40]; if (d.every((v, n) => Math.abs(v - want[n]) <= 6)) hits++; }
    const out = map.toSource(3, 3).inside;   // the top-left corner of the frame is outside this warped, shrunk picture
    return { err, hits, tot, out }; });
  T('2 toSource(toCanvas(p)) = p', mp.err < 1e-6);
  T('2 every source cell center is drawn where toCanvas says', mp.tot >= 10 && mp.hits === mp.tot);
  T('2 a point outside the picture is reported outside', mp.out === false);
  const miss = await pick('CQ', 3, 3);
  T('2 a click outside the picture keeps pick mode and the old color', miss.hex === '#123456' && miss.still);
  await E(() => { chromaPicking = null; });

  // 3. playhead outside the clip: no pick
  const off = await E(() => { const c = state.clips[0]; c.start = 3; setTime(1); drawFrame(); return true; });
  const offR = await pick('CQ', 960, 540);
  T('3 no sample when the playhead is outside the clip', off && offR.hex === '#123456');
  await E(() => { chromaPicking = null; state.clips[0].start = 0; });

  // 4. video whose element is SMALLER than its media size (a proxy): kx/ky, source-time stabilization.
  //    A 12×8 grid (cells 32 media px) so a mapping off by a fraction of a cell shows.
  const FF = path.join(__dirname, '..', 'desktop', 'bin', 'ffmpeg' + (process.platform === 'win32' ? '.exe' : ''));
  const dir = path.join(__dirname, 'out', 'chroma'); fs.mkdirSync(dir, { recursive: true });
  const vid = path.join(dir, 'grid.webm');
  execFileSync(FF, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=192x128:r=25:d=3', '-vf',
    "format=gbrp,geq=r='20+20*floor(12*X/W)':g='20+30*floor(8*Y/H)':b='40+160*mod(floor(12*X/W)+floor(8*Y/H)+1,2)',format=yuv420p",
    '-c:v', 'libvpx-vp9', '-b:v', '2M', '-pix_fmt', 'yuv420p', vid]);
  const vr = await E(async b64 => {
    const url = URL.createObjectURL(new Blob([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], { type: 'video/webm' }));
    const el = await loadMediaEl('video', url); els.gv = el; _wireSeekRedraw(el);
    state.media = state.media.filter(m => m.id !== 'gv'); state.media.push({ id: 'gv', type: 'video', name: 'gv', url, duration: el.duration, w: 384, h: 256, srcFps: 25 });   // the element is half the media size
    const c = makeClip({ id: 'CV', type: 'video', track: 'V1', start: 0, duration: 2.5, mediaId: 'gv', inPoint: 0.4 });
    Object.assign(c.props, { rotation: -23, flipV: true, scale: 0.9, x: -5, y: 3, cropR: 0.1, cropB: 0.07, stabMode: 'none', stabZoom: 1.2,
      cornerPin: 1, cpTLx: -5, cpTLy: 8, cpTRx: 7, cpTRy: -4, cpBRx: 5, cpBRy: 6, cpBLx: -8, cpBLy: -6 });
    const n = 75; c.stab = { fps: 25, n, dx: [...Array(n)].map((_, i) => -i * 0.0007), dy: [...Array(n)].map((_, i) => i * 0.0005), rot: [...Array(n)].map((_, i) => -i * 0.0025), sc: [...Array(n)].map(() => 1), st: [...Array(n)].map((_, i) => i / 25) };
    SET([c], c); state.playing = false; setTime(1.5);
    for (let i = 0; i < 60; i++) { syncMediaPlayback(); await new Promise(r => setTimeout(r, 40)); if (i > 2 && !el.seeking && el.readyState >= 2) break; }
    await new Promise(r => setTimeout(r, 80)); drawFrame();
    const cr = _stabCorrection(c, 1.5);
    return { vw: el.videoWidth, cur: el.currentTime, want: srcTimeFor(c, 1.5), rot: cr && cr.rot, fr: (() => { const f = clipSourceFrame(c, 1.5); return f && [f.kx, f.ky]; })() };
  }, fs.readFileSync(vid).toString('base64'));
  T('4 setup: element at half the media size, seeked to the clip’s source time, stabilized', vr.vw === 192 && Math.abs(vr.cur - vr.want) < 0.05 && Math.abs(vr.rot) > 0.05 && vr.fr && vr.fr[0] === 0.5 && vr.fr[1] === 0.5);
  const pts4 = await E(() => POINTS(state.clips[0], 1.5, 32, 32));
  const res4 = [];
  for (const q of pts4) { const r = await pick('CV', q.X, q.Y); res4.push({ q, r }); await E(() => drawFrame()); }
  const bad4 = res4.filter(({ q, r }) => !close(HEXJ(r.hex), q.drawn, 12));
  R['chroma: video picks'] = { points: pts4.length, cells: new Set(pts4.map(q => q.cell.join())).size, bad: bad4.slice(0, 4).map(({ q, r }) => ({ X: q.X, Y: q.Y, drawn: q.drawn, picked: r.hex })) };
  T('4 video (proxy-sized element) pick = the color drawn under the click', pts4.length >= 6 && bad4.length === 0);

  // 5. motion tracking follows the footage AS DRAWN: keyframed position + stabilization
  const tk = await E(async () => { state.project.fps = 25;
    const el = document.createElement('canvas'); el.width = 320; el.height = 180; let ct = 0;
    const paint = () => { const g = el.getContext('2d'); g.fillStyle = '#345'; g.fillRect(0, 0, 320, 180); const x0 = 60 + 60 * ct;
      g.fillStyle = '#fc3'; g.fillRect(x0, 74, 26, 26); g.fillStyle = '#a20'; g.fillRect(x0 + 4, 78, 8, 8); g.fillStyle = '#126'; g.fillRect(x0 + 15, 86, 7, 11); g.fillStyle = '#eee'; g.fillRect(x0 + 3, 90, 5, 4); };   // one non-repeating subject
    Object.defineProperty(el, 'currentTime', { get: () => ct, set: v => { ct = v; paint(); }, configurable: true }); el.play = () => Promise.resolve(); el.pause = () => {}; paint();
    state.media = state.media.filter(m => m.id !== 'tv'); state.media.push({ id: 'tv', type: 'video', name: 'tv', duration: 5, w: 320, h: 180, srcFps: 25 }); els.tv = el;
    const v = makeClip({ id: 'TV', type: 'video', track: 'V1', start: 0, duration: 3, mediaId: 'tv' });
    v.kf = { x: [{ t: 0, v: 0 }, { t: 3, v: 12 }] }; v.kfEaseMode = 'linear';
    Object.assign(v.props, { stabMode: 'none', stabZoom: 1.1 });
    const n = 75; v.stab = { fps: 25, n, dx: [...Array(n)].map((_, i) => 0.0006 * i), dy: [...Array(n)].map((_, i) => -0.0004 * i), rot: [...Array(n)].map(() => 0), sc: [...Array(n)].map(() => 1), st: [...Array(n)].map((_, i) => i / 25) };
    const t = makeClip({ id: 'TT', type: 'text', track: 'TX', start: 0, duration: 3 }); Object.assign(t.text, { content: 'O', size: 150 });
    // where the checker is drawn at tt: centroid of its yellow squares on the preview (text hidden while measuring)
    const seen = tt => { const keep = t.props.opacity; t.props.opacity = 0; setTime(tt); drawFrame(); t.props.opacity = keep;
      const W = CV().width, H = CV().height, d = CV().getContext('2d').getImageData(0, 0, W, H).data; let sx = 0, sy = 0, k = 0;
      for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) { const i = (y * W + x) * 4; if (d[i] > 220 && d[i + 1] > 170 && d[i + 2] < 110) { sx += x; sy += y; k++; } } return { X: sx / k, Y: sy / k }; };
    SET([v, t], t); const s0 = seen(0.5); t.props.x = (s0.X - 960) / 1920 * 100; t.props.y = (s0.Y - 540) / 1080 * 100; setTime(0.5); drawFrame();
    const ot = window.toast; window.toast = () => {}; try { await trackMotion(t); } finally { window.toast = ot; }
    return [0.6, 0.8, 1, 1.2, 1.5, 2, 2.5].map(tt => { const s = seen(tt), lp = liveProps(t, tt); return Math.hypot(960 + lp.x / 100 * 1920 - s.X, 540 + lp.y / 100 * 1080 - s.Y); }); });
  R['chroma: tracking error px'] = tk.map(v => +v.toFixed(1));
  T('5 tracking on animated, stabilized footage follows the drawn subject (< 12 px)', tk.every(v => v < 12));

  T('no page errors', app.errors.length === 0);
  if (app.errors.length) R['chroma: errors'] = app.errors.slice(0, 5);
}]);

/* ========================= section: sweep2 (second-pass review) ========================= */
SECTIONS.push(['sweep2', async (app) => {
  const p = app.page, E = (f, ...a) => p.evaluate(f, ...a), T = (k, ok) => check('sweep2: ' + k, ok);
  const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
  const { addWavMedia } = require('./lib/fixture-page');
  const FP = path.join(__dirname, '..', 'desktop', 'bin', 'ffprobe' + (process.platform === 'win32' ? '.exe' : ''));
  await p.setViewport({ width: 1280, height: 720 });
  await E(() => {
    window.sleep = ms => new Promise(r => setTimeout(r, ms));
    window.COL = (t, s, d, o = {}) => makeClip(Object.assign({ type: 'color', track: t, start: s, duration: d, props: defaultProps('color') }, o));
    window.HIST = clips => { closeOverlay(true); state.clips = clips; state.selection = null; state.selExtra = []; state.locked = {}; state.history = []; state.hIndex = -1; pushHistory(); renderTimeline(); renderInspector(); };
    window.MENUS = () => [...document.querySelectorAll('.menu')].filter(m => m.classList.contains('show')).map(m => m.id);
  });
  const vid = await addWavMedia(p, path.join(__dirname, 'fixtures', 'long.wav'), { name: 'long.wav' });

  // 1. undo is not stuck once a transcript arrives (speaker slots appear in the live snapshot)
  const u = await E(async (vid) => {
    const m = state.media.find(x => x.id === vid); delete m.transcript;
    HIST([makeClip({ type: 'audio', track: 'A1', start: 0, duration: 5, mediaId: vid, name: 'voice' })]);
    const s0 = snapshot();
    pushHistory(); state.clips[0].start = 1;
    pushHistory(); state.clips[0].duration = 3;
    const s2 = snapshot();
    m.transcript = { v: 1, words: [['hi', 0.5, 0.8]], covered: [[0, m.duration]], lag: 0 };   // e.g. transcription finished
    let n = 0; while (state.hIndex > 0 && n < 20) { undo(); n++; }
    const back = _snapSame(snapshot(), s0) && state.clips[0].start === 0 && state.clips[0].duration === 5;
    const redoable = state.hIndex < state.history.length - 1;
    while (state.hIndex < state.history.length - 1) redo();
    return { n, back, redoable, fwd: state.clips[0].start === 1 && state.clips[0].duration === 3, s2same: _snapSame(snapshot(), s2) };
  }, vid);
  T('1 undo walks back past the moment a transcript arrived (no endless loop, redo kept)', u.n <= 3 && u.back && u.redoable && u.fwd && u.s2same);

  // 2. a Fast (MediaRecorder) WebM gets its Duration written into the header.
  //    (MediaRecorder itself is unreliable in this headless build, so the
  //    recorder's layout is made with FFmpeg: live mode = unknown-size Segment and
  //    no Duration, minus the SeekHead the recorder doesn't write.)
  const FFM = path.join(__dirname, '..', 'desktop', 'bin', 'ffmpeg' + (process.platform === 'win32' ? '.exe' : ''));
  const wdir = path.join(__dirname, 'out', 'sweep2'); fs.mkdirSync(wdir, { recursive: true });
  const live = path.join(wdir, 'live.webm');
  execFileSync(FFM, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=s=160x90:r=25:d=2', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-live', '1', '-f', 'webm', live]);
  let buf = fs.readFileSync(live);
  { const seg = buf.indexOf(Buffer.from([0x18, 0x53, 0x80, 0x67])) + 12;          // Segment data (8-byte unknown size)
    const vint = i => { let n = 1; while (!(buf[i] & (0x80 >> (n - 1)))) n++; let v = buf[i] & (0xff >> n); for (let k = 1; k < n; k++) v = v * 256 + buf[i + k]; return [n, v]; };
    const cut = idLen => { const [n, v] = vint(seg + idLen); buf = Buffer.concat([buf.subarray(0, seg), buf.subarray(seg + idLen + n + v)]); };
    if (buf.readUInt32BE(seg) === 0x114D9B74) cut(4);   // SeekHead
    if (buf[seg] === 0xEC) cut(1); }                    // Void
  const probeDur = f => { try { return execFileSync(FP, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString().trim(); } catch (e) { return 'probe failed'; } };
  const rec = path.join(wdir, 'recorder-like.webm'); fs.writeFileSync(rec, buf);
  const wd = await E(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0)), blob = new Blob([bytes], { type: 'video/webm' });
    const out = await _webmWithDuration(blob, 2);
    const o = new Uint8Array(await out.arrayBuffer()); let s = ''; for (let i = 0; i < o.length; i += 0x8000) s += String.fromCharCode.apply(null, o.subarray(i, i + 0x8000));
    const withSeek = await _webmWithDuration(new Blob([bytes.slice(0, 40), new Uint8Array([0x11, 0x4D, 0x9B, 0x74, 0x80]), bytes.slice(40)]), 2);   // a SeekHead in front: left alone
    return { b64: btoa(s), grew: o.length - bytes.length, seekLeft: withSeek.size === bytes.length + 5 };
  }, buf.toString('base64'));
  const fixed = path.join(wdir, 'with-duration.webm'); fs.writeFileSync(fixed, Buffer.from(wd.b64, 'base64'));
  let decodes = true; try { execFileSync(FFM, ['-v', 'error', '-xerror', '-i', fixed, '-f', 'null', '-']); } catch (e) { decodes = false; }
  R['sweep2: webm duration'] = { before: probeDur(rec), after: probeDur(fixed), grew: wd.grew, decodes };
  T('2 a recorder-style WebM gets a Duration (ffprobe reads 2 s; still decodes; untouched when a SeekHead is present)',
    probeDur(rec) === 'N/A' && Math.abs(+probeDur(fixed) - 2) < 0.05 && wd.grew === 11 + 7 && decodes && wd.seekLeft);

  // 3. Escape closes the Theme menu and the right-click menu
  await E(() => HIST([COL('V1', 0, 4)]));
  await p.click('#themeBtn'); await sleep(200); const th0 = await E(() => MENUS());
  await p.keyboard.press('Escape'); await sleep(150); const th1 = await E(() => MENUS());
  const cb = await E(() => { const r = document.querySelector('#tracksHost .clip').getBoundingClientRect(); return [r.left + 10, r.top + r.height / 2]; });
  await p.mouse.click(cb[0], cb[1], { button: 'right' }); await sleep(200); const cx0 = await E(() => MENUS());
  await p.keyboard.press('Escape'); await sleep(150); const cx1 = await E(() => MENUS());
  T('3 Escape closes the Theme menu and the clip menu', th0.includes('themeMenu') && !th1.length && cx0.includes('ctxMenu') && !cx1.length);

  // 4. New project (Ctrl+N / button) asks with the shared dialog: tooltips, Escape = Cancel
  await E(() => { HIST([COL('V1', 0, 4)]); _savedSig = null; });
  await p.click('#newBtn'); await sleep(200);
  const np = await E(() => ({ btns: [...document.querySelectorAll('#overlay .modal-foot button')].map(b => !!b.title), title: (document.querySelector('#overlay h3') || {}).textContent }));
  await p.keyboard.press('Escape'); await sleep(150);
  const np2 = await E(() => ({ ov: document.getElementById('overlay').classList.contains('show'), n: state.clips.length }));
  T('4 New project asks with tooltipped buttons; Escape keeps the project', np.btns.length === 3 && np.btns.every(Boolean) && /new project/i.test(np.title || '') && !np2.ov && np2.n === 1);

  // 5. every inspector control has a tooltip (Start/Duration had none)
  const tips = await E(() => { HIST([COL('V1', 0, 4)]); selectClip(state.clips[0].id); state.inspTab = 'clip'; renderInspector();
    return ['iStart', 'iDur'].map(id => !!document.getElementById(id).title); });
  T('5 Start/Duration fields have tooltips', tips.every(Boolean));

  // 6. speed/reverse on a linked picture+sound pair keep the partner in sync
  const lk = await E(async (vid) => {
    state.media.push({ id: 'sv', type: 'video', name: 'sv', duration: 30, w: 64, h: 36 });
    const v = makeClip({ type: 'video', track: 'V1', start: 2, duration: 10, mediaId: 'sv', linkId: 'LK' }), a = makeClip({ type: 'audio', track: 'A1', start: 2, duration: 10, mediaId: vid, linkId: 'LK' });
    const a2 = makeClip({ type: 'audio', track: 'A2', start: 4, duration: 4, mediaId: vid, linkId: 'LK' });   // offset partner (merge-sync)
    HIST([v, a, a2]); selectClip(v.id); state.inspTab = 'clip'; renderInspector();
    const r = document.querySelector('#inspBody input[data-k="speed"]'); r.value = 2; r.dispatchEvent(new Event('input')); r.dispatchEvent(new Event('change'));
    const sp = { v: [v.duration, v.props.speed], a: [a.start, a.duration, a.props.speed], a2: [a2.start, a2.duration, a2.props.speed] };
    const rv = document.getElementById('pReverse'); rv.checked = true; rv.dispatchEvent(new Event('change'));
    const rev = [!!v.props.reverse, !!a.props.reverse, !!a2.props.reverse];
    undo(); undo();
    const back = state.clips.every(c => (c.props.speed || 1) === 1 && !c.props.reverse) && state.clips.find(c => c.id === a2.id).start === 4;
    return { sp, rev, back };
  }, vid);
  T('6 Speed on a linked clip changes its partners (offset scaled); Reverse follows a same-span partner; undoable',
    lk.sp.v[0] === 5 && lk.sp.a[0] === 2 && lk.sp.a[1] === 5 && lk.sp.a[2] === 2 && lk.sp.a2[0] === 3 && lk.sp.a2[1] === 2 && lk.sp.a2[2] === 2
    && lk.rev.join() === 'true,true,false' && lk.back);

  // 7. narrow window (desktop minimum): inspector sliders stay usable, Export fully visible
  const vp = async (w, h) => { await p.setViewport({ width: w, height: h }); await p.waitForFunction(w => innerWidth === w, { timeout: 5000 }, w).catch(() => {}); await sleep(400); };
  await vp(980, 640);
  await p.waitForFunction(() => document.getElementById('inspBody').clientWidth < 225, { timeout: 5000 }).catch(() => {}); await sleep(100);   // the columns animate (.28 s)
  const nw = await E(() => { state.media.push({ id: 'nv', type: 'video', name: 'nv', duration: 9, w: 64, h: 36 }); HIST([makeClip({ type: 'video', track: 'V1', start: 0, duration: 4, mediaId: 'nv' })]);
    selectClip(state.clips[0].id); state.inspTab = 'clip'; renderInspector(); void document.body.offsetWidth;
    const w = [...document.querySelectorAll('#inspBody .ctl>input[type=range]')].map(r => r.getBoundingClientRect().width).filter(x => x > 0);
    return { min: Math.min(...w), n: w.length, w: w.map(Math.round).join(), iw: innerWidth }; });
  R['sweep2: narrow sliders'] = nw;
  await vp(900, 640);
  const hb = await E(() => { const b = document.getElementById('exportBtn').getBoundingClientRect(); return { r: b.right, w: b.width, W: innerWidth, sw: document.documentElement.scrollWidth, fits: document.getElementById('exportBtn').scrollWidth <= document.getElementById('exportBtn').clientWidth + 1 }; });
  await vp(1280, 720);
  T('7 at the minimum window width every inspector slider is at least 120 px wide', nw.n > 10 && nw.min >= 120);
  T('7 at 900 px the Export button is whole and on screen', hb.r <= hb.W && hb.w >= 80 && hb.fits && hb.sw <= hb.W);

  // 10. speed ramps on a linked picture+sound pair: presets, curve edits, removal and the Speed slider
  //     reach a same-span partner (one undo step each); an offset partner is left alone
  const rp = await E(async (vid) => {
    state.media.push({ id: 'rv', type: 'video', name: 'rv', duration: 60, w: 64, h: 36 });
    const v = makeClip({ type: 'video', track: 'V1', start: 2, duration: 10, mediaId: 'rv', linkId: 'LR' }), a = makeClip({ type: 'audio', track: 'A1', start: 2, duration: 10, mediaId: vid, linkId: 'LR' });
    const a2 = makeClip({ type: 'audio', track: 'A2', start: 4, duration: 4, mediaId: vid, linkId: 'LR' });
    HIST([v, a, a2]); selectClip(v.id); state.inspTab = 'clip'; state.time = 7; renderInspector();
    const same = () => JSON.stringify(v.ramp || null) === JSON.stringify(a.ramp || null) && Math.abs(v.duration - a.duration) < 1e-9 && v.props.speed === a.props.speed && v.start === a.start
      && [0.1, 0.3, 0.5, 0.7, 0.9].every(f => { const t = v.start + v.duration * f; return Math.abs((srcTimeFor(v, t) - v.inPoint) - (srcTimeFor(a, t) - a.inPoint)) < 1e-9; });
    const H = () => state.hIndex, out = {};
    let h0 = H(); document.getElementById('ramp_hero').click();
    out.preset = { same: same(), ramp: !!v.ramp && !!a.ramp, dur: v.duration !== 10, step: H() - h0, a2: !a2.ramp && a2.duration === 4 && a2.start === 4 };
    undo(); { const [u, w] = state.clips; out.presetUndo = !u.ramp && !w.ramp && u.duration === 10 && w.duration === 10; } redo();
    selectClip(state.clips[0].id); state.inspTab = 'clip'; renderInspector(); await sleep(60);
    const V = state.clips[0], A = state.clips[1];
    return { out, ids: [V.id, A.id] };
  }, vid);
  // drag a point of the curve with the real mouse
  const gp = await E(async () => { let cv = document.getElementById('rampGraph'); const sec = cv.closest('.sec'); if (sec.classList.contains('collapsed')) { sec.querySelector('h4').click(); await sleep(250); cv = document.getElementById('rampGraph'); } cv.scrollIntoView({ block: 'center' }); await sleep(100); for (let k = 0, prev = ''; k < 40; k++) { const b = cv.getBoundingClientRect(), key = [b.left, b.top, b.width, cv.clientWidth].map(Math.round).join(); if (key === prev) break; prev = key; await sleep(60); }   // wait for the section/column animation to settle
    const r = cv.getBoundingClientRect(), c = state.clips[0], pts = _proRampPts(c), W = cv.clientWidth, H = cv.clientHeight;
    const lo = Math.log(0.1), hi = Math.log(10), q = pts[2];
    const x = r.left + 40 + q[0] * (W - 48), y = r.top + 8 + (1 - (Math.log(q[1]) - lo) / (hi - lo)) * (H - 22), at = document.elementFromPoint(x, y);
    return { x, y, h: state.hIndex, w: r.width, cw: W, ch: H, at: at && (at.id || at.className), pts: JSON.stringify(pts), sel: state.selection }; });
  R['sweep2: ramp drag gp'] = gp;
  await p.mouse.move(gp.x, gp.y); await p.mouse.down(); await p.mouse.move(gp.x, gp.y - 12, { steps: 4 }); await p.mouse.move(gp.x, gp.y - 25, { steps: 4 }); await p.mouse.up(); await sleep(80);
  const rp2 = await E(async (h0) => {
    const [v, a, a2] = state.clips;
    const same = () => JSON.stringify(v.ramp || null) === JSON.stringify(a.ramp || null) && Math.abs(v.duration - a.duration) < 1e-9 && v.props.speed === a.props.speed
      && [0.1, 0.3, 0.5, 0.7, 0.9].every(f => { const t = v.start + v.duration * f; return Math.abs((srcTimeFor(v, t) - v.inPoint) - (srcTimeFor(a, t) - a.inPoint)) < 1e-9; });
    const out = { drag: { same: same(), moved: !v.ramp.preset && Math.abs(v.ramp.pts[2][1] - 0.35) > 0.02, step: state.hIndex - h0, a2: !a2.ramp } };
    // the Speed slider with a ramp on both
    selectClip(v.id); state.inspTab = 'clip'; renderInspector();
    const r = document.querySelector('#inspBody input[data-k="speed"]'); r.value = (v.props.speed || 1) * 1.5; r.dispatchEvent(new Event('input')); r.dispatchEvent(new Event('change'));
    out.speed = same();
    // removing it (the None button)
    selectClip(v.id); state.inspTab = 'clip'; renderInspector();
    let h1 = state.hIndex; document.getElementById('rampNone').click();
    out.remove = { same: same(), gone: !v.ramp && !a.ramp, step: state.hIndex - h1 };
    // palette entry
    selectClip(v.id); state.time = v.start + 1; h1 = state.hIndex;
    const P = typeof COMMANDS !== 'undefined' ? COMMANDS.find(c => c.n === 'Speed ramp: Montage') : null;
    if (P) { P.f(); out.palette = { same: same(), on: !!a.ramp, step: state.hIndex - h1 }; }
    return out;
  }, gp.h);
  R['sweep2: linked ramps'] = Object.assign(rp.out, rp2);
  T('10 a ramp preset on a linked clip reaches the same-span partner (sound mapping identical), one undo step; offset partner untouched',
    rp.out.preset.same && rp.out.preset.ramp && rp.out.preset.dur && rp.out.preset.step === 1 && rp.out.preset.a2 && rp.out.presetUndo);
  T('10 dragging the ramp curve and the Speed slider keep the partner identical; the drag is one undo step', rp2.drag.same && rp2.drag.moved && rp2.drag.step === 1 && rp2.drag.a2 && rp2.speed);
  T('10 removing the ramp removes it from the partner too (one step)', rp2.remove.same && rp2.remove.gone && rp2.remove.step === 1 && (!rp2.palette || (rp2.palette.same && rp2.palette.on && rp2.palette.step === 1)));

  // 11. relinking several files at once: one summary toast
  const rl = await E(async () => {
    const wav = (n) => { const sr = 8000, len = sr * (0.5 + n * 0.1), b = new ArrayBuffer(44 + len * 2), d = new DataView(b), w = (o, s) => [...s].forEach((c, i) => d.setUint8(o + i, c.charCodeAt(0)));
      w(0, 'RIFF'); d.setUint32(4, 36 + len * 2, true); w(8, 'WAVE'); w(12, 'fmt '); d.setUint32(16, 16, true); d.setUint16(20, 1, true); d.setUint16(22, 1, true); d.setUint32(24, sr, true); d.setUint32(28, sr * 2, true); d.setUint16(32, 2, true); d.setUint16(34, 16, true); w(36, 'data'); d.setUint32(40, len * 2, true);
      for (let i = 0; i < len; i++) d.setInt16(44 + i * 2, Math.round(8000 * Math.sin(i * 0.2)), true);
      return new File([b], 'relink' + n + '.wav', { type: 'audio/wav' }); };
    const files = [1, 2, 3].map(wav), clips = [];
    files.forEach((f, i) => { state.media.push({ id: 'rph' + i, type: 'audio', name: 'relink' + (i + 1), ext: 'WAV', duration: 0.5, size: f.size, missing: true, url: null });
      clips.push(makeClip({ type: 'audio', track: 'A1', start: i, duration: 0.4, mediaId: 'rph' + i })); });
    HIST(clips);
    document.querySelectorAll('#toasts .toast').forEach(e => e.remove());
    const seen = []; const mo = new MutationObserver(() => document.querySelectorAll('#toasts .toast').forEach(t => { if (!t._seen) { t._seen = 1; seen.push(t.textContent); } })); mo.observe(document.getElementById('toasts'), { childList: true });
    await importFiles(files); await sleep(50); mo.disconnect();
    const rel = seen.filter(t => /Relinked/.test(t));
    return { rel, linked: state.clips.every(c => !/^rph/.test(c.mediaId)), phGone: !state.media.some(m => /^rph/.test(m.id)) };
  });
  R['sweep2: relink toast'] = rl;
  T('11 relinking 3 files shows one "Relinked 3 files" toast', rl.linked && rl.phGone && rl.rel.length === 1 && /Relinked 3 files/.test(rl.rel[0]));

  // 12. a tiny but real export is kept; a recording with no video frames is still refused
  const mkf = (name, args) => { const f = path.join(wdir, name); execFileSync(FFM, ['-y', '-v', 'error', ...args, f]); return f; };
  const tiny = mkf('tiny-color.webm', ['-f', 'lavfi', '-i', 'color=c=0x3050a0:s=320x180:r=30:d=0.8', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-b:v', '20k', '-live', '1', '-f', 'webm']);
  const tinyBuf = fs.readFileSync(tiny), clusterAt = tinyBuf.indexOf(Buffer.from([0x1F, 0x43, 0xB6, 0x75]));
  const aonly = mkf('audio-only.webm', ['-f', 'lavfi', '-i', 'sine=f=440:d=1', '-c:a', 'libopus', '-f', 'webm']);
  const mp4v = mkf('tiny.mp4', ['-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=25:d=0.6', '-c:v', 'mpeg4', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4']);
  const mp4a = mkf('audio.mp4', ['-f', 'lavfi', '-i', 'sine=f=440:d=0.6', '-c:a', 'aac', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4']);
  const ev = await E(async (L) => {
    const B = (b64, type) => new Blob([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], { type });
    const n = {}; for (const [k, b64, t] of L) n[k] = await _recVideoFrames(B(b64, t));
    // through saveExport itself
    const run = async (b64) => { const saved = []; const orig = window._saveExportBlob; window._saveExportBlob = (b, ext) => saved.push([b.size, ext]);
      document.querySelectorAll('#toasts .toast').forEach(e => e.remove());
      exportUI.chunks = [B(b64, 'video/webm')]; exportUI.recorder = { mimeType: 'video/webm' }; exportUI.preset = null; exportUI.discard = false; exportUI.range = { R0: 0, D: 0.8 };
      saveExport(); await sleep(300); window._saveExportBlob = orig;
      return { saved: saved.length, refused: [...document.querySelectorAll('#toasts .toast')].some(t => /no video data/.test(t.textContent)) }; };
    return { n, tiny: await run(L[0][1]), empty: await run(L[1][1]) };
  }, [['tiny', tinyBuf.toString('base64'), 'video/webm'], ['headerOnly', tinyBuf.subarray(0, clusterAt).toString('base64'), 'video/webm'],
      ['audioOnly', fs.readFileSync(aonly).toString('base64'), 'video/webm'], ['mp4', fs.readFileSync(mp4v).toString('base64'), 'video/mp4'],
      ['mp4audio', fs.readFileSync(mp4a).toString('base64'), 'video/mp4'], ['junk', Buffer.from('not a video').toString('base64'), 'video/webm']]);
  R['sweep2: tiny export'] = Object.assign({ size: tinyBuf.length }, ev);
  T('12 a tiny plain-color export (<2 KB) counts its frames and is saved', tinyBuf.length < 2048 && ev.n.tiny >= 20 && ev.tiny.saved === 1 && !ev.tiny.refused);
  T('12 a recording with no video frames (header only, audio only; WebM and MP4) is still refused', ev.n.headerOnly === 0 && ev.n.audioOnly === 0 && ev.n.mp4 >= 10 && ev.n.mp4audio === 0 && ev.n.junk === null
    && ev.empty.saved === 0 && ev.empty.refused);

  // 13. the Flip buttons stay on one line in the narrow inspector (and in the normal one)
  const flip = async () => E(() => { state.media.push({ id: 'fv', type: 'video', name: 'fv', duration: 9, w: 64, h: 36 }); HIST([makeClip({ type: 'video', track: 'V1', start: 0, duration: 4, mediaId: 'fv' })]);
    selectClip(state.clips[0].id); state.inspTab = 'clip'; renderInspector();
    const r = []; for (const on of [false, true]) { state.clips[0].props.flipH = on; state.clips[0].props.flipV = on; renderInspector(); void document.body.offsetWidth;
      const bs = ['flipHBtn', 'flipVBtn'].map(i => document.getElementById(i));
      r.push(bs.map(b => { const lh = parseFloat(getComputedStyle(b).lineHeight) || 16, rc = b.getBoundingClientRect();
        return { h: Math.round(rc.height), w: Math.round(rc.width), fits: b.scrollWidth <= b.clientWidth + 1, top: Math.round(rc.top), one: b.getClientRects().length === 1 && rc.height < lh * 2 + 6, txt: b.innerText.trim() }; })); }
    return { iw: document.getElementById('inspBody').clientWidth, r, tips: ['flipHBtn', 'flipVBtn'].every(i => !!document.getElementById(i).title) }; });
  await vp(980, 640);
  await p.waitForFunction(() => document.getElementById('inspBody').clientWidth < 225, { timeout: 5000 }).catch(() => {}); await sleep(100);
  const fN = await flip();
  await vp(1280, 720);
  await p.waitForFunction(() => document.getElementById('inspBody').clientWidth > 240, { timeout: 5000 }).catch(() => {}); await sleep(100);   // the column animation can outlast 100 ms on a busy machine
  const fW = await flip();
  R['sweep2: flip'] = { narrow: fN, wide: fW };
  const oneLine = f => f.r.every(pair => pair.every(b => b.one && b.fits && b.w > 40) && pair[0].top === pair[1].top && pair[0].h === pair[1].h) && f.r[0][0].h === f.r[1][0].h && f.tips;
  T('13 Flip buttons fit on one line at 980 px (short labels) and at 1280 px, with or without the check mark', oneLine(fN) && oneLine(fW) && /Horiz\./.test(fN.r[0][0].txt) && /Horizontal/.test(fW.r[0][0].txt));

  // 8. Captions default to a titles track the captions fit on (a new one when the only track holds a title)
  const cap = await E(async (vid) => {
    const m = state.media.find(x => x.id === vid);
    m.transcript = { v: 1, words: [['Hello', 0.5, 0.9], ['there.', 1.0, 1.4], ['Second', 3.0, 3.4], ['line.', 3.5, 3.9]], covered: [[0, m.duration]], lag: 0 };
    TRACKS = TRACKS.filter(t => t.kind !== 'text' || t.id === 'TX'); buildTracks();
    HIST([makeClip({ type: 'audio', track: 'A1', start: 0, duration: 5, mediaId: vid, name: 'voice' }), makeClip({ type: 'text', track: 'TX', start: 0, duration: 5, name: 'My title' })]);
    TX.dirty = true; aiCaptionsDialog(); for (let i = 0; i < 40 && !document.getElementById('capGo'); i++) await sleep(50);
    const def = document.getElementById('capTrack').value;
    document.getElementById('capGo').click(); await sleep(100);
    const caps = state.clips.filter(c => c.isCaption);
    const tr = caps.length && trackOf(caps[0].track);
    const title = state.clips.find(c => c.name === 'My title');
    return { def, n: caps.length, newTrack: !!tr && tr.id !== 'TX' && tr.kind === 'text', titleKept: !!title && title.track === 'TX' };
  }, vid);
  T('8 Captions default to a new titles track when the existing one holds a title (nothing skipped)', cap.def === '__new' && cap.n === 2 && cap.newTrack && cap.titleKept);

  // 9. the "Restore your last session" bar asks before replacing work started since launch
  await E(() => { HIST([COL('V1', 0, 3), COL('V1', 3, 3)]); localStorage.setItem('vibe-autosave', serializeProject()); });
  await p.reload(); await sleep(700);
  const rb0 = await E(() => { const bar = !!document.getElementById('restoreBar'); state.clips = [makeClip({ type: 'color', track: 'V1', start: 0, duration: 7 })]; renderTimeline(); return bar; });
  await p.click('#rbYes'); await sleep(200);
  const rb1 = await E(() => ({ ask: !!document.querySelector('#overlay #acAlt'), n: state.clips.length }));
  await p.keyboard.press('Escape'); await sleep(150);
  const rb2 = await E(() => { const r = { n: state.clips.length, d: state.clips[0].duration, bar: !!document.getElementById('restoreBar') }; localStorage.removeItem('vibe-autosave'); return r; });
  T('9 Restore asks before replacing the current timeline; Cancel keeps it', rb0 && rb1.ask && rb1.n === 1 && rb2.n === 1 && rb2.d === 7 && rb2.bar);

  // 14. toasts never block clicks, and a repeated message renews instead of stacking
  const tst = await p.evaluate(() => { document.getElementById('toasts').innerHTML = ''; for (let k = 0; k < 5; k++) toast('Same message'); toast('Other');
    const n = document.querySelectorAll('#toasts .toast').length, pe = getComputedStyle(document.getElementById('toasts')).pointerEvents; document.getElementById('toasts').innerHTML = ''; return { n, pe }; });
  T('14 toasts: click-through, identical messages don’t stack', tst.n === 2 && tst.pe === 'none');
  T('no page errors', app.errors.length === 0);
  if (app.errors.length) R['sweep2: errors'] = app.errors.slice(0, 5);
}]);

/* ========================= section: kfspeed =========================
 * v4.10.2: when a clip's speed (or speed ramp) changes, its keyframes stay on
 * the same SOURCE moments (1×→2× halves each key's clip time). Ground truth:
 * srcTimeFor at each key's timeline position before and after the change. */
SECTIONS.push(['kfspeed', async (app) => {
  const p = app.page, E = (f, ...a) => p.evaluate(f, ...a), T = (k, ok) => check('kfspeed: ' + k, ok);
  await p.setViewport({ width: 1600, height: 1000 });
  await E(() => {
    window.RESET = (clips) => {
      if (typeof proInsideCompound === 'function') while (proInsideCompound()) proCloseCompound();
      state.media = [{ id: 'vm', type: 'video', name: 'v.mp4', duration: 60, w: 64, h: 36, url: 'blob:none' }, { id: 'am', type: 'audio', name: 'a.wav', duration: 60, w: 0, h: 0 }];
      state.clips = clips; state.locked = {}; state.selection = null; state.selExtra = []; state.markers = [];
      state.history = []; state.hIndex = -1; pushHistory(); state.inspTab = 'clip'; state.time = 100; try { closeOverlay(); } catch (e) { }
      renderTimeline();
    };
    window.KC = (o) => { const c = makeClip(Object.assign({ type: 'video', track: 'V1', start: 2, duration: 4, inPoint: 5, mediaId: 'vm' }, o));
      c.kf = { x: [{ t: 0.5, v: 0 }, { t: 1, v: 40, i: 'bezier', b: [0.2, 0.1, 0.7, 0.9] }, { t: 3, v: 100 }], opacity: [{ t: 2.5, v: 1 }, { t: 4, v: 0 }] };
      return c; };
    // the source moment of every key: [prop, index, source seconds]
    window.KSRC = c => { const o = []; for (const k in c.kf) c.kf[k].forEach((q, i) => o.push([k, i, srcTimeFor(c, c.start + q.t)])); return o; };
    window.SAME = (a, b, tol = 1e-6) => a.length === b.length && a.every((x, i) => x[0] === b[i][0] && x[1] === b[i][1] && Math.abs(x[2] - b[i][2]) < tol);
    window.INSIDE = c => Object.values(c.kf).every(a => a.every(q => q.t >= -1e-9 && q.t <= c.duration + 1e-9));
    window.SPEED = (c, v) => { selectClip(c.id); state.inspTab = 'clip'; renderInspector();
      const r = document.querySelector('#inspBody input[type=range][data-k=speed]'); r.value = v; r.dispatchEvent(new Event('input')); r.dispatchEvent(new Event('change')); };
    window.J = c => JSON.stringify([c.start, c.duration, c.props, c.kf || null, c.ramp ? { pts: c.ramp.pts, w: c.ramp.w } : null, c.duck || null]);
  });

  // 1. Speed slider 1 → 2 (the real inspector control): keys halve, stay on their source moments and inside the clip; handles untouched; one undo step restores exactly
  const r1 = await E(() => {
    const c = KC(); RESET([c]); const before = J(c), src0 = KSRC(c), b0 = JSON.stringify(c.kf.x[1].b);
    SPEED(c, 2);
    const o = { dur: c.duration, ts: c.kf.x.map(q => q.t).concat(c.kf.opacity.map(q => q.t)), same: SAME(src0, KSRC(c)), inside: INSIDE(c), b: JSON.stringify(c.kf.x[1].b) === b0 };
    undo(); const u = state.clips.find(x => x.id === c.id); o.undo = J(u) === before;
    redo(); const r = state.clips.find(x => x.id === c.id); o.redo = Math.abs(r.kf.x[2].t - 1.5) < 1e-9;
    return o;
  });
  T('1 Speed slider 1→2: key times halve (0.5,1,3 → 0.25,0.5,1.5) and stay inside the 2 s clip', Math.abs(r1.dur - 2) < 1e-9 && [0.25, 0.5, 1.5, 1.25, 2].every((t, i) => Math.abs(r1.ts[i] - t) < 1e-9) && r1.inside);
  T('1 every key shows the same source moment as before', r1.same);
  T('1 bezier handles (segment fractions) are unchanged', r1.b);
  T('1 one undo step restores the clip exactly; redo re-applies', r1.undo && r1.redo);

  // 2. a drag through many values ends exactly where one step would; slowing down (1 → 0.5) doubles key times
  const r2 = await E(() => {
    const c = KC(); RESET([c]); const src0 = KSRC(c), h0 = state.hIndex;
    selectClip(c.id); renderInspector(); const r = document.querySelector('#inspBody input[type=range][data-k=speed]');
    for (const v of [1.2, 1.7, 2.6, 3.1, 0.7, 0.5]) { r.value = v; r.dispatchEvent(new Event('input')); }
    r.dispatchEvent(new Event('change'));
    return { dur: c.duration, t: c.kf.x[2].t, same: SAME(src0, KSRC(c)), steps: state.hIndex - h0 };
  });
  T('2 dragging the slider 1→…→0.5: keys double, same source moments, one undo step', Math.abs(r2.dur - 8) < 1e-9 && Math.abs(r2.t - 6) < 1e-9 && r2.same && r2.steps === 1);

  // 3. linked picture+sound: the partner's keys follow too (both clips, one undo step)
  const r3 = await E(() => {
    const v = KC({ linkId: 'L' }), a = KC({ type: 'audio', track: 'A1', mediaId: 'am', linkId: 'L' }); a.kf = { volume: [{ t: 1, v: 1 }, { t: 3.5, v: 0.2 }] };
    RESET([v, a]); const sv = KSRC(v), sa = KSRC(a), ja = J(a);
    SPEED(v, 2);
    const o = { v: SAME(sv, KSRC(v)), a: SAME(sa, KSRC(a)), at: a.kf.volume.map(q => q.t), inside: INSIDE(a) };
    undo(); o.undo = J(state.clips.find(x => x.id === a.id)) === ja;
    return o;
  });
  T('3 the linked sound\'s keys follow the picture\'s speed change (and undo restores both)', r3.v && r3.a && Math.abs(r3.at[0] - 0.5) < 1e-9 && Math.abs(r3.at[1] - 1.75) < 1e-9 && r3.inside && r3.undo);

  // 4. the Speed reset arrow (2 → 1) and the value field
  const r4 = await E(async () => {
    const c = KC(); RESET([c]); SPEED(c, 2); const src0 = KSRC(c);
    document.querySelector('#inspBody .rst[data-rstk=speed]').click();
    const o = { dur: c.duration, same: SAME(src0, KSRC(c)), t: c.kf.x[2].t };
    // the typed value field (click the readout, type, Enter)
    selectClip(c.id); renderInspector(); const val = document.querySelector('#inspBody input[data-k=speed]').closest('.ctl').querySelector('.val'); val.click();
    const inp = val.querySelector('input'); inp.value = '4'; inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    o.typed = Math.abs(c.duration - 1) < 1e-9 && Math.abs(c.kf.x[2].t - 0.75) < 1e-9 && SAME(src0, KSRC(c));
    return o;
  });
  T('4 Speed reset arrow puts the keys back on their source moments (and the typed value field retimes too)', Math.abs(r4.dur - 4) < 1e-9 && Math.abs(r4.t - 3) < 1e-9 && r4.same && r4.typed);

  // 5. speed ramps: applying a preset, the slider on a ramped clip, a curve edit and removing the ramp all keep keys on their source moments
  const r5 = await E(() => {
    const c = KC(); RESET([c]); const src0 = KSRC(c), o = {};
    proRampApply(c, 'hero'); o.preset = SAME(src0, KSRC(c), 1e-5) && INSIDE(c); o.moved = Math.abs(c.kf.x[2].t - 3) > 0.05;
    SPEED(c, (c.props.speed) * 1.5); o.slider = SAME(src0, KSRC(c), 1e-5) && INSIDE(c);
    proRampLinked(c, () => proRampEdit(c, () => { c.ramp.pts[2][1] *= 0.5; })); o.edit = SAME(src0, KSRC(c), 1e-5);
    const d = c.duration; proRampRemove(c); o.remove = !c.ramp && Math.abs(c.duration - d) < 1e-9 && SAME(src0, KSRC(c), 1e-5);
    // reversed + ramped
    const r = KC({ props: Object.assign(defaultProps(), { reverse: true }) }); RESET([r]); const s1 = KSRC(r);
    proRampApply(r, 'montage'); o.rev = SAME(s1, KSRC(r), 1e-5) && INSIDE(r);
    return o;
  });
  T('5 ramp preset: keys move onto the same source moments (not left at their old times)', r5.preset && r5.moved);
  T('5 Speed slider on a ramped clip, a curve edit and Remove ramp keep keys on their source moments', r5.slider && r5.edit && r5.remove);
  T('5 a reversed clip with a ramp keeps its keys on their source moments', r5.rev);

  // 6. Paste attributes → Speed: the target's own keys follow; keys pasted with Transform arrive unchanged
  const r6 = await E(() => {
    const src = KC({ start: 20 }); src.props.speed = 2; src.duration = 2; src.kf = { x: [{ t: 0.2, v: 5 }, { t: 1.8, v: 9 }] };
    const dst = KC({ start: 30 }), dst2 = KC({ start: 40 }); RESET([src, dst, dst2]); const s0 = KSRC(dst);
    state.selection = src.id; copySelected();
    state.selection = dst.id; state.selExtra = [dst2.id];
    pasteAttrsDialog(); document.querySelectorAll('#overlay [data-pa]').forEach(cb => { cb.checked = cb.dataset.pa === 'speed'; }); document.getElementById('paApply').click();
    const o = { speed: SAME(s0, KSRC(dst)) && Math.abs(dst.duration - 2) < 1e-9 && INSIDE(dst) && Math.abs(dst2.kf.opacity[1].t - 2) < 1e-9 };
    const d3 = KC({ start: 50 }); state.clips.push(d3); state.selection = d3.id; state.selExtra = [];
    pasteAttrsDialog(); document.querySelectorAll('#overlay [data-pa]').forEach(cb => { cb.checked = cb.dataset.pa === 'speed' || cb.dataset.pa === 'transform'; }); document.getElementById('paApply').click();
    o.pasted = JSON.stringify(d3.kf.x.map(q => q.t)) === '[0.2,1.8]' && Math.abs(d3.duration - 2) < 1e-9;
    return o;
  });
  T('6 Paste attributes → Speed retimes each target\'s keys (multi-select)', r6.speed);
  T('6 keys pasted with Transform keep the source clip\'s timing', r6.pasted);

  // 7. compound: its own keys follow the speed exactly like the clips inside it do
  const r7 = await E(() => {
    const inner = KC({ start: 0, duration: 4, inPoint: 5 }); inner.kf = { x: [{ t: 1, v: 0 }, { t: 3, v: 100 }] };
    RESET([inner]); state.selection = inner.id; const cmp = proMakeCompound();
    cmp.kf = { opacity: [{ t: 1, v: 1 }, { t: 3, v: 0.2 }] };
    SPEED(cmp, 2);
    const v = playClips().find(x => x._cmp === cmp.id);
    return { own: cmp.kf.opacity.map(q => q.t), inner: v && v.kf.x.map(q => v.start + q.t - cmp.start), dur: cmp.duration };
  });
  T('7 a compound\'s own keys follow its speed, in step with the keys of the clips inside', Math.abs(r7.dur - 2) < 1e-9 && r7.inner && [0.5, 1.5].every((t, i) => Math.abs(r7.own[i] - t) < 1e-9 && Math.abs(r7.inner[i] - t) < 1e-9));

  // 8. fades/transitions stay in timeline seconds, clamped to the shorter clip; reverse leaves keys where they are
  const r8 = await E(() => {
    const c = KC(); Object.assign(c.props, { fadeIn: 3, fadeOut: 1, transIn: 'dissolve', transInDur: 2.5 }); RESET([c]);
    SPEED(c, 2); const o = { fi: c.props.fadeIn, fo: c.props.fadeOut, ti: c.props.transInDur };
    const kt = JSON.stringify(c.kf); selectClip(c.id); renderInspector(); const rv = document.getElementById('pReverse'); rv.checked = true; rv.dispatchEvent(new Event('change'));
    o.rev = c.props.reverse && JSON.stringify(c.kf) === kt;
    return o;
  });
  T('8 fades/transition lengths stay in seconds, clamped to the new length', r8.fi === 2 && r8.fo === 1 && r8.ti === 2);
  T('8 Play in reverse leaves the keys where they are on the timeline', r8.rev);

  // 9. ducked music: after a speed change Remove ducking still recognizes its keys and restores the clip's own (re-timed) volume keys
  const r9 = await E(() => {
    const c = KC({ type: 'audio', track: 'A1', mediaId: 'am' }); c.kf = { volume: [{ t: 0, v: 1 }, { t: 1, v: 0.3 }, { t: 2, v: 0.3 }, { t: 3, v: 1 }] };
    c.duck = { prev: [{ t: 0.5, v: 0.9 }, { t: 3.5, v: 0.6 }], sig: _proVolSig(c), keys: JSON.parse(JSON.stringify(c.kf.volume)), in0: 5, sp: 1, dur: 4, db: -12 };
    RESET([c]); SPEED(c, 2);
    const mine = proUnduckClip(c);
    return { mine, back: c.kf && JSON.stringify(c.kf.volume.map(q => [q.t, q.v])) };
  });
  T('9 Remove ducking after a speed change restores the pre-duck keys at their source moments', r9.mine && r9.back === '[[0.25,0.9],[1.75,0.6]]');

  // 10. (follow-up) the Speed reset arrow carries linked partners like the slider: same span → exact copy (ramp removed too),
  //     a J/L-offset partner → the same factor with its offset scaled; keys stay on their source moments; one undo step
  const r10 = await E(() => {
    const o = {};
    const v = KC({ linkId: 'L' }), a = KC({ type: 'audio', track: 'A1', mediaId: 'am', linkId: 'L' }); a.kf = { volume: [{ t: 1, v: 1 }, { t: 3.5, v: 0.2 }] };
    RESET([v, a]); SPEED(v, 2); const sa = KSRC(a), ja = J(a), jv = J(v);
    const h0 = state.hIndex; selectClip(v.id); renderInspector(); document.querySelector('#inspBody .rst[data-rstk=speed]').click();
    o.plain = a.props.speed === 1 && Math.abs(a.duration - 4) < 1e-9 && a.start === v.start && SAME(sa, KSRC(a)) && INSIDE(a) && state.hIndex - h0 === 1;
    undo(); o.undo = J(state.clips.find(x => x.id === a.id)) === ja && J(state.clips.find(x => x.id === v.id)) === jv;
    // ramped pair: the ramp reaches the partner (proRampLinked); the reset arrow removes it from both
    const v2 = KC({ linkId: 'M' }), a2 = KC({ type: 'audio', track: 'A1', mediaId: 'am', linkId: 'M' }); a2.kf = { volume: [{ t: 1, v: 1 }, { t: 3.5, v: 0.2 }] };
    RESET([v2, a2]); const s2 = KSRC(a2); proRampApply(v2, 'hero'); o.rampBoth = !!a2.ramp && J(a2).slice(0, 40) === J(v2).slice(0, 40);
    selectClip(v2.id); renderInspector(); document.querySelector('#inspBody .rst[data-rstk=speed]').click();
    o.ramp = !v2.ramp && !a2.ramp && a2.props.speed === 1 && Math.abs(a2.duration - 4) < 1e-9 && SAME(s2, KSRC(a2), 1e-5);
    // J-cut partner (sound starts 1 s before the picture), both at 2×: reset → 1×, offset back to 1 s, its keys on their source moments
    const v3 = KC({ linkId: 'N', start: 3 }), a3 = KC({ type: 'audio', track: 'A1', mediaId: 'am', linkId: 'N', start: 2 }); a3.kf = { volume: [{ t: 1, v: 1 }, { t: 3.5, v: 0.2 }] };
    RESET([v3, a3]); SPEED(v3, 2); const s3 = KSRC(a3); o.jOff = a3.start;
    selectClip(v3.id); renderInspector(); document.querySelector('#inspBody .rst[data-rstk=speed]').click();
    o.j = a3.props.speed === 1 && Math.abs(a3.start - 2) < 1e-9 && Math.abs(a3.duration - 4) < 1e-9 && SAME(s3, KSRC(a3));
    return o;
  });
  T('10 Speed reset arrow: the linked sound follows (speed, length, keys), one undo step restores both', r10.plain && r10.undo);
  T('10 Speed reset arrow on a ramped linked pair removes the ramp from both, keys stay on their source moments', r10.rampBoth && r10.ramp);
  T('10 Speed reset arrow: a J-cut partner gets the same factor and its offset back', Math.abs(r10.jOff - 2.5) < 1e-9 && r10.j);

  // 11. (follow-up) Paste attributes → Speed carries linked partners too (constant speed and a ramp), one undo step
  const r11 = await E(() => {
    const o = {};
    const src = KC({ start: 20 }); src.props.speed = 2; src.duration = 2;
    const v = KC({ start: 30, linkId: 'P' }), a = KC({ type: 'audio', track: 'A1', mediaId: 'am', start: 30, linkId: 'P' }); a.kf = { volume: [{ t: 1, v: 1 }, { t: 3.5, v: 0.2 }] };
    RESET([src, v, a]); const sa = KSRC(a), ja = J(a);
    state.selection = src.id; copySelected(); state.selection = v.id; state.selExtra = [];
    const h0 = state.hIndex;
    pasteAttrsDialog(); document.querySelectorAll('#overlay [data-pa]').forEach(cb => { cb.checked = cb.dataset.pa === 'speed'; }); document.getElementById('paApply').click();
    o.plain = a.props.speed === 2 && Math.abs(a.duration - 2) < 1e-9 && a.start === v.start && SAME(sa, KSRC(a)) && INSIDE(a) && state.hIndex - h0 === 1;
    undo(); o.undo = J(state.clips.find(x => x.id === a.id)) === ja;
    // a ramp pasted onto a linked picture: the sound gets the identical curve and length
    const s2 = KC({ start: 20 }); const v2 = KC({ start: 30, linkId: 'Q' }), a2 = KC({ type: 'audio', track: 'A1', mediaId: 'am', start: 30, linkId: 'Q' });
    a2.kf = { volume: [{ t: 1, v: 1 }, { t: 3.5, v: 0.2 }] };
    RESET([s2, v2, a2]); proRampApply(s2, 'hero'); const sa2 = KSRC(a2);
    state.selection = s2.id; copySelected(); state.selection = v2.id; state.selExtra = [];
    pasteAttrsDialog(); document.querySelectorAll('#overlay [data-pa]').forEach(cb => { cb.checked = cb.dataset.pa === 'speed'; }); document.getElementById('paApply').click();
    o.ramp = !!v2.ramp && !!a2.ramp && JSON.stringify(a2.ramp.pts) === JSON.stringify(v2.ramp.pts) && Math.abs(a2.duration - v2.duration) < 1e-9 && a2.props.speed === v2.props.speed
      && SAME(sa2, KSRC(a2), 1e-5) && [0.1, 0.4, 0.8].every(u => Math.abs(srcTimeFor(a2, a2.start + u * a2.duration) - srcTimeFor(v2, v2.start + u * v2.duration)) < 1e-9);
    return o;
  });
  T('11 Paste attributes → Speed: the linked sound follows (speed, length, keys), one undo step', r11.plain && r11.undo);
  T('11 Paste attributes → Speed with a ramp: the linked sound gets the same curve and stays in sync', r11.ramp);

  T('no page errors', app.errors.length === 0);
  if (app.errors.length) R['kfspeed: errors'] = app.errors.slice(0, 5);
  R['kfspeed: values'] = { r1, r2, r4, r5, r6, r7, r8, r9, r10, r11 };
}]);

/* ========================= section: axfade (v4.10.2) =========================
 * Same-track In transitions crossfade the SOUND too: the outgoing clip A keeps
 * sounding past its out point (fading out equal-power) while B fades in — in the
 * offline mix, the FFmpeg graph (audio-filter.js through real FFmpeg) and the
 * live preview's gains. Tones: A = 440 Hz, B = 1000 Hz (0.5 amplitude); C = one
 * file, 440 Hz for 0–3 s then 1000 Hz (a clip split in two). Levels are read
 * with a Hann-windowed Goertzel over 100 ms. */
SECTIONS.push(['axfade', async (app) => {
  const p = app.page, E = (f, ...a) => p.evaluate(f, ...a), T = (k, ok) => check('axfade: ' + k, ok);
  const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
  const { addWavMedia } = require('./lib/fixture-page');
  const { buildAudioFilter } = require('../desktop/audio-filter.js');
  const FF = path.join(__dirname, '..', 'desktop', 'bin', 'ffmpeg' + (process.platform === 'win32' ? '.exe' : ''));
  if (!fs.existsSync(FF)) { R['axfade'] = 'skipped (no desktop/bin/ffmpeg)'; return; }
  const dir = path.join(__dirname, 'out', 'axfade'); fs.mkdirSync(dir, { recursive: true });
  const tone = (name, lav) => { const f = path.join(dir, name);
    execFileSync(FF, ['-y', '-v', 'error', '-f', 'lavfi', '-i', lav, '-af', 'volume=4', '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', f]); return f; };
  const F = { tA: tone('a440.wav', 'sine=frequency=440:sample_rate=48000:duration=6'),
    tB: tone('b1000.wav', 'sine=frequency=1000:sample_rate=48000:duration=6'),
    tC: tone('c440-1000.wav', 'aevalsrc=if(lt(t\\,3)\\,sin(2*PI*440*t)\\,sin(2*PI*1000*t))/8:s=48000:d=6') };
  for (const k in F) await addWavMedia(p, F[k], { name: k + '.wav', type: 'video', id: k });
  // Hann-windowed Goertzel: amplitude of f over [a,b) (same code in the page and here)
  const GZ = (d, f, a, b, SR = 48000) => { const i0 = Math.round(a * SR), n = Math.round((b - a) * SR), w = 2 * Math.cos(2 * Math.PI * f / SR);
    let s1 = 0, s2 = 0, ws = 0; for (let i = 0; i < n; i++) { const h = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)); ws += h; const s = (d[i0 + i] || 0) * h + w * s1 - s2; s2 = s1; s1 = s; }
    return 2 * Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - w * s1 * s2)) / ws; };
  await E((F, gz) => {
    window.GZ = eval('(' + gz + ')');
    for (const m of state.media) if (F[m.id]) { els[m.id] = new Audio(m.url); m.hasAudio = true; m._file = F[m.id]; }
    window.vibeNative = window.vibeNative || {};
    window.XA = {
      set: (clips) => { state.clips = clips.map(o => { const c = makeClip(Object.assign({ type: 'video', track: 'V1', name: 'x' }, o, { props: Object.assign(defaultProps(), o.props || {}) }));
        if (o.id) c.id = o.id; if (o.linkId) c.linkId = o.linkId; return c; }); state.muted = {}; state.solo = {}; },
      // levels (amplitude) of 440/880/1000 Hz at the given timeline seconds (±50 ms)
      lv: (d, ts) => ts.map(t => ({ t, a: GZ(d, 440, t - 0.05, t + 0.05), a2: GZ(d, 880, t - 0.05, t + 0.05), b: GZ(d, 1000, t - 0.05, t + 0.05) })),
      mix: async (D, ts) => { const b = await renderAudioOffline(D, 48000); return b ? XA.lv(b.getChannelData(0), ts) : null; },
      spec: (D) => { for (const m of state.media) if (m._file) m.proxyPath = 'file://' + m._file; const s = buildAudioMixSpec(D); for (const m of state.media) delete m.proxyPath; return s; },
    };
  }, F, GZ.toString());
  const ffMix = (spec, ts) => { spec.clips.forEach(c => { c.channels = 1; }); const af = buildAudioFilter(spec, 0), out = path.join(dir, 'o.f32');
    execFileSync(FF, ['-y', '-v', 'error', ...af.inputs, '-filter_complex', af.filter, '-map', af.outLabel, '-t', String(spec.duration), '-ar', '48000', '-ac', '2', '-f', 'f32le', out]);
    const b = fs.readFileSync(out), f = new Float32Array(b.buffer, b.byteOffset, b.length / 4), L = new Float32Array(f.length / 2);
    for (let i = 0; i < L.length; i++)L[i] = f[2 * i]; return ts.map(t => ({ t, a: GZ(L, 440, t - 0.05, t + 0.05), a2: GZ(L, 880, t - 0.05, t + 0.05), b: GZ(L, 1000, t - 0.05, t + 0.05) })); };
  const dB = x => 20 * Math.log10(Math.max(1e-9, x / 0.5));   // relative to the full tone
  const TS = [1.5, 2.25, 2.5, 2.75, 3.5];                       // A alone, ¼, ½, ¾ through the 1 s Dissolve at 2 s, B alone
  // equal-power law: A = cos(πu/2), B = sin(πu/2); expected dB at u = ¼, ½, ¾
  const EP = u => [dB(0.5 * Math.cos(Math.PI * u / 2)), dB(0.5 * Math.sin(Math.PI * u / 2))];
  const xfOK = (L, tag, fA = 'a') => {   // L = levels at TS
    const [s, q1, h, q3, e] = L, ok = {
      alone: dB(s[fA]) > -0.5 && dB(s.b) < -40 && dB(e.b) > -0.5 && dB(e[fA]) < -40,
      half: Math.abs(dB(h[fA]) - dB(h.b)) < 0.5 && Math.abs(dB(h[fA]) - EP(0.5)[0]) < 0.6,
      curve: [[q1, 0.25], [q3, 0.75]].every(([x, u]) => Math.abs(dB(x[fA]) - EP(u)[0]) < 0.8 && Math.abs(dB(x.b) - EP(u)[1]) < 0.8),
    };
    R['axfade: ' + tag + ' dB'] = L.map(x => [x.t, +dB(x[fA]).toFixed(2), +dB(x.b).toFixed(2)]);
    return ok.alone && ok.half && ok.curve;
  };
  const DIFF = [{ id: 'A', mediaId: 'tA', start: 0, duration: 2, inPoint: 0 }, { id: 'B', mediaId: 'tB', start: 2, duration: 2, inPoint: 0, props: { transIn: 'dissolve', transInDur: 1 } }];
  const SAME = [{ id: 'A', mediaId: 'tC', start: 0, duration: 2, inPoint: 0 }, { id: 'B', mediaId: 'tC', start: 2, duration: 2, inPoint: 3.5, props: { transIn: 'dissolve', transInDur: 1 } }];

  // 1. offline mix (browser exports): two media, and one media split in two
  const off = await E(async (DIFF, SAME, TS) => { const o = {};
    XA.set(DIFF); o.diff = await XA.mix(4.5, TS);
    XA.set(SAME); o.same = await XA.mix(4.5, TS);
    XA.set(DIFF.map(c => Object.assign({}, c, { props: Object.assign({}, c.props, { transIn: 'none' }) }))); o.none = await XA.mix(4.5, [2.5]);
    return o; }, DIFF, SAME, TS);
  T('1 offline mix: mid-Dissolve both tones at equal power (−3 dB), equal-power curve, one tone outside', xfOK(off.diff, 'offline'));
  T('1 offline mix: a clip split in two (one media) crossfades the same way', xfOK(off.same, 'offline same media'));
  T('1 no transition: a plain cut (A silent after it)', dB(off.none[0].a) < -40 && dB(off.none[0].b) > -0.5);

  // 2. FFmpeg graph (desktop export): the app's spec through audio-filter.js and real FFmpeg
  const sp = await E((DIFF, SAME) => { XA.set(DIFF); const d = XA.spec(4.5); XA.set(SAME); const s = XA.spec(4.5); return { d, s, sup: _audioSpecSupported() }; }, DIFF, SAME);
  T('2 spec: the tail is a clip of its own and A/B carry the crossfade curve', sp.sup && sp.d.clips.length === 3 && sp.d.clips.every(c => c.env) && Math.abs(sp.d.clips[2].start - 2) < 1e-9 && Math.abs(sp.d.clips[2].inPoint - 2) < 1e-9);
  T('2 FFmpeg mix: mid-Dissolve both tones at equal power, equal-power curve, one tone outside', xfOK(ffMix(sp.d, TS), 'ffmpeg'));
  T('2 FFmpeg mix: one media split in two', xfOK(ffMix(sp.s, TS), 'ffmpeg same media'));

  // 3. linked sound clips (Detach audio / Merge & sync): muted pictures, sound on A1
  const lk = await E(async (TS) => { const o = {};
    const L = (link) => [{ id: 'A', mediaId: 'tA', start: 0, duration: 2, props: { muteClip: true }, linkId: link && 'L1' },
      { id: 'B', mediaId: 'tB', start: 2, duration: 2, props: { muteClip: true, transIn: 'dissolve', transInDur: 1 }, linkId: link && 'L2' },
      { id: 'A2', type: 'audio', track: 'A1', mediaId: 'tA', start: 0, duration: 2, linkId: link && 'L1' },
      { id: 'B2', type: 'audio', track: 'A1', mediaId: 'tB', start: 2, duration: 2, linkId: link && 'L2' }];
    XA.set(L(true)); o.mix = await XA.mix(4.5, TS); o.spec = XA.spec(4.5);
    XA.set(L(false)); o.unlinked = await XA.mix(4.5, [2.5]);
    return o; }, TS);
  T('3 linked audio clips crossfade with their pictures (offline)', xfOK(lk.mix, 'linked offline') && lk.spec.clips.length === 3);
  T('3 linked audio clips crossfade with their pictures (FFmpeg)', xfOK(ffMix(lk.spec, TS), 'linked ffmpeg'));
  T('3 unlinked audio clips keep a plain cut (audio clips have no transitions)', dB(lk.unlinked[0].a) < -40 && dB(lk.unlinked[0].b) > -0.5);

  // 4. speed, source edge, fades, volume, mute
  const more = await E(async () => { const o = {};
    // pitch-changing 2× speed: A sounds at 880 Hz and its tail continues at 2× (still 880 Hz)
    XA.set([{ id: 'A', mediaId: 'tA', start: 0, duration: 1, props: { speed: 2, preservePitch: false } }, { id: 'B', mediaId: 'tB', start: 1, duration: 2, props: { transIn: 'dissolve', transInDur: 1 } }]);
    o.rec = await XA.mix(3, [0.5, 1.5]);
    XA.set([{ id: 'A', mediaId: 'tA', start: 0, duration: 1, props: { speed: 2 } }, { id: 'B', mediaId: 'tB', start: 1, duration: 2, props: { transIn: 'dissolve', transInDur: 1 } }]);
    o.pp = await XA.mix(3, [0.5, 1.5]); o.ppTail = _axfPlan().tails.map(t => [t.inPoint, t.duration, t.props.speed]);
    // source runs out 0.5 s into the transition: A stops there, B unaffected
    XA.set([{ id: 'A', mediaId: 'tA', start: 0, duration: 2, inPoint: 3.5 }, { id: 'B', mediaId: 'tB', start: 2, duration: 2, props: { transIn: 'dissolve', transInDur: 1 } }]);
    o.edge = await XA.mix(4.5, [2.25, 2.75]); o.edgeTail = _axfPlan().tails[0].duration;
    // long clip fades: the smaller of fade and crossfade (not the product); A's fade out ends where its sound ends
    XA.set([{ id: 'A', mediaId: 'tA', start: 0, duration: 2, props: { fadeOut: 2 } }, { id: 'B', mediaId: 'tB', start: 2, duration: 2, props: { fadeIn: 2, transIn: 'dissolve', transInDur: 1 } }]);
    o.fades = await XA.mix(4.5, [1.5, 2.5, 3.5]);
    // a short fade out on A changes nothing
    XA.set([{ id: 'A', mediaId: 'tA', start: 0, duration: 2, props: { fadeOut: 0.2 } }, { id: 'B', mediaId: 'tB', start: 2, duration: 2, props: { transIn: 'dissolve', transInDur: 1 } }]);
    o.short = await XA.mix(4.5, [2.5]);
    // volume 0.5 on A carries into its tail; a muted A has a silent tail; a muted track too
    XA.set([{ id: 'A', mediaId: 'tA', start: 0, duration: 2, props: { volume: 0.5 } }, { id: 'B', mediaId: 'tB', start: 2, duration: 2, props: { transIn: 'dissolve', transInDur: 1 } }]);
    o.vol = await XA.mix(4.5, [2.5]);
    state.clips[0].props.muteClip = true; o.mute = await XA.mix(4.5, [2.5]);
    // a photo/color B: A's sound fades out under it
    XA.set([{ id: 'A', mediaId: 'tA', start: 0, duration: 2 }, { id: 'B', type: 'color', start: 2, duration: 2, props: { transIn: 'dissolve', transInDur: 1 } }]);
    o.color = await XA.mix(4.5, [2.5, 3.2]);
    return o; });
  T('4 pitch-changing speed: the tail keeps A\'s end speed (880 Hz through the transition)', dB(more.rec[0].a2) > -0.5 && Math.abs(dB(more.rec[1].a2) - EP(0.5)[0]) < 0.8 && dB(more.rec[1].a) < -30);
  T('4 pitch kept at 2×: tail continues from source 2 s at 2× (440 Hz)', dB(more.pp[0].a) > -1 && Math.abs(dB(more.pp[1].a) - EP(0.5)[0]) < 1 && JSON.stringify(more.ppTail) === '[[2,1,2]]');
  T('4 source edge: the tail stops where the recording ends', Math.abs(more.edgeTail - 0.5) < 1e-6 && Math.abs(dB(more.edge[0].a) - EP(0.25)[0]) < 0.8 && dB(more.edge[1].a) < -40 && Math.abs(dB(more.edge[1].b) - EP(0.75)[1]) < 0.8);
  // fades: A at 1.5 = (3−1.5)/2 = 0.75 (fade now ends at 3); at 2.5 min(0.25, 0.707) = 0.25; B at 2.5 min(0.25, 0.707) = 0.25; at 3.5 = 0.75
  const fz = more.fades, near = (x, g) => Math.abs(dB(x) - dB(0.5 * g)) < 0.6;
  T('4 long fades combine as the smaller curve (no double fade); A\'s fade out ends with its sound', near(fz[0].a, 0.75) && near(fz[1].a, 0.25) && near(fz[1].b, 0.25) && near(fz[2].b, 0.75));
  T('4 a fade out shorter than the transition changes nothing', Math.abs(dB(more.short[0].a) - EP(0.5)[0]) < 0.6);
  T('4 volume carries into the tail; mute silences it', near(more.vol[0].a, 0.5 * Math.SQRT1_2) && near(more.vol[0].b, Math.SQRT1_2) && dB(more.mute[0].a) < -40 && near(more.mute[0].b, Math.SQRT1_2));
  T('4 photo/color B: A\'s sound fades out under it', near(more.color[0].a, Math.SQRT1_2) && near(more.color[1].a, Math.cos(Math.PI * 0.6)));

  // 5. live preview: the gains the preview sets while playing (Web Audio nodes / aux element)
  const live = await E(async (DIFF, SAME) => { const o = {}, sl = ms => new Promise(r => setTimeout(r, ms));
    ensureAudioGraph();
    const g = key => { const n = audioNodes[key]; return n && n.gain ? n.gain.gain.value : null; };
    // playing, the render loop moves the playhead on: read the gains and the time it set them for together
    const at = async (t, bk, ak) => { state.playing = true; state.time = t; syncMediaPlayback(); await sl(30); state.time = t; syncMediaPlayback();
      const u = (state.time - 2) / 1; return { b: g(bk), a: g(ak), u, wb: Math.sin(Math.PI / 2 * Math.min(1, u)), wa: Math.cos(Math.PI / 2 * Math.min(1, u)) }; };
    try {
      XA.set(DIFF);
      o.d = await at(2.5, 'tB', 'tA'); o.d.aT = els.tA.currentTime;
      o.d25 = await at(2.25, 'tB', 'tA');
      o.d35 = await at(3.5, 'tB', 'tA');
      XA.set(SAME);
      await at(1.7, 'tC', 'aux:A~xf'); o.pre = { aux: !!_auxEls['A~xf'], t: _auxEls['A~xf'] && _auxEls['A~xf'].currentTime };
      o.s = await at(2.5, 'tC', 'aux:A~xf'); o.s.aT = _auxEls['A~xf'] && _auxEls['A~xf'].currentTime;
    } finally { state.playing = false; _previewVoicesStop(); for (const el of Object.values(els)) try { el.pause(); } catch (e) {} }
    return o; }, DIFF, SAME);
  R['axfade: live'] = live;
  const c45 = Math.SQRT1_2, nr = (x, v) => typeof x === 'number' && Math.abs(x - v) < 0.01;
  const curve = x => x && nr(x.b, x.wb) && nr(x.a, x.wa);
  T('5 preview (two media): B at sin, A\'s continued sound at cos on its own element, past its out point', curve(live.d) && Math.abs(live.d.u - 0.5) < 0.1 && live.d.aT > 2.2
    && curve(live.d25) && Math.abs(live.d25.u - 0.25) < 0.1 && nr(live.d35.b, 1));
  T('5 preview (one media split): A\'s tail pre-rolled on an extra element before the cut, then at cos', live.pre.aux && Math.abs(live.pre.t - 2) < 0.05 && curve(live.s) && Math.abs(live.s.u - 0.5) < 0.1 && live.s.aT > 2.2);
  T('no page errors', app.errors.length === 0);
  if (app.errors.length) R['axfade: errors'] = app.errors.slice(0, 5);
}]);

/* ========================= section: samemedia =========================
 * Two ordinary video clips of the SAME file on screen at once (picture-in-
 * picture on V1/V2, a freeze frame over its own clip, overlapping copies): one
 * clip keeps the main decoder els[mediaId], every other one draws from its own
 * hidden decoder (_smUse). ramp25.webm: frame k is a flat gray of level ≈ 20+2k,
 * so the level says exactly which source frame is showing. V2 clips are scaled
 * to 0.4 in the middle: the edge (x=0.1) shows V1, the center V2. */
SECTIONS.push(['samemedia', async (app) => {
  const p = app.page, E = (f, ...a) => p.evaluate(f, ...a), T = (k, ok) => check('samemedia: ' + k, ok);
  const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
  const FF = path.join(__dirname, '..', 'desktop', 'bin', 'ffmpeg' + (process.platform === 'win32' ? '.exe' : ''));
  const b64 = f => fs.readFileSync(f).toString('base64');
  await p.setViewport({ width: 1400, height: 900 });
  const setup = await E(async (ramp) => {
    const bytes = Uint8Array.from(atob(ramp), c => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: 'video/webm' }));
    const el = await loadMediaEl('video', url); els.r = el; _wireSeekRedraw(el);
    state.media = [{ id: 'r', type: 'video', name: 'r', url, duration: el.duration, w: 64, h: 36, srcFps: 25 }];
    state.project.fps = 30; state.playing = false;
    const S = _pbSampler('r'), tmp = document.createElement('canvas'), lev = [];
    const g = cvs => cvs.getContext('2d').getImageData(Math.floor(cvs.width / 2), Math.floor(cvs.height / 2), 1, 1).data[1];
    for (let k = 0; k < 100; k++) { await _pbGrab(S, (k + 0.5) / 25, tmp); lev.push(g(tmp)); }
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const hid = () => [...Object.values(els), ..._smUse.values(), ..._xfUse.values()];
    window.SM = {
      lev, sleep, bytes,
      L: s => lev[Math.max(0, Math.min(99, Math.floor(s * 25 + 1e-6)))],
      W: (c, t) => SM.L(srcTimeFor(c, t)),   // the level clip c must show at t
      px: (fx = 0.5) => { const c = document.getElementById('preview'); return c.getContext('2d').getImageData(Math.floor(c.width * fx), Math.floor(c.height / 2), 1, 1).data[1]; },
      set: (clips) => { for (const id of [..._smUse.keys()]) _hdRelease(_smUse, id); for (const k in _smPrev) delete _smPrev[k];
        state.clips = clips.map(o => { const c = makeClip(Object.assign({ type: 'video', track: 'V1', mediaId: 'r' }, o, { props: Object.assign(defaultProps(), o.props || {}) }));
          if (o.id) c.id = o.id; if (o.freezeAt != null) { c.freeze = true; c.freezeAt = o.freezeAt; } return c; });
        state.selection = null; state.selExtra = []; if (typeof proCmpTouched === 'function') proCmpTouched(); renderTimeline(); return state.clips; },
      byId: id => state.clips.find(c => c.id === id),
      idle: async () => { for (let i = 0; i < 100 && hid().some(v => v.seeking); i++) await sleep(20); await sleep(150); },
      paused: async (t, fx) => { state.playing = false; state.exporting = false; setTime(t);
        for (let i = 0; i < 60; i++) { syncMediaPlayback(); await sleep(40); if (i > 2 && hid().every(v => !v.seeking && v.readyState >= 2)) break; }
        await sleep(80); drawFrame(); return fx == null ? [SM.px(0.1), SM.px(0.5)] : SM.px(fx); },
      precise: async (t) => { await SM.idle(); state.exporting = true; state.time = t;
        try { await seekMediaExact(t); if (proBlendUsed()) await proBlendPrepare(t); drawFrame(); return [SM.px(0.1), SM.px(0.5)]; } finally { state.exporting = false; } },
      cold: () => { for (const id of [..._smUse.keys()]) _hdRelease(_smUse, id); for (const u in _xfPool) { for (const v of _xfPool[u]) { try { v.removeAttribute('src'); v.load(); } catch (e) { } } delete _xfPool[u]; } },
      count: () => _smUse.size + Object.values(_xfPool).reduce((n, l) => n + l.length, 0),
    };
    return { steps: lev.slice(1).every((v, i) => v >= lev[i]) && lev[99] - lev[0] > 150 };
  }, b64(path.join(__dirname, 'fixtures', 'blend', 'ramp25.webm')));
  T('fixture decodes (ramp levels rise)', setup.steps);
  const near = (a, b, tol = 4) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= tol;
  const both = (got, w) => Array.isArray(got) && near(got[0], w[0]) && near(got[1], w[1]);
  const V2 = { scale: 0.4 };

  // 1. picture-in-picture of one file: V1 = src 0.., V2 = src 2.. (listed FIRST, so array order would have given it els)
  const pip = await E(async (V2) => {
    const [Q, P] = SM.set([{ id: 'Q', track: 'V2', start: 0.52, duration: 3, inPoint: 2, props: V2 }, { id: 'P', start: 0, duration: 4, inPoint: 0 }]);
    const t = 1.22, w = [SM.W(P, t), SM.W(Q, t)], o = { w };
    SM.cold(); o.precise = await SM.precise(t);
    o.paused = await SM.paused(t);
    o.owner = Math.abs(els.r.currentTime - srcTimeFor(P, t)) < 0.02;
    const q = _smUse.get('Q'); o.qdec = !!q && q !== els.r && q.muted && Math.abs(q.currentTime - srcTimeFor(Q, t)) < 0.02;
    o.t2 = 2.9; o.w2 = [SM.W(P, 2.9), SM.W(Q, 2.9)]; o.precise2 = await SM.precise(2.9);
    o.pre = await SM.precise(0.3); o.wpre = SM.W(P, 0.3); o.relPre = _smUse.size === 0;    // P alone: no second decoder
    return o; }, V2);
  T('1 PiP of one file: Precise frame shows each clip\'s own source moment (edge = V1, center = V2)', both(pip.precise, pip.w) && both(pip.precise2, pip.w2) && Math.abs(pip.w[0] - pip.w[1]) > 30);
  T('1 PiP of one file: paused preview shows both correctly', both(pip.paused, pip.w));
  T('1 the lowest track keeps the main decoder; the other clip gets its own muted decoder', pip.owner && pip.qdec);
  T('1 a clip alone on screen uses only the main decoder', near(pip.pre[0], pip.wpre) && pip.relPre);

  // 2. the clip already playing keeps the main decoder when another enters (even on a higher... or lower track)
  const sticky = await E(async (V2) => {
    const [X, Y] = SM.set([{ id: 'X', track: 'V2', start: 0, duration: 4, inPoint: 0, props: V2 }, { id: 'Y', start: 1, duration: 3, inPoint: 2 }]);
    await SM.paused(0.5); const o = {};
    const t = 1.62; o.px = await SM.paused(t); o.w = [SM.W(Y, t), SM.W(X, t)];
    o.xOwns = Math.abs(els.r.currentTime - srcTimeFor(X, t)) < 0.02 && _smUse.has('Y') && !_smUse.has('X');
    return o; }, V2);
  T('2 the clip that had the main decoder keeps it when a lower-track clip of the same file enters', sticky.xOwns && both(sticky.px, sticky.w));

  // 3. overlapping exact copies (blurred-background look): same moment → they share els, no extra decoder
  const dup = await E(async (V2) => {
    const [A, B] = SM.set([{ id: 'A', start: 0, duration: 3, inPoint: 1 }, { id: 'B', track: 'V2', start: 0, duration: 3, inPoint: 1, props: V2 }]);
    const t = 1.02, o = { w: [SM.W(A, t), SM.W(B, t)] };
    o.precise = await SM.precise(t); o.paused = await SM.paused(t); o.none = _smUse.size === 0;
    return o; }, V2);
  T('3 exact copies at the same moment share the main decoder (no extra decoder) and both are right', both(dup.precise, dup.w) && both(dup.paused, dup.w) && dup.none);

  // 4. freeze frame over its own clip, a reversed and a 2× clip on V2 (Precise + paused)
  const kinds = await E(async (V2) => {
    const o = {}, t = 1.62;
    let [P, F] = SM.set([{ id: 'P', start: 0, duration: 4, inPoint: 0 }, { id: 'F', track: 'V2', start: 1, duration: 2, inPoint: 3, freezeAt: 3.02, props: V2 }]);
    o.fw = [SM.W(P, t), SM.W(F, t)]; o.fp = await SM.precise(t); o.fq = await SM.paused(t);
    [P, F] = SM.set([{ id: 'P', start: 0, duration: 4, inPoint: 0 }, { id: 'R', track: 'V2', start: 1, duration: 2, inPoint: 1.5, props: Object.assign({ reverse: true }, V2) }]);
    o.rw = [SM.W(P, t), SM.W(F, t)]; o.rp = await SM.precise(t); o.rq = await SM.paused(t);
    [P, F] = SM.set([{ id: 'P', start: 0, duration: 4, inPoint: 0 }, { id: 'S', track: 'V2', start: 1, duration: 1, inPoint: 2, props: Object.assign({ speed: 2 }, V2) }]);
    o.sw = [SM.W(P, t), SM.W(F, t)]; o.sp = await SM.precise(t); o.sq = await SM.paused(t);
    return o; }, V2);
  T('4 a freeze frame over its own clip: both right', both(kinds.fp, kinds.fw) && both(kinds.fq, kinds.fw));
  T('4 a reversed copy over the clip: both right', both(kinds.rp, kinds.rw) && both(kinds.rq, kinds.rw));
  T('4 a 2× copy over the clip: both right', both(kinds.sp, kinds.sw) && both(kinds.sq, kinds.sw));

  // 5. compound clips: the PiP pair inside one compound, and one clip inside a compound over the same file outside
  const cmp = await E(async (V2) => {
    const o = {}, t = 1.22;
    let [Q, P] = SM.set([{ id: 'Q', track: 'V2', start: 0.52, duration: 3, inPoint: 2, props: V2 }, { id: 'P', start: 0, duration: 4, inPoint: 0 }]);
    o.w = [SM.W(P, t), SM.W(Q, t)];
    state.selection = 'P'; state.selExtra = ['Q']; const c1 = proMakeCompound(); o.one = state.clips.length === 1 && c1 && c1.type === 'compound';
    SM.cold(); o.inside = await SM.precise(t); o.insideP = await SM.paused(t);
    [Q, P] = SM.set([{ id: 'Q', track: 'V2', start: 0.52, duration: 3, inPoint: 2, props: V2 }, { id: 'P', start: 0, duration: 4, inPoint: 0 }]);
    state.selection = 'Q'; state.selExtra = []; const c2 = proMakeCompound(); o.two = state.clips.length === 2 && c2 && c2.type === 'compound';
    o.mixed = await SM.precise(t); o.mixedP = await SM.paused(t);
    o.ids = [..._smUse.keys()];
    return o; }, V2);
  R['samemedia: compound'] = cmp;
  T('5 inside a compound clip the PiP pair shows both source moments', cmp.one && both(cmp.inside, cmp.w) && both(cmp.insideP, cmp.w));
  T('5 a clip inside a compound over the same file outside it: both right', cmp.two && both(cmp.mixed, cmp.w) && both(cmp.mixedP, cmp.w) && cmp.ids.length === 1);

  // 6. chroma pick / tracking read the element the compositor draws; frame blending on the second clip
  const misc = await E(async (V2) => {
    const o = {}, t = 1.22;
    const [Q, P] = SM.set([{ id: 'Q', track: 'V2', start: 0.52, duration: 3, inPoint: 2, props: V2 }, { id: 'P', start: 0, duration: 4, inPoint: 0 }]);
    await SM.paused(t);
    const lvl = f => { const k = document.createElement('canvas'); k.width = 8; k.height = 8; const g = k.getContext('2d'); g.drawImage(f.el, 0, 0, 8, 8); return g.getImageData(4, 4, 1, 1).data[1]; };
    const fq = clipSourceFrame(Q, t), fp = clipSourceFrame(P, t);
    o.q = fq && fq.el === _smUse.get('Q') && near(lvl(fq), SM.W(Q, t)); o.p = fp && fp.el === els.r && near(lvl(fp), SM.W(P, t));
    function near(a, b) { return Math.abs(a - b) <= 4; }
    // frame blending on the V2 copy at 0.4×: the blended mix of ITS source frames
    Q.props.speed = 0.4; Q.props.frameBlend = true; Q.inPoint = 2.01;
    const tb = 1.3, plan = proBlendPlan(Q, tb); o.plan = plan && plan.length;
    const wsum = plan ? plan.reduce((s, [, w]) => s + w, 0) : 1; o.bw = plan ? plan.reduce((s, [x, w]) => s + w * SM.L(x), 0) / wsum : null;
    o.bp = await SM.precise(tb); o.bpw = SM.W(P, tb);
    return o; }, V2);
  T('6 clipSourceFrame (chroma Pick from frame, tracking) returns each clip\'s own decoder at its own moment', misc.q && misc.p);
  T('6 frame blending on the second clip blends ITS source frames', misc.plan >= 2 && near(misc.bp[1], misc.bw, 5) && near(misc.bp[0], misc.bpw));

  // 7. playback: the second decoder is pre-rolled before its clip enters, then plays in step; released afterwards
  const play = await E(async (V2) => {
    const [P, Q] = SM.set([{ id: 'P', start: 0, duration: 4, inPoint: 0 }, { id: 'Q', track: 'V2', start: 1.0, duration: 1.2, inPoint: 2.2, props: V2 }]);
    await SM.paused(0.3);
    const samples = [], draw0 = window.drawFrame; let pre = null;
    window.drawFrame = function () { draw0(); const t = state.time; if (!state.playing) return;
      const q = _smUse.get('Q');
      if (t > 0.6 && t < 0.98 && q && !pre) pre = { t, cur: q.currentTime, paused: q.paused };
      if (t < 1.1 || t > 2.1) return;
      samples.push({ t: +t.toFixed(3), pc: +els.r.currentTime.toFixed(3), qc: q ? +q.currentTime.toFixed(3) : null, seeking: !!(q && q.seeking) || els.r.seeking,
        px: [SM.px(0.1), SM.px(0.5)], want: q ? [SM.L(els.r.currentTime), SM.L(q.currentTime)] : null, playing: !!q && !q.paused }); };
    const t0 = performance.now(); setPlaying(true); state.rate = 0.5;   // half speed: more drawn frames per timeline second on a slow machine
    try { while (state.playing && state.time < 2.4 && performance.now() - t0 < 12000) await SM.sleep(30); }
    finally { window.drawFrame = draw0; }
    setPlaying(false); state.rate = 1; await SM.sleep(80);
    const o = { samples, pre, released: _smUse.size === 0, total: SM.count() };
    await SM.paused(3.0); o.after = _smUse.size === 0;
    return o; }, V2);
  const S = play.samples.filter(s => s.qc != null && !s.seeking);
  const drift = S.length ? Math.max(...S.map(s => Math.abs(s.qc - (2.2 + s.t - 1.0)))) : 9, pdrift = S.length ? Math.max(...S.map(s => Math.abs(s.pc - s.t))) : 9;
  const good = S.filter(s => near(s.px[0], s.want[0], 6) && near(s.px[1], s.want[1], 6)).length;
  R['samemedia: play'] = { drift: +drift.toFixed(3), main: +pdrift.toFixed(3), frames: S.length, good, pre: play.pre, total: play.total };
  T('7 playback: the second clip\'s decoder is pre-rolled (parked on its first frame) before it enters', play.pre && play.pre.paused && Math.abs(play.pre.cur - 2.2) < 0.05);
  T('7 playback: the second decoder plays in step (drift < 0.25 s or no worse than the main one) and each clip shows its own frame', S.length >= 2 && drift < Math.max(0.25, pdrift + 0.1) && S.some(s => s.playing) && good >= S.length * 0.6);
  T('7 decoders released when the clips no longer overlap (idle pool ≤ 2)', play.released && play.after && play.total <= 2);
  if (fails.some(f => f.startsWith('samemedia: 7'))) R['samemedia: play samples'] = play.samples.slice(0, 12);

  // 8. proxy ↔ original swaps ("Play the original", full-quality export): the second decoder follows the file; old ones are dropped
  const swap = await E(async (V2) => {
    const [Q, P] = SM.set([{ id: 'Q', track: 'V2', start: 0.52, duration: 3, inPoint: 2, props: V2 }, { id: 'P', start: 0, duration: 4, inPoint: 0 }]);
    const t = 1.22, o = { w: [SM.W(P, t), SM.W(Q, t)] };
    await SM.paused(t); const url0 = els.r.currentSrc || els.r.src;
    const url1 = URL.createObjectURL(new Blob([SM.bytes], { type: 'video/webm' })), el1 = await loadMediaEl('video', url1), el0 = els.r;
    els.r = el1; _wireSeekRedraw(el1);
    o.px = await SM.precise(t); o.pxP = await SM.paused(t);
    const q = _smUse.get('Q'); o.follows = !!q && q._xfUrl === (el1.currentSrc || el1.src);
    o.oldGone = !_xfPool[url0] && ![..._smUse.values()].some(v => v._xfUrl === url0);
    els.r = el0; await SM.paused(t); o.back = !!_smUse.get('Q') && _smUse.get('Q')._xfUrl === url0 && !_xfPool[url1];
    return o; }, V2);
  T('8 swapping the file behind the media (proxy ↔ original): the second decoder follows it, the old ones are dropped', both(swap.px, swap.w) && both(swap.pxP, swap.w) && swap.follows && swap.oldGone && swap.back);

  // 9. many overlapping copies, then the media removed: nothing leaks
  const leak = await E(async () => {
    const L = []; for (let i = 0; i < 4; i++) L.push({ id: 'C' + i, track: i ? 'V2' : 'V1', start: 0, duration: 3, inPoint: i * 0.8, props: { scale: 0.3 + 0.1 * i } });
    SM.set(L); await SM.precise(1.0); await SM.paused(1.0); const o = { busy: _smUse.size };
    await SM.paused(3.5); o.idle = SM.count(); o.none = _smUse.size === 0;
    const keep = els.r; delete els.r; syncMediaSeek(); o.swept = SM.count() === 0; els.r = keep;
    return o; });
  T('9 several copies each get a decoder; all released after, at most two kept idle, none once the file is gone', leak.busy === 3 && leak.none && leak.idle <= 2 && leak.swept);

  // 10. SOUND of two clips of one file at once is unchanged: each heard once, from the right source moment —
  //     offline mix, FFmpeg graph, and the preview (the owner on the main element, the other on its own aux element; hidden decoders are muted)
  if (fs.existsSync(FF)) {
    const { addWavMedia } = require('./lib/fixture-page'), { buildAudioFilter } = require('../desktop/audio-filter.js');
    const dir = path.join(__dirname, 'out', 'samemedia'); fs.mkdirSync(dir, { recursive: true });
    const wav = path.join(dir, 'c440-1000.wav');
    execFileSync(FF, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'aevalsrc=if(lt(t\\,3)\\,sin(2*PI*440*t)\\,sin(2*PI*1000*t))/2:s=48000:d=6', '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', wav]);
    await addWavMedia(p, wav, { name: 'tc.wav', type: 'video', id: 'tc' });
    const GZ = (d, f, a, b, SR = 48000) => { const i0 = Math.round(a * SR), n = Math.round((b - a) * SR), w = 2 * Math.cos(2 * Math.PI * f / SR);
      let s1 = 0, s2 = 0, ws = 0; for (let i = 0; i < n; i++) { const h = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)); ws += h; const s = (d[i0 + i] || 0) * h + w * s1 - s2; s2 = s1; s1 = s; }
      return 2 * Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - w * s1 * s2)) / ws; };
    // V1: src 0.. (440 Hz) at volume 0.8; V2: src 3.5.. (1000 Hz) at volume 0.4 — both from 0.5 s to 2 s
    const CL = [{ id: 'P', mediaId: 'tc', start: 0, duration: 2, inPoint: 0, props: { volume: 0.8 } }, { id: 'Q', mediaId: 'tc', track: 'V2', start: 0.5, duration: 1.5, inPoint: 3.5, props: { volume: 0.4 } }];
    const au = await E(async (CL, gz, wav) => {
      const GZ = eval('(' + gz + ')'); const m = state.media.find(x => x.id === 'tc'); m.hasAudio = true; window.vibeNative = window.vibeNative || {};
      els.tc = new Audio(m.url);
      SM.set(CL);
      const lv = (d, t) => ({ a: GZ(d, 440, t - 0.05, t + 0.05), b: GZ(d, 1000, t - 0.05, t + 0.05) });
      const b = await renderAudioOffline(2.5, 48000), d = b.getChannelData(0), o = { off: [lv(d, 0.3), lv(d, 1.2)] };
      m.proxyPath = 'file://' + wav; o.spec = buildAudioMixSpec(2.5); delete m.proxyPath;
      // preview while playing (sound-only element: no picture, so no hidden decoder)
      ensureAudioGraph(); const sl = ms => new Promise(r => setTimeout(r, ms));
      try { state.playing = true; state.time = 1.2; syncMediaPlayback(); await sl(40); state.time = 1.2; syncMediaPlayback();
        const g = k => { const n = audioNodes[k]; return n && n.gain ? n.gain.gain.value : null; };
        o.live = { main: g('tc'), aux: g('aux:Q'), mainT: els.tc.currentTime, auxT: _auxEls.Q && _auxEls.Q.currentTime, hidden: _smUse.size };
      } finally { state.playing = false; _previewVoicesStop(); try { els.tc.pause(); } catch (e) { } }
      // the same with the picture file (ramp25 has no sound track): the second clip's hidden decoder is muted and its sound goes to its aux element
      SM.set([{ id: 'P', start: 0, duration: 4, inPoint: 0 }, { id: 'Q', track: 'V2', start: 0.5, duration: 3, inPoint: 2, props: { scale: 0.4 } }]);
      try { state.playing = true; state.time = 1.2; syncMediaPlayback(); await sl(40); syncMediaPlayback();
        o.vid = { hid: _smUse.size, muted: [..._smUse.values()].every(v => v.muted), aux: !!_auxEls.Q, auxNotHidden: !_auxEls.Q || ![..._smUse.values()].includes(_auxEls.Q) };
      } finally { state.playing = false; _previewVoicesStop(); for (const el of Object.values(els)) try { el.pause(); } catch (e) { } }
      return o; }, CL, GZ.toString(), wav);
    const spec = au.spec; spec.clips.forEach(c => { c.channels = 1; });
    const af = buildAudioFilter(spec, 0), out = path.join(dir, 'o.f32');
    execFileSync(FF, ['-y', '-v', 'error', ...af.inputs, '-filter_complex', af.filter, '-map', af.outLabel, '-t', String(spec.duration), '-ar', '48000', '-ac', '2', '-f', 'f32le', out]);
    const bf = fs.readFileSync(out), f32 = new Float32Array(bf.buffer, bf.byteOffset, bf.length / 4), Lc = new Float32Array(f32.length / 2);
    for (let i = 0; i < Lc.length; i++) Lc[i] = f32[2 * i];
    const ffl = [0.3, 1.2].map(t => ({ a: GZ(Lc, 440, t - 0.05, t + 0.05), b: GZ(Lc, 1000, t - 0.05, t + 0.05) }));
    R['samemedia: sound'] = { off: au.off, ffmpeg: ffl, live: au.live, vid: au.vid, spec: spec.clips.length };
    const lvOK = L => near(L[0].a, 0.4, 0.02) && L[0].b < 0.005 && near(L[1].a, 0.4, 0.02) && near(L[1].b, 0.2, 0.02);   // 0.5 × volume, each once
    T('10 offline mix: each clip of the file heard once at its own volume and source moment', lvOK(au.off));
    T('10 FFmpeg mix: the same (two spec clips)', spec.clips.length === 2 && lvOK(ffl));
    T('10 preview: the owner plays on the main element, the other clip on its own aux element (right volumes and source times)', au.live && near(au.live.main, 0.8, 0.01) && near(au.live.aux, 0.4, 0.01)
      && Math.abs(au.live.mainT - 1.2) < 0.25 && Math.abs(au.live.auxT - 4.2) < 0.25 && au.live.hidden === 0);
    T('10 preview: hidden picture decoders are muted; the second clip\'s sound stays on its aux element', au.vid.hid === 1 && au.vid.muted && au.vid.aux && au.vid.auxNotHidden);
  } else R['samemedia: sound'] = 'skipped (no desktop/bin/ffmpeg)';

  T('no page errors', app.errors.length === 0);
  if (app.errors.length) R['samemedia: errors'] = app.errors.slice(0, 5);
  R['samemedia: values'] = { pip, sticky, dup, kinds, misc, swap, leak };
}]);

/* ========================= section: wedge =========================
   v4.10.3: a media element whose seek never completes (Windows, an MP3 whose clip
   had been muted, deleted and dragged back: <audio> stuck "seeking" at
   readyState 1, silent while the meter moved). The app notices the stall and puts
   a fresh element on the same file in its place; playback seeks no longer pile up. */
SECTIONS.push(['wedge', async (app) => {
  const p = app.page, E = (f, ...a) => p.evaluate(f, ...a), T = (k, ok) => check('wedge: ' + k, ok);
  const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
  const FF = path.join(__dirname, '..', 'desktop', 'bin', 'ffmpeg' + (process.platform === 'win32' ? '.exe' : ''));
  if (!fs.existsSync(FF)) { R['wedge: skipped'] = 'no desktop/bin/ffmpeg'; return; }
  const dir = path.join(__dirname, 'out', 'wedge'); fs.mkdirSync(dir, { recursive: true });
  const mp3 = path.join(dir, 'tone.mp3');
  execFileSync(FF, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '20', '-c:a', 'libmp3lame', '-b:a', '160k', mp3]);
  await E(async (b64) => {
    const o = AudioNode.prototype.connect;   // tap what reaches the speakers
    AudioNode.prototype.connect = function (d, ...a) { const r = o.call(this, d, ...a);
      if (d instanceof AudioDestinationNode) { const c = d.context; if (!c.__tap) { c.__tap = c.createAnalyser(); c.__tap.fftSize = 2048; } o.call(this, c.__tap); } return r; };
    window.RMS = () => { const a = audioCtx && audioCtx.__tap; if (!a) return 0; const d = new Float32Array(a.fftSize); a.getFloatTimeDomainData(d); let s = 0; for (const v of d) s += v * v; return Math.sqrt(s / d.length); };
    await importFiles([new File([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], 'tone.mp3', { type: 'audio/mpeg' })]);
  }, fs.readFileSync(mp3).toString('base64'));
  for (let i = 0; i < 50 && !(await E(() => state.media[0] && !state.media[0].loading && !!els[state.media[0].id])); i++) await sleep(200);
  const playRms = async (ms = 900) => { await E(() => { setPlaying(false); setTime(0.4); setPlaying(true); }); await sleep(ms);   // loudest of 2 s of samples: the page can be busy right after an import
    let r = 0; for (let i = 0; i < 10; i++) { r = Math.max(r, await E(() => RMS())); await sleep(200); } await E(() => setPlaying(false)); await sleep(150); return r; };

  // 1. the reported flow: mute the clip, delete it, add the file back -> sound
  await E(() => addMediaToTimeline(state.media[0], 0, 'A1'));
  const r0 = await playRms();
  await E(() => { const c = state.clips[0]; pushHistory(); c.props.muteClip = true; renderTimeline(); });
  const rMuted = await playRms();
  await E(() => { state.selection = state.clips[0].id; deleteSelected(); addMediaToTimeline(state.media[0], 0, 'A1'); });
  const r1 = await playRms();
  R['wedge: flow rms'] = [r0, rMuted, r1].map(x => +x.toFixed(3));
  T('1 muted, deleted and re-added clip plays with sound (and is silent while muted)', r0 > 0.1 && rMuted < 0.01 && r1 > 0.1);

  // 2. a healthy element is never replaced (normal play, jumps, scrubbing)
  const keep = await E(async () => { const id = state.media[0].id, el = els[id];
    for (const t of [0.5, 7, 3, 12]) { setTime(t); await new Promise(r => setTimeout(r, 120)); }
    setPlaying(true); await new Promise(r => setTimeout(r, 1500)); setTime(9); await new Promise(r => setTimeout(r, 800)); setPlaying(false);
    return els[id] === el; });
  T('2 a healthy element is kept through playback, jumps and scrubbing', keep);

  // 3. a wedged element (seeking forever at readyState 1, no sound) is replaced and the clip is heard
  const w = await E(async () => { const id = state.media[0].id, old = els[id];
    setPlaying(false); old.pause();
    Object.defineProperty(old, 'seeking', { get: () => true, configurable: true });
    Object.defineProperty(old, 'readyState', { get: () => 1, configurable: true });
    old.play = () => Promise.resolve(); old.muted = true; old._skT = performance.now() - 3000;
    old._proxyMark = 'kept';   // the app's own markers come along
    setTime(0.4); setPlaying(true); await new Promise(r => setTimeout(r, 1300));
    const el = els[id], n = audioNodes[id];
    const out = { replaced: el !== old, tag: el.tagName, src: el.src === old.src, muted: el.muted, playing: !el.paused, wired: !!(n && n.src && n.src.mediaElement === el),
      oldPaused: old.paused, mark: el._proxyMark, rms: RMS() };
    setPlaying(false); return out; });
  R['wedge: revive'] = w;
  T('3 a wedged element is replaced by a fresh one on the same file, wired to the audio chain', w.replaced && w.tag === 'AUDIO' && w.src && w.wired && w.mark === 'kept');
  T('3 ...and the clip is heard again', w.playing && w.rms > 0.1);

  // 4. playback seeks don't pile up while one is in flight
  const g = await E(() => { let n = 0; const f = { seeking: true, _skA: 0, set currentTime(v) { n++; }, get currentTime() { return 0; } };
    _elSeekTo(f, 1); _elSeekTo(f, 1.1); _elSeekTo(f, 1.2); const a = n; f._skA = performance.now() - 1000; _elSeekTo(f, 2); const b = n; f.seeking = false; _elSeekTo(f, 3); return [a, b, n]; });
  T('4 a seek in flight is not restarted every frame (again after 0.9 s, or once it lands)', g[0] === 1 && g[1] === 2 && g[2] === 3);

  T('no page errors', app.errors.length === 0);
  if (app.errors.length) R['wedge: errors'] = app.errors.slice(0, 5);
}]);

/* ========================= section: stale =========================
   v4.10.4: a Precise export made while Vibe Edit was covered by another window
   (Windows reports it hidden) had ~40% repeated frames: 'seeked' fired, no frame
   was presented (rVFC silent), the 200 ms fallback won and the PREVIOUS frame
   was drawn. Simulated here with a decoder that announces 'seeked' at once but
   only delivers the frame 300 ms later. ramp25.webm: frame k is gray ≈ 20+2k. */
SECTIONS.push(['stale', async (app) => {
  const p = app.page, E = (f, ...a) => p.evaluate(f, ...a), T = (k, ok) => check('stale: ' + k, ok);
  const fs = require('fs'), path = require('path');
  const b64 = fs.readFileSync(path.join(__dirname, 'fixtures', 'blend', 'ramp25.webm')).toString('base64');
  const run = (verify) => E(async (b, verify) => {
    const url = URL.createObjectURL(new Blob([Uint8Array.from(atob(b), c => c.charCodeAt(0))], { type: 'video/webm' }));
    const el = await loadMediaEl('video', url); els.r = el; _wireSeekRedraw(el);
    state.media = [{ id: 'r', type: 'video', name: 'r', url, duration: el.duration, w: 64, h: 36, srcFps: 25 }];
    state.project.fps = 25; state.playing = false;
    state.clips = [makeClip({ type: 'video', track: 'V1', start: 0, duration: 3, mediaId: 'r', name: 'r' })];
    // the lagging decoder: 'seeked' at once, the frame itself 300 ms later, nothing presented
    const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime');
    let want = null;
    Object.defineProperty(el, 'currentTime', { configurable: true, get() { return want != null ? want : desc.get.call(el); },
      set(v) { want = v; setTimeout(() => desc.set.call(el, v), 300); el.dispatchEvent(new Event('seeked')); } });
    el.requestVideoFrameCallback = () => 0;
    const real = window._awaitFreshFrame; if (!verify) window._awaitFreshFrame = async () => true;
    const lev = []; state.exporting = true;
    for (let i = 0; i < 20; i++) { state.time = 0.5 + i / 25; await seekMediaExact(state.time); drawFrame();
      const c = document.getElementById('preview'); lev.push(c.getContext('2d').getImageData(c.width >> 1, c.height >> 1, 1, 1).data[1]); }
    state.exporting = false; window._awaitFreshFrame = real; delete el.currentTime;
    const steps = lev.slice(1).map((v, i) => v - lev[i]);
    return { lev, repeats: steps.filter(d => Math.abs(d) < 1).length, stats: Object.assign({}, _freshStats) };
  }, b64, verify);
  const before = await run(false), after = await run(true);
  R['stale: without check'] = { repeats: before.repeats, lev: before.lev.join(',') };
  R['stale: with check'] = { repeats: after.repeats, lev: after.lev.join(','), stats: after.stats };
  const wrong = before.lev.filter((v, i) => Math.abs(v - after.lev[i]) >= 1).length;
  const rising = after.lev.slice(1).every((v, i) => v - after.lev[i] >= 1 && v - after.lev[i] <= 4);   // one source frame per export frame (≈ +2 gray)
  T('1 (control) without the held-frame check the lagging decoder draws the previous frame', wrong >= 15);
  T('1 with it, every exported frame is the right one and advances by one source frame', after.repeats === 0 && rising && after.stats.stale === 0);
  // Electron: a covered window is not treated as hidden
  const main = fs.readFileSync(path.join(__dirname, '..', 'desktop', 'main.js'), 'utf8');
  T('2 desktop: occlusion detection and occluded-window backgrounding are off', /CalculateNativeWinOcclusion/.test(main) && /disable-backgrounding-occluded-windows/.test(main));
  T('no page errors', app.errors.length === 0);
  if (app.errors.length) R['stale: errors'] = app.errors.slice(0, 5);
}]);

(async () => {
  for (const [name, fn] of SECTIONS) {
    if (process.argv[2] && !process.argv.slice(2).includes(name)) continue;   // node review-fixes.js picture
    const app = await openApp({ asr: false });
    try { await fn(app); } catch (e) { check(name + ': threw ' + e.message, false); }
    await app.close();
  }
  console.log(JSON.stringify(R, null, 1));
  console.log(fails.length ? 'FAIL: ' + fails.join('; ') : 'PASS');
  process.exit(fails.length ? 1 : 0);
})();
