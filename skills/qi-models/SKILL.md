---
name: qi-models
description: Every model qi can run, and everything recorded about it — the two offered Granite sizes with install size, RAM, hashes and which activated adapters exist; the ten packs in the catalogue; the five RAG intrinsics and the aLoRA distinction. Use when choosing or comparing a model size, adding or editing a pack, looking up a checksum, repo id, port, byte count or licence, explaining why the activated gate matters, or answering any question about what weights qi uses and where they come from.
license: AGPL-3.0-or-later
compatibility: The card script needs Node 20+. Reading the cards needs nothing.
metadata:
  org.qubie.qi.role: models
---

# The models

## Two authorities, and nothing else

Model information lives in exactly two files. Everything else — this skill, the
README, the CLI's help text — is a rendering of them. If you find a third copy,
delete it.

| File | Owns |
|---|---|
| `src/model/catalog.json` | **Packs.** What each is, its repo, files, byte count, runtime, port, hashes, mirrors, and which verbs it binds. Read by `tools/pull.sh`, `src/model/packs.ts` and the Swift installer, so those three can never disagree. |
| `cli/models.mjs` | **Sizes.** The two offered Granite sizes, their base hashes, which activated adapters have been converted, RAM, and the download plan. Read by `@qi-ui/cli`. |

To see everything at once, without reading either by hand:

```sh
node scripts/cards.mjs           # every pack and every size
node scripts/cards.mjs 8b        # one size, with its full download plan
node scripts/cards.mjs --packs   # the catalogue only
```

The script reads the two files above. It cannot go stale.

## The two sizes

| | model | install | needs | activated gate |
|---|---|---|---|---|
| `3b` | Granite 4.1 3B | 2.6 GB | ~8 GB RAM | yes |
| `8b` | Granite 4.1 8B | 6.1 GB | ~16 GB RAM | yes |

Granite 4.1 ships at more sizes than this; these are the two qi offers. Each has
a matching set of RAG intrinsics, so the choice cascades cleanly: pick a size and
the adapters trained against those exact weights come with it. That is not a
given — adapters are rank-32 deltas against a specific hidden size, and a set
trained for another base does not load at all.

**Recommend `3b` unless there is a reason.** It is the only size every number in
this project was measured against. `8b` is hash-verified but has never actually
been run — treat any 8b claim as untested until someone reports otherwise.

**30b was offered and was withdrawn**, because nothing in its download plan
carried a `sha256`. Do not re-add it without hashes; the card explains why.
`cli/models.mjs` is the authority, and `node scripts/cards.mjs` prints what it
actually says rather than what this file remembers.

## The column nobody thinks to ask about

`activated`. IBM publishes each intrinsic twice: a plain LoRA, and an
**activated** one that engages only after its invocation tokens, which leaves
the base model's KV cache for the prompt valid.

On `answerability` — which runs once per source the research process reads,
eight times a question — that is **16.98s against 0.04s per call**. It is the
difference between research being affordable and not.

The difference in the file is a single key: `adapter.alora.invocation_tokens`.
A standard LoRA changes the weights, so the server cannot reuse a prompt it
already processed under the base model and reprocesses the lot. An activated
LoRA applies only from the invocation point, so the prefix stays cached.

IBM ships activated variants as safetensors only. The GGUF conversions for 3b
and 8b are this project's own, published at
`https://github.com/qubie-org/qi/releases/download/weights-v1`. 30b is not done.
See `qi-train` for the conversion recipe.

## The shelf

Five intrinsics, ~400 MB total, loaded onto the core's weights at startup and
named per request:

| Intrinsic | Used for | Activated (3b/8b) |
|---|---|---|
| `answerability` | **The gate.** Does this passage answer the question? | yes |
| `query_rewrite` | Make a terse question standalone | yes |
| `query_clarification` | Ask for what is missing | yes |
| `citations` | Attribute a sentence to a document | no |
| `hallucination_detection` | Which sentences of a reply the documents do not support | no |

Full detail, including the failure modes and the exact numbers:
[rag-intrinsics.md](references/rag-intrinsics.md).

## Two rules that produce silent failures

**Zero every scale after the server starts.** `--lora-init-without-apply` is
documented to load adapters without applying them and in llama.cpp b10250 it
does not — every adapter reports scale 1.0, five rank-32 deltas stack, and the
model emits `<tool_call></tool_response>` forever. It passes no test and fails no
startup check.

**A name in both `rag/` and `rag/alora/` is one intrinsic in two forms, and the
activated one wins.** Loading both puts two copies on the shelf under different
ids, and a request naming the plain one silently gets different weights. The
union rule is in `tools/serve.sh` and duplicated in `Model.adapters()`; both
enumerate every name *either* directory offers.

## The catalogue

Ten packs. Three are required (`core`, `embed`, `rag`); the rest are optional so
that a first launch is not gated on downloading a vision model nobody asked for.

Every card — what each pack is for, its repo, size, runtime, port, hashes and
mirrors — is in [model-cards.md](references/model-cards.md).

All weights are Apache-2.0 and IBM's. They are **not** covered by qi's AGPL-3.0
licence; that licence is driven by bundling Lightpanda. Say so plainly whenever
licensing comes up.

## Adding or changing a pack

Edit `src/model/catalog.json` and nothing else. Then bind its verbs in
`src/packs/`. See [packs.md](references/packs.md) for the schema, the mirror
rule, and how `derived` files work.

## References

- [model-cards.md](references/model-cards.md) — a card per pack, plus the three
  sizes in full.
- [rag-intrinsics.md](references/rag-intrinsics.md) — the five adapters, aLoRA
  mechanics, and the gate's measured accuracy.
- [packs.md](references/packs.md) — the catalogue schema and how a pack is
  installed, verified and served.
