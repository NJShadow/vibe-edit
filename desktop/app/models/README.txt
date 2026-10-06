Files used by Vibe Edit's speaker labels (desktop app, v4.9+).

speaker-campp.onnx / speaker-campp.f16
  CAM++ speaker-verification model "speech_campplus_sv_zh_en_16k-common_advanced"
  by the 3D-Speaker project (Alibaba DAMO Academy), Apache License 2.0.
  https://github.com/modelscope/3D-Speaker  ·  paper: https://arxiv.org/abs/2303.00332
  Exported to ONNX for Vibe Edit (graph + weights stored as float16; the app
  expands them to float32 when it loads the model). Verified against the
  PyTorch original: cosine 0.99999 or better on every test window.

ort.wasm.bundle.min.mjs / ort-wasm-simd-threaded.wasm
  ONNX Runtime Web 1.30.0 (Microsoft), MIT License. https://onnxruntime.ai

If these files are missing, speaker labels fall back to the smaller built-in
GE2E voice model (Resemblyzer, Apache 2.0), which is embedded in the app.
