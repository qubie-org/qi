#!/usr/bin/env python3
"""Pull Canvas UI components into src/canvasui/.

Canvas UI ships as shadcn-registry source rather than an npm package, but the
components we want have zero dependencies and import nothing but React, so the
CLI (and a components.json, and Tailwind) is unnecessary — fetch the files.

Chosen for the art direction, not for the demo reel. toki is white, quiet, and
all its contrast lives in the type; blaze / glitch / vhs / laser / shatter would
fight that, so they are deliberately not here.
"""
import json, pathlib, sys, urllib.request

REGISTRY = "https://canvasui.dev/r/registry.json"
WANT = [
    "clouds",        # theme-aware mist; blurs and refracts, parted by the cursor
    "displacement",  # ripples away from the cursor, chromatic fringing
    "glass",         # cursor-following lens that refracts the page
    "bend",          # folds top and bottom as you scroll — suits a feed
    "grid",          # quiet structural overlay
]

root = pathlib.Path(__file__).resolve().parent.parent
out = root / "src" / "canvasui"
out.mkdir(parents=True, exist_ok=True)


def get(url: str):
    # The site 403s urllib's default agent.
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (toki fetch)"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


index = {it["name"]: it for it in get(REGISTRY)["items"]}
total = 0
for name in WANT:
    key = f"{name}-react"
    if key not in index:
        print(f"  {name:<14} not in registry", file=sys.stderr)
        continue
    item = get(f"https://canvasui.dev/r/{key}.json")
    deps = item.get("dependencies") or []
    for f in item.get("files", []):
        content = f["content"]
        dest = out / pathlib.Path(f["path"]).name
        dest.write_text(content)
        total += len(content)
        print(f"  {name:<14} {dest.relative_to(root)}  {len(content):,} chars  deps={deps or 'none'}")

print(f"\n{total/1024:.0f} KB of component source in {out.relative_to(root)}", file=sys.stderr)
