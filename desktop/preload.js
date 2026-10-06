// Bridge between the sandboxed editor page and native FFmpeg helpers.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const api = {
  appVersion: () => ipcRenderer.invoke('app:version'),
  hasFFmpeg: () => ipcRenderer.invoke('ffmpeg:has'),
  listEncoders: () => ipcRenderer.invoke('ffmpeg:list-encoders'),
  remuxExport: (o) => ipcRenderer.invoke('ffmpeg:remux', o),
  keyLead: (o) => ipcRenderer.invoke('ffmpeg:keylead', o),
  // Track inventory (audio tracks + subtitle tracks) for the import chooser.
  // NOTE: deliberately NOT named probeStreams — that key already exists below
  // for codec detection, and a duplicate key in this object literal silently
  // shadowed one of them (the v3.52-3.53 'chooser never appears' bug).
  probeTracks: (p) => ipcRenderer.invoke('ffmpeg:streams', p),
  cancelProxy: (jobId) => ipcRenderer.invoke('ffmpeg:cancelProxy', jobId),
  // Resolve the on-disk path of a dropped/picked File (needed to hand it to ffmpeg)
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); }
    catch (e) { return (file && file.path) || null; }
  },
  // Probe a file's duration (seconds) before conversion, to populate the trim dialog.
  probeDuration: (inputPath) => ipcRenderer.invoke('ffmpeg:duration', inputPath),
  // Probe codec info (video/audio) to detect unplayable audio tracks like DTS/AC3.
  probeStreams: (inputPath) => ipcRenderer.invoke('ffmpeg:probeStreams', inputPath),
  // Re-read a file by its absolute path (used to auto-relink saved projects).
  readPath: (p) => ipcRenderer.invoke('file:readPath', p),
  // Check a path exists and get its size/name WITHOUT reading the bytes (for large files).
  statPath: (p) => ipcRenderer.invoke('file:statPath', p),
  // Convert an unsupported media file into an editable H.264/AAC proxy.
  // jobId matches streamed progress events; opts={start,end} converts only a portion.
  makeProxy: (inputPath, jobId, opts) => ipcRenderer.invoke('ffmpeg:proxy', inputPath, jobId, opts),
  // Subscribe to conversion progress. Returns an unsubscribe function.
  onProxyProgress: (cb) => {
    const handler = (_e, data) => { try { cb(data); } catch (_) {} };
    ipcRenderer.on('ffmpeg:proxy-progress', handler);
    return () => ipcRenderer.removeListener('ffmpeg:proxy-progress', handler);
  },
  // Re-encode the recorded master into a proper MP4 and save it
  encodeMp4: (arrayBuffer, opts) => ipcRenderer.invoke('ffmpeg:encode', arrayBuffer, opts),
  // Subscribe to encode progress ({pct, secs, totalSec}). Returns an unsubscribe fn.
  onEncodeProgress: (cb) => {
    const handler = (_e, data) => { try { cb(data); } catch (_) {} };
    ipcRenderer.on('ffmpeg:encode-progress', handler);
    return () => ipcRenderer.removeListener('ffmpeg:encode-progress', handler);
  },
  // Cancel the in-flight export encode (kills the ffmpeg process).
  // jobId (optional): the id passed to encodeMp4/encodeAudio — cancels that job
  // even before FFmpeg has started it.
  cancelEncode: (jobId) => ipcRenderer.invoke('ffmpeg:cancelEncode', jobId),
  // Remove one of the app's own temp files (export intermediates).
  deleteTemp: (p) => ipcRenderer.invoke('file:deleteTemp', p),
  encodeAudio: (wavBuffer, opts) => ipcRenderer.invoke('ffmpeg:encodeAudio', wavBuffer, opts),
  // Marker capability: the encode handler can mix audio directly from source files.
  mixAudioFromFiles: true,
  // Read a generated proxy file's bytes (so the page can hold it as a blob)
  readProxy: (p) => ipcRenderer.invoke('ffmpeg:readproxy', p),
  // Scene-change scores for every frame of a video (v4.6): {input,start,end,jobId}
  sceneScores: (o) => ipcRenderer.invoke('ffmpeg:scenes', o),
  cancelScenes: (jobId) => ipcRenderer.invoke('ffmpeg:cancelScenes', jobId),
  onSceneProgress: (cb) => {
    const handler = (_e, data) => { try { cb(data); } catch (_) {} };
    ipcRenderer.on('ffmpeg:scenes-progress', handler);
    return () => ipcRenderer.removeListener('ffmpeg:scenes-progress', handler);
  },
  // Project persistence
  saveProject: (json, name) => ipcRenderer.invoke('project:save', json, name),
  saveProjectTo: (json, dest) => ipcRenderer.invoke('project:saveTo', json, dest),
  openProject: () => ipcRenderer.invoke('project:open'),
};
// Exposed under the new name; the previous name stays as an alias so any
// reference missed during the rename keeps working rather than failing at
// runtime in a user's hands.
contextBridge.exposeInMainWorld('vibeNative', api);
contextBridge.exposeInMainWorld('cutroomNative', api);

