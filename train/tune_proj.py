"""
Train ONLY the projection. The decoder stays frozen.

Everything measured so far says the same thing: facts injected as soft tokens
are linearly recoverable at the generation position (0.706 unbound+aligned,
against 0.062 chance), and the frozen head reads none of it (0.052–0.068, i.e.
chance). The information is present; the read-out is missing.

So the first fine-tune should touch only the read-out. 115k parameters — the
256→448 projection and its norm — against 35M frozen ones. If that moves
entity-hit off chance, the channel is confirmed end to end and scaling up is
justified. If it does not, the problem is deeper than the interface and a full
fine-tune would have been wasted.

Two choices carry the earlier findings:

  unbound     binding costs 40% of recoverable signal (0.706 → 0.419) and buys
              addressability the *decoder* does not need. The policy heads that
              do need it can read a separate bound state off the same facts.
  aligned init  the projection starts from the closed-form potion→BarunLM map
              rather than noise, so training refines an alignment instead of
              discovering one.

Metric is entity-hit alone. Loss is not reported as a result because the
templates dominate it — that was the flaw in the run this replaces.

    python3.12 train/tune_proj.py --smoke
    python3.12 train/tune_proj.py --steps 800
"""

import argparse
import glob
import json
import pathlib
import struct
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
from probe_align import CITIES, ATTRS, embed_fact, fit_alignment, load_potion, unit  # noqa: E402

SLOTS, FACT_DIM = 8, 256
MEM_CEILING_MB = 2000

# Held out so "learned the channel" cannot be "memorised four cities".
TRAIN_CITIES, TEST_CITIES = CITIES[:12], CITIES[12:]
TEMPLATES = [
    "The report is from {city}.",
    "This is {city}.",
    "Conditions in {city} today.",
    "Filed from {city}.",
]


class Inject(nn.Module):
    """The only trainable thing here."""

    def __init__(self, dim, W):
        super().__init__()
        self.proj = nn.Linear(FACT_DIM, dim, bias=False)
        with torch.no_grad():
            self.proj.weight.copy_(torch.tensor(W.T))
        self.scale = nn.Parameter(torch.ones(1))
        self.norm = nn.LayerNorm(dim)

    def forward(self, state):
        return self.norm(self.proj(state)) * self.scale


def state_for(city, rng, emb, index):
    """Unbound: facts laid in slots, meaning intact, no role multiply."""
    picks = rng.choice(len(ATTRS), size=2, replace=False)
    fs = [f"{city} {ATTRS[a]} {int(rng.integers(0, 99))}" for a in picks]
    st = np.zeros((SLOTS, FACT_DIM), np.float32)
    for i, f in enumerate(fs):
        st[i % SLOTS] += embed_fact(f, emb, index)
    return st


def make_batch(rng, tok, emb, index, n, cities):
    states, ids, labels = [], [], []
    for _ in range(n):
        city = cities[int(rng.integers(len(cities)))]
        text = TEMPLATES[int(rng.integers(len(TEMPLATES)))].format(city=city)
        t = tok.encode(text).ids[:32]
        states.append(state_for(city, rng, emb, index))
        ids.append(t)
    width = max(len(t) for t in ids)
    pad = [t + [0] * (width - len(t)) for t in ids]
    labels = [[x if j < len(t) else -100 for j, x in enumerate(p)] for t, p in zip(ids, pad)]
    return (torch.tensor(np.stack(states)), torch.tensor(pad), torch.tensor(labels))


def forward(m, cfg, inject, state, ids):
    pre = inject(state)
    x = torch.cat([pre, m.embedding(ids)], 1)
    checkpoint, si = x, 0
    for i, layer in enumerate(m.layers):
        x = layer(x, None)
        stride = cfg.residual_select_every
        if stride and (i + 1) % stride == 0:
            x = m.selectors[si](checkpoint, x)
            checkpoint, si = x, si + 1
    return m.lm_head(m.final_norm(x))[:, SLOTS:]


@torch.no_grad()
def entity_hit(m, cfg, inject, tok, emb, index, cities, seed, n=48):
    """Generate greedily from the state alone; did the right city come out?"""
    rng = np.random.default_rng(seed)
    states = np.stack([state_for(cities[int(rng.integers(len(cities)))], rng, emb, index) for _ in range(n)])
    want = [cities[int(np.random.default_rng(seed).integers(len(cities)))] for _ in range(n)]
    # regenerate deterministically so labels match the states above
    rng = np.random.default_rng(seed)
    want, states = [], []
    for _ in range(n):
        c = cities[int(rng.integers(len(cities)))]
        want.append(c)
        states.append(state_for(c, rng, emb, index))
    states = torch.tensor(np.stack(states))

    seed_ids = torch.tensor([tok.encode("The report is from").ids] * n)
    out = seed_ids
    for _ in range(8):
        logits = forward(m, cfg, inject, states, out)
        out = torch.cat([out, logits[:, -1].argmax(-1, keepdim=True)], 1)
    hits = 0
    tail = out[:, seed_ids.shape[1]:]
    for i in range(n):
        hits += want[i].lower() in tok.decode(tail[i].tolist()).lower()
    return hits / n, tok.decode(tail[0].tolist()).strip(), want[0]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--steps", type=int, default=800)
    ap.add_argument("--bs", type=int, default=16)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--smoke", action="store_true")
    a = ap.parse_args()
    if a.smoke:
        a.steps, a.bs = 20, 4

    cfg = BarunConfig(**json.load(open(BARUN + "/barun_config.json")))
    est = (35.2e6 * 4 + a.bs * 40 * cfg.vocab_size * 4 * 3 + a.bs * 40 * cfg.dim * 4 * 40) / 1e6
    print(f"estimated peak ≈ {est:.0f} MB (ceiling {MEM_CEILING_MB}, threads {torch.get_num_threads()})")
    if est > MEM_CEILING_MB:
        sys.exit("aborting: over ceiling")

    emb, words = load_potion()
    index = {w: i for i, w in enumerate(words)}
    tok = Tokenizer.from_file(BARUN + "/tokenizer.json")
    m = BarunLM(cfg)
    m.load_state_dict(load_file(BARUN + "/model.safetensors"), strict=False)
    m.eval()
    for p in m.parameters():
        p.requires_grad_(False)

    W, n_anchor, resid = fit_alignment(emb, words, tok, m.embedding.weight.detach().numpy())
    inject = Inject(cfg.dim, W)
    trainable = sum(p.numel() for p in inject.parameters() if p.requires_grad)
    frozen = sum(p.numel() for p in m.parameters())
    print(f"alignment on {n_anchor} words (cos {1-resid:.3f});  trainable {trainable/1e3:.0f}k  frozen {frozen/1e6:.1f}M")
    assert not any(p.requires_grad for p in m.parameters()), "decoder must stay frozen"

    opt = torch.optim.AdamW(inject.parameters(), lr=a.lr, weight_decay=0.0)
    lossf = nn.CrossEntropyLoss(ignore_index=-100)
    rng = np.random.default_rng(0)

    base_in, _, _ = entity_hit(m, cfg, inject, tok, emb, index, TRAIN_CITIES, 7)
    base_out, _, _ = entity_hit(m, cfg, inject, tok, emb, index, TEST_CITIES, 8)
    print(f"\n   before        seen {base_in:.3f}   held-out {base_out:.3f}"
          f"   (chance ≈ {1/len(TRAIN_CITIES):.3f} / {1/len(TEST_CITIES):.3f})\n")

    for step in range(1, a.steps + 1):
        state, ids, labels = make_batch(rng, tok, emb, index, a.bs, TRAIN_CITIES)
        logits = forward(m, cfg, inject, state, ids)
        loss = lossf(logits[:, :-1].reshape(-1, logits.shape[-1]), labels[:, 1:].reshape(-1))
        loss.backward()
        torch.nn.utils.clip_grad_norm_(inject.parameters(), 1.0)
        opt.step(); opt.zero_grad(set_to_none=True)

        if step % max(1, a.steps // 8) == 0 or step == a.steps:
            seen, sample, want = entity_hit(m, cfg, inject, tok, emb, index, TRAIN_CITIES, 7)
            held, _, _ = entity_hit(m, cfg, inject, tok, emb, index, TEST_CITIES, 8)
            print(f"   {step:5}  loss {loss.item():5.2f}   seen {seen:.3f}   held-out {held:.3f}"
                  f"    | want {want!r} got {sample[:34]!r}")


if __name__ == "__main__":
    main()
