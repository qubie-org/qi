---
name: qi-train
description: Convert, fine-tune or train weights for qi — chiefly converting IBM's activated LoRA safetensors to GGUF so the answerability gate costs milliseconds instead of seconds, and the pre-Granite research lane under train/. Use when asked to convert an adapter, produce activated adapters for a new model size, fine-tune anything, run a training job, or touch train/, and read it before running any GPU work for this project.
license: AGPL-3.0-or-later
compatibility: Conversion needs Python with transformers and a llama.cpp checkout. Training needs a real GPU — never a Mac. Modal or a CUDA box.
metadata:
  org.qubie.qi.role: train
---

# Training and conversion

## Read this first

**Never train or benchmark on the Mac.** Not "prefer not to" — never. A number
measured on a Mac is not comparable to any published result and not reliably
comparable to the next run on the same machine. The Mac is for development, data
preparation and smoke tests. Real runs go to a CUDA box or to Modal.

This rule has been broken and corrected in this project's history more than
once. If a task says "train X" and you are on a Mac, the correct first move is
to say so and ask where it should run.

## What "training" actually means here

Almost nothing in qi is trained. Be precise about which of these three a task
is, because they have nothing in common:

1. **Conversion.** Taking IBM's published activated LoRA safetensors and
   producing GGUF. This is the live, valuable lane — it is what makes the
   research gate affordable, and it is the only reason `30b` is worse than the
   other two sizes. No gradient is involved. Needs no GPU and not even the base
   weights. See [alora-conversion.md](references/alora-conversion.md).
2. **Fine-tuning an adapter.** Nobody has done this for qi. If someone asks,
   the honest position is that the five IBM intrinsics are trained against these
   exact weights by people with the data for it, and a home-made replacement
   would need to beat them on the measurements in `qi-research` before it was
   worth shipping. MLX is the right tool for the tuning; an adapter trained
   there comes back to llama.cpp to be served.
3. **The research lane in `train/`.** A separate architecture investigation —
   BitNet ternary QAT, recurrent depth, HDC soft-token memory — carried over
   from the project's previous incarnation. Nothing in `src/` imports it. See
   [research-lane.md](references/research-lane.md).

## The one thing worth converting now

30b has no activated adapters, so its `answerability` gate costs seconds per
source instead of 0.04s, eight times a question. Producing them is the single
highest-value model task available in this repository.

The 8b conversion was done on a CUDA box and needed **neither a GPU nor the
17.6 GB base model** — `--base-model-id` resolves shapes through `AutoConfig`
alone. So 30b is tractable.

The gate on success is not "it converted". It is:

```
adapter.alora.invocation_tokens == [100264, 78191, 100265]
```

the same invocation tokens as the working 3b files. Then a real run through
`tools/check.sh` claim 4 and a timing of `answerability` against the plain
adapter. Full recipe in [alora-conversion.md](references/alora-conversion.md).

## After any conversion

1. Hash the file. Put the hash in `cli/models.mjs` under `activatedSha`, and in
   `src/model/catalog.json` if the pack lists it. **Never write a hash from
   memory** — one in this repository was once half real and half invented.
2. Upload as a release asset under the `weights-v1` tag. Naming: 3b assets are
   unprefixed (`rag-alora-<name>.gguf`), everything else carries its size
   (`rag-8b-alora-<name>.gguf`). Renaming the originals would break every
   install pointing at them.
3. Add the name to `MODELS[size].activated` in `cli/models.mjs`, which is what
   flips the "activated gate" column for that size.
4. Update the size's `note` if the trade-off changed.
5. Run `node skills/qi-models/scripts/cards.mjs <size>` and read the download plan
   back. Nothing in it should say `unverified`.

## Where GPU work runs

| Tier | For |
|---|---|
| Mac | Development, data prep, smoke tests, and CPU-only conversion. Never a benchmark. |
| CUDA box | Single-GPU training and conversion. Detach the job; do not hold it open on an SSH session. |
| Modal | Fan-out, big-GPU, and overflow. `train/modal_*.py` are written for it and checkpoint to a volume so a preemption costs minutes rather than the run. |

## References

- [alora-conversion.md](references/alora-conversion.md) — the safetensors → GGUF
  recipe, what to verify, and why it matters.
- [research-lane.md](references/research-lane.md) — what `train/` and `.stage/`
  are, what they established, and the one file in `train/` that is live.
