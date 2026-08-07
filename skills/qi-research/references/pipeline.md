# The pipeline, stage by stage

Constants, from `src/ground/research.ts`:

```
ANGLES        3     how many angles the question is split into
PER_ANGLE     4     results considered per angle (the typed words get 2×)
MAX_READ      8     sources actually read
MIN_PASSAGE   200   a page shorter than this had nothing on it
ENOUGH        3     admitted sources below which the gate is ignored
READ_AT_ONCE  5     politeness — these are strangers' servers
MODEL_AT_ONCE 4     llama-server reports four slots; a fifth just queues
```

## 1 · rewrite — `query_rewrite` [aLoRA]

Make a terse question standalone.

**Read this before re-adding a rewrite step in front of everything.** One was
added, and it made the process worse twice:

- Asked to name the field first — the conditioning trick that works elsewhere in
  this codebase — the model guessed the field and then conditioned faithfully on
  its guess. `mamba vs transformers` became "the Mamba video game engine and the
  Transformers franchise". `moe routing collapse` went to networking.
- Shown the titles its own search had just returned, so it would not have to
  guess, it stopped guessing and started copying: the angles came back as
  verbatim page titles and the question as "…based on the titles of the pages
  found".

Then the premise turned out to be false. `answerability` is trained on
conversations, so a noun phrase is not a question — but measured against a paper
it plainly answers, `mamba vs transformers` **passes** the gate, and the model's
expanded question is the one form that fails it. The terse words were never the
problem. What the gate was rejecting was pages, correctly, because the angles had
drifted and the searches were bringing back the wrong ones.

## 2 · decompose

Not sub-questions in the logical sense — **searches**. The test for a good angle
is "would this return different pages", which is why the prompt asks for search
phrasings rather than a decomposition. A model asked to decompose produces a
numbered restatement; asked what it would type into a search box, it produces
something usable.

The original question is always one of the angles. A decomposition that loses
the thing actually asked is worse than no decomposition.

## 3 · gather

The angles run concurrently. They were sequential, and on one real question that
was 45 of the 91 seconds — half the run waiting for four searches with nothing
to say to each other. Each angle already fans out across nine engines
internally, so this is a second layer of the same concurrency.

**The typed words outrank anything the model wrote** — weight 1.6 against 1.0,
and they are searched twice as wide.

Filtering drifted angles was tried and abandoned. Scored against the domain
those searches themselves return, the video-game reading of `mamba` came out
*highest* of the three, because it shares every content word with the right one
and embeddings cannot tell two meanings of "Mamba" apart. Neither can the search
results, which is why the domain vector was polluted too.

What is reliable is **which query produced a page**. A drifted angle cannot be
detected, but it also cannot contaminate the one query nobody invented. A page
found by two angles gets a bonus rather than a replacement, because agreement is
evidence of centrality.

## 4 · read → `thin`

Plain fetch, escalating to Lightpanda when the page is thin. Under
`MIN_PASSAGE`, the loss is `thin`. Five reads at a time — eight simultaneous
fetches from one machine is rude.

Reading and admitting run together. They were sequential and it was the single
largest cost in the run: eight pages fetched one after another, each followed by
its own model call, none dependent on any other.

## 5 · admit → `offTopic` [aLoRA]

`answerability`, once per source. The most-called model path in the app, and the
reason the aLoRA conversion mattered: 16.98 s against 0.04 s per call.

**Both of its arguments were wrong for a long time, in the same way.** It was
asked whether the *top of a page* answered a *string of typed words*, when what
it can judge is whether *prose* answers a *question*. `prose()` now feeds it the
page's sentences.

Widening the old 2,200-character window was a patch on the wrong axis: more of
the top of a page is still the top of the page. Sentences are the right unit,
and `candidates()` already produces them — its length filter removes navigation
incidentally, because "Skip to main content", "Login" and "Subscribe" are all
under forty characters and prose is not.

**The gate demotes rather than discards.** Its verdict is obeyed while `ENOUGH`
(3) other sources survive and ignored below that. A run with plenty of admitted
sources stays as strict as it was; a run facing a blank page takes the noise,
because at that point noise is the only thing on offer that could be useful. The
claims are still tagged and still have to survive everything downstream.

## 6a · pick a sentence → `irrelevant`

**The model no longer writes the quote.** Told "quote the words that support it,
copied exactly, do not tidy it", it returned *"Speculative decoding is a
technique used to improve the efficiency of language models"* — fluent,
accurate, and nowhere in the source. Three of five sources failed the same way,
all paraphrases beginning "Speculative decoding is/refers to/offers". The
verification was working; the instruction was not.

So the source is split into sentences, they are offered as an enumeration, and
the model picks one **by number**. The grammar admits only those numbers, so the
quote is verbatim by construction.

`candidates()` decides what may be quoted:

- 40–300 characters. Too short is not evidence; too long is not a quotation.
- **Must end in terminal punctuation.** Bought with a citation that read
  `"Speculative decoding - Wikipedia Jump to content From Wikipedia, the free
  encyclopedia Machine learning and data mining Paradigms…"` attached to a
  perfectly good claim. Every check passed — verbatim, in the source, right
  length — and it was the masthead. Navigation has no sentences in it, so
  nothing splits it. Prose ends in a full stop; a strip of menu items ends in
  whatever the next element happened to be. That absence is the test, and it
  removes chrome as a *class* without a word list to maintain.
- **Must not end in `?`.** Interrogative headings slip past the terminal-stop
  rule because they do have punctuation. "How Does Caffeine Affect Running
  Performance?" and "Could a yen carry trade unwind trigger a crash?" both
  reached notes as findings — verbatim, cited, answering nothing. A source that
  asks the question is not a source that answers it.
- First 40 candidates only.

## 6b · restate → `failed`

One sentence, in the model's own words, **shown only the sentence**. The
question is deliberately absent; see the parent skill for what happened when it
was not.

Filters after it, each cheap and each unable to lose content:

- `tidy()` strips the reporting voice. Told to state the fact, a small model
  still opens with "The source establishes that" about a third of the time — the
  instruction competes with a very strong prior, and removing the preamble
  afterwards is more reliable than another round of prompt wording.
- Claims starting "the number/index/sentence/finding/answer/value/field" are
  dropped — the model describing the mechanism rather than using it.
- First-person claims are dropped as somebody's opinion. **This is one of the
  known overfits**: an interview, a memoir or a field report *is* first person,
  and there the rule throws away the only source there is.
- Hitting the 220-character ceiling is `failed`, not `irrelevant` — the grammar
  would not close, which is a bug, not an absence of content.

`readable()` cleans the quote for display only, and touches nothing but markup:
LaTeX (`$2.29\times$` → `2.29×`), and Wikipedia's inline furniture
(`[ citation needed ]`, `[ edit ]`). Every word survives.

## 7 · verify → `misquoted` [no model]

`quotesFrom(source, quote)`. Both sides normalised for what is an artefact of
rendering — whitespace, spacing around punctuation, curly quotes, dashes,
non-breaking spaces — and for nothing that changes a word.

Bought with a real failure: a page rendered to text read `output distribution ,
so the technique` — a space before the comma, left behind when block tags became
whitespace. The model quoted it the way it is *written*, and a plain substring
test threw the citation away. Every claim from every source failed that way:
eight sources, zero findings, and nothing in the logs to say why.

A fragment under 24 characters is not evidence of anything and fails outright.

Then `invents()`. See the parent skill.

## 8 · dedup → `duplicate`

Cosine over `says` at 0.9, keeping the first.

## The note

**Written in code, not by the model.** A model asked to produce the final
markdown will rewrite the claims on its way past — it is generating, and
generating is where the quotes stop matching. The claims have already been
verified; assembling them is string work, and string work should not go near a
model.

Two details worth keeping:

- When the claim *is* the sentence, print it once. The extractor emits the
  evidence before the claim, so the claim is about the evidence rather than
  about the page — which is the point, and which means it sometimes is the
  sentence, near enough. A quotation that says the same thing as the line above
  it is not a citation, it is an echo, and it reads as a bug whether or not it
  is one.
- An empty run and a run where nothing worked produce the same empty list and
  mean opposite things. The losses tell them apart — and when there are no
  losses either, nothing was ever reached, which is the one outcome that must
  not be reported as a finished search: *"No sources were reached at all — this
  did not fail to find an answer, it failed to look."*

## `/present`

The same claims in a different shape. Every slide is one finding with its
sentence and its page under it. The model chooses a title and a heading per
slide, both a few words and both under a grammar; **nothing else on a slide is
written freehand**. The last slide says what was set aside and why.
