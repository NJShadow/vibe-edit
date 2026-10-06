/* browser.js — one place that knows how to start a headless Chromium.
 *
 * @sparticuz/chromium changed its export shape between releases (CommonJS
 * `.default` vs named exports), which silently broke every suite that copied
 * the launch snippet. All suites now call launch() from here instead.
 *
 * Resolution order:
 *   1. $CHROME_PATH, if set
 *   2. @sparticuz/chromium (either export shape)
 *   3. a Playwright-installed Chromium under $PLAYWRIGHT_BROWSERS_PATH
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

async function resolveChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH))
    return { exe: process.env.CHROME_PATH, args: [] };
  try {
    const mod = require('@sparticuz/chromium');
    const c = mod.default || mod;
    if (c && typeof c.executablePath === 'function') {
      const exe = await c.executablePath();
      if (exe && fs.existsSync(exe)) return { exe, args: [...(c.args || [])] };
    }
  } catch (e) { /* fall through */ }
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  if (fs.existsSync(root)) {
    for (const d of fs.readdirSync(root).filter(n => /^chromium-\d+$/.test(n)).sort().reverse()) {
      const exe = path.join(root, d, 'chrome-linux', 'chrome');
      if (fs.existsSync(exe)) return { exe, args: [] };
    }
  }
  throw new Error('No Chromium found. Set CHROME_PATH to a Chrome/Chromium executable.');
}

async function launch(opts = {}) {
  const { exe, args } = await resolveChrome();
  return puppeteer.launch({
    executablePath: exe,
    args: [...args, '--no-sandbox', '--allow-file-access-from-files', '--autoplay-policy=no-user-gesture-required',
      '--use-fake-ui-for-media-stream', '--enable-unsafe-swiftshader'],
    headless: 'shell',
    defaultViewport: opts.viewport || { width: 1500, height: 950 },
    protocolTimeout: opts.protocolTimeout || 180000,
  });
}

async function close(browser) {
  await Promise.race([browser.close(), new Promise(r => setTimeout(r, 3000))]);
  try { browser.process() && browser.process().kill('SIGKILL'); } catch (e) {}
}

module.exports = { launch, close };
