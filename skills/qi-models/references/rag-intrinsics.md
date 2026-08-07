# The RAG intrinsics

Five LoRA adapters from `ibm-granite/granitelib-rag-r1.0`, trained against the
core's exact weights. ~394 MB for the whole shelf rather than five models,
because they load onto weights already resident and are named per request.

They are the reason the core is dense rather than mixture-of-experts.

## The five

| Name | Decides | Called from | Activated (3b/8b) |
|---|---|---|---|
| `answerability` | Does this passage answer this question? | `judge.answers()`, once per source read | **yes** |
| `query_rewrite` | Make a terse question standalone | research step 1 | **yes** |
| `query_clarification` | What is missing from this question | `judge.clarify()` | **yes** |
| `citations` | Which document supports this sentence | `judge` | no |
| `hallucination_detection` | Which sentences of a reply are unsupported | `judge.unsupportedSpans()` | no |

## Activated vs plain — the number that matters

IBM publishes each intrinsic twice. The difference in the GGUF is one key:

```
adapter.alora.invocation_tokens
```

A **standard LoRA** changes the weights, so the server cannot reuse a prompt it
has already processed under the base model. It reprocesses the lot.

An **activated LoRA** applies only from its invocation point, so the prefix stays
cached.

On `answerability` — the most-called model path in the app, once per source, up
to eight times a question — that is:

```
plain      16.98 s per call
activated   0.04 s per call
```

It is not an optimisation. It is the difference between the research loop being
affordable and not existing.

IBM publishes activated variants as **safetensors only**. The GGUF conversions
for 3b and 8b are this project's own, published as release assets at
`https://github.com/qubie-org/qi/releases/download/weights-v1`. The 8b files
carry `[100264, 78191, 100265]` — the same invocation tokens as the working 3b
files. 30b has not been converted, and is no longer an offered size. Recipe in
`qi-train`, should that change.

Asset naming: 3b was converted first and its assets have no size in the name
(`rag-alora-answerability.gguf`); everything after it carries its size
(`rag-8b-alora-answerability.gguf`). Renaming the originals would break every
install already pointing at them, so 3b stays the exception. See `assetName()`
in `cli/models.mjs`.

## Two silent failures

**1. Every scale must be zero after startup.** `--lora-init-without-apply` is
documented to load adapters without applying them. In llama.cpp **b10250 it does
not**: `/lora-adapters` reports every adapter at scale 1.0, five rank-32 deltas
stack, and the model becomes a machine that emits `<tool_call></tool_response>`
forever. It passes no test and fails no startup check — the server comes up fine
and the weights are quietly wrong.

`Model.silence()` posts zeroes once the server answers. Re-verify after any
llama.cpp upgrade:

```sh
curl -s http://127.0.0.1:8082/lora-adapters | python3 -m json.tool
```

**2. A name in both directories is one intrinsic, not two.** `packs/rag/x.gguf`
and `packs/rag/alora/x.gguf` are the same adapter in two forms and the activated
one must win. Loading both puts two copies on the shelf under different ids, and
a request naming the plain one silently gets different weights.

The rule is: enumerate every name *either* directory offers, prefer `alora/`.
Driving the loop off the plain files and checking for an activated twin looks
equivalent and is not — deleting a superseded plain file removes the only thing
naming its intrinsic, and three adapters silently stop loading. `check.sh`
caught that in one run, which is the argument for `check.sh` existing.

Implemented twice, and they must agree: `tools/serve.sh` and
`Model.adapters()` in `native/Sources/qi/Model.swift`.

## The name of an adapter is its filename

`src/model/granite.ts` matches on it. So the two directories must not disagree
about spelling, and a file in `alora/` **replaces** rather than joins its twin.

## Everything fails open

`src/ground/judge.ts` is the only place these are called from, and every function
there returns `null` for "nobody knows" — the pack is absent, or the call failed.
Only `false` is a verdict, and only a verdict stops anything.

The rag pack is nominally required, but the app must be exactly as capable
without it as it was before the pack existed, and better with it. That asymmetry
is the reason the calls live behind `judge.ts` instead of inline at the call
sites. Preserve it.

## What the gate is actually worth

`answerability` gates every source the research process reads. Measured across
the ten domains:

- `offTopic` is **40% of every source fetched** — far and away the largest loss
  in the process.
- Read one rejection at a time, the gate is **right about half the time**.
- It is right about the things that matter most. Asked who founded Hugging Face
  it threw out pages about Moonshot AI and a Tsinghua spin-out, which are
  different companies. Six sources it refused for `creatine cognitive effects`
  produced not one claim when forced.
- When it is wrong it is wrong expensively. `caffeine effect on marathon
  performance` returned nothing at all while a source it had refused said
  plainly that caffeine improves performance in longer endurance events.

So the verdict **demotes rather than discards**: obeyed while three other
sources survive, ignored below that. A note that says nothing is not more
accurate than a note with one good finding in it.

Two of its arguments were wrong for a long time in the same way: it was asked
whether the *top of a page* answered a *string of typed words*, when what it can
judge is whether *prose* answers a *question*. It now gets the sentences of the
page (via `prose()`) and the question they were meant to answer.

To investigate the gate rather than trust it, use `shadowGate`: it runs the gate
but does not obey it and tags claims from refused sources. A verified, on-topic
claim carrying the tag is a false rejection with the receipt attached; a
rejected source that yields nothing is the gate being right. Counting both
settles it without anyone having to judge a page by hand.
