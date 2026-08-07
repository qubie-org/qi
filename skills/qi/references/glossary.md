# Glossary

These words are used precisely in this codebase. Using one loosely in a commit
message or a docblock is how a design gets misremembered.

**river** — the single flow of text that is the whole interface. There are no
blocks in it: no headings, no lists, no fences, no tables, no paragraphs. Block
constructs are *downgraded* into it, never rendered as boxes.

**downgrade** — the transformation in `src/inline/downgrade.ts` that folds
CommonMark into the river. Nothing is dropped; it changes shape. A heading
becomes `loud` text, a table becomes cells joined by a dot glyph, a fence
becomes inline code.

**sigil** — a leading character that opens a namespace in the composer. There
are two. `/` invokes something (a command, or an app that takes the page). `@`
queries what you already have. `$` (skills) and `#` (search) existed, were
complete and wired, held zero instances, and were deleted.

**command** — a folder under `src/commands/` with a `COMMAND.md` and a
`command.ts`. It runs and returns one fact, or opens a place. Its markdown body
is documentation for a person and is sent nowhere.

**app** — a folder under `src/apps/` with an `APP.md` and an `app.tsx`. It has a
`surface` and takes over the page rather than returning into it. Registered
under `/`, because `/present` already opened one and the distinction stopped
being something a sigil could carry.

**vibe** — four signed numbers read from the conversation: warmth, energy,
gravity, wonder. Each is a projection onto an axis in embedding space defined by
two poles of words. Folded into a running state with decay, so the room drifts
rather than flips.

**key** — the musical key derived from the vibe: tonic, mode, waveform, filter
cutoff, tempo. Every sound the interface makes is a degree of that scale. See
`src/engine/key.ts`.

**miss** — the one interval in the app that is not in the current scale: a flat
second below the tonic. The only dissonance, and therefore the only sound that
carries information. Consonance is just the sound of things working.

**tone** — one of four fixed colours (blue, red, gold, green), measured in
OKLCH, never interpolated between. A word gets one only if it genuinely evokes
it; most words get none.

**motif / deco** — a glyph placed beside a word, or a mark drawn over it.
Placed by embedding similarity against prototypes, with a measured threshold.
Deterministic: the same sentence always decorates the same way.

**pack** — an optional download of weights, described in
`src/model/catalog.json` and registered against the model client. `core`,
`embed` and `rag` are required; everything else the user has to ask for.

**intrinsic** — one of the five RAG LoRA adapters IBM trained against these
exact base weights: `answerability`, `citations`, `hallucination_detection`,
`query_clarification`, `query_rewrite`. They load onto the core's weights and
are named per request. The whole shelf is ~400 MB rather than five models.

**aLoRA / activated LoRA** — an adapter that engages only after its invocation
tokens, so the base model's KV cache for the prompt stays valid. The difference
is a single key in the GGUF: `adapter.alora.invocation_tokens`. On
`answerability` it is 16.98s against 0.04s per call. IBM publishes activated
variants for three of the five.

**the gate** — `answerability`, used to decide whether a passage answers the
question. Runs once per source read, so it is the most-called model path in the
app. It is right about half the time. It **demotes rather than discards**: its
verdict is obeyed while three other sources survive and ignored below that.

**angle** — one of the search phrasings a question is decomposed into. Not a
sub-question: the test for a good angle is "would this return different pages".
The typed words are always one of the angles and outrank the rest, because they
are the only query nobody invented.

**claim** — one finding: `says` (the model's words), `quote` (verbatim from the
source, chosen by number under a grammar), `url`, `title`. A claim whose quote
is not a substring of its source is discarded.

**loss** — where a source went. Six named buckets: `thin`, `offTopic`,
`irrelevant`, `failed`, `misquoted`, `duplicate`. They are counted separately
because a single `rejected` number cannot say which of three different fixes is
needed, and the note prints them.

**shadow gate** — the mode that runs the gate but does not obey it, tagging
claims from refused sources. A verified on-topic claim carrying the tag is a
false rejection with the receipt attached.

**working set** — what actually reaches the model each step: a topic line, a
few retrieved facts, the open task, the steps so far. Rebuilt from the store
every step, so context cost is O(1) in the length of the conversation rather
than O(n).

**fill** — a grammar-constrained call. The model emits JSON matching a schema
and cannot emit anything else. This is the preferred way to get judgement out of
a 3B model; free generation is the fallback.

**potion** — the working-set store. Legacy name, still in some docblocks.

**toki** — the previous incarnation of this project: a ternary recurrent model
trained from scratch. `train/` is its remains. The working directory is still
named after it.
