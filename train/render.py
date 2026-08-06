"""
Can a 35M decoder render a sentence from soft-token state?

This is the experiment the whole architecture rests on. Everywhere else in the
design, information reaches the model as *text in a prompt*. Here it must arrive
as a fixed set of soft tokens bound out of an HDC state — facts never appear as
words the model can copy. If a 35M cannot learn that channel, the design is
wrong regardless of how good the memory is.

Staged deliberately:

  stage 1 (this file, no teacher, free)
      A generated world of (entity, attribute, value) triples rendered by
      template. The facts go in ONLY as vectors. The metric is whether the
      right entity and the right value come out. If the channel carries no
      information the model can still learn the template — and will score ~0
      on the slots, which is exactly the signal we want to see.

  stage 2 (later, Qwen via OpenRouter)
      Same channel, natural phrasing instead of templates. Only worth paying
      for once stage 1 says the channel works.

The conditioner here is the FIXED binding — bind each fact to its own role,
then bundle into a fixed slot budget. The version in common.py bundles first,
which measures at exactly 1/N (chance) in probe_hdc.py.

    python3.12 train/render.py --smoke      # tiny, CPU, is it wired up
    python3.12 train/render.py --steps 4000 # real run (GPU)
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
import torch.nn.functional as F

ROOT = pathlib.Path(__file__).resolve().parent.parent
BARUN = glob.glob(str(pathlib.Path.home() / ".cache/huggingface/hub/models--harrrshall--BarunLM-35M/snapshots/*/"))[0]
sys.path.insert(0, BARUN)

from barunlm.config import BarunConfig  # noqa: E402
from barunlm.model import BarunLM  # noqa: E402
from safetensors.torch import load_file  # noqa: E402
from tokenizers import Tokenizer  # noqa: E402

SLOTS = 8
FACT_DIM = 256
MAX_FACTS = 8


# ── the world ───────────────────────────────────────────────────────────────
# Small and closed, so "did it read the state" is answerable exactly. The
# entities are multi-token on purpose — Reykjavik costs 6 tokens in this
# vocabulary, and a renderer that only works on single-token names would be
# passing a test the real task does not offer.

CITIES = ["Reykjavik", "Lisbon", "Nairobi", "Osaka", "Bogota", "Helsinki", "Dakar", "Perth",
          "Quito", "Riga", "Tunis", "Vilnius", "Muscat", "Bergen", "Cusco", "Hobart"]
ATTRS = [("temperature", "degrees", (-20, 40)), ("wind", "km/h", (0, 90)),
         ("humidity", "percent", (10, 99)), ("population", "thousand", (50, 9000))]


def make_example(rng):
    city = CITIES[rng.integers(len(CITIES))]
    k = int(rng.integers(1, 3))
    picks = rng.choice(len(ATTRS), size=k, replace=False)
    facts, parts = [], []
    for a in picks:
        name, unit, (lo, hi) = ATTRS[a]
        val = int(rng.integers(lo, hi))
        facts.append(f"{city} {name} {val} {unit}")
        parts.append(f"{name} is {val} {unit}")
    return facts, f"In {city}, {' and '.join(parts)}.", city, [f.split()[-2] for f in facts]


# ── potion, for turning a fact string into a vector ─────────────────────────


def load_potion():
    raw = (ROOT / "public/models/potion/potion.bin").read_bytes()
    assert raw[:4] == b"PTN1"
    vocab, dim, scale = struct.unpack_from("<IIf", raw, 4)
    emb = np.frombuffer(raw, np.int8, offset=16, count=vocab * dim).reshape(vocab, dim).astype(np.float32) * scale
    words = json.loads((ROOT / "public/models/potion/potion.vocab.json").read_text())
    if isinstance(words, dict):
        words = words.get("vocab", words.get("words", list(words.keys())))
    return emb, {w: i for i, w in enumerate(words)}


def embed_fact(text, emb, index):
    """model2vec is a mean over token vectors; greedy longest-match is enough here."""
    vecs = []
    for word in text.lower().split():
        i = index.get(word)
        if i is None:
            # fall back to the longest prefix piece the table does have
            for cut in range(len(word), 1, -1):
                i = index.get(word[:cut]) or index.get(f"##{word[:cut]}")
                if i is not None:
                    break
        if i is not None:
            vecs.append(emb[i])
    if not vecs:
        return np.zeros(FACT_DIM, np.float32)
    v = np.mean(vecs, 0)
    return v / max(np.linalg.norm(v), 1e-6)


# ── the model ───────────────────────────────────────────────────────────────


class Conditioner(nn.Module):
    """Facts -> soft tokens. Bind each fact to its OWN role, then bundle.

    The order is the whole point. Bundling first (what common.py does) sums the
    facts into one vector before any role is applied, which destroys per-fact
    addressing — measured at exactly 1/N in probe_hdc.py. Binding first keeps
    each fact recoverable, and spreading over SLOTS accumulators means
    interference is between the ~N/SLOTS facts sharing a slot rather than all N.

    Roles are fixed bipolar, not learned: ±1 vectors are self-inverse under
    elementwise multiply, which is what makes unbinding exact, and learning them
    would only let the model drift away from that property.
    """

    def __init__(self, dim, slots=SLOTS, fact_dim=FACT_DIM):
        super().__init__()
        self.slots = slots
        g = torch.Generator().manual_seed(0)
        self.register_buffer("roles", (torch.randint(0, 2, (MAX_FACTS, fact_dim), generator=g) * 2 - 1).float())
        self.proj = nn.Linear(fact_dim, dim, bias=False)
        self.norm = nn.LayerNorm(dim)

    def forward(self, facts, mask):
        # facts (B, N, FACT_DIM), mask (B, N)
        B, N, _ = facts.shape
        bound = facts * self.roles[:N] * mask[..., None]
        state = facts.new_zeros(B, self.slots, facts.shape[-1])
        for i in range(N):
            state[:, i % self.slots] += bound[:, i]
        return self.norm(self.proj(state))


class Renderer(nn.Module):
    """BarunLM with a fact channel prepended to the sequence."""

    def __init__(self, barun):
        super().__init__()
        self.b = barun
        self.cond = Conditioner(barun.config.dim)

    def forward(self, ids, facts, mask, labels=None):
        pre = self.cond(facts, mask)                       # (B, slots, D)
        x = torch.cat([pre, self.b.embedding(ids)], 1)
        # The layer loop is reimplemented rather than called: BarunLM.forward
        # embeds input_ids itself and takes no inputs_embeds, so there is no
        # supported way to hand it a prefix.
        checkpoint, si = x, 0
        for index, layer in enumerate(self.b.layers):
            x = layer(x, None)
            stride = self.b.config.residual_select_every
            if stride and (index + 1) % stride == 0:
                x = self.b.selectors[si](checkpoint, x)
                checkpoint, si = x, si + 1
        logits = self.b.lm_head(self.b.final_norm(x))[:, pre.shape[1]:]
        if labels is None:
            return logits
        return logits, F.cross_entropy(logits[:, :-1].reshape(-1, logits.shape[-1]),
                                       labels[:, 1:].reshape(-1), ignore_index=-100)


# ── data ────────────────────────────────────────────────────────────────────


def batch(rng, tok, emb, index, n, device):
    ids, facts, masks, metas = [], [], [], []
    for _ in range(n):
        fs, sentence, city, vals = make_example(rng)
        t = tok.encode(sentence).ids[:64]
        ids.append(t)
        fv = [embed_fact(f, emb, index) for f in fs]
        m = [1.0] * len(fv) + [0.0] * (MAX_FACTS - len(fv))
        fv += [np.zeros(FACT_DIM, np.float32)] * (MAX_FACTS - len(fv))
        facts.append(np.stack(fv)); masks.append(m); metas.append((sentence, city, vals))
    width = max(len(t) for t in ids)
    pad = [t + [0] * (width - len(t)) for t in ids]
    lab = [[x if j < len(t) else -100 for j, x in enumerate(p)] for t, p in zip(ids, pad)]
    return (torch.tensor(pad, device=device), torch.tensor(np.array(facts), device=device),
            torch.tensor(masks, device=device), torch.tensor(lab, device=device), metas)


@torch.no_grad()
def evaluate(model, tok, rng, emb, index, device, n=64):
    """Did the entity and the value actually come out of the state?"""
    model.eval()
    ids, facts, masks, _, metas = batch(rng, tok, emb, index, n, device)
    gen = torch.zeros(n, 1, dtype=torch.long, device=device)
    out = [[] for _ in range(n)]
    for _ in range(48):
        logits = model(gen, facts, masks)
        nxt = logits[:, -1].argmax(-1, keepdim=True)
        gen = torch.cat([gen, nxt], 1)
        for i in range(n):
            out[i].append(int(nxt[i, 0]))
    city_hit = val_hit = 0
    for i, (sentence, city, vals) in enumerate(metas):
        text = tok.decode(out[i])
        city_hit += city.lower() in text.lower()
        val_hit += all(v in text for v in vals)
    model.train()
    return city_hit / n, val_hit / n, tok.decode(out[0]), metas[0][0]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--steps", type=int, default=4000)
    ap.add_argument("--bs", type=int, default=32)
    ap.add_argument("--lr", type=float, default=3e-4)
    ap.add_argument("--smoke", action="store_true")
    a = ap.parse_args()
    if a.smoke:
        a.steps, a.bs = 30, 4

    device = "cuda" if torch.cuda.is_available() else "cpu"
    rng = np.random.default_rng(0)
    emb, index = load_potion()
    tok = Tokenizer.from_file(BARUN + "/tokenizer.json")
    cfg = BarunConfig(**json.load(open(BARUN + "/barun_config.json")))
    barun = BarunLM(cfg)
    barun.load_state_dict(load_file(BARUN + "/model.safetensors"), strict=False)
    model = Renderer(barun).to(device)
    print(f"device {device}  params {sum(p.numel() for p in model.parameters())/1e6:.1f}M  "
          f"(conditioner {sum(p.numel() for p in model.cond.parameters())/1e3:.0f}k)")

    opt = torch.optim.AdamW(model.parameters(), lr=a.lr, weight_decay=0.01)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, a.lr, total_steps=a.steps, pct_start=0.1)

    sel0 = [s.score.weight.detach().clone() for s in barun.selectors]
    for step in range(1, a.steps + 1):
        ids, facts, masks, labels, _ = batch(rng, tok, emb, index, a.bs, device)
        _, loss = model(ids, facts, masks, labels)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        opt.step(); sched.step(); opt.zero_grad(set_to_none=True)
        if step % max(1, a.steps // 10) == 0 or step == a.steps:
            c, v, sample, want = evaluate(model, tok, rng, emb, index, device, n=16 if a.smoke else 64)
            print(f"  {step:5}  loss {loss.item():.3f}   entity {c:.2f}  value {v:.2f}")
            if step == a.steps:
                print(f"        want: {want}\n        got : {sample.strip()[:90]}")

    print("\n── did the residual selectors move?")
    for i, (s, before) in enumerate(zip(barun.selectors, sel0)):
        after = s.score.weight.detach()
        drift = (after - before).norm() / before.norm().clamp(min=1e-6)
        print(f"   selector {i}: |Δ|/|w| = {drift:.3f}   std {before.std():.4f} → {after.std():.4f}")


if __name__ == "__main__":
    main()
