#!/usr/bin/env python3
"""Inspect needle's ONNX graphs and dump its tokenizer for the browser.

needle-onnx ships fp32 (its PORTING.md says quantization is explicitly out of
scope), and it ships the raw SentencePiece protobuf. Neither is what we want
to send down the wire, so this:

  1. prints the exact graph I/O so the TS decode loop can match it
  2. dumps the SentencePiece vocab to JSON, so the browser needs no SP binding
"""
import json, pathlib, sys

import onnx
import sentencepiece as spm
from sentencepiece import sentencepiece_model_pb2 as sp_pb2

root = pathlib.Path(__file__).resolve().parent.parent
src = root / "models" / "needle"
out = root / "public" / "models" / "needle"
out.mkdir(parents=True, exist_ok=True)


def describe(path: pathlib.Path) -> None:
    m = onnx.load(str(path), load_external_data=False)
    g = m.graph
    print(f"\n=== {path.name}  (ir {m.ir_version}, opset {m.opset_import[0].version})")

    def fmt(vs, tag):
        for v in vs:
            t = v.type.tensor_type
            dims = [d.dim_param or str(d.dim_value) for d in t.shape.dim]
            dtype = onnx.TensorProto.DataType.Name(t.elem_type)
            print(f"  {tag:<7}{v.name:<28}{dtype:<8}({', '.join(dims)})")

    fmt(g.input, "in")
    fmt(g.output, "out")
    params = sum(
        int(onnx.numpy_helper.to_array(t).size) for t in g.initializer if t.data_type == 1
    )
    print(f"  fp32 initializer elements: {params:,}")


for name in ("encoder.onnx", "decoder_step.onnx"):
    describe(src / name)

# --- tokenizer -----------------------------------------------------------
proto = sp_pb2.ModelProto()
proto.ParseFromString((src / "needle.model").read_bytes())
kind = sp_pb2.TrainerSpec.ModelType.Name(proto.trainer_spec.model_type)

sp = spm.SentencePieceProcessor(model_file=str(src / "needle.model"))
specials = json.loads((src / "tokenizer-specials.json").read_text())

pieces = [(p.piece, round(p.score, 6), int(p.type)) for p in proto.pieces]
payload = {
    "type": kind,
    "byteFallback": bool(proto.trainer_spec.byte_fallback),
    "addDummyPrefix": bool(proto.normalizer_spec.add_dummy_prefix),
    "unkId": proto.trainer_spec.unk_id,
    "specials": specials,
    "pieces": pieces,
}
(out / "needle.tokenizer.json").write_text(json.dumps(payload, separators=(",", ":")))

print(f"\n=== tokenizer")
print(f"  model_type      {kind}")
print(f"  vocab           {len(pieces):,}")
print(f"  byte_fallback   {payload['byteFallback']}")
print(f"  add_dummy_prefix{payload['addDummyPrefix']}")
print(f"  specials        {specials}")
print(f"  -> {(out / 'needle.tokenizer.json').stat().st_size/1e3:.0f} KB")

# Goldens so the TS port can be proven byte-identical to sentencepiece.
golden = {}
for s in [
    "What's the weather in San Francisco?",
    "set a 5 min timer",
    "how far away is the moon",
    "read the file src/app.tsx",
    "Kraków, 3:30pm!",
]:
    golden[s] = sp.encode(s)
(out / "needle.tokenizer.golden.json").write_text(json.dumps(golden, indent=1))
print(f"  goldens         {len(golden)} pairs")
for s, ids in golden.items():
    print(f"    {s!r} -> {ids}")
