"""
Does the channel generalise once memorising stops being the cheap option?

`tune_proj.py` took entity-hit from 0 to 0.958 on twelve entities and left
held-out at exactly 0.000 for 1200 steps, with loss at 0.02 by step 300. That is
a lookup table: 116k parameters is far more than enough to memorise twelve
state→name pairs, so gradient descent bought the memorisation and threw away the
systematic potion→BarunLM alignment it started from.

The diagnosis said the bottleneck is entity *diversity*, not steps or capacity.
So the only thing that changes here is the number of entities — thousands
instead of twelve — making a systematic map cheaper than a lookup. Same 116k
projection, same frozen decoder, same held-out protocol.

Two changes to how it is judged, both from what the last run taught:

  single-token entities   "Reykjavik" costs 6 tokens in this vocabulary, so
                          generating it is a six-way-compounded bet and scores
                          zero for near-misses. Entities here are one token, so
                          the metric measures the channel rather than the
                          tokenizer.
  rank as well as hit     generation is all-or-nothing and can score 0.000 while
                          the right answer sits second. Forced-choice rank over
                          candidate entities gives partial credit and can
                          distinguish "no signal" from "weak signal".

    python3.12 train/tune_scale.py --smoke
    python3.12 train/tune_scale.py --steps 3000
"""

import argparse
import glob
import json
import pathlib
import sys

import numpy as np
import torch
import torch.nn as nn

torch.set_num_threads(2)

ROOT = pathlib.Path(__file__).resolve().parent.parent
BARUN = glob.glob(str(pathlib.Path.home() / ".cache/huggingface/hub/models--harrrshall--BarunLM-35M/snapshots/*/"))[0]
sys.path.insert(0, BARUN)

from barunlm.config import BarunConfig  # noqa: E402
from barunlm.model import BarunLM  # noqa: E402
from safetensors.torch import load_file  # noqa: E402
from tokenizers import Tokenizer  # noqa: E402
from probe_align import fit_alignment, load_potion, unit  # noqa: E402

SLOTS, FACT_DIM = 8, 256
MEM_CEILING_MB = 2500
RELATIONS = ["level", "size", "count", "rate", "value", "grade", "score", "depth"]
PROMPT = "The report is from"
CANDIDATES = 64


def build_entities(potion_words, potion_index, tok, min_len=4):
    """Words both tables know, that BarunLM can emit in a single token.

    Single-token is the point: it removes the tokenizer from the measurement.
    A six-token entity turns generation into six compounded guesses and scores
    zero for getting five right, which would tell us about BPE rather than about
    the channel.
    """
    out = []
    for surface, tid in tok.get_vocab().items():
        key = surface.replace("Ġ", "").replace("▁", "")
        if len(key) < min_len or not key.isalpha() or not key.islower():
            continue
        if key in potion_index and surface.startswith(("Ġ", "▁")):
            out.append((key, tid))
    out.sort()
    return out


class Inject(nn.Module):
    def __init__(self, dim, W):
        super().__init__()
        self.proj = nn.Linear(FACT_DIM, dim, bias=False)
        with torch.no_grad():
            self.proj.weight.copy_(torch.tensor(W.T))
        self.scale = nn.Parameter(torch.ones(1))
        self.norm = nn.LayerNorm(dim)

    def forward(self, state):
        return self.norm(self.proj(state)) * self.scale


def state_for(word, rng, emb, potion_index):
    """Unbound facts in slots — binding costs 40% of recoverable signal."""
    st = np.zeros((SLOTS, FACT_DIM), np.float32)
    for i in range(2):
        rel = RELATIONS[int(rng.integers(len(RELATIONS)))]
        parts = [emb[potion_index[w]] for w in (word, rel) if w in potion_index]
        st[i % SLOTS] += unit(np.mean(parts, 0))
    return st


def make_batch(rng, entities, emb, potion_index, prompt_ids, n):
    states, ids, labels = [], [], []
    for _ in range(n):
        word, tid = entities[int(rng.integers(len(entities)))]
        states.append(state_for(word, rng, emb, potion_index))
        seq = prompt_ids + [tid]
        ids.append(seq)
        # Only the entity position is supervised. Everything before it is the
        # same fixed prompt in every example and would otherwise dominate the
        # loss exactly the way the templates did last time.
        labels.append([-100] * len(prompt_ids) + [tid])
    return (torch.tensor(np.stack(states)), torch.tensor(ids), torch.tensor(labels))


def forward(m, cfg, inject, state, ids):
    x = torch.cat([inject(state), m.embedding(ids)], 1)
    checkpoint, si = x, 0
    for i, layer in enumerate(m.layers):
        x = layer(x, None)
        stride = cfg.residual_select_every
        if stride and (i + 1) % stride == 0:
            x = m.selectors[si](checkpoint, x)
            checkpoint, si = x, si + 1
    return m.lm_head(m.final_norm(x))[:, SLOTS:]


@torch.no_grad()
def score(m, cfg, inject, entities, emb, potion_index, prompt_ids, seed, n=128):
    """Generation hit (argmax over the WHOLE vocabulary) and forced-choice rank."""
    rng = np.random.default_rng(seed)
    picks = [entities[int(rng.integers(len(entities)))] for _ in range(n)]
    states = torch.tensor(np.stack([state_for(w, rng, emb, potion_index) for w, _ in picks]))
    ids = torch.tensor([prompt_ids] * n)
    logits = forward(m, cfg, inject, states, ids)[:, -1]

    gold = torch.tensor([tid for _, tid in picks])
    hit = float((logits.argmax(-1) == gold).float().mean())

    # Forced choice: the right entity against CANDIDATES-1 others drawn from the
    # same pool. Partial credit, so a weak signal is distinguishable from none.
    rng2 = np.random.default_rng(seed + 1)
    wins = mrr = 0.0
    for i in range(n):
        distract = [entities[int(rng2.integers(len(entities)))][1] for _ in range(CANDIDATES - 1)]
        pool = torch.tensor([int(gold[i])] + distract)
        s = logits[i, pool]
        rank = int((s > s[0]).sum()) + 1
        wins += rank == 1
        mrr += 1.0 / rank
    return hit, wins / n, mrr / n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--steps", type=int, default=3000)
    ap.add_argument("--bs", type=int, default=32)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--smoke", action="store_true")
    a = ap.parse_args()
    if a.smoke:
        a.steps, a.bs = 30, 8

    cfg = BarunConfig(**json.load(open(BARUN + "/barun_config.json")))
    est = (35.2e6 * 4 + a.bs * 16 * cfg.vocab_size * 4 * 3 + a.bs * 16 * cfg.dim * 4 * 40) / 1e6
    print(f"estimated peak ≈ {est:.0f} MB (ceiling {MEM_CEILING_MB}, threads {torch.get_num_threads()})")
    if est > MEM_CEILING_MB:
        sys.exit("aborting: over ceiling")

    emb, words = load_potion()
    potion_index = {w: i for i, w in enumerate(words)}
    tok = Tokenizer.from_file(BARUN + "/tokenizer.json")
    m = BarunLM(cfg)
    m.load_state_dict(load_file(BARUN + "/model.safetensors"), strict=False)
    m.eval()
    for p in m.parameters():
        p.requires_grad_(False)

    entities = build_entities(words, potion_index, tok)
    rng = np.random.default_rng(0)
    order = rng.permutation(len(entities))
    cut = int(len(entities) * 0.85)
    train = [entities[i] for i in order[:cut]]
    held = [entities[i] for i in order[cut:]]

    W, n_anchor, resid = fit_alignment(emb, words, tok, m.embedding.weight.detach().numpy())
    inject = Inject(cfg.dim, W)
    print(f"entities {len(entities)} single-token  →  train {len(train)}  held-out {len(held)}")
    print(f"alignment on {n_anchor} words (cos {1-resid:.3f});  "
          f"trainable {sum(p.numel() for p in inject.parameters())/1e3:.0f}k  frozen {sum(p.numel() for p in m.parameters())/1e6:.1f}M")
    assert not any(p.requires_grad for p in m.parameters()), "decoder must stay frozen"

    prompt_ids = tok.encode(PROMPT).ids
    opt = torch.optim.AdamW(inject.parameters(), lr=a.lr, weight_decay=0.0)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, a.lr, total_steps=a.steps, pct_start=0.1)
    lossf = nn.CrossEntropyLoss(ignore_index=-100)

    h, w, mr = score(m, cfg, inject, held, emb, potion_index, prompt_ids, 5)
    print(f"\n   before   held-out  gen {h:.3f}  top1/{CANDIDATES} {w:.3f}  mrr {mr:.3f}"
          f"   (chance ≈ {1/len(entities):.4f} / {1/CANDIDATES:.3f})\n")

    for step in range(1, a.steps + 1):
        state, ids, labels = make_batch(rng, train, emb, potion_index, prompt_ids, a.bs)
        logits = forward(m, cfg, inject, state, ids)
        loss = lossf(logits[:, :-1].reshape(-1, logits.shape[-1]), labels[:, 1:].reshape(-1))
        loss.backward()
        torch.nn.utils.clip_grad_norm_(inject.parameters(), 1.0)
        opt.step(); sched.step(); opt.zero_grad(set_to_none=True)

        if step % max(1, a.steps // 10) == 0 or step == a.steps:
            sh, sw, _ = score(m, cfg, inject, train, emb, potion_index, prompt_ids, 4)
            hh, hw, hm = score(m, cfg, inject, held, emb, potion_index, prompt_ids, 5)
            print(f"   {step:5}  loss {loss.item():5.2f} | seen gen {sh:.3f} top1 {sw:.3f}"
                  f" | HELD-OUT gen {hh:.3f} top1 {hw:.3f} mrr {hm:.3f}")


if __name__ == "__main__":
    main()
