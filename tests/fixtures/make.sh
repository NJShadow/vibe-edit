#!/bin/sh
# Regenerate the speech fixtures (deterministic). Requires: pip install espeakng-loader
cd "$(dirname "$0")"
python3 tts.py long-spec.json long.wav long.json
python3 tts.py dialog-spec.json dialog.wav dialog.json   # three speakers, ground-truth speaker per word
python3 tts.py dialog4-spec.json dialog4.wav dialog4.json   # four speakers, two of them close
# the same speech under room noise + mains hum, as a real recording would have
python3 - <<'PY'
import wave, struct, random, math, json
r = wave.open('long.wav'); n = r.getnframes(); sr = r.getframerate()
x = struct.unpack('<%dh' % n, r.readframes(n)); random.seed(7)
y = []
for i, v in enumerate(x):
    noise = random.gauss(0, 1) * 32768 * 10 ** (-48 / 20) + 32768 * 10 ** (-52 / 20) * math.sin(2 * math.pi * 60 * i / sr)
    y.append(max(-32768, min(32767, int(v * 0.8 + noise))))
w = wave.open('long-noisy.wav', 'wb'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
w.writeframes(struct.pack('<%dh' % len(y), *y)); w.close()
print('wrote long-noisy.wav')
PY
python3 music.py music120.wav music120.json 120 30
python3 music.py music97.wav music97.json 97 30 0.08
# Real two-speaker phone call with ground truth: the sample shipped in the
# pyannote.audio wheel (MIT). phone.json = its sample.stm utterances split into
# evenly timed pseudo-words (speaker 0 = Diane, 1 = Sheila).
#   pip download pyannote.audio --no-deps -d /tmp/pa && unzip -o /tmp/pa/*.whl 'pyannote/audio/sample/*' -d /tmp/pa
#   cp /tmp/pa/pyannote/audio/sample/sample.wav phone-sample.wav
# Speaker-encoder reference (tests/ge2e-reference.js): needs torch + librosa + the
# Resemblyzer wheel; see ge2e/README.txt.
