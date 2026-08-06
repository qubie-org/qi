#!/usr/bin/env python3
"""Pack a model2vec table into a compact int8 blob the browser can slice directly.

  public/models/<name>/potion.bin
    magic 'PTN1' | u32 vocab | u32 dim | f32 scale | int8[vocab*dim]
  public/models/<name>/potion.vocab.json
    [token, ...]  index-aligned with the rows above

Handles both dtypes in the wild: potion-base-8M ships F32, potion-code-16M
ships F16.

    python3 tools/pack_potion.py                 # base (prose)
    python3 tools/pack_potion.py potion-code     # code spans + the pi lane
"""
import json, struct, pathlib, sys
import numpy as np

DTYPES = {"F32": np.float32, "F16": np.float16, "BF16": None}

root = pathlib.Path(__file__).resolve().parent.parent
name = sys.argv[1] if len(sys.argv) > 1 else "potion"
src = root / "models" / name
out = root / "public" / "models" / name
out.mkdir(parents=True, exist_ok=True)

weights = next(src.glob("*.safetensors"))
raw = weights.read_bytes()
hlen = struct.unpack_from("<Q", raw, 0)[0]
hdr = json.loads(raw[8 : 8 + hlen])
key = "embeddings" if "embeddings" in hdr else next(k for k in hdr if k != "__metadata__")
meta = hdr[key]

dtype = DTYPES.get(meta["dtype"])
if dtype is None:
    raise SystemExit(f"unsupported dtype {meta['dtype']}")

o0, o1 = meta["data_offsets"]
vocab_n, dim = meta["shape"]
itemsize = np.dtype(dtype).itemsize
emb = np.frombuffer(raw, dtype=dtype, count=(o1 - o0) // itemsize, offset=8 + hlen + o0)
emb = emb.reshape(vocab_n, dim).astype(np.float32)

# L2-normalise every row so cosine collapses to a dot in the browser.
norms = np.linalg.norm(emb, axis=1, keepdims=True)
norms[norms == 0] = 1.0
emb /= norms

scale = float(np.abs(emb).max() / 127.0)
q = np.clip(np.round(emb / scale), -127, 127).astype(np.int8)
err = float(np.abs(q.astype(np.float32) * scale - emb).max())

print(f"{name}: {meta['dtype']} {vocab_n}x{dim}  scale={scale:.6g}  max_quant_err={err:.5f}")

with open(out / "potion.bin", "wb") as f:
    f.write(b"PTN1")
    f.write(struct.pack("<IIf", vocab_n, dim, scale))
    f.write(q.tobytes())

tok = json.load(open(src / "tokenizer.json"))
vocab = tok["model"]["vocab"]
words = [None] * len(vocab)
for w, i in vocab.items():
    words[i] = w
assert None not in words and len(words) == vocab_n, f"vocab {len(words)} != rows {vocab_n}"
json.dump(words, open(out / "potion.vocab.json", "w"), separators=(",", ":"))

before = weights.stat().st_size
after = sum((out / f).stat().st_size for f in ("potion.bin", "potion.vocab.json"))
print(f"  {before/1e6:.2f} MB -> {after/1e6:.2f} MB")
