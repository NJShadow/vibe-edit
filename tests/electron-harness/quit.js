/* Quit-path harness for tests/desktop-quit.js: runs the REAL desktop/main.js
 * in Electron, answers the quit prompt with a chosen button, and records what
 * happened. The window's own close handler, the page's projectDirty /
 * exportInFlight / saveProject and main.js's temp clean-up all run unmodified;
 * only the native dialogs are answered automatically.
 * Env: VIBE_QUIT_SCENARIO = JSON {setup, answer, saveAs, delayClose, wait, after}
 *      VIBE_QUIT_OUT      = file the log is written to (the process may exit
 *                           before stdout is flushed, so the file is the record)
 *      VIBE_SAVE_DIR      = optional: export save dialogs answer into this folder */
const { app, dialog, shell } = require('electron');
const path = require('path'), fs = require('fs');
const DESK = path.resolve(__dirname, '..', '..', 'desktop');
process.chdir(DESK);
const SC = JSON.parse(process.env.VIBE_QUIT_SCENARIO || '{}');
const OUT = process.env.VIBE_QUIT_OUT;
const log = { dialogs: [], events: [], saveDialogs: 0 };
const flush = () => { try { fs.writeFileSync(OUT, JSON.stringify(log)); } catch (_) {} };
const sleep = ms => new Promise(r => setTimeout(r, ms));
dialog.showMessageBoxSync = (w, o) => {
  o = o || w;
  const i = (o.buttons || []).indexOf(SC.answer);
  log.dialogs.push({ buttons: o.buttons, message: o.message, detail: o.detail, answered: i < 0 ? null : SC.answer });
  flush();
  return i < 0 ? (o.cancelId != null ? o.cancelId : 0) : i;
};
let nSave = 0;
dialog.showSaveDialogSync = (w, o) => {
  o = o || w; log.saveDialogs++; flush();
  const name = path.basename((o && o.defaultPath) || 'x');
  if (/\.vibe$/.test(name)) return SC.saveAs || undefined;          // the project Save dialog
  return process.env.VIBE_SAVE_DIR ? path.join(process.env.VIBE_SAVE_DIR, (++nSave) + '-' + name) : undefined;
};
shell.showItemInFolder = () => {};
require(path.join(DESK, 'main.js'));
app.on('will-quit', () => { log.events.push('will-quit'); flush(); });
app.on('browser-window-created', (_e, win) => {
  win.on('closed', () => { log.events.push('closed'); flush(); });
  win.webContents.once('did-finish-load', async () => {
    await sleep(2500);
    try { log.setup = await win.webContents.executeJavaScript('(async()=>{' + (SC.setup || 'return null;') + '})()'); }
    catch (e) { log.setupError = String(e && e.message || e); }
    flush();
    if (SC.delayClose) await sleep(SC.delayClose);
    log.events.push('close-requested'); flush();
    win.close();
    await sleep(SC.wait || 2500);
    log.alive = !win.isDestroyed();
    if (log.alive && SC.after) {
      try { log.after = await win.webContents.executeJavaScript('(async()=>{' + SC.after + '})()'); } catch (e) { log.afterError = String(e); }
    }
    log.events.push('harness-exit'); flush();
    app.exit(0);
  });
});
