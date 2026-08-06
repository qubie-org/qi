#!/usr/bin/env python3
"""Find the public-apis entries a *browser* can actually call.

The README's CORS column is self-reported and frequently wrong, so we ask each
origin directly: send a real cross-origin GET and see whether it comes back
with an Access-Control-Allow-Origin we'd be allowed to read.

Writes tools/out/api_probe.json — the candidate pool a human then curates into
src/ground/sources.ts. Nothing here ships to the browser directly.
"""
import json, pathlib, re, sys, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor

ORIGIN = "https://toki.local"
TIMEOUT = 8
WORKERS = 8  # deliberately gentle: these are strangers' free endpoints

root = pathlib.Path(__file__).resolve().parent.parent
out = root / "tools" / "out"
out.mkdir(parents=True, exist_ok=True)

readme = urllib.request.urlopen(
    "https://raw.githubusercontent.com/public-apis/public-apis/master/README.md", timeout=30
).read().decode()

rows, section = [], "?"
for line in readme.splitlines():
    if line.startswith("### "):
        section = line[4:].strip()
        continue
    if not line.startswith("|"):
        continue
    c = [x.strip() for x in line.strip().strip("|").split("|")]
    if len(c) != 5 or c[0].lower() == "api" or set("".join(c)) <= set("-: "):
        continue
    m = re.match(r"\[(.*?)\]\((.*?)\)", c[0])
    if not m:
        continue
    auth = c[2].lower().strip("`")
    if auth not in ("no", ""):
        continue
    if c[3].lower() != "yes" or c[4].lower() != "yes":
        continue
    rows.append({"name": m.group(1), "url": m.group(2), "desc": c[1], "section": section})

print(f"{len(rows)} keyless + https + self-declared-CORS candidates", file=sys.stderr)


def probe(r):
    req = urllib.request.Request(
        r["url"],
        headers={"Origin": ORIGIN, "User-Agent": "toki-probe/0.1 (+grounding source check)"},
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            acao = resp.headers.get("Access-Control-Allow-Origin")
            body = resp.read(4096)
            ctype = (resp.headers.get("Content-Type") or "").split(";")[0]
            return {
                **r,
                "status": resp.status,
                "acao": acao,
                "cors_ok": acao in ("*", ORIGIN),
                "ctype": ctype,
                "json": ctype.endswith("json") or body.lstrip()[:1] in (b"{", b"["),
                "sample": body[:200].decode("utf-8", "replace"),
            }
    except Exception as e:  # noqa: BLE001 — every failure mode means "unusable"
        return {**r, "status": None, "cors_ok": False, "error": f"{type(e).__name__}: {e}"[:120]}


with ThreadPoolExecutor(WORKERS) as ex:
    results = list(ex.map(probe, rows))

usable = [r for r in results if r.get("cors_ok")]
usable_json = [r for r in usable if r.get("json")]
usable.sort(key=lambda r: r["name"].lower())

(out / "api_probe.json").write_text(json.dumps(results, indent=1))
print(f"reachable with real CORS: {len(usable)}", file=sys.stderr)
print(f"  ...of which return JSON: {len(usable_json)}", file=sys.stderr)
for r in usable_json:
    print(f"  {r['section'][:18]:<18} {r['name'][:26]:<26} {r['url'][:58]}")
