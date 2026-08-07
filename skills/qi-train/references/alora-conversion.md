# Converting an activated LoRA to GGUF

## Why

IBM publishes each RAG intrinsic twice: a plain LoRA, and an **activated** one
that engages only after its invocation tokens, leaving the base model's KV cache
for the prompt valid.

On `answerability` — once per source read, eight times a question — that is
**16.98 s against 0.04 s per call**. It is the difference between the research
process being affordable and not existing.

IBM ships the activated variants as **safetensors only**. llama.cpp needs GGUF.
So the conversions are this project's own.

Done: 3b, 8b. Not done: **30b**. That is the gap.

## What the file must end up containing

One key, and it is the whole point:

```
adapter.alora.invocation_tokens
```

For every working file in this project it is `[100264, 78191, 100265]`. A
conversion that produces a valid GGUF without that key has produced a plain
LoRA wearing the right filename, and the only symptom will be that the app feels
slow.

Check it before anything else:

```sh
python3 llama.cpp/gguf-py/gguf/scripts/gguf_dump.py --no-tensors \
  packs/rag/alora/answerability.gguf | grep -i alora
```

## The recipe

> The exact invocation below is reconstructed from the commit that produced the
> 8b files (`939f64d`) rather than from a script checked into this repository.
> There is no `tools/convert*.sh`. Verify each step as you go, and **write the
> working invocation into `tools/` when you have it** — this is the obvious
> missing artefact in the repo.

What the commit records, and what matters:

- It ran on the CUDA box, but needed **neither a GPU nor the base model**.
- `--base-model-id` resolves tensor shapes through `AutoConfig` alone, which is
  why the 17.6 GB base was never downloaded.
- All three outputs carried the same invocation tokens as the working 3b files,
  and that was treated as the acceptance test.

Shape of the run:

```sh
# 1. the source adapters — safetensors, from IBM
huggingface-cli download ibm-granite/granitelib-rag-r1.0 \
  --include "answerability/granite-4.1-30b/alora/*" \
  --local-dir ./alora-src

# 2. convert, resolving shapes from the config rather than the weights
python3 llama.cpp/convert_lora_to_gguf.py \
  ./alora-src/answerability/granite-4.1-30b/alora \
  --base-model-id ibm-granite/granite-4.1-30b \
  --outtype f16 \
  --outfile rag-30b-alora-answerability.gguf
```

Note the two directory conventions in `cli/models.mjs`, because they differ and
it is not a typo:

| Field | 3b value | Used for |
|---|---|---|
| `lora` | `granite4.1_3b` | the plain LoRA path in `granitelib-rag-r1.0` |
| `alora` | `granite-4.1-3b` | the activated path |

Only three of the five have activated variants: `answerability`,
`query_rewrite`, `query_clarification`. `citations` and
`hallucination_detection` stay plain and keep paying the reprocess.

## Verifying properly

Converting is the easy half. In order:

1. **The key.** `gguf_dump` as above. `[100264, 78191, 100265]`.
2. **It loads.** Put it in `packs/rag/alora/`, start `tools/serve.sh`, and check
   `/lora-adapters` lists it — with `scale: 0`, like everything else.
3. **It changes the answer.** `bash tools/check.sh` claim 4. An adapter that
   loads but does not change the output is base weights wearing a hat, and looks
   identical from the outside.
4. **It is actually fast.** Time `answers()` against a real passage, plain
   versus activated. If the activated one is not sub-100 ms, the invocation
   tokens are not being honoured no matter what the metadata says.
5. **It agrees with 3b.** Run a handful of `domains.ts` questions and compare
   the `offTopic` rate. A gate that admits everything or refuses everything is
   broken in a way step 3 will not catch.

## Publishing

1. `shasum -a 256` the file. That value, and no other, goes into the code.
2. Upload as an asset on the `weights-v1` release under `qubie-org/qi`.
3. Naming, from `assetName()` in `cli/models.mjs`:

   ```
   3b      rag-alora-<name>.gguf          (unprefixed — the exception)
   others  rag-<size>-alora-<name>.gguf
   ```

   3b was converted first and its assets carry no size. Renaming them would
   break every install already pointing at them, so 3b stays the exception.
4. Add the hash to `MODELS[size].activatedSha` and the name to
   `MODELS[size].activated`. That second edit is what flips the "activated gate"
   column and changes what `qiui setup` tells a person they are getting.
5. Update `note` for that size.
6. `node skills/qi-models/scripts/cards.mjs <size>` — nothing in the plan should
   read `unverified`.

## While you are in there

`cli/models.mjs` has **no `sha256` for the 30b base model and no `activatedSha`
map at all**. Every 30b install is therefore unverified end to end. Fetch the
LFS oid from HuggingFace and fill it in. This is a small task with a real
failure behind it: a corrupt GGUF has been downloaded in this project before,
and `llama-bench` benchmarked it perfectly happily.
