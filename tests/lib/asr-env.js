/* asr-env.js — run the app's REAL speech pipeline offline in the test browser.
 *
 * The app loads transformers.js from cdn.jsdelivr.net and Whisper weights from
 * huggingface.co. Neither is reachable from the test sandbox, so every request
 * for them is answered from local npm packages instead:
 *   @huggingface/transformers@3.0.2   (the exact library build the app pins)
 *   sts-whisper-tiny                  (Xenova/whisper-tiny ONNX weights, q8)
 * Nothing about the app is stubbed: tokenizer, feature extractor, ONNX
 * inference, cross-attention word alignment and chunk stitching are all real.
 * The face detector (@mediapipe/face_detection) is served the same way.
 * Only the model differs from the app's default (multilingual tiny instead of
 * tiny.en — same architecture and size), which the suites state explicitly.
 */
const fs = require('fs');
const path = require('path');

// Resolved from node_modules directly: these packages' `exports` maps hide package.json.
const NM = path.resolve(__dirname, '..', 'node_modules');
const TF_DIST = NM + '/@huggingface/transformers/dist/';
const MODEL_DIR = NM + '/sts-whisper-tiny/models/Xenova/whisper-tiny/';
const FACE_DIR = NM + '/@mediapipe/face_detection/';
const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.wasm': 'application/wasm', '.data': 'application/octet-stream', '.tflite': 'application/octet-stream', '.binarypb': 'application/octet-stream', '.onnx': 'application/octet-stream', '.txt': 'text/plain', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.jpg': 'image/jpeg', '.png': 'image/png' };

// Extra local files for tests: https://vibe-test.local/<name> -> ROOTS[...]/<name>
const ROOTS = (process.env.VIBE_TEST_MEDIA || '').split(path.delimiter).filter(Boolean);
async function installAsrEnv(page, log = () => {}) {
  await page.setRequestInterception(true);
  page.on('request', req => {
    const url = req.url();
    let file = null;
    let m = url.match(/^https:\/\/cdn\.jsdelivr\.net\/npm\/@huggingface\/transformers@[^/]+\/dist\/(.+)$/);
    if (m) file = TF_DIST + m[1];
    m = url.match(/^https:\/\/huggingface\.co\/[^/]+\/whisper-[^/]+\/resolve\/[^/]+\/(.+)$/);
    if (m) file = MODEL_DIR + m[1].split('?')[0];
    m = url.match(/^https:\/\/cdn\.jsdelivr\.net\/npm\/@mediapipe\/face_detection@[^/]+\/(.+)$/);
    if (m) file = FACE_DIR + m[1].split('?')[0];
    m = url.match(/^https:\/\/vibe-test\.local\/(.+)$/);
    if (m) { const n = decodeURIComponent(m[1]); file = ROOTS.map(r => path.join(r, n)).find(f => fs.existsSync(f)) || path.join(ROOTS[0] || '/', n); }
    if (!file) return req.continue();
    if (!fs.existsSync(file)) { log('404 ' + url); return req.respond({ status: 404, body: 'not found' }); }
    req.respond({ status: 200, body: fs.readFileSync(file),
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' } });
  });
}
module.exports = { installAsrEnv, MODEL_ID: 'Xenova/whisper-tiny' };
