#!/usr/bin/env python3
"""music.py — synthetic music with KNOWN beat times, for the beat-sync tests.
  python3 music.py out.wav out.json bpm seconds [swing]
Kick on every beat, snare on 2 and 4, closed hi-hat on 8ths, a bass line and a
sustained chord pad (which carries no rhythm — a detector must ignore it)."""
import json, sys, wave
import numpy as np
out, meta, bpm, secs = sys.argv[1], sys.argv[2], float(sys.argv[3]), float(sys.argv[4])
swing = float(sys.argv[5]) if len(sys.argv) > 5 else 0.0
sr = 44100; n = int(secs * sr); x = np.zeros(n); rng = np.random.default_rng(3)
beat = 60.0 / bpm; lead = 0.37
def add(sig, t):
    i = int(round(t * sr)); j = min(n, i + len(sig))
    if 0 <= i < n: x[i:j] += sig[:j - i]
tt = np.arange(int(0.35 * sr)) / sr
kick = np.sin(2 * np.pi * (50 + 110 * np.exp(-tt * 28)) * tt) * np.exp(-tt * 9) * 0.9
sn_t = np.arange(int(0.2 * sr)) / sr
snare = (rng.standard_normal(len(sn_t)) * 0.5 + np.sin(2 * np.pi * 190 * sn_t) * 0.3) * np.exp(-sn_t * 22) * 0.5
hh_t = np.arange(int(0.05 * sr)) / sr
hat = np.diff(rng.standard_normal(len(hh_t) + 1)) * np.exp(-hh_t * 90) * 0.12
beats = []
k = 0
while lead + k * beat < secs - 0.4:
    t = lead + k * beat; beats.append(round(t, 4))
    add(kick, t)
    if k % 4 in (1, 3): add(snare, t)
    add(hat, t); add(hat, t + beat * (0.5 + swing))
    k += 1
# bass line (roots move every bar) and a pad (no attacks)
roots = [55, 55 * 1.335, 55 * 1.498, 55 * 1.122]
for b in range(0, len(beats), 2):
    f = roots[(b // 8) % 4]; tb = np.arange(int(beat * 1.8 * sr)) / sr
    add(np.sin(2 * np.pi * f * tb) * np.minimum(1, tb * 40) * np.exp(-tb * 2) * 0.35, beats[b])
tp = np.arange(n) / sr
x += 0.06 * (np.sin(2 * np.pi * 220 * tp) + np.sin(2 * np.pi * 277.2 * tp) + np.sin(2 * np.pi * 329.6 * tp))
x = x / np.max(np.abs(x)) * 0.9
with wave.open(out, 'wb') as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr); w.writeframes((x * 32767).astype('<i2').tobytes())
json.dump({'bpm': bpm, 'beats': beats, 'duration': secs}, open(meta, 'w'))
print('wrote', out, len(beats), 'beats')
