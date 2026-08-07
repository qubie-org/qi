---
name: qi-research
description: The research process in src/ground/research.ts — the eight stages, the six named failure exits, the guards that do not depend on a prompt, and the 22-question ten-domain evaluation that decides whether a change helped. Use when changing anything about how qi searches, reads, gates, extracts, verifies or composes a note or a deck; when a note comes back empty or with bad citations; or when asked to evaluate or measure the research process.
license: AGPL-3.0-or-later
compatibility: The evaluation reaches real endpoints and needs a running app plus the model server. Tens of seconds per question.
metadata:
  org.qubie.qi.role: research
---

# The research process

`/research` and `/present` both run it. It is the most heavily annotated code in
the repository and the annotations are the specification — read the header of
`src/ground/research.ts` before changing anything in it.

## The claim it makes

Asking a 3B model a question and printing the answer is a lookup: it asks once
and believes the first thing back. Research is the same pieces in an order — ask
several ways, read more than one source, keep only what answers, make every
claim point at the sentence it came from.

None of that is capability. It is **order**, and order is the one thing a 3B
model reliably will not impose on itself. Given four tool calls and a hard
question it does not decompose; it restates.

So the process is code and only the judgement is the model's.

## The eight stages and six exits

Full walkthrough with the failures behind each decision:
[pipeline.md](references/pipeline.md).

```
1 rewrite     make the question standalone              [aLoRA]
2 decompose   into angles that need different searches
3 gather      nine engines per angle, deduped by URL
4 read        plain fetch, escalating to Lightpanda      → thin
5 admit       does this passage answer the question?     → offTopic   [aLoRA]
6a pick       a sentence, by number, under a grammar     → irrelevant
6b restate    that sentence, question absent             → failed
7 verify      the quote occurs in the page               → misquoted  [no model]
8 dedup       by embedding                               → duplicate
```

Losses are counted **separately and by name**. One `rejected` number was
useless: seven of eight sources were being dropped and it could not say whether
they were unreachable, off-topic, or fine-but-misquoted — three problems with
three different fixes. The note prints them, because a note listing only what it
found reads as complete whether or not it is.

## The three things you must not weaken

**Step 7 is the load-bearing one and has no model in it.** A claim whose quote
is not a substring of its source is discarded, so a paraphrase cannot become a
citation and an invention cannot become a fact. Everything above it is a
suggestion; this is the part that is true.

`quotesFrom` forgives typography and forgives nothing else — whitespace, spacing
around punctuation, curly quotes and dashes. A paraphrase still fails, which is
the point. It has already cost eight sources and zero findings once, when a page
rendered `distribution , so` and the model quoted it correctly.

**The summarising call does not see the question.** Given a sentence and a
question that do not match, a model will reconcile them, and the sentence is the
only one of the two it is allowed to change. That produced the worst output this
process has made: asked who founded Hugging Face and shown a sentence from the
Moonshot AI page, it wrote *"Hugging Face was founded in March 2023 by three
former schoolmates from Tsinghua University"* — every name right, the company
swapped, under a citation that contradicted it. A fabricated claim carrying a
genuine citation is worse than an unsourced guess, because the citation is what
makes it look checked.

**`invents()` is the guard that does not depend on a prompt.** No proper noun may
appear in a claim that is not in its quote. It checks every capitalised word
*including the first* — an earlier version skipped the leading word to avoid
flagging "The", which meant "Anthropic built it." passed clean and the Hugging
Face substitution was caught only by luck. A guard whose coverage depends on the
length of the fabricated name is not a guard.

It rejects the occasional honest paraphrase ("Runners" where the source said
"athletes"). That trade is deliberate: a false positive costs one claim from one
slide; a false negative is a fabricated sentence under a citation that appears to
support it.

## Changing it

The rule from `qi-develop` applies hardest here. In order of preference: make
the wrong answer unexpressible, then filter after, then measure. The extractor
does not write quotes — it picks a sentence index and the grammar admits only
those numbers, so a paraphrase is not a thing the model is able to emit.

Before you change anything, read the `── What was tried instead ──` sections.
Five approaches are recorded there with the measurement that killed each,
including one whose premise turned out to be false after it had already been
built twice.

**Any change needs the eval.** Not a spot check: the process was tuned against
six machine-learning papers, and several of its filters are visibly shaped by
that one distribution.

## The evaluation

22 terse questions across ten domains, grouped by **which part of the pipeline
each one stresses** rather than by subject, so a failure is attributable.
Protocol, how to run it in slices, and how to read the table:
[evaluation.md](references/evaluation.md).

It is a **report, not a gate**. There is no correct number of claims for "why did
the bronze age collapse", and a threshold there would be a number invented to be
met. What it decides mechanically are the overfitting tells — a claim that
restates its own quote, a quote too short to be evidence, page chrome quoted as
a finding — counted per domain, because if they cluster in one group that group
is where the paper-shaped assumptions broke.

## Known open defects

- **`offTopic` is 40% of every source fetched.** The gate is right about half
  the time. This is the largest single known defect in the process, not a
  settled design. Use `shadowGate` to investigate rather than guessing.
- **`combinatorial` was never tested before `domains.ts` existed** — and it is
  the case the whole process exists for, where no single page answers and the
  note only works if claims from different sources compose.
- **The process cannot tell when a page was written.** Undated pages read as
  current. That is the failure to watch for in the `current` and `finance`
  groups.
- **`Claim` may simply be the wrong shape for a procedure.** The `practical`
  group exists to find out whether "the answer is steps" fits a structure built
  around one sentence and one quote.
