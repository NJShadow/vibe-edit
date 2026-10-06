reference.json / windows.f32 — six 1.6 s windows of long.wav (resampled to 16 kHz by
librosa) with librosa's mel spectrogram and the Resemblyzer PyTorch embeddings, used by
tests/ge2e-reference.js to prove dev/pro-ge2e.js reproduces the original model.

dev/speaker-ge2e.bin was made from Resemblyzer 0.1.4's pretrained.pt (Apache-2.0):
3 LSTM layers (weight_ih, weight_hh, bias_ih, bias_hh) + linear, float16, after a
"VGE2" + uint32 header-length + JSON header (tensor names and shapes).
