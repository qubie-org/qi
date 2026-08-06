# stage {#stage}

A scratch bench for one question carried over from TinyOS: **can a
deterministic, untrained vector rank the document a query came from?**

TinyOS built the harness around HDC and it worked — deterministic replay,
journals as truth, `.store/` derived and regenerable, 97% of turns rendered
from structure, grammar-constrained decoding proven on a 360M model, 13 gates
usable as reward. What failed was one thing, and it blocked the two paths that
motivated the plan:

> `tvec:{$[#w:words x; bund@tok'w; TIE]}` — every word of a document,
> majority-bundled into one 16,384-bit vector.

Measured there (`tests/results/s0-hdc-selection.md`): 6% top-5 at 948
candidates on the honest condition. The vectors ranked **names**, not content.
Adding the file body made it *worse*.

## the hypothesis this tests {#stage-why}

TinyOS diagnosed "bundle saturation" and tried emphasis — `acc`/`seal`, which
remembers how often a bit was set. S5 re-ran with it and went 71% → 65%.

That is **term frequency**, and TF upweights exactly the least informative
words. The opposite intervention is the one worth testing:

| | direction | what it does |
|---|---|---|
| `bund` (shipped) | — | every token votes, repeats included |
| `acc`/`seal` | **more** TF | frequent tokens vote harder |
| `tvecSet` | **no** TF | each distinct term votes once |
| `+idf` mask | **IDF** | drop bits set the same way in every document |

The IDF mask is the binary-HDC analog of whitening — removing the shared
common-mode component. On real embeddings that same intervention moved
measured superposition capacity from 2 to 6, and anisotropy from 0.58 to 0.0001.

## method {#stage-method}

Self-supervised, so it needs no labels and no mined sessions. Hold **one
paragraph** out of each document, build that document's vector from the
remainder, then ask whether the held-out paragraph retrieves its own document
out of the whole corpus.

Document vectors are built **before** the IDF mask is computed, so no query
text contributes to the mask it is scored against.

Two conditions, keeping TinyOS's point that both obvious framings lie:

- **raw** — the paragraph as written. Often contains words from its own path,
  so this partly measures matching a name against a name.
- **nopath** — every token appearing in the document's path removed. The honest
  one, and the condition S0 collapsed on.

## layout {#stage-layout}

Constraint: **no bun, no build step, no Python.** Node ≥ 23.6 strips types
natively. The kernel is pure so the runtime is swappable.

| file | I/O | role |
|---|---|---|
| `hdc.ts` | none | HDC primitives + the IDF mask. Typed arrays only. |
| `bench.ts` | none | the benchmark. Takes a corpus as data. |
| `rim.ts` | **all** | the only file touching the outside world |
| `run.ts` | via rim | entry point |

TinyOS enforced this split with a lint rule (`I/O only in rim.k`). Worth
keeping: retargeting to deno or the browser means rewriting `rim.ts` and
nothing else.

```text
node .stage/run.ts [--root=DIR] [--docs=N] [--keep=BITS]
```

## results {#stage-results verdict=SET-SEMANTICS-WINS}

494 markdown documents under `~/Apps`, held-out paragraph per document,
**nopath** condition, top-5. Chance is 1.0%.

| method | q=5 | q=10 | q=20 | q=full (~82) |
|---|---:|---:|---:|---:|
| `tvec` — TinyOS as shipped | 23.5 | 35.4 | 42.7 | 52.2 |
| `tvec+idf` | 23.3 | 35.2 | 43.5 | 59.5 |
| **`tvecSet`** — each term votes once | **31.8** | **40.3** | **49.8** | **74.9** |
| `tvecSet+idf` | 28.5 | 32.6 | 40.7 | 67.8 |
| `tvecSet/pMax` — per-paragraph, max | 25.5 | 31.6 | 42.9 | 66.2 |
| `tvecSet/pTop3` — per-paragraph, mean top-3 | 28.1 | 33.8 | 45.1 | 65.8 |

**1. Set semantics is the fix.** `tvecSet` wins at every query length, by up to
+22.7 points. In K this is one character — `?` for distinct:

```k
tvec:{$[#w:?words x; bund@tok'w; TIE]}
```

This is the opposite direction from `acc`/`seal`. That commit weights by how
often a bit was set (term frequency); removing repetition entirely beats it.

**2. IDF masking — rejected.** It helps `tvec` only at long queries (+7.3 at
full length) and *hurts* `tvecSet` everywhere. It was correcting the same
defect as dedup, less well. Not worth the kernel complexity.

**3. Many vectors per node — rejected in this form.** S0's option 2 loses at
every query length, under both max and mean-of-top-3 pooling. The top-3 control
matters: plain max is biased by paragraph count (max of N noisy draws grows
with N), and correcting for that did not flip the result, so the loss is real
rather than extreme-value statistics.

Why it loses is worth keeping: a paragraph bundle is built from ~30 tokens
against a document's ~200, and **majority bundling is already an averaging
operation** — splitting the content into subsets throws away evidence per
vector faster than it buys selectivity.

Note this is the opposite of the multi-view result on dense embeddings, and the
difference is what was split. There, K views were *different projections of the
same items* (more looks, same evidence). Here, paragraphs are *different
subsets of the content* (fewer looks each). Only the first kind helps.

**4. The real bottleneck is query sparsity, and none of these fix it.** Every
method collapses as queries shorten; the best 5-word result is 31.8%. Short
goal statements are exactly TinyOS's regime, which is why S0 read 6% there.
A better bundling rule cannot repair it — the query simply carries too little.

**5. Learned atoms LOSE to random ones here.** potion (model2vec) is the same
algorithm — bag of words, pooled, no forward pass — so giving both sides the
same whole-word tokenization isolates the atom exactly.

| nopath top-5 | q=5 | q=10 | full |
|---|---:|---:|---:|
| `tvecSet` (random atoms, 16384 bits) | **31.8** | **40.3** | **74.9** |
| `potion` (learned atoms, 256 floats) | 21.1 | 28.7 | 47.4 |
| `potion-cc` (common component removed) | 20.4 | 28.7 | 49.6 |

Removing the shared anisotropic direction barely helps (+2.2 at full length),
so the collapse is *not* mainly anisotropy. What is left:

- **Dimension.** 16,384 bits against 256 floats. Superposing ~200 distinct
  terms into 256 dimensions has no room; HDC has 64x more.
- **Vocabulary ceiling.** 19% of body tokens are outside potion's 29,528-word
  vocab and are dropped. In technical markdown those OOV tokens are identifiers
  and jargon — the *most* discriminative terms in the document. HDC hashes
  anything, so its semantic blindness costs less here than potion's inability
  to represent `ConvGRU` at all.

**Caveat that bounds all of this:** the benchmark rewards lexical overlap by
construction — a held-out paragraph shares literal vocabulary with its own
document. That is the regime where exact matching wins. A task needing
paraphrase or synonym matching would very likely reverse the result, and
nothing here shows HDC is better in general.

## what this deliberately does not test {#stage-caveats}

- **Address vs content is kept separate on purpose.** Only content vectors are
  scored. Binding the path back in (`nvec`) would reintroduce the exact
  name-matching artifact that made S0's `raw` column look healthy.
- Retrieval only. Nothing here says whether a *dynamical* read (spreading over
  a self-organised lattice) beats a similarity ranking — that is a separate
  measurement.
- One vector per document. The other open direction from S0 — many vectors per
  node, per-paragraph or per-symbol, with a cleanup memory — is untouched here.
