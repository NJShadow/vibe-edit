/* Runs the REAL desktop app (desktop/main.js + preload + app/index.html) in
 * Electron and executes one test script inside the page. Used by
 * tests/desktop-pro.js. Env: VIBE_TEST_SCRIPT = path of a JS file whose body
 * is an async function returning JSON-able results. */
const { app } = require('electron');
const path = require('path'), fs = require('fs');
const DESK = path.resolve(__dirname, '..', '..', 'desktop');
process.chdir(DESK);
// VIBE_SAVE_DIR: answer every save dialog with a file in that folder (numbered),
// so export tests run unattended.
if (process.env.VIBE_SAVE_DIR) {
  const { dialog, shell } = require('electron'); let n = 0;
  dialog.showSaveDialogSync = (w, o) => { o = o || w; return path.join(process.env.VIBE_SAVE_DIR, (++n) + '-' + path.basename((o && o.defaultPath) || 'x')); };
  shell.showItemInFolder = () => {};
}
require(path.join(DESK, 'main.js'));
app.on('browser-window-created', (_e, win) => {
  const logged = [];   // errors the app catches and logs (never thrown to the page)
  win.webContents.on('console-message', (e, level, message) => {
    const lv = (e && e.level) ?? level, msg = (e && e.message) ?? message;
    if ((lv === 'error' || lv === 3) && /ReferenceError|TypeError|frame error|is not defined/.test(String(msg))) logged.push(String(msg).slice(0, 200));
  });
  win.webContents.once('did-finish-load', async () => {
    await new Promise(r => setTimeout(r, 2500));
    try {
      const body = fs.readFileSync(process.env.VIBE_TEST_SCRIPT, 'utf8');
      const r = await win.webContents.executeJavaScript('(async()=>{' + body + '})()');
      r.consoleErrors = logged;
      console.log('RESULT ' + JSON.stringify(r));
    } catch (e) { console.log('RESULT ' + JSON.stringify({ error: String(e && e.message || e) })); }
    app.exit(0);
  });
});
