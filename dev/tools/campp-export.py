"""Rebuild desktop/app/models/speaker-campp.{onnx,f16} (v4.9).
Source weights: CAM++ "speech_campplus_sv_zh_en_16k-common_advanced" (3D-Speaker,
Apache-2.0) — e.g. from the `senko` wheel on PyPI: senko/models/.../campplus_cn_en_common.pt
and senko/camplusplus.py (the model definition).
Usage: python campp-export.py <camplusplus.py dir> <campplus_cn_en_common.pt> <out dir>
Needs torch, onnx, onnxruntime, numpy."""
import sys, torch, numpy as np, onnx, torch.nn.functional as F
from onnx import numpy_helper
sys.path.insert(0, sys.argv[1]); import camplusplus as cp
# ONNX averages the last partial segment of avg_pool1d(ceil_mode=True) differently
# from PyTorch; an explicit pad/sum/count is exact in both.
def seg_pooling(self, x, seg_len=100, stype='avg'):
    B, C, T = x.shape[0], x.shape[1], x.shape[2]; n = (T + seg_len - 1) // seg_len
    s = F.pad(x, (0, n * seg_len - T)).reshape(B, C, n, seg_len).sum(-1)
    cnt = torch.clamp(T - torch.arange(n, device=x.device) * seg_len, max=seg_len).to(x.dtype)
    return (s / cnt).unsqueeze(-1).expand(B, C, n, seg_len).reshape(B, C, n * seg_len)[..., :T]
for v in vars(cp).values():
    if isinstance(v, type) and hasattr(v, 'seg_pooling'): v.seg_pooling = seg_pooling
m = cp.CAMPPlus(feat_dim=80, embedding_size=192, memory_efficient=False)
m.load_state_dict(torch.load(sys.argv[2], map_location='cpu', weights_only=True)); m.eval()
out = sys.argv[3].rstrip('/') + '/'
torch.onnx.export(m, (torch.randn(1, 137, 80),), out + 'tmp.onnx', input_names=['feats'], output_names=['emb'],
                  dynamic_axes={'feats': {1: 't'}}, opset_version=17, dynamo=False)
g = onnx.load(out + 'tmp.onnx'); blob = []; off = 0
for t in g.graph.initializer:   # float tensors → one external file (stored as float16)
    if t.data_type == onnx.TensorProto.FLOAT and np.prod(t.dims) >= 16:
        a = numpy_helper.to_array(t).astype(np.float32); raw = a.tobytes()
        t.ClearField('raw_data'); t.ClearField('float_data'); t.data_location = onnx.TensorProto.EXTERNAL
        for k, v in [('location', 'speaker-campp.data'), ('offset', str(off)), ('length', str(len(raw)))]:
            e = t.external_data.add(); e.key = k; e.value = v
        blob.append(a.ravel()); off += len(raw)
onnx.save(g, out + 'speaker-campp.onnx')
np.concatenate(blob).astype(np.float16).tofile(out + 'speaker-campp.f16')
import os; os.remove(out + 'tmp.onnx'); print('done')
