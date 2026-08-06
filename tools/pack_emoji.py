#!/usr/bin/env python3
"""Build a compact emoji lexicon for inline placement.

The value in emojibase is not the pictures — it is the CLDR annotations. Every
emoji carries human-curated concept words ("grinning face" -> cheerful, grin,
happy, laugh, smile), which is exactly the concept-to-glyph mapping the motif
bank needs and which nobody has to hand-write.

Vectors ARE precomputed here, and that is a change. potion embedded a label in
about seven microseconds, so eighteen hundred of them cost 13 ms at load and
shipping a matrix would have been the more expensive option. granite-embedding
is a real six-layer encoder: the same eighteen hundred labels are seconds of
CPU, every single boot, for a table that never changes.

So they are embedded once, here, against the same weights the embed pack runs,
and written as int8 with a scale. Roughly 700 KB for 1,800 x 384, which loads
instantly and costs nothing at runtime.

The two files are a matched pair. If the embed pack ever changes model this has
to be regenerated — emoji.ts checks the dimension and the count and refuses
rather than letting every emoji be quietly wrong.

Writes public/emoji/emoji.json  [emoji, label, "tag tag tag"][]
       public/emoji/emoji.vec   EMJ1 header + int8 rows
"""
import json, pathlib, struct
import numpy as np

root = pathlib.Path(__file__).resolve().parent.parent
src = root / "node_modules" / "emojibase-data" / "en" / "data.json"
out = root / "public" / "emoji" / "emoji.json"
vec_out = root / "public" / "emoji" / "emoji.vec"
model = root / "packs" / "embed" / "model.onnx"
tokenizer = root / "packs" / "embed" / "tokenizer.json"

# Groups worth putting in a sentence. Flags (regional indicators) and the
# component group are noise: nobody means Chad by writing "chad".
KEEP_GROUPS = {
    0,  # smileys & emotion
    # 1 (people & body) is deliberately absent. Its glyphs are people *doing*
    # things, and the tag index kept reaching for them: "steam" found the person
    # in a steamy room, "effort" the person lifting weights, "process" the
    # person running. Each is a fair reading of the tag and a bad picture of the
    # word — a figure appearing beside a noun in a sentence about weather reads
    # as a mistake. qi places pictures of things.
    3,  # animals & nature
    4,  # food & drink
    5,  # travel & places
    6,  # activities
    7,  # objects
    8,  # symbols
}
MAX_TAGS = 10

data = json.loads(src.read_text())
rows, skipped = [], 0
for e in data:
    if e.get("group") not in KEEP_GROUPS:
        skipped += 1
        continue
    glyph, label, tags = e.get("emoji"), e.get("label"), e.get("tags") or []
    if not glyph or not label or not tags:
        skipped += 1
        continue
    # ZWJ sequences are compounds — 🧑‍🚒 is person + fire engine, and it beat
    # 🔥 for the word "fire". They are also wide and render inconsistently.
    if "\u200d" in glyph or len(glyph) > 2:
        skipped += 1
        continue
    # Fonts lag the standard. A glyph the system cannot draw renders as a blank
    # box or as nothing at all, which on this page looks like a bug in the
    # layout rather than a missing font — an invisible gap mid-sentence where a
    # picture should be. Anything newer than Emoji 12 (2019) is not reliably
    # present, and the older set is more than enough.
    if float(e.get("version") or 0) > 12:
        skipped += 1
        continue
    rows.append([glyph, label, " ".join(tags[:MAX_TAGS])])

out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps(rows, ensure_ascii=False, separators=(",", ":")))

# ── vectors ──────────────────────────────────────────────────────────────────
if not model.exists():
    raise SystemExit(f"embed pack missing: {model}\n  run tools/pull.sh embed")

import onnxruntime as ort
from transformers import AutoTokenizer

tok = AutoTokenizer.from_pretrained("ibm-granite/granite-embedding-30m-english")
sess = ort.InferenceSession(str(model), providers=["CPUExecutionProvider"])

# The label alone, not label-plus-tags.
#
# Tags do a different job and are indexed separately at runtime: they *select*
# the candidates for a word, because a tag is a person deciding that this emoji
# is about that concept. What the vector has to do is *rank* those candidates,
# and for that the tags are noise — 🌊's are "surf surfer surfing", which pulled
# its vector far enough toward surfing that "ocean" matched 🐙 octopus instead.
#
# So: tags select, the label ranks. The label is what the emoji is.
texts = [r[1] for r in rows]

vecs = []
BATCH = 64
for i in range(0, len(texts), BATCH):
    enc = tok(texts[i : i + BATCH], return_tensors="np", padding=True, truncation=True, max_length=64)
    feeds = {x.name: enc[x.name].astype("int64") for x in sess.get_inputs() if x.name in enc}
    hidden = sess.run(None, feeds)[0]
    cls = hidden[:, 0, :]  # CLS pooling, per 1_Pooling/config.json
    cls = cls / np.linalg.norm(cls, axis=1, keepdims=True)
    vecs.append(cls.astype("float32"))
    print(f"  embedded {min(i + BATCH, len(texts)):,}/{len(texts):,}", end="\r")

m = np.concatenate(vecs)

# Centred the same way the app centres, so these vectors are comparable with the
# ones the page produces. An uncentred lexicon in a centred space would score
# every word against every emoji at roughly the same middling similarity.
centre_words = (root / "src" / "model" / "vectors.ts").read_text()
start = centre_words.index("const CENTRE_WORDS =")
words = " ".join(
    part.split("'")[1] for part in centre_words[start : centre_words.index(").split(", start)].split("+")
).split()
enc = tok(words, return_tensors="np", padding=True, truncation=True, max_length=16)
feeds = {x.name: enc[x.name].astype("int64") for x in sess.get_inputs() if x.name in enc}
raw = sess.run(None, feeds)[0][:, 0, :]
raw = raw / np.linalg.norm(raw, axis=1, keepdims=True)
centre = raw.mean(axis=0)

m = m - centre
m = m / np.linalg.norm(m, axis=1, keepdims=True)

scale = float(np.abs(m).max() / 127.0)
q = np.clip(np.round(m / scale), -127, 127).astype("int8")

with vec_out.open("wb") as f:
    f.write(b"EMJ1")
    f.write(struct.pack("<IIf", q.shape[0], q.shape[1], scale))
    f.write(q.tobytes())

print(f"\nkept {len(rows):,} emoji, skipped {skipped:,}")
print(f"  {out.relative_to(root)}  {out.stat().st_size/1024:.0f} KB")
print(f"  {vec_out.relative_to(root)}   {vec_out.stat().st_size/1024:.0f} KB  ({q.shape[0]}x{q.shape[1]} int8)")
for r in rows[:5]:
    print(f"   {r[0]}  {r[1]:<28}{r[2][:52]}")
