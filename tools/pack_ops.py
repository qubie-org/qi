#!/usr/bin/env python3
"""Extract every keyless operation qi could actually call.

The catalogue index answers "which API could help". This answers "and what
exactly would I send it", which is the difference between knowing a thing exists
and being able to use it.

public-apis cannot answer that: its URLs are documentation pages, not endpoints
— thirty sampled through the net bridge returned twenty HTML pages and ten dead
links, and zero JSON. APIs.guru can, because every entry is an OpenAPI
description with a server, paths, and typed parameters. The cost is that most of
it is behind a key: sixty sampled specs came back 48 requiring auth, and of the
rest about twelve percent yield a callable GET. That is ~295 APIs and ~3,400
operations — a smaller number than the headline one, and the true one.

Each operation is embedded by what it does, so a question retrieves operations
rather than APIs. "when did the ISS last pass over" should find the endpoint
that answers it, not the space agency that owns it.

Writes public/apis/ops.json  [{api, title, base, path, what, params[]}]
       public/apis/ops.vec   OPS1 header + int8 rows
"""
import json, pathlib, struct, urllib.request, concurrent.futures as cf
import numpy as np

root = pathlib.Path(__file__).resolve().parent.parent
out_dir = root / "public" / "apis"
model = root / "packs" / "embed" / "model.onnx"
cache = root / ".cache-apis-guru.json"

# One API may not flood the index. A cloud provider with 900 endpoints would
# otherwise crowd out every small useful one on sheer volume.
MAX_OPS_PER_API = 24

# A key by another name. Some APIs declare no security scheme at all and then
# require an api key as an ordinary query parameter — Interzoid calls its one
# "license", which is how a spec that looks keyless produces a call that is not.
# The model, asked to fill a required parameter it has no value for, invents a
# plausible one, and the request fails in a way that looks like the API being
# down. Any operation that needs one of these is not callable.
KEYLIKE = (
    "key", "apikey", "api_key", "token", "access_token", "auth", "license",
    "secret", "appid", "app_id", "app_key", "client_id", "client_secret",
    "subscription", "signature", "password",
)
MAX_SPEC_BYTES = 6_000_000

if not model.exists():
    raise SystemExit(f"embed pack missing: {model}\n  run tools/pull.sh embed")
if not cache.exists():
    print("fetching apis.guru list…")
    req = urllib.request.Request("https://api.apis.guru/v2/list.json", headers={"user-agent": "qi/0.1"})
    with urllib.request.urlopen(req, timeout=180) as r:
        cache.write_bytes(r.read())
catalogue = json.loads(cache.read_text())
print(f"{len(catalogue):,} apis to inspect")


def get_json(url):
    req = urllib.request.Request(url, headers={"user-agent": "qi/0.1", "accept": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        raw = r.read(MAX_SPEC_BYTES + 1)
        if len(raw) > MAX_SPEC_BYTES:
            raise ValueError("spec too large")
        return json.loads(raw)


def base_url(spec):
    """Where requests go. OpenAPI 3 says `servers`; Swagger 2 says host+basePath."""
    for s in spec.get("servers") or []:
        u = s.get("url", "")
        # Templated servers ({region}.example.com) cannot be called blind.
        if u.startswith("http") and "{" not in u:
            return u.rstrip("/")
    host = spec.get("host")
    if not host or "{" in host:
        return None
    scheme = "https" if "https" in (spec.get("schemes") or ["https"]) else (spec.get("schemes") or ["https"])[0]
    return f"{scheme}://{host}{spec.get('basePath', '')}".rstrip("/")


def deref(spec, node):
    """Follow one local $ref. Anything remote or nested is left alone."""
    if not isinstance(node, dict):
        return None
    ref = node.get("$ref")
    if not ref:
        return node
    if not ref.startswith("#/"):
        return None
    cur = spec
    for part in ref[2:].split("/"):
        part = part.replace("~1", "/").replace("~0", "~")
        if not isinstance(cur, dict) or part not in cur:
            return None
        cur = cur[part]
    return cur if isinstance(cur, dict) else None


def param_type(p):
    if "type" in p:
        return p["type"]
    schema = p.get("schema") or {}
    return schema.get("type", "string")


def harvest(key):
    """Every callable keyless GET this API offers."""
    api = catalogue[key]
    pref = api.get("versions", {}).get(api.get("preferred")) or {}
    url = pref.get("swaggerUrl")
    if not url:
        return []
    try:
        spec = get_json(url)
    except Exception:
        return []

    schemes = spec.get("securityDefinitions") or (spec.get("components") or {}).get("securitySchemes") or {}
    if schemes and spec.get("security") != []:
        return []

    base = base_url(spec)
    if not base:
        return []

    info = spec.get("info") or {}
    title = (info.get("title") or key).strip()
    out = []

    for path, item in (spec.get("paths") or {}).items():
        if not isinstance(item, dict) or len(out) >= MAX_OPS_PER_API:
            continue
        op = item.get("get")
        if not isinstance(op, dict) or op.get("deprecated"):
            continue
        # An operation that needs its own key is not keyless however open the
        # rest of the API is.
        if op.get("security"):
            continue

        raw = (item.get("parameters") or []) + (op.get("parameters") or [])
        params, usable = [], True
        for p in raw:
            p = deref(spec, p)
            if not p or not p.get("name"):
                usable = False
                break
            where = p.get("in")
            if where in ("header", "cookie"):
                # Ignorable when optional; unfillable when not.
                if p.get("required"):
                    usable = False
                    break
                continue
            if where not in ("path", "query"):
                usable = False
                break
            flat = p["name"].lower().replace("-", "_")
            if p.get("required") and (flat in KEYLIKE or any(k in flat for k in ("apikey", "api_key", "access_token", "client_secret"))):
                usable = False
                break
            params.append(
                {
                    "name": p["name"],
                    "in": where,
                    "req": bool(p.get("required")),
                    "type": param_type(p),
                    "what": " ".join((p.get("description") or "").split())[:90],
                }
            )
        if not usable:
            continue

        what = " ".join((op.get("summary") or op.get("description") or "").split())[:180]
        if not what and not path.strip("/"):
            continue
        out.append(
            {
                "api": key,
                "title": title,
                "base": base,
                "path": path,
                "what": what,
                "params": params,
            }
        )
    return out


keys = list(catalogue)
ops = []
done = 0
with cf.ThreadPoolExecutor(max_workers=14) as ex:
    for got in ex.map(harvest, keys):
        ops.extend(got)
        done += 1
        if done % 100 == 0:
            print(f"  {done:,}/{len(keys):,} specs · {len(ops):,} operations", end="\r")

print(f"\n{len(ops):,} callable keyless operations from {len({o['api'] for o in ops}):,} apis")
if not ops:
    raise SystemExit("nothing callable found — has the catalogue moved?")

import onnxruntime as ort
from transformers import AutoTokenizer

tok = AutoTokenizer.from_pretrained("ibm-granite/granite-embedding-30m-english")
sess = ort.InferenceSession(str(model), providers=["CPUExecutionProvider"])


def encode(texts, max_len=96):
    out, BATCH = [], 64
    for i in range(0, len(texts), BATCH):
        enc = tok(texts[i : i + BATCH], return_tensors="np", padding=True, truncation=True, max_length=max_len)
        feeds = {x.name: enc[x.name].astype("int64") for x in sess.get_inputs() if x.name in enc}
        cls = sess.run(None, feeds)[0][:, 0, :]
        cls = cls / np.linalg.norm(cls, axis=1, keepdims=True)
        out.append(cls.astype("float32"))
        print(f"  embedded {min(i + BATCH, len(texts)):,}/{len(texts):,}", end="\r")
    return np.concatenate(out)


# The operation as someone would ask for it: what it does, whose it is, and the
# path, which often carries the noun the summary left out.
texts = [f"{o['what']} {o['title']} {o['path'].replace('/', ' ').replace('{', '').replace('}', '')}".strip() for o in ops]
m = encode(texts)

src = (root / "src" / "model" / "vectors.ts").read_text()
start = src.index("const CENTRE_WORDS =")
words = " ".join(part.split("'")[1] for part in src[start : src.index(").split(", start)].split("+")).split()
centre = encode(words, max_len=16).mean(axis=0)

m = m - centre
m = m / np.linalg.norm(m, axis=1, keepdims=True)
scale = float(np.abs(m).max() / 127.0)
q = np.clip(np.round(m / scale), -127, 127).astype("int8")

out_dir.mkdir(parents=True, exist_ok=True)
(out_dir / "ops.json").write_text(json.dumps(ops, ensure_ascii=False, separators=(",", ":")))
with (out_dir / "ops.vec").open("wb") as f:
    f.write(b"OPS1")
    f.write(struct.pack("<IIf", q.shape[0], q.shape[1], scale))
    f.write(q.tobytes())

print(f"\n  {(out_dir / 'ops.json').relative_to(root)}  {(out_dir / 'ops.json').stat().st_size/1024:.0f} KB")
print(f"  {(out_dir / 'ops.vec').relative_to(root)}   {(out_dir / 'ops.vec').stat().st_size/1024:.0f} KB  ({q.shape[0]}x{q.shape[1]} int8)")
