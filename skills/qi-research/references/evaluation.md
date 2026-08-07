# The domain evaluation

`src/ground/__tests__/domains.ts`. Run it after any change to the research
process, and before claiming one helped.

## Why it exists

Every question the process was measured against while it was being fixed was a
machine-learning paper: speculative decoding, mamba, mixture-of-experts, rope
scaling, grouped-query attention, flash attention. Six prompts, one domain, and
every decision in `research.ts` was made against that one distribution.

Several are visibly shaped by it:

| Decision | Shaped by |
|---|---|
| `readable()` strips LaTeX | arXiv, and nowhere else |
| the `says` pattern permits `2.29` | ML papers report speedups |
| `candidates()` wants 40–300 characters | paper prose. A recipe step and a spec-sheet line are shorter |
| first person rejected as opinion | but an interview, a memoir or a field report *is* first person, and there the rule throws away the only source there is |

None of those were wrong when they were made. They were made against the
evidence available, and the evidence was all from one place. That is the
definition of overfitting, and the only way to see it is to ask the process
questions from somewhere else.

## The ten groups

Grouped by **what the question does to the process**, not by subject. Subject is
what retrieval already scores on; what matters here is which part of the
pipeline each question stresses, so that a failure is attributable.

| Group | Stresses |
|---|---|
| `technical` | the lane it was built in — the control. Should stay good, or something has regressed |
| `current` | recency. Weights are stale and the gate has no clock, so a confidently dated answer is the failure to watch for |
| `health` | where an unsupported claim is not merely wrong. The quote check has to hold hardest here |
| `law` | long sentences, jurisdiction, a shifting answer |
| `history` | disputed, and the sources disagree on purpose |
| `practical` | the answer is a procedure, not a claim. `Claim` may simply be the wrong shape |
| `commercial` | marketing copy is fluent, quotable and worthless. Chrome density is highest here |
| `people` | disambiguation, and a name the model half-remembers |
| `finance` | time-sensitive numbers — the worst case for a process that cannot tell when a page was written |
| `combinatorial` | two fields at once, where no single source answers and the note only works if claims from different places compose. **This is the case the whole process exists for, and nothing had ever tested it** |

Every question is terse, because that is what people type.

## How to run it

It reaches real endpoints, takes tens of seconds a question, and takes about
fifteen minutes end to end. **It is not in CI and must not be.**

It also cannot load under bun — the sandbox needs Wasmer and a browser. Drive it
from the running app, in slices:

```sh
curl -s -X POST http://127.0.0.1:8777/eval --data \
  'const m = await import("/src/ground/__tests__/domains.ts"); return m.ask(0, 2)'
```

Then `ask(2, 4)`, and so on, to 22. Or the `qi_eval` MCP tool.

```js
m.progress()          // { done, of }
m.reset()             // throw away a part-finished run
m.report()            // the table over whatever has been asked
m.run(on)             // all 22 in one call — see the warning below
```

**Save every slice as it comes back.** The results accumulate in a module-level
array that survives between calls only because the page caches it, and the app
has died on question fourteen of twenty-two — Lightpanda segfaulted on a
chrome-heavy page — taking fifteen minutes of real network traffic with it. Each
slice hands its results back to the caller for exactly this reason. Write them
to a file.

Two at a time at most. `research()` already pools five reads and four model
calls internally; running two of it at once oversubscribes the model server's
slots and stops being polite to the sites being read.

`run()` exists for completeness. Prefer slices — the control server's bridge
drops a completion handler long before fifteen minutes, and an 86-second call
has already been lost that way.

## Reading the report

`report()` returns four things.

**`byDomain`** — a row per group: `asked`, `claims`, `barren`, `medianSec`,
`lost` and `tells`.

`barren` is the number that matters: a question that produced nothing at all.

**`lost`** — the six named exits, summed per group. Read them as a diagnosis:

| Dominant loss | Means |
|---|---|
| `thin` | the pages are unreachable or JS-only. A reading problem, not a research one |
| `offTopic` | the gate refused. Either retrieval is bringing junk, or the gate is wrong — run `shadowGate` to tell them apart |
| `irrelevant` | the model read it and had nothing to say |
| `failed` | the grammar would not compile. **A bug**, not an absence of content |
| `misquoted` | the quote was absent, or `invents()` fired |
| `duplicate` | sources agreeing, which is fine |

`irrelevant` and `failed` were one bucket once, and that number went to six with
no way to tell which. "The model read it and had nothing to say" and "the
grammar would not compile" are not the same event and only one of them is a bug.

**`tells`** — the overfitting detectors, and the only thing this file decides
mechanically:

| Tell | Fires when |
|---|---|
| `echo` | the claim restates its own quote, so the citation adds nothing |
| `thin` | the quote is under 60 characters — too short to establish anything |
| `chrome` | navigation, cookie banners or calls to action quoted as evidence |

**If a tell clusters in one group, that group is where the paper-shaped
assumptions broke.** That is the whole reason they are counted per domain rather
than in total.

**`barren`** — the list of questions that produced nothing. This is the backlog,
written by the questions rather than by you.

## What it is not

It is a report, not a gate. There is no correct number of claims for "why did
the bronze age collapse", and a threshold here would be a number invented to be
met. Whether a research note is any good is a judgement no assertion in the file
can make, which is why it returns **every claim in full** — they have to be
readable to be judged.

So: read the claims. Do not read only the table.

## Numbers on record

From the run that motivated the current design:

- `offTopic` was **40% of every source fetched**, in all ten domains — far and
  away the largest loss.
- Judged one rejection at a time, the gate is **right about half the time**.
- Splitting extraction into pick-then-summarise took `echo` from **60% to zero**
  and ran **three times faster**, because a model that cannot continue stops
  generating.
- Three barren notes had good answers sitting in sources the gate had refused,
  which is what produced the demote-rather-than-discard rule.

When you change the process, produce the comparable numbers. A claim that
something improved without them is not usable by the next person.
