# Testing

Three tiers, and they are separated by what they need, not by what they cover.

## Tier 1 — `bun test`

The gate. Twelve suites, no network, no model server, fast. Run it before every
commit. The list lives in `package.json` under `scripts.test`; it is explicit
rather than a glob, which is deliberate — a glob would silently pull in a suite
that needs a server and turn the gate into a coin flip.

| Suite | What it protects |
|---|---|
| `src/packs/__tests__/bpe.ts` | The tokenizer, against a reference fixture. |
| `src/model/__tests__/tighten.ts` | Trimming a reply without losing its meaning. |
| `src/inline/__tests__/smoke.ts` | Parse and render, end to end. |
| `src/inline/__tests__/live.ts` | Streaming text as it arrives. |
| `src/engine/__tests__/place.ts` | Glyph and mark placement. |
| `src/pages/__tests__/space.ts` | The `qi:` address space. |
| `src/pages/__tests__/sigils.ts` | Registration, matching, and the namespace table. |
| `src/ground/__tests__/route.ts` | Which source a sentence reaches. |
| `src/ground/__tests__/leaf.ts` | That an extracted value actually occurs in the payload. |
| `src/ground/__tests__/quantity.ts` | Units, precision and as-of times. |
| `src/ground/__tests__/invents.ts` | The proper-noun guard. See below. |
| `src/apps/deck/__tests__/render.ts` | Markdown to slides. |

Two of these deserve the extra sentence:

**`quote.ts`** (not in the default list, run it when touching `quotesFrom`)
guards the function that decides whether a claim keeps its source. A bug in it
is *invisible*: research simply returns nothing, which looks like "the web had
no answer". It did exactly that once — eight sources, zero findings — because a
page rendered as `distribution , so` and the model quoted `distribution, so`.

**`invents.ts`** exists because of one output, and the fixture is that output:
asked who founded Hugging Face, shown a sentence about Moonshot AI, the model
produced a fabricated claim under a genuine citation that contradicted it. If
you weaken this guard you are re-opening that.

## Tier 2 — needs a model server

These are integration tests and are meant to be. What breaks in them is not a
logic error; it is an agreement between processes — llama's tool-call streaming,
the summariser's grammar, the store's retrieval, the model's willingness to
answer from context instead of fetching again. None of that can be mocked
without testing the mock.

| Suite | Needs |
|---|---|
| `src/ground/__tests__/harness.ts` | The model server and the operations index. Routing is pure embeddings; everything past routing is not. |
| `src/ground/__tests__/grounding.ts` | Reranking, the fallback chain, the cache. Sandbox stubbed — it needs Wasmer and a browser. |
| `src/ground/__tests__/spread.ts` | Coverage across the *kinds* of thing people ask, and where there is nothing at all. |
| `src/ground/__tests__/multistep.ts` | Questions that cannot be answered in one fetch. Calls the agent, not `ground()`. |
| `src/ground/__tests__/adversarial.ts` | Questions designed to be got wrong. Grew out of a `multistep` run that produced a confident fabrication unprompted. |
| `src/ground/__tests__/taint.ts` | Questions whose nearest API operation is confidently wrong. An index of 2,721 operations always has a nearest one, and a wrong operation still returns 200, still parses, still renders with a real hostname. |
| `src/agent/__tests__/loop.ts` | The loop end to end against two real servers. |
| `src/model/__tests__/harness.ts` | Real vectors under bun — onnxruntime-web's wasm build runs there, so words are scored with the same weights the app uses. A fake backend would let a tokenizer or pooling mistake pass every assertion. |
| `src/apps/note/__tests__/note.ts` | `parseDoc` / `writeDoc` round-trips. The editor is a contenteditable and only true in a real DOM; what is checked here is the conversion at either end, which is where a text editor quietly loses your writing. |

Start `tools/serve.sh` first.

## Tier 3 — reports, not gates

Two files that do not pass or fail, and are not supposed to.

**`src/ground/__tests__/calibration.ts`** — every bar in the grounding path is
measured at boot rather than written down. That is the right design and an
opaque one. This prints what the numbers came out at and how much daylight there
is between a question that should route and one that should not. Run it after
swapping a model.

**`src/ground/__tests__/domains.ts`** — the 22-question, ten-domain evaluation of
the research process. It reaches real endpoints, takes tens of seconds a
question, and is driven in slices from outside the app. Full protocol in the
`qi-research` skill. Do not put it in CI and do not run it as one call.

## Running Tier 2 and 3 from inside the app

Some of this cannot load under bun — the sandbox needs Wasmer and a browser, and
relative proxy paths like `/llm` and `/apis` mean nothing in a bun process. Use
the app's eval endpoint:

```sh
curl -s -X POST http://127.0.0.1:8777/eval --data \
  'const m = await import("/src/ground/__tests__/domains.ts"); return m.ask(0, 2)'
```

Or the `qi_eval` MCP tool, which is the same thing with the result formatted.

## Writing a new test

- Say in the docblock what failure the test exists to catch, and — where there
  was one — quote the real output that motivated it. Every good test file in
  this repository does.
- If a test needs the network, it is Tier 2 and must not go into
  `scripts.test`.
- Prefer a fixture captured from a real response over a hand-written one. The
  bugs here are about what real pages and real APIs actually look like:
  `distribution , so`, `[ citation needed ]`, `$2.29\times$`, a masthead that
  passes every check because navigation has no sentences in it.

## The one non-obvious gate

`train/test_downgrade_parity.py` proves the Python port of `downgrade()` matches
the TypeScript one byte for byte. If those two disagree, a model trained on the
Python side learns a format the renderer does not produce. Run it if you touch
either file.
