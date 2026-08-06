#!/usr/bin/env python3
"""Build a searchable index of the open web's APIs.

qi reaches ten endpoints. The reason was never that ten is enough — it is that
a browser may only read from a host that agreed to be read, so the ten were
chosen for being reachable rather than for being useful. The net bridge removed
that limit; this removes the other one, which is that nothing knew what else was
out there.

APIs.guru curates OpenAPI descriptions for 2,529 APIs across 108,000 endpoints.
Each carries a title, a description and a category — which is exactly what an
embedding index wants, and exactly what a 3B model cannot be handed as a tool
list. So the model never sees the catalogue: a question is embedded, the nearest
few APIs are retrieved, and only those reach it.

The vectors are centred the same way vectors.ts centres, against the same word
list read out of that file. An uncentred index in a centred space would score
every API against every question at roughly the same middling similarity — the
exact anisotropy failure the app already fixed once.

Writes public/apis/apis.json  [{id, title, what, cats, spec, provider}]
       public/apis/apis.vec   API1 header + int8 rows
"""
import json, pathlib, struct, urllib.request
import numpy as np

root = pathlib.Path(__file__).resolve().parent.parent
out_dir = root / "public" / "apis"
model = root / "packs" / "embed" / "model.onnx"

LIST = "https://api.apis.guru/v2/list.json"
# The other catalogue, and the one that matters more here. public-apis lists
# 1,636 APIs with an explicit Auth column, and 761 of them need no key at all —
# cat facts, exchange rates, transit, space, trivia. APIs.guru is four times
# larger and, sampled, about 12% keyless, most of that enterprise
# infrastructure. A personal app wants the small catalogue far more than the
# big one, so both are indexed and each entry says which it is.
PUBLIC_APIS = "https://raw.githubusercontent.com/public-apis/public-apis/master/README.md"
MAX_DESC = 220

if not model.exists():
    raise SystemExit(f"embed pack missing: {model}\n  run tools/pull.sh embed")

cache = root / ".cache-apis-guru.json"
if cache.exists():
    catalogue = json.loads(cache.read_text())
    print(f"using cached list.json ({len(catalogue):,} apis)")
else:
    print("fetching apis.guru list…")
    with urllib.request.urlopen(LIST, timeout=120) as r:
        catalogue = json.load(r)
    cache.write_text(json.dumps(catalogue))
    print(f"  {len(catalogue):,} apis")

rows = []
for key, api in catalogue.items():
    pref = api.get("versions", {}).get(api.get("preferred"))
    if not pref:
        continue
    info = pref.get("info", {})
    title = (info.get("title") or key).strip()
    desc = " ".join((info.get("description") or "").split())[:MAX_DESC]
    cats = info.get("x-apisguru-categories") or []
    spec = pref.get("swaggerUrl") or pref.get("swaggerYamlUrl") or ""
    if not title or not spec:
        continue
    rows.append(
        {
            "id": key,
            "title": title,
            "what": desc,
            "cats": cats,
            "spec": spec,
            "provider": info.get("x-providerName") or key,
        }
    )

for r in rows:
    # APIs.guru carries no auth field. Sampling its specs put the keyless share
    # near 12%, so the honest default is "assume a key is needed" and let the
    # keyless catalogue below be the one that says otherwise.
    r["keyless"] = False

print(f"apis.guru indexable: {len(rows):,}")

# ── public-apis ─────────────────────────────────────────────────────────────
import re

pa_cache = root / ".cache-public-apis.md"
if pa_cache.exists():
    md = pa_cache.read_text()
else:
    print("fetching public-apis…")
    req = urllib.request.Request(PUBLIC_APIS, headers={"user-agent": "qi/0.1"})
    with urllib.request.urlopen(req, timeout=120) as r:
        md = r.read().decode("utf8")
    pa_cache.write_text(md)

# The README is a set of category tables; the heading above each row block is
# the category, which is worth keeping — it is how people reach for a class of
# thing before they know which one they want.
section = ""
pa = 0
for line in md.splitlines():
    head = re.match(r"^#{2,3}\s+(.+?)\s*$", line)
    if head:
        section = head.group(1).strip()
        continue
    row = re.match(
        r"^\|\s*\[([^\]]+)\]\(([^)]+)\)\s*\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|", line
    )
    if not row:
        continue
    name, url, desc, auth, https, cors = (x.strip() for x in row.groups())
    keyless = auth.lower() in ("", "no")
    rows.append(
        {
            "id": f"publicapis:{name.lower().replace(' ', '-')}",
            "title": name,
            "what": desc[:MAX_DESC],
            "cats": [section.lower()] if section else [],
            "spec": url,
            "provider": "public-apis",
            "keyless": keyless,
            "cors": cors.lower() == "yes",
        }
    )
    pa += 1

print(f"public-apis indexable: {pa:,}  (keyless {sum(1 for r in rows if r.get('keyless')):,})")
print(f"indexable total: {len(rows):,}")

import onnxruntime as ort
from transformers import AutoTokenizer

tok = AutoTokenizer.from_pretrained("ibm-granite/granite-embedding-30m-english")
sess = ort.InferenceSession(str(model), providers=["CPUExecutionProvider"])


def encode(texts, max_len=96):
    out = []
    BATCH = 64
    for i in range(0, len(texts), BATCH):
        enc = tok(
            texts[i : i + BATCH],
            return_tensors="np",
            padding=True,
            truncation=True,
            max_length=max_len,
        )
        feeds = {x.name: enc[x.name].astype("int64") for x in sess.get_inputs() if x.name in enc}
        cls = sess.run(None, feeds)[0][:, 0, :]
        cls = cls / np.linalg.norm(cls, axis=1, keepdims=True)
        out.append(cls.astype("float32"))
        print(f"  embedded {min(i + BATCH, len(texts)):,}/{len(texts):,}", end="\r")
    return np.concatenate(out)


# What an API is about, in the words someone would use to ask for it. The
# category is included because "financial" and "weather" are how people reach
# for a whole class of thing before they know which one they want.
texts = [f"{r['title']}. {r['what']} {' '.join(r['cats'])}".strip() for r in rows]
m = encode(texts)

# Centred against the same list vectors.ts uses, parsed out of that file so the
# two can never drift apart silently.
src = (root / "src" / "model" / "vectors.ts").read_text()
start = src.index("const CENTRE_WORDS =")
words = " ".join(
    part.split("'")[1] for part in src[start : src.index(").split(", start)].split("+")
).split()
raw = encode(words, max_len=16)
centre = raw.mean(axis=0)

m = m - centre
m = m / np.linalg.norm(m, axis=1, keepdims=True)

scale = float(np.abs(m).max() / 127.0)
q = np.clip(np.round(m / scale), -127, 127).astype("int8")

out_dir.mkdir(parents=True, exist_ok=True)
(out_dir / "apis.json").write_text(json.dumps(rows, ensure_ascii=False, separators=(",", ":")))
with (out_dir / "apis.vec").open("wb") as f:
    f.write(b"API1")
    f.write(struct.pack("<IIf", q.shape[0], q.shape[1], scale))
    f.write(q.tobytes())

print(f"\n{len(rows):,} apis indexed")
print(f"  {(out_dir / 'apis.json').relative_to(root)}  {(out_dir / 'apis.json').stat().st_size/1024:.0f} KB")
print(f"  {(out_dir / 'apis.vec').relative_to(root)}   {(out_dir / 'apis.vec').stat().st_size/1024:.0f} KB  ({q.shape[0]}x{q.shape[1]} int8)")
