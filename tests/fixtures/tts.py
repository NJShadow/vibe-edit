#!/usr/bin/env python3
"""tts.py — synthesize test speech with GROUND-TRUTH word timings (eSpeak NG).

Used only by the test suite. Produces a WAV plus a JSON list of every word with
its true start/end in seconds, so transcription and cut accuracy can be
measured against fact instead of eyeballed.

  python3 tts.py spec.json out.wav out.json
spec: {"rate":160, "voice":"en-us", "segments":[{"text":"Hello there.","pause":0.8,"voice":"en-us+f3","spk":1}, ...]}
  per-segment "voice"/"pitch" switch speakers; "spk" is copied onto every word as ground truth.
  "pause" = seconds of digital silence appended after the segment.
"""
import ctypes, json, struct, sys, wave
import espeakng_loader as L

lib = ctypes.CDLL(L.get_library_path())
SR = lib.espeak_Initialize(0x01, 0, L.get_data_path().encode(), 0)  # AUDIO_OUTPUT_RETRIEVAL

class EVENT(ctypes.Structure):
    _fields_ = [('type', ctypes.c_int), ('unique_identifier', ctypes.c_uint),
                ('text_position', ctypes.c_int), ('length', ctypes.c_int),
                ('audio_position', ctypes.c_int), ('sample', ctypes.c_int),
                ('user_data', ctypes.c_void_p), ('id', ctypes.c_int64)]
CB = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.POINTER(ctypes.c_short), ctypes.c_int, ctypes.POINTER(EVENT))
buf, events = [], []
def _cb(wav, n, ev):
    if wav and n > 0: buf.extend(wav[:n])
    i = 0
    while ev[i].type != 0:
        if ev[i].type == 1:  # espeakEVENT_WORD
            events.append((ev[i].text_position, ev[i].length, ev[i].sample))
        i += 1
    return 0
cb = CB(_cb); lib.espeak_SetSynthCallback(cb)

spec = json.load(open(sys.argv[1]))
assert lib.espeak_SetVoiceByName(spec.get('voice', 'en-us').encode()) == 0, 'unknown voice'
lib.espeak_SetParameter(1, spec.get('rate', 160), 0)   # espeakRATE
pcm, words = [], []
lead = int(SR * spec.get('lead', 0.5)); pcm.extend([0] * lead)
for si, seg in enumerate(spec['segments']):
    buf.clear(); events.clear()
    if 'voice' in seg: assert lib.espeak_SetVoiceByName(seg['voice'].encode()) == 0, 'unknown voice ' + seg['voice']   # per-segment speaker
    if 'pitch' in seg: lib.espeak_SetParameter(3, seg['pitch'], 0)          # espeakPITCH
    text = seg['text'].encode('utf-8')
    lib.espeak_Synth(text, len(text) + 1, 0, 0, 0, 0, None, None)  # POS_CHARACTER, espeakCHARS_AUTO
    lib.espeak_Synchronize()
    # trim eSpeak's own leading/trailing silence so pauses are exactly what we ask
    thr = 300
    first = next((i for i, v in enumerate(buf) if abs(v) > thr), 0)
    last = len(buf) - next((i for i, v in enumerate(reversed(buf)) if abs(v) > thr), 0)
    seg_audio = buf[first:last]
    base = len(pcm)
    starts = []
    for (tp, ln, smp) in events:
        w = seg['text'].encode('utf-8')[tp - 1:tp - 1 + ln].decode('utf-8', 'ignore')
        starts.append((w, max(0, smp - first)))
    for k, (w, s) in enumerate(starts):
        e = starts[k + 1][1] if k + 1 < len(starts) else len(seg_audio)
        # tighten the end to the last loud sample before the next word
        j = min(e, len(seg_audio)) - 1
        while j > s and abs(seg_audio[j]) < thr: j -= 1
        words.append({'w': w, 's': (base + s) / SR, 'e': (base + j + 1) / SR, 'seg': si, **({'spk': seg['spk']} if 'spk' in seg else {})})
    pcm.extend(seg_audio)
    pcm.extend([0] * int(SR * seg.get('pause', 0.3)))
with wave.open(sys.argv[2], 'wb') as f:
    f.setnchannels(1); f.setsampwidth(2); f.setframerate(SR)
    f.writeframes(struct.pack('<%dh' % len(pcm), *pcm))
json.dump({'sr': SR, 'duration': len(pcm) / SR, 'words': words}, open(sys.argv[3], 'w'), indent=1)
print('wrote', sys.argv[2], round(len(pcm) / SR, 2), 's,', len(words), 'words')
