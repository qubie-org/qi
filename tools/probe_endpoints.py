#!/usr/bin/env python3
"""Probe concrete keyless endpoints for real browser reachability.

public-apis gives us the discovery pool, but it links to documentation pages,
not endpoints — so the actual endpoint has to be named and verified by hand.
This checks each one the way the browser will: cross-origin GET, no key, and a
readable Access-Control-Allow-Origin coming back.

Survivors get curated into src/ground/sources.ts with a reducer apiece.
"""
import json, pathlib, sys, urllib.request
from concurrent.futures import ThreadPoolExecutor

ORIGIN = "https://qi.local"
TIMEOUT = 10
WORKERS = 6

# id, what it grounds, endpoint
ENDPOINTS = [
    # --- encyclopaedic: the backbone. short extract + a thumbnail chip -------
    ("wiki",        "topic summary + image",  "https://en.wikipedia.org/api/rest_v1/page/summary/Moon"),
    ("wiki_search", "topic lookup",           "https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=moon&format=json&origin=*"),
    # --- numbers you can put on screen --------------------------------------
    ("solar",       "planet/moon figures",    "https://api.le-systeme-solaire.net/rest/bodies/lune"),
    ("weather",     "current weather",        "https://api.open-meteo.com/v1/forecast?latitude=37.77&longitude=-122.42&current=temperature_2m,wind_speed_10m"),
    ("geocode",     "place -> lat/lon",       "https://geocoding-api.open-meteo.com/v1/search?name=San%20Francisco&count=1"),
    ("fx",          "currency rates",         "https://api.frankfurter.app/latest?from=USD&to=EUR"),
    ("crypto",      "coin price",             "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd"),
    ("country",     "country facts",          "https://restcountries.com/v3.1/name/japan?fields=name,population,capital,flags,area"),
    ("zip",         "postcode -> place",      "https://api.zippopotam.us/us/90210"),
    ("sun",         "sunrise/sunset",         "https://api.sunrise-sunset.org/json?lat=37.77&lng=-122.42&formatted=0"),
    ("iss",         "ISS position",           "https://api.wheretheiss.at/v1/satellites/25544"),
    ("agify",       "name -> age guess",      "https://api.agify.io?name=nathaniel"),
    # --- language: feeds the motif + theme layer directly --------------------
    ("datamuse",    "word associations",      "https://api.datamuse.com/words?ml=ocean&max=10"),
    ("dict",        "definition",             "https://api.dictionaryapi.dev/api/v2/entries/en/serendipity"),
    # --- images: inline chips ------------------------------------------------
    ("artic",       "artwork images",         "https://api.artic.edu/api/v1/artworks/search?q=blue&limit=3&fields=id,title,image_id"),
    ("dog",         "dog photo",              "https://dog.ceo/api/breeds/image/random"),
    ("nasa_img",    "space imagery",          "https://images-api.nasa.gov/search?q=moon&media_type=image"),
    # --- text with personality ----------------------------------------------
    ("advice",      "one-line advice",        "https://api.adviceslip.com/advice"),
    ("catfact",     "cat fact",               "https://catfact.ninja/fact"),
    ("useless",     "random fact",            "https://uselessfacts.jsph.pl/api/v2/facts/random"),
    ("joke",        "joke",                   "https://official-joke-api.appspot.com/random_joke"),
    ("chuck",       "joke",                   "https://api.chucknorris.io/jokes/random"),
    # --- structured worlds ---------------------------------------------------
    ("pokemon",     "pokemon stats",          "https://pokeapi.co/api/v2/pokemon/pikachu"),
    ("openlib",     "book lookup",            "https://openlibrary.org/search.json?q=dune&limit=3"),
    ("tvmaze",      "show lookup",            "https://api.tvmaze.com/search/shows?q=severance"),
    ("hn",          "top story ids",          "https://hacker-news.firebaseio.com/v0/topstories.json"),
    ("github",      "repo stats",             "https://api.github.com/repos/facebook/react"),
    ("spacex",      "latest launch",          "https://api.spacexdata.com/v4/launches/latest"),
]


def probe(row):
    ident, purpose, url = row
    req = urllib.request.Request(
        url, headers={"Origin": ORIGIN, "User-Agent": "qi-probe/0.1 (+grounding source check)"}
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            acao = resp.headers.get("Access-Control-Allow-Origin")
            raw = resp.read()
            ctype = (resp.headers.get("Content-Type") or "").split(";")[0]
            try:
                parsed = json.loads(raw)
                shape = sketch(parsed)
            except Exception:
                parsed, shape = None, "<not json>"
            return {
                "id": ident, "purpose": purpose, "url": url, "status": resp.status,
                "acao": acao, "cors_ok": acao in ("*", ORIGIN),
                "bytes": len(raw), "ctype": ctype, "shape": shape,
            }
    except Exception as e:  # noqa: BLE001
        return {"id": ident, "purpose": purpose, "url": url, "cors_ok": False,
                "error": f"{type(e).__name__}: {e}"[:110]}


def sketch(v, depth=0):
    """One-line description of the JSON shape, so reducers can be written."""
    if depth > 2:
        return "…"
    if isinstance(v, dict):
        return "{" + ", ".join(f"{k}:{sketch(x, depth+1)}" for k, x in list(v.items())[:7]) + "}"
    if isinstance(v, list):
        return f"[{len(v)}×{sketch(v[0], depth+1) if v else ''}]"
    if isinstance(v, str):
        return f'"{v[:24]}…"' if len(v) > 24 else f'"{v}"'
    return type(v).__name__


with ThreadPoolExecutor(WORKERS) as ex:
    results = list(ex.map(probe, ENDPOINTS))

out = pathlib.Path(__file__).resolve().parent / "out"
out.mkdir(parents=True, exist_ok=True)
(out / "endpoint_probe.json").write_text(json.dumps(results, indent=1))

ok = [r for r in results if r.get("cors_ok")]
print(f"\n{len(ok)}/{len(results)} usable from a browser\n", file=sys.stderr)
for r in results:
    mark = "OK " if r.get("cors_ok") else "-- "
    detail = r.get("shape", r.get("error", ""))
    size = f"{r['bytes']/1024:6.1f}K" if r.get("bytes") else "      "
    print(f"{mark}{r['id']:<12}{size}  {detail[:104]}")
