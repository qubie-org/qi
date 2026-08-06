#!/usr/bin/env python3
"""Build a compact emoji lexicon for inline placement.

The value in emojibase is not the pictures — it is the CLDR annotations. Every
emoji carries human-curated concept words ("grinning face" -> cheerful, grin,
happy, laugh, smile), which is exactly the concept-to-glyph mapping the motif
bank needs and which nobody has to hand-write.

Vectors are NOT precomputed here. potion embeds a label in ~7 microseconds, so
1,900 of them cost about 13 ms at load — cheaper than shipping a 500 KB matrix
and keeping it in sync with the table.

Writes public/models/emoji.json: [emoji, label, "tag tag tag"][]
"""
import json, pathlib

root = pathlib.Path(__file__).resolve().parent.parent
src = root / "node_modules" / "emojibase-data" / "en" / "data.json"
out = root / "public" / "models" / "emoji.json"

# Groups worth putting in a sentence. Flags (regional indicators) and the
# component group are noise: nobody means Chad by writing "chad".
KEEP_GROUPS = {
    0,  # smileys & emotion
    1,  # people & body
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
    rows.append([glyph, label, " ".join(tags[:MAX_TAGS])])

out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps(rows, ensure_ascii=False, separators=(",", ":")))

print(f"kept {len(rows):,} emoji, skipped {skipped:,}")
print(f"  {out.relative_to(root)}  {out.stat().st_size/1024:.0f} KB")
for r in rows[:5]:
    print(f"   {r[0]}  {r[1]:<28}{r[2][:52]}")
