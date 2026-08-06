#!/usr/bin/env python3
"""INT8-quantize needle's ONNX graphs for the browser.

needle-onnx ships fp32 — 140 MB to run a 26M-parameter model — and its
PORTING.md states quantization is out of scope for that repo. Dynamic
quantization is the right tool here: activations are calibrated at runtime, so
no calibration set is needed, and MatMul/Gemm weights (nearly all of the bulk)
drop to int8.

Embedding lookups (Gather) are left alone; quantising them costs accuracy for
almost no size on a 8192-vocab model.
"""
import pathlib, shutil, sys, time

from onnxruntime.quantization import QuantType, quantize_dynamic

root = pathlib.Path(__file__).resolve().parent.parent
src = root / "models" / "needle"
out = root / "public" / "models" / "needle"
out.mkdir(parents=True, exist_ok=True)

for name in ("encoder", "decoder_step"):
    fp32 = src / f"{name}.onnx"
    q8 = out / f"{name}.q8.onnx"
    t0 = time.time()
    quantize_dynamic(
        model_input=str(fp32),
        model_output=str(q8),
        weight_type=QuantType.QInt8,
        per_channel=True,
        reduce_range=False,
        extra_options={"MatMulConstBOnly": True},
    )
    a, b = fp32.stat().st_size, q8.stat().st_size
    print(f"{name:<14}{a/1e6:7.1f} MB -> {b/1e6:6.1f} MB  ({b/a:.0%})  {time.time()-t0:.1f}s")

for f in ("needle.model", "tokenizer-specials.json"):
    shutil.copy2(src / f, out / f)

total = sum(p.stat().st_size for p in out.glob("*.q8.onnx"))
print(f"\nquantized total: {total/1e6:.1f} MB (was 139.8 MB)")
