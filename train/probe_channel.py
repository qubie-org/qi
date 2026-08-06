"""
Does information injected as soft tokens survive the decoder?

No training. This asks the one thing that decides whether the soft-token channel
is worth training at all: if facts are bound into a fixed HDC state, projected
to the decoder's width, and run through all 12 frozen layers, is the identity of
those facts still *there* at the output?

The instrument is a linear probe — a ridge regression from hidden states to
"which city was in the state". Fitting a linear readout is not training the
model; the model never sees a gradient. If a linear map can recover the fact,
then the information survived and a fine-tune has something to learn from. If it
is at chance, the injection destroys the signal and no amount of fine-tuning is
the cheap fix — the injection mechanism is what needs changing.

Three points are probed, so a failure can be localised:

  state    the conditioner output, before the transformer
  layer 6  halfway
  final    after all 12 layers and the final norm — what the head actually sees

A drop between `state` and `final` is the transformer washing the prefix out. A
low score at `state` would mean the conditioner itself is lossy.

Everything runs under no_grad on CPU with a capped thread count and a printed
memory estimate. It is a few hundred forward passes on a 35M model — smaller
than the smoke test that already ran here.

    python3.12 train/probe_channel.py
"""

import glob
import json
import pathlib
import struct
import sys

import numpy as np
import torch

# Guards first, before anything allocates. Two threads keeps the machine
# usable; the default would take every core for a job that does not need them.
torch.set_num_threads(2)

ROOT = pathlib.Path(__file__).resolve().parent.parent
BARUN = glob.glob(str(pathlib.Path.home() / ".cache/huggingface/hub/models--harrrshall--BarunLM-35M/snapshots/*/"))[0]
sys.path.insert(0, BARUN)

from barunlm.config import BarunConfig  # noqa: E402
from barunlm.model import BarunLM  # noqa: E402
from safetensors.torch import load_file  # noqa: E402
from tokenizers import Tokenizer  # noqa: E402

N_EXAMPLES = 384
BATCH = 16
SEQ = 24
SLOTS = 8
FACT_DIM = 256
MEM_CEILING_MB = 1500

CITIES = ["Reykjavik", "Lisbon", "Nairobi", "Osaka", "Bogota", "Helsinki", "Dakar", "Perth",
          "Quito", "Riga", "Tunis", "Vilnius", "Muscat", "Bergen", "Cusco", "Hobart"]
ATTRS = ["temperature", "wind", "humidity", "population"]


def budget(dim: int, vocab: int) -> float:
    """Peak resident estimate, so this aborts rather than swaps."""
    weights = 35.2e6 * 4
    acts = BATCH * (SEQ + SLOTS) * dim * 4 * 14        # 12 layers + slack
    logits = BATCH * (SEQ + SLOTS) * vocab * 4
    collected = N_EXAMPLES * dim * 4 * 3               # the three probe points
    return (weights + acts + logits + collected) / 1e6


def load_potion():
    raw = (ROOT / "public/models/potion/potion.bin").read_bytes()
    assert raw[:4] == b"PTN1"
    v, d, sc = struct.unpack_from("<IIf", raw, 4)
    emb = np.frombuffer(raw, np.int8, offset=16, count=v * d).reshape(v, d).astype(np.float32) * sc
    words = json.loads((ROOT / "public/models/potion/potion.vocab.json").read_text())
    if isinstance(words, dict):
        words = words.get("vocab", words.get("words", list(words.keys())))
    return emb, {w: i for i, w in enumerate(words)}


def embed_fact(text, emb, index):
    vecs = [emb[index[w]] for w in text.lower().split() if w in index]
    if not vecs:
        return np.zeros(FACT_DIM, np.float32)
    v = np.mean(vecs, 0)
    return v / max(np.linalg.norm(v), 1e-6)


def bind_state(facts, roles):
    """The FIXED binding: each fact to its own role, bundled into SLOTS."""
    state = np.zeros((SLOTS, FACT_DIM), np.float32)
    for i, f in enumerate(facts):
        state[i % SLOTS] += f * roles[i]
    return state


def ridge_probe(X, y, classes, folds=4, lam=1.0):
    """Cross-validated linear readout. Chance is 1/len(classes)."""
    X = (X - X.mean(0)) / (X.std(0) + 1e-6)
    X = np.concatenate([X, np.ones((len(X), 1), np.float32)], 1)
    Y = np.eye(classes)[y]
    n = len(X)
    order = np.random.default_rng(0).permutation(n)
    X, Y, y = X[order], Y[order], y[order]
    hits = 0
    for f in range(folds):
        va = np.zeros(n, bool)
        va[f * n // folds:(f + 1) * n // folds] = True
        Xt, Yt = X[~va], Y[~va]
        W = np.linalg.solve(Xt.T @ Xt + lam * np.eye(Xt.shape[1]), Xt.T @ Yt)
        hits += int((np.argmax(X[va] @ W, 1) == y[va]).sum())
    return hits / n


@torch.no_grad()
def main():
    cfg = BarunConfig(**json.load(open(BARUN + "/barun_config.json")))
    est = budget(cfg.dim, cfg.vocab_size)
    print(f"estimated peak ≈ {est:.0f} MB (ceiling {MEM_CEILING_MB} MB, threads {torch.get_num_threads()})")
    if est > MEM_CEILING_MB:
        sys.exit(f"aborting: estimate {est:.0f} MB exceeds ceiling")

    emb, index = load_potion()
    tok = Tokenizer.from_file(BARUN + "/tokenizer.json")
    m = BarunLM(cfg)
    m.load_state_dict(load_file(BARUN + "/model.safetensors"), strict=False)
    m.eval()

    rng = np.random.default_rng(0)
    roles = (rng.integers(0, 2, (SLOTS, FACT_DIM)) * 2 - 1).astype(np.float32)
    # Untrained projection, fixed. This is deliberately the *worst* case: a
    # random map into the decoder's width, exactly what a fine-tune would start
    # from. If the signal survives even this, training can only improve it.
    # np.sqrt returns float64 and would silently promote the whole matrix.
    proj = torch.tensor((rng.standard_normal((FACT_DIM, cfg.dim)) / float(np.sqrt(FACT_DIM))).astype(np.float32))

    prompt = tok.encode("The report says").ids[:SEQ]
    ids = torch.tensor([prompt] * BATCH)

    feats = {"state": [], "layer6": [], "final": [], "final@last": []}
    labels = []

    for start in range(0, N_EXAMPLES, BATCH):
        states, ys = [], []
        for _ in range(BATCH):
            ci = int(rng.integers(len(CITIES)))
            picks = rng.choice(len(ATTRS), size=2, replace=False)
            fs = [f"{CITIES[ci]} {ATTRS[a]} {int(rng.integers(0, 99))}" for a in picks]
            states.append(bind_state([embed_fact(f, emb, index) for f in fs], roles))
            ys.append(ci)
        st = torch.tensor(np.stack(states))
        pre = st @ proj                                   # (B, SLOTS, D)

        x = torch.cat([pre, m.embedding(ids)], 1)
        feats["state"].append(pre.mean(1).numpy())

        checkpoint, si = x, 0
        for i, layer in enumerate(m.layers):
            x = layer(x, None)
            stride = cfg.residual_select_every
            if stride and (i + 1) % stride == 0:
                x = m.selectors[si](checkpoint, x)
                checkpoint, si = x, si + 1
            if i == 5:
                feats["layer6"].append(x[:, SLOTS:].mean(1).numpy())
        fin = m.final_norm(x)
        feats["final"].append(fin[:, SLOTS:].mean(1).numpy())
        # The last text position is what generation actually conditions on;
        # mean-pooling over the whole span could flatter the result.
        feats["final@last"].append(fin[:, -1].numpy())
        labels.extend(ys)

    y = np.array(labels)
    print(f"\n══ can a linear readout recover WHICH CITY was in the state?")
    print(f"   {N_EXAMPLES} examples, {len(CITIES)} cities, chance = {1/len(CITIES):.3f}\n")
    # Shuffled labels are the control. A probe that scores above chance on
    # randomised targets is reading an artefact of the fitting, not the model,
    # and every number above it would be meaningless.
    yshuf = np.random.default_rng(1).permutation(y)
    for name in ("state", "layer6", "final", "final@last"):
        X = np.concatenate(feats[name], 0)
        acc = ridge_probe(X, y, len(CITIES))
        ctl = ridge_probe(X, yshuf, len(CITIES))
        bar = "█" * int(acc * 40)
        print(f"   {name:<11} {acc:.3f}  (shuffled {ctl:.3f})  {bar}")

    print("\n   state  = conditioner output, before any layer")
    print("   layer6 = halfway, read off the TEXT positions only")
    print("   final  = after 12 layers + norm, what the head sees")


if __name__ == "__main__":
    main()
