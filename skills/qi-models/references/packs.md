# Packs: the catalogue, and what happens to a pack

## One document, three readers

`src/model/catalog.json` is read by:

- `tools/pull.sh` — the source installer
- `src/model/packs.ts` — the page, to know what is bound
- `native/Sources/qi/Packs.swift` — the app, as a **bundled resource**, not
  reimplemented in Swift

That last one is the point. A second copy of the list in Swift would be a second
thing to forget to update, and the failure would be an app that downloads the
wrong file and verifies it against the wrong hash.

`cli/qiui.mjs` is the exception: it builds its plan from `cli/models.mjs`
instead, because the CLI's unit is a *size* and the catalogue's unit is a
*pack*. Those are genuinely different questions.

## The schema

```jsonc
{
  "id": "rag",
  "title": "citations",
  "what": "Prose. What this is for, and what it is not for.",
  "repo": "ibm-granite/granitelib-rag-r1.0",
  "runtime": "llama" | "onnx" | "mlx" | "lora",
  "required": true,
  "port": 8082,                 // llama runtimes only
  "bytes": 394264576,
  "binds": ["cite", "answerable", "rewrite"],
  "files": [
    "plain-name.gguf",                            // bare path, or…
    { "from": "a/deep/path/Lora-bf16.gguf",       // …a move
      "to": "answerability.gguf" }
  ],
  "sha256": { "answerability.gguf": "819d…" },
  "derived": ["answerability.gguf"],              // converted here, not mirrored
  "mirrors": [
    { "repo": "…", "why": "…", "sha256": { "…": "…" } }
  ]
}
```

`files` is heterogeneous by design: most packs name a file, some rename it on
the way in. Both shapes decode in `Packs.swift`, which keeps the convenience in
the document rather than pushing it onto every reader.

## Rules

**Every file that can be verified must be.** A pack with no hashes cannot be
verified and says so. `scripts/cards.mjs` prints that column; check it before
declaring a pack done. A corrupt 3.8 GB GGUF has been downloaded in this project
and `llama-bench` benchmarked it perfectly happily — nothing noticed until the
server refused to load it.

**Every hash comes from HuggingFace's LFS oid, or from hashing the file. Never
from memory.** The 3b checksum in `cli/models.mjs` was once wrong in a way worth
recognising: its first sixteen characters were real and the remaining forty-eight
were invented. It would have failed every 3b install.

**Each mirror carries its own hash.** Mirrors are not byte-identical: a
different llama.cpp version writes different GGUF metadata, so the file differs
even when the weights do not. The hash checked is the one belonging to the
source actually used.

**Probe before pinning a source.** A model's official repository is not always
its fastest. IBM's own GGUF served at 50 KB/s while two community mirrors of the
same weights served at 2 MB/s — a four-minute download against a twenty-three-
hour one. `pull.sh` probes every source before committing to anything large.

**`derived` names files this project produced rather than mirrored.** They are
fetched from `https://github.com/qubie-org/qi/releases/download/<tag>` because
there is no upstream to mirror. They travel with the release that needs them.

**Optional means optional.** Only `required` packs are fetched on first launch.
A first run must not be gated on a vision model nobody asked for.

## Where a pack ends up

| Context | Location |
|---|---|
| From source | `<repo>/packs/<id>/` |
| From the CLI | `~/.qi/packs/<id>/`, or `$QI_HOME/packs/<id>/` |
| The app | `~/Library/Application Support/Qi/packs/<id>/` |
| A bundled build | `Qi.app/Contents/Resources/packs/<id>/` |

"What is installed" is a directory listing rather than a database. Removing a
pack is `rm -rf`.

**The bundle is always consulted first.** A build that carries its weights must
never go looking on disk for a copy a previous build downloaded — two versions
of one pack with one of them stale is a class of bug worth designing out rather
than detecting.

Weights left the bundle by default for one reason: every Sparkle update used to
be the app *plus* 2.5 GB of model files that had not changed, and nobody
installs that twice. `QI_BUNDLE_PACKS=1` puts them back, which keeps the
fully-bundled DMG a supported thing to make rather than a path that quietly
rots.

## How a pack is fetched

`native/Sources/qi/Install.swift`. Five properties, each from something that has
already gone wrong here:

| Property | Because |
|---|---|
| resume | A 2 GB file that restarts from zero on a dropped connection never finishes on a bad link. |
| verify | A corrupt GGUF downloaded once and benchmarked happily. |
| retry | Transient 5xx and connection resets are the normal case at this size, not the exception. |
| parallel | One stream does not saturate a link. On a 2 GB file: minutes against tens of minutes. |
| state on disk | The app will be quit mid-download, and relaunching must continue rather than begin. |

**Presence is not completeness.** An interrupted download leaves a directory
full of `.partN` files, and treating that as installed is how a first run that
was cancelled once never resumes. `Install.complete()` checks for the files.

**On Xet:** Hugging Face's fast path is a content-addressed chunked protocol
whose client is Python. `HF_XET_HIGH_PERFORMANCE=1` does nothing here, because
nothing here is `huggingface_hub` — this is URLSession against `/resolve/main/`,
a plain CDN redirect. What gets throughput on that path is asking for several
byte ranges at once. That is not Xet and does not pretend to be: no
deduplication, no cross-file chunk reuse. On a single 2 GB file, dedup would
have bought nothing anyway.

For the source installer, the rule is simpler: **curl, always.** The Xet client
stalls at zero bytes against this CDN often enough that a download either
finishes or hangs forever with no way to tell which — measured at 5 KB/s where
plain HTTPS did 2 MB/s.

## How a pack is served

`tools/serve.sh` reads the catalogue and starts one `llama-server` per installed
pack with `runtime: llama` and a `port`. There is no configuration: install a
pack and it gets a server on the next start; remove it and it does not. The page
discovers the same thing over `/packs/installed`, so neither side holds a stale
list.

Only `core` hosts the adapter shelf. Every granitelib adapter is trained against
those exact weights; applying one to the vision model or to `fast` would be
applying it to a model it has never seen.

Context is `-c 32768` by default, never `-c 0`. `-c 0` means "take the window
the GGUF was trained with", which for Granite 4.1-3B is 131k and does not fit.
`fast` is the exception and gets the full length, because its Mamba2 layers have
fixed-size state and its window is nearly free.

## Adding a pack — checklist

1. Add the entry to `src/model/catalog.json`. Write `what` in the codebase's
   voice: what it is *for*, and what it is not for.
2. Get real hashes. `curl -sI` the LFS pointer or hash the downloaded file.
3. `bash tools/pull.sh <id>` and confirm it lands.
4. Bind its verbs in `src/packs/<id>.ts`. Follow `src/packs/see.ts` — a pack
   with its own server subclasses the client and overrides `base`.
5. If it has a server, give it a port in the catalogue and confirm
   `tools/serve.sh` starts it.
6. `bash tools/check.sh <port>`.
7. `node skills/qi-models/scripts/cards.mjs --packs` and read your own card
   back. If the verified column says "no hashes", you are not finished.
