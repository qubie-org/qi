"""
Superposition and binding: the two things the architecture needs and that
`tune_scale.py` did not test.

That run confirmed the channel — held-out generation 0.875 on never-seen
entities, from a 116k map into a frozen decoder. But its state held two facts
about ONE entity, unbound. Everything in the slots agreed, and nothing had to be
picked out. The real case is a state holding facts about several different
things, one of which the question is about.

So the state here carries N *distinct* entities, each paired with its own
relation, and the prompt names one relation:

    state  = { harbour↔depth, ledger↔value, cabinet↔grade, ... }
    prompt = "The depth report is from"     →     harbour

Nothing in the prompt identifies the entity. The only way to answer is to find
the slot matching the cue and read off what it is bound to — associative
retrieval out of a superposition, which is exactly what an agent state must
support.

Two axes, swept together:

  N ∈ {1,2,4,8}   how many distinct entities share the fixed slot budget
  bind ∈ {0,1}    ±1 role multiply. Binding is what makes a fact addressable
                  by the policy/memory heads, and it cost 40% of linearly
                  recoverable signal before any training (0.706 → 0.419). Does
                  training buy that back, or is the two-channel split real?

The projection is per-slot here, unlike `tune_scale.py`. Unbinding a ±1 role is
an elementwise multiply, which a *shared* map applied identically to every slot
cannot represent — so a shared projection would handicap the bound condition for
a reason that has nothing to do with the question. Both conditions get per-slot
maps so the only difference between them is the binding.

    python3.12 train/tune_super.py --smoke
    python3.12 train/tune_super.py --steps 1000
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
from tune_scale import build_entities  # noqa: E402

SLOTS, FACT_DIM = 8, 256
MEM_CEILING_MB = 3000
CANDIDATES = 64
# One relation per slot at most, so N <= SLOTS keeps each fact addressable and
# isolates decoder-side superposition from the intra-slot crowding that
# probe_hdc.py already characterised.
RELATIONS = ["depth", "value", "grade", "score", "weight", "height", "length", "width"]


class Inject(nn.Module):
    """Per-slot projections, so unbinding a slot's role is representable."""

    def __init__(self, dim, W):
        super().__init__()
        self.proj = nn.Parameter(torch.tensor(W).unsqueeze(0).repeat(SLOTS, 1, 1))
        self.scale = nn.Parameter(torch.ones(1))
        self.norm = nn.LayerNorm(dim)

    def forward(self, state):           # (B, SLOTS, FACT_DIM)
        out = torch.einsum("bsf,sfd->bsd", state, self.proj)
        return self.norm(out) * self.scale


def make_state(entities, rng, emb, potion_index, roles, n_facts, bind):
    """N distinct entities, each bound to its own relation, one per slot."""
    picks = rng.choice(len(entities), size=n_facts, replace=False)
    rels = rng.choice(len(RELATIONS), size=n_facts, replace=False)
    st = np.zeros((SLOTS, FACT_DIM), np.float32)
    pairs = []
    for i, (pi, ri) in enumerate(zip(picks, rels)):
        word, tid = entities[int(pi)]
        rel = RELATIONS[int(ri)]
        v = unit(np.mean([emb[potion_index[w]] for w in (word, rel) if w in potion_index], 0))
        st[i] = v * roles[i] if bind else v
        pairs.append((word, tid, rel))
    # The question is about one of them, chosen at random — so the model cannot
    # succeed by always reading slot 0.
    ask = int(rng.integers(n_facts))
    return st, pairs[ask]


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


def encode_prompt(tok, rel):
    return tok.encode(f"The {rel} report is from").ids


def make_batch(rng, entities, emb, potion_index, roles, tok, n, n_facts, bind):
    states, ids, labels = [], [], []
    for _ in range(n):
        st, (word, tid, rel) = make_state(entities, rng, emb, potion_index, roles, n_facts, bind)
        p = encode_prompt(tok, rel)
        states.append(st)
        ids.append(p + [tid])
        labels.append([-100] * len(p) + [tid])
    width = max(len(x) for x in ids)
    ids = [x + [0] * (width - len(x)) for x in ids]
    labels = [x + [-100] * (width - len(x)) for x in labels]
    return torch.tensor(np.stack(states)), torch.tensor(ids), torch.tensor(labels)


@torch.no_grad()
def score(m, cfg, inject, entities, emb, potion_index, roles, tok, seed, n_facts, bind, n=128):
    rng = np.random.default_rng(seed)
    states, prompts, golds = [], [], []
    for _ in range(n):
        st, (word, tid, rel) = make_state(entities, rng, emb, potion_index, roles, n_facts, bind)
        states.append(st); prompts.append(encode_prompt(tok, rel)); golds.append(tid)
    width = max(len(p) for p in prompts)
    ids = torch.tensor([p + [0] * (width - len(p)) for p in prompts])
    logits = forward(m, cfg, inject, torch.tensor(np.stack(states)), ids)
    # Prompts are equal length in practice, but read the true last position.
    last = torch.tensor([len(p) - 1 for p in prompts])
    logits = logits[torch.arange(n), last]
    gold = torch.tensor(golds)
    hit = float((logits.argmax(-1) == gold).float().mean())

    rng2 = np.random.default_rng(seed + 1)
    wins = mrr = 0.0
    for i in range(n):
        pool = torch.tensor([int(gold[i])] + [entities[int(rng2.integers(len(entities)))][1]
                                              for _ in range(CANDIDATES - 1)])
        s = logits[i, pool]
        rank = int((s > s[0]).sum()) + 1
        wins += rank == 1
        mrr += 1.0 / rank
    return hit, wins / n, mrr / n


def condition(m, cfg, W, entities_tr, entities_ho, emb, potion_index, roles, tok, n_facts, bind, steps, bs, lr):
    inject = Inject(cfg.dim, W)
    opt = torch.optim.AdamW(inject.parameters(), lr=lr, weight_decay=0.0)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, lr, total_steps=steps, pct_start=0.1)
    lossf = nn.CrossEntropyLoss(ignore_index=-100)
    rng = np.random.default_rng(0)
    for step in range(1, steps + 1):
        st, ids, lab = make_batch(rng, entities_tr, emb, potion_index, roles, tok, bs, n_facts, bind)
        logits = forward(m, cfg, inject, st, ids)
        loss = lossf(logits[:, :-1].reshape(-1, logits.shape[-1]), lab[:, 1:].reshape(-1))
        loss.backward()
        torch.nn.utils.clip_grad_norm_(inject.parameters(), 1.0)
        opt.step(); sched.step(); opt.zero_grad(set_to_none=True)
    seen = score(m, cfg, inject, entities_tr, emb, potion_index, roles, tok, 4, n_facts, bind)
    held = score(m, cfg, inject, entities_ho, emb, potion_index, roles, tok, 5, n_facts, bind)
    return seen, held, float(loss.item())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--steps", type=int, default=1000)
    ap.add_argument("--bs", type=int, default=32)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--smoke", action="store_true")
    a = ap.parse_args()
    facts_sweep = [1, 2, 4, 8]
    if a.smoke:
        a.steps, a.bs, facts_sweep = 40, 8, [1, 4]

    cfg = BarunConfig(**json.load(open(BARUN + "/barun_config.json")))
    est = (35.2e6 * 4 + a.bs * 20 * cfg.vocab_size * 4 * 3 + SLOTS * FACT_DIM * cfg.dim * 4 * 3) / 1e6
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
    roles = (rng.integers(0, 2, (SLOTS, FACT_DIM)) * 2 - 1).astype(np.float32)
    W, _, resid = fit_alignment(emb, words, tok, m.embedding.weight.detach().numpy())

    trainable = SLOTS * FACT_DIM * cfg.dim + cfg.dim * 2 + 1
    print(f"entities {len(entities)} → train {len(train)} / held-out {len(held)};  "
          f"alignment cos {1-resid:.3f};  trainable {trainable/1e3:.0f}k  frozen 35.1M")
    print(f"chance: gen {1/len(entities):.4f}   top1/{CANDIDATES} {1/CANDIDATES:.3f}\n")
    print(f"   {'facts':>5} {'bind':>5} | {'seen gen':>9} {'top1':>6} | {'HELD gen':>9} {'top1':>6} {'mrr':>6} | loss")
    print("   " + "─" * 68)

    for n_facts in facts_sweep:
        for bind in (False, True):
            (sg, sw, _), (hg, hw, hm), loss = condition(
                m, cfg, W, train, held, emb, potion_index, roles, tok,
                n_facts, bind, a.steps, a.bs, a.lr)
            print(f"   {n_facts:>5} {str(bind):>5} | {sg:9.3f} {sw:6.3f} | {hg:9.3f} {hw:6.3f} {hm:6.3f} | {loss:.2f}")


if __name__ == "__main__":
    main()
