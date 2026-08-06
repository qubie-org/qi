# qi

A text river with a model in it, running on your own machine.

You type into one line. Answers arrive in the same line, inline, and the things
you can invoke are named rather than buried in menus. Nothing leaves the machine
unless you ask it to — the model, the embedder and the retrieval adapters all run
locally, and the only network traffic is the pages you asked it to read.

```
/research    investigates a question and leaves a note, with sources
/present     the same process, laid out as slides that carry their citations
/goal        keeps working until a second opinion agrees it is finished
/note /deck  the things you have made
@            find one of them
```

## Research that has to show its work

Asking a 3B model a question and printing the answer is a lookup. This is not
that. A question is searched several ways, more than one source is read, a
trained gate decides whether a page answers the question at all, and every claim
carries the sentence it came from — checked character by character against the
page it was taken from.

That last check is the load-bearing one. A claim whose quote is not in its source
is discarded, so a paraphrase cannot become a citation and an invention cannot
become a fact. Everything above it is a suggestion; that part is true.

It is not enough on its own. Asked who founded Hugging Face and shown a sentence
from the Moonshot AI page, the model once wrote *"Hugging Face was founded in
March 2023 by three former schoolmates from Tsinghua University"* — every name
correct, every date correct, the company swapped for the one in the question,
under a citation that contradicted it. So the summarising call no longer sees the
question, and no proper noun may appear in a claim that is not in its quote.
Neither guard depends on a prompt continuing to behave.

The notes say what they set aside, too. A note listing only what it found reads
as complete whether or not it is, and *"this is what there is"* and *"this is what
I could get"* are different claims.

## What it runs on

| | |
|---|---|
| generation | IBM Granite 4.1 3B, Q4_K_M, via llama.cpp on Metal |
| retrieval | five Granite RAG intrinsics, three of them activated LoRA |
| embedding | Granite Embedding 30M, ONNX |
| reading | Lightpanda, for pages that only exist after their own JavaScript |

The activated adapters matter more than they sound. An activated LoRA engages
only after its invocation tokens, so the base model's KV cache for the prompt
stays valid — for `answerability`, which runs once per source read, that is the
difference between 16.98s and 0.04s per call. Without it the research loop would
not be affordable at all.

Everything the model is asked to decide is decided under a grammar, so the wrong
answer is not a thing it is able to emit. Where that was not possible, the answer
is filtered afterwards. Where neither was possible, it is measured and written
down.

## Building it

```sh
bun install
bash tools/pull.sh          # the weights, about 2.5 GB
bun run dev                 # the page
bash tools/serve.sh         # the model server
```

For a standalone app:

```sh
npx vite build
bash native/build.sh        # → native/Qi.app
```

`native/build.sh` walks llama-server's dylib closure and rewrites it to
`@rpath`, so the app carries its own model server rather than depending on a
Homebrew tree. `QI_BUNDLE_PACKS=1` bundles the weights too and needs no network
at all; the default installs them to Application Support on first run, resumable
and verified against the hashes in `src/model/catalog.json`.

## Licence

AGPL-3.0. See [LICENSE](LICENSE).

qi bundles [Lightpanda](https://github.com/lightpanda-io/browser), which is
AGPL-3.0, and that is the reason for the choice rather than an incidental
consequence of it. The Granite weights are Apache-2.0 and are IBM's, not covered
by this licence — see [ibm-granite](https://huggingface.co/ibm-granite).
