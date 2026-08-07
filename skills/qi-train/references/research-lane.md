# The research lane: `train/` and `.stage/`

Neither directory is part of the app. Nothing in `src/` imports either. They are
tracked because the questions they answer are still open, and because deleting a
negative result is how a project pays for the same experiment twice.

Read this before touching them, and before telling anyone that qi "trains a
model" — it does not.

## `train/` — toki v2

The previous incarnation of this project trained a model from scratch: a
recurrent, ternary (BitNet b1.58) architecture with an HDC memory channel. qi
replaced all of it with one file of Granite weights. What survives is the
measurement record.

| File | Asks |
|---|---|
| `common.py` | The v2 config and the ternary QAT. v1 was D=160, char-level, 323K ternary params, 74.5% exact-match on tool calls after 12k steps on a T4 — never enough training to say anything about the ceiling. v2: D=768, 8192 BPE, input injection per Parcae/Universal Transformer, prelude/loop/coda. |
| `modal_prep.py` | Trains an 8192 BPE and tokenises FineWeb-edu to shards. Characters cannot carry a real corpus: every word costs 5–8 positions, so a 512-token window held ~80 words. |
| `modal_pretrain.py` | BitNet b1.58 QAT over FineWeb-edu. Dense first, MoE second — recurrence, ternary QAT and expert routing can each ruin a loss curve and v1 already paid for the lesson that you cannot tell them apart after the fact (prune-after-QAT took val 0.043 to 0.19). |
| `probe_hdc.py` | Can N facts bound into one fixed state still be told apart from 200 distractors? The whole design rests on this and it was unverified. |
| `probe_channel.py` | Does information injected as soft tokens survive 12 frozen decoder layers? A linear probe, no training. |
| `probe_align.py` | Fits the potion→decoder map in closed form on shared vocabulary, so an injected fact arrives in coordinates the model already speaks. |
| `tune_proj.py` | Trains **only** the 115k projection, decoder frozen. Took entity-hit 0 → 0.958 on twelve entities and left held-out at exactly 0.000 for 1200 steps — a lookup table, not a channel. |
| `tune_scale.py` | The same with thousands of entities, making a systematic map cheaper than memorisation. Held-out generation 0.875 on never-seen entities from a 116k map into a frozen decoder. |
| `tune_super.py` | Superposition and binding: a state holding facts about several *different* things, one of which the question is about. The case `tune_scale` did not test. |
| `render.py` / `modal_render.py` | Can a 35M decoder render a sentence from soft-token state, with facts arriving only as vectors? CPU-smoke-testable and GPU-decisive versions of one experiment. |

The through-line: the soft-token channel carries information (0.706 linear
recoverability against 0.062 chance), the frozen head does not read it (0.052–
0.068, chance), so the read-out was the missing piece, and training only the
projection confirmed the channel end to end once entity diversity made
memorisation the expensive option.

None of that is wired to qi. If you are asked to "train the model", this is
probably not what is meant — check.

## The one live file

`train/downgrade.py` is a **faithful port of `src/inline/downgrade.ts`**, and
`train/test_downgrade_parity.py` is the gate that proves they agree byte for
byte over a corpus.

It exists because a model's training targets have to be exactly what the
renderer will later produce, or it learns a dialect the page cannot speak.

**Keep them in lockstep. If one changes, both change**, and run the parity test:

```sh
python3 train/test_downgrade_parity.py
```

This is the only reason `train/` is not simply archived.

## `.stage/` — the HDC bench

A self-contained C program (no build system, no bun, no Python) asking one
question carried over from TinyOS: **can a deterministic, untrained vector rank
the document a query came from?**

What TinyOS established: deterministic replay, journals as truth, a derived and
regenerable store, 97% of turns rendered from structure, grammar-constrained
decoding proven on a 360M model, 13 gates usable as reward. What failed was one
thing — `tvec`, bundling every word of a document into one vector — and it
blocked the two paths that motivated the plan.

Findings recorded in `.stage/README.md` and `.stage/THEORY.md`:

- Set semantics beat `tvec` by 23 points.
- IDF masking: **rejected**.
- Many vectors per node: **rejected**.
- The real bottleneck is query sparsity, not document representation.

`bash .stage/build.sh` builds it. It touches nothing else in the repository.

## Rules for both

- **Never run either on the Mac** beyond a smoke test. See the parent skill.
- A negative result is a result. If you re-run an experiment here, write the
  number down next to the old one rather than replacing it.
- Do not import from `train/` or `.stage/` into `src/`. If something in there
  becomes load-bearing, move it and say so in the commit.
