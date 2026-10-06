#!/usr/bin/env node
/* smoke.js — the always-run safety net.
 *
 * Boots the real app in a headless browser and checks that every subsystem is
 * present, a frame actually draws, legacy projects still open, and the UI has no
 * structural faults. Run this after ANY change; it catches the "whole script
 * aborted" class of failure that unit-style checks miss entirely.
 *
 * Usage:  node tests/smoke.js
 */
const { launch, close } = require('./browser');
const path = require('path');

const APP = 'file://' + path.resolve(__dirname, '..', 'vibe-edit.html');

(async () => {
  const browser = await launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  // Errors the app CATCHES and logs (e.g. the render loop's "frame error") never
  // reach pageerror — v4.7 shipped one to the owner's PC that way. Count them too.
  page.on('console', m => { if (m.type() === 'error' && /ReferenceError|TypeError|frame error|is not defined/.test(m.text())) errors.push('console: ' + m.text()); });
  await page.goto(APP);
  await new Promise(r => setTimeout(r, 800));

  const r = await page.evaluate(() => {
    const out = {}, q = s => document.querySelector(s), qa = s => [...document.querySelectorAll(s)];
    out.version = APP_VERSION;

    // every subsystem entry point must exist — a mid-script throw wipes the rest
    out.subsystems = [
      'drawFrame', 'renderTimeline', 'renderInspector', 'splitClip', 'joinSelected',
      'linkSelected', 'groupSelected', 'freezeFrameAt', 'startRoll', 'startSlipSlide',
      'zoomToFit', 'drawMeter', 'drawWave', 'drawVizClip', 'drawCornerPinned',
      'analyzeStabilization', 'analyzeTimelineAudio', 'multicamSync', 'trackMotion',
      'openGuide', 'askExportSource', 'beginFullQualityExport', 'endFullQualityExport',
      'exportInFlight', 'loadProjectJSON', 'serializeProject', 'clipVisibleAt',
      'audioGainDialog', 'makeSplitEdit', 'importFiles'
    ].every(f => typeof window[f] === 'function');

    // a frame really renders
    const img = document.createElement('canvas'); img.width = 64; img.height = 64;
    state.media = [{ id: 'm1', type: 'image', name: 'i', duration: 5, w: 64, h: 64, el: img }];
    state.clips = [makeClip({ type: 'image', track: 'V1', start: 0, duration: 3, name: 'i', mediaId: 'm1' })];
    renderTimeline(); state.time = 1; drawFrame();
    out.drawsFrame = true;

    // corner pin path renders too (it swaps the whole draw routine)
    const c = state.clips[0];
    Object.assign(c.props, { cornerPin: 1, cpTLx: 10, cpTLy: 8 });
    drawFrame(); c.props.cornerPin = 0;
    out.cornerPinDraws = true;

    // projects from the previous app name must still open
    let err = ''; const _t = window.toast; window.toast = (m, k) => { if (k === 'err') err = String(m); };
    loadProjectJSON(JSON.stringify({
      app: 'cutroom', version: 1, name: 'legacy',
      project: { w: 640, h: 360, fps: 30, bg: '#000' },
      clips: [{ id: 'c1', type: 'text', track: 'TX', start: 0, duration: 2, name: 'T',
        props: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, speed: 1 },
        text: { content: 'x', size: 60, color: '#fff', font: 'Impact, sans-serif', align: 'center' } }],
      media: []
    }));
    window.toast = _t;
    out.legacyProjectOpens = state.clips.length === 1 && !/Not a/.test(err);
    out.savesNewFormat = JSON.parse(serializeProject()).app === 'vibe-edit';

    // guide + branding
    openGuide();
    out.guideOpens = !!q('#gdBody') && qa('#gdBody .gditem').length >= 25;
    closeOverlay();
    out.brandMarkPresent = !!q('.brandmark path');

    // ---- structural UI audit (each of these has caused a real bug before) ----
    const ids = {}; qa('[id]').forEach(e => ids[e.id] = (ids[e.id] || 0) + 1);
    out.duplicateIds = Object.keys(ids).filter(k => ids[k] > 1);
    out.noDuplicateIds = out.duplicateIds.length === 0;

    const inter = qa('button,select,input[type=range],input[type=checkbox],input[type=color]')
      .filter(e => e.offsetParent !== null);
    const noTip = inter.filter(e => {
      if ((e.title || '').length > 3) return false;
      const w = e.closest('.ctl,.field,.gif-group,label');
      return !(w && (w.title || '').length > 3) && !e.getAttribute('aria-label');
    });
    out.visibleControls = inter.length;
    out.untooltipped = noTip.map(e => e.id || e.className).slice(0, 10);
    out.allControlsTooltipped = noTip.length === 0;

    out.unlabelledButtons = qa('button').filter(e => e.offsetParent !== null &&
      !e.textContent.trim() && !e.getAttribute('aria-label') && !(e.title || '').length).length;
    out.allButtonsLabelled = out.unlabelledButtons === 0;

    return out;
  });

  // The export panels only exist once the dialog is built, so this runs after.
  // They were once nested inside a hidden parent — invisible to any check that
  // only reads inline styles, which is why it is asserted structurally here.
  const panelCheck = await page.evaluate(async () => {
    const q = s => document.querySelector(s);
    const sleep = ms => new Promise(r2 => setTimeout(r2, ms));
    const el = document.createElement('canvas'); el.width = 64; el.height = 64;
    state.media = [{ id: 'mp', type: 'image', name: 'i', duration: 5, w: 64, h: 64, el }];
    state.clips = [makeClip({ type: 'image', track: 'V1', start: 0, duration: 3, name: 'i', mediaId: 'mp' })];
    renderTimeline();
    q('#exportBtn').click(); await sleep(400);
    const panels = ['#videoPanel', '#gifPanel', '#audioPanel'].map(q).filter(Boolean);
    const ok = panels.length === 3 &&
      panels.every(a => panels.every(b => a === b || !a.contains(b)));
    // v4.7 layout: choices left, live summary + Export button right
    const side = q('.xside'), sumRows = q('#expSum') ? q('#expSum').querySelectorAll('.xr').length : 0;
    const exportLayoutOK = !!side && side.contains(q('#mGo')) && sumRows >= 5 && !q('.xmain').contains(q('#mGo'));
    // Advanced settings must reach the encoder (they were silently dropped before v4.7)
    let got = null; const rp = window.renderPrecise, ae = window.askExportSource;
    window.renderPrecise = cfg => { got = cfg; }; window.askExportSource = async () => 'full';
    window._adv.comp = 'crf'; window._adv.crf = 21; window._adv.preset = 'slow'; window._adv.threads = 'one';
    q('#mGo').click(); await sleep(50);
    window.renderPrecise = rp; window.askExportSource = ae;
    const advReachesEncoder = !!(got && got.adv && got.adv.comp === 'crf' && got.adv.crf === 21 && got.adv.preset === 'slow' && got.adv.threads === 1);
    const defaultPresetWorks = !!(got && got.w === state.project.w && got.h === state.project.h);
    Object.assign(window._adv, { comp: 'bitrate', crf: 18, preset: 'medium', threads: 'all' });
    closeOverlay(true);
    return { exportPanelsFound: panels.length, exportPanelsSiblings: ok, exportLayoutOK, advReachesEncoder, defaultPresetWorks };
  });
  Object.assign(r, panelCheck);

  console.log(JSON.stringify(r, null, 1));
  console.log('pageerrors:', errors.length ? errors : '(none)');
  const fails = Object.keys(r).filter(k => typeof r[k] === 'boolean' && !r[k]);
  console.log(fails.length || errors.length ? ('FAIL: ' + fails.join(',')) : 'PASS');
  await close(browser);
  process.exit(fails.length || errors.length ? 1 : 0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
