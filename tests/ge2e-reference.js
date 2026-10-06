/* ge2e-reference.js — the in-app speaker encoder (dev/pro-ge2e.js) against the
 * Python original: librosa mel spectrogram and the Resemblyzer/PyTorch model
 * on the same six 1.6 s windows (fixtures/ge2e, made by fixtures/ge2e/make.py).
 * Usage: node tests/ge2e-reference.js */
const fs = require('fs'), path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'dev', 'pro-ge2e.js'), 'utf8');
const eng = new Function(src + '\nreturn _proGe2eEngine();')();
const bin = fs.readFileSync(path.join(__dirname, '..', 'dev', 'speaker-ge2e.bin'));
eng.load(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.length));
const ref = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'ge2e', 'reference.json'), 'utf8'));
const raw = fs.readFileSync(path.join(__dirname, 'fixtures', 'ge2e', 'windows.f32'));
const all = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length));
const N = 25600, wins = ref.starts.map((_, i) => all.slice(i * N, (i + 1) * N));
// mel: relative error on window 0
const m0 = eng.mel(eng.normVol(wins[0])); let num = 0, den = 0;
ref.mel_full0.forEach((row, t) => row.forEach((v, k) => { num += (m0[t * 40 + k] - v) ** 2; den += v * v; }));
const melRel = Math.sqrt(num / den);
const t0 = Date.now(); const E = eng.embed(wins); const ms = Date.now() - t0;
const cos = E.map((e, i) => ref.emb[i].reduce((s, v, j) => s + v * e[j], 0));
const R = { melRelErr: +melRel.toExponential(2), embCos: cos.map(c => +c.toFixed(5)), msPerWindow: Math.round(ms / wins.length) };
const ok = melRel < 1e-4 && Math.min(...cos) > 0.999;
console.log(JSON.stringify(R, null, 1)); console.log(ok ? 'PASS' : 'FAIL'); process.exit(ok ? 0 : 1);
