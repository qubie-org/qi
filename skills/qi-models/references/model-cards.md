# Model cards

The numbers here are printed live by `scripts/cards.mjs`, which reads
`src/model/catalog.json` and `cli/models.mjs`. **Prefer the script for any
figure you are about to quote.** This file carries what those two files cannot:
why each model is the one chosen, and what is known about it that is not a
field.

---

## The two sizes

### Granite 4.1 3B — `3b`

- `ibm-granite/granite-4.1-3b-GGUF`, `granite-4.1-3b-Q4_K_M.gguf`, ~2.1 GB
- Install total 2.6 GB · ~8 GB RAM · activated gate available
- Served on `:8082` with `--jinja -c 32768 -ngl 99 -ctk q8_0 -ctv q8_0`

**The one everything here was measured against.** Every latency, every accuracy
rate, every failure quoted in this repository came from these weights. A number
from another size is not comparable until someone re-runs it.

Dense rather than mixture-of-experts, and that was a choice with a cost:
`granite-4.0-h-tiny` generates roughly three times faster for the same quality.
Dense won because every granitelib adapter is trained against *these* weights,
and the intrinsics shelf is worth more than the tokens per second.

Context is 32k, not the advertised 131k. The model is 40 layers with 8 KV heads
and 64-dim heads, about 80 KB of KV cache per token at f16 — the full window
would want ~10 GB of cache on top of the weights, which does not fit next to a
browser on a 16 GB machine. 32k with an 8-bit cache is ~1.3 GB and holds a
genuinely long conversation. The quality cost at `q8_0` is not measurable here.

One flag is mandatory: **without `--jinja` the model's own chat template is not
applied and Granite cannot emit a tool call at all.**

### Granite 4.1 8B — `8b`

- `ibm-granite/granite-4.1-8b-GGUF`, ~5.3 GB
- Install total 6.1 GB · ~16 GB RAM · activated gate available

Base weights and all three converted adapters are hash-verified, and the
adapters carry `[100264, 78191, 100265]` — the same invocation tokens as the
working 3b files, which is what should make the activated gate cost 0.04s rather
than seconds.

**It has never actually been run.** Treat any 8b claim as untested until someone
reports otherwise.

### Granite 4.1 30B — withdrawn

Listed once, and removed. Two things were true of it and only the second was
disqualifying.

It had no converted activated adapters, so its `answerability` gate ran plain
LoRA at seconds per source rather than 0.04s — eight sources a question makes
that the dominant cost of researching anything. Slow, but honest, and fixable
by conversion.

What removed it is that **nothing in its download plan was hash-verified**: no
`sha256` for the base, no `activatedSha` map. A corrupt GGUF has reached this
project once already and was benchmarked happily by a tool that did not check.
Offering a size that cannot be verified is handing that failure to someone else,
on a 17.5 GB download where a silent truncation is likeliest.

If it returns, the hashes come first and the adapters second — not the other way
round. `cli/models.mjs` is the authority and its header records this.

---

## The catalogue

Ten packs in `src/model/catalog.json`. Three required, seven optional — optional
precisely so a first launch is not gated on downloading a vision model nobody
asked for.

### `core` — granite 4.1 3b · **required** · llama · `:8082`

The model that thinks. Streams replies, calls tools, fills JSON schemas under a
grammar. Binds `say`, `call`, `json`.

Carries two mirrors. **Mirrors are not byte-identical** — a different llama.cpp
version writes different GGUF metadata, so the file differs even when the
weights do not. Each mirror therefore carries its own hash, and the hash checked
is the one belonging to the source actually used. IBM's own GGUF served at
50 KB/s while community mirrors of the same weights served at 2 MB/s: four
minutes against twenty-three hours.

### `embed` — meaning · **required** · onnx

`ibm-granite/granite-embedding-30m-english`. RoBERTa-shaped, 384-dimensional,
~123 MB as `model.onnx` plus tokenizer and config.

It does far more than retrieval. Source routing, the working set, motif
placement, colour, the four vibe axes and the sound key are all cosine
similarities against this encoder. Swapping it moves every threshold in the app
at once — which is why `src/engine/place.ts` *measures* where "no relation" sits
rather than hard-coding it, and why `src/ground/__tests__/calibration.ts`
exists. Run calibration after any change here.

384 dimensions and this shape convert cleanly to CoreML, which is what would put
it on the Neural Engine under the native shell.

### `rag` — citations · **required** · lora

Five adapters, ~394 MB, not a model. Full card in
[rag-intrinsics.md](rag-intrinsics.md).

Required because `answerability` gates every source the research process reads.
Without it the gate fails open and the notes fill with pages that merely mention
the subject.

Three of the five are activated variants produced by a local conversion — HF
ships those as safetensors, not GGUF — so they come from this project's own
release rather than upstream. They are listed under `derived` in the catalogue.

### `fast` — granite 4.0 h-tiny · optional · llama · `:8085`

An alternative core: 7B total, ~1B active, and 36 of its 40 layers are Mamba2
with fixed-size state. Generates like a 1B and holds a long conversation for a
fraction of the KV cost — its window is nearly free, so it gets the full length
rather than 32k.

**No granitelib adapter targets it**, so the intrinsics shelf does not apply.
That is the trade: three times the speed, none of the gates.

### `see` — eyes · optional · llama · `:8083`

`granite-vision-4.1-4b`, plus an `mmproj`. ~3.3 GB, and ~2.5 GB resident while
loaded. Its own server, because llama.cpp serves one model per process.

Built on the dense Granite 4.1 tower, so it speaks the same chat template,
tokenizer and tool grammar as the core — a conversation can hand it an image and
get back text the core understands with no translation layer.

**What it is actually good at is documents, not photographs.** It was trained on
charts to CSV, tables to HTML or OTSL, key-value pairs out of scanned forms. The
useful question is what a table says, not what a picture looks like. Write its
verb accordingly.

### `rerank` — ordering · optional · onnx

`granite-embedding-reranker-english-r2`, ~600 MB. A cross-encoder that reads
query and candidate *together*, which a bi-encoder cannot, so it fixes the cases
where two answers embed almost identically and only one is right.

### `docs` — documents · optional · onnx

`granite-docling-258M`, ~550 MB. Layout, tables, formulas and code out of a PDF
page or a screenshot, emitted as structured markup rather than prose. Small
enough to run on every page of a long document.

### `hear` — ears · optional · mlx · `:8084`

`granite-speech-4.1-2b`, ~2 GB. Speech to text in six languages plus
translation into English. A speech encoder in front of the same Granite language
tower.

### `guard` — guardrails · optional · lora

`granitelib-guardian-r1.0`, ~200 MB. Adapters that judge a reply before it is
shown: safety, factuality, and whether an answer is supported by what was
retrieved. **`files` is currently empty in the catalogue** — this pack is
declared but not yet installable.

### `time` — forecasting · optional · onnx

`granite-timeseries-ttm-r2`. A few megabytes that forecast a numeric series
without being trained on it. Zero-shot, which is what makes it usable on
whatever series the conversation happens to produce.

---

## Licensing

Every weight above is **Apache-2.0 and IBM's**. None of it is covered by qi's
AGPL-3.0 licence, which follows from bundling Lightpanda and nothing else.

When someone asks "what licence is qi", the honest answer has two halves and
both matter. See `qi-ship` for the notice files the app carries.
