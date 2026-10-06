/* fixture-page.js — boot the app with the offline speech environment and helpers
 * for loading WAV fixtures as media. Shared by the AI suites. */
const fs = require('fs');
const path = require('path');
const { launch, close } = require('../browser');
const { installAsrEnv, MODEL_ID } = require('./asr-env');
const APP = 'file://' + path.resolve(__dirname, '..', '..', 'vibe-edit.html');

async function openApp(opts = {}) {
  const browser = await launch(opts);
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  if (opts.asr !== false) await installAsrEnv(page);
  // opts.desktop: the desktop copy (desktop/app/index.html), which has the app/models/ files beside it
  await page.goto(opts.desktop ? 'file://' + path.resolve(__dirname, '..', '..', 'desktop', 'app', 'index.html') : APP); await new Promise(r => setTimeout(r, 600));
  await page.evaluate((m) => { document.getElementById('restoreBar')?.remove(); AI.model = m; }, MODEL_ID);
  return { browser, page, errors, close: () => close(browser) };
}
// Register a WAV file as a media item (type audio or video) and return its id.
async function addWavMedia(page, file, o = {}) {
  const b64 = fs.readFileSync(file).toString('base64');
  return page.evaluate(async (b64, o) => {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
    const dur = await new Promise(r => { const a = new Audio(url); a.onloadedmetadata = () => r(a.duration); a.onerror = () => r(0); });
    const id = o.id || ('m' + uid());
    state.media.push({ id, type: o.type || 'audio', name: o.name || 'fixture.wav', url, duration: dur, w: 0, h: 0 });
    return id;
  }, b64, o);
}
module.exports = { openApp, addWavMedia, MODEL_ID };
