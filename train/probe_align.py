"""
Aligned injection: make a fact vector look like words to the decoder.

`probe_channel.py` showed the soft-token channel carries information through 12
frozen layers, but it did so through a *random* projection — so the signal lands
in an arbitrary subspace. The LM head is a specific fixed linear map (tied to
the embedding table), and there is no reason it would read an arbitrary
subspace. That makes "can the head use it" untestable as things stand.

Both potion and BarunLM have an embedding table over words. So the map between
them can be fitted in closed form on the words they share — no training, one
ridge solve — and an injected fact then arrives in the coordinates the model
already speaks.

Two questions follow, both free:

  1. does recoverability beat the random projection's 0.664?
  2. does injecting a city's facts raise that city's own tokens at the output?

(2) is the sufficient condition. (1) was only the necessary one.

    python3.12 train/probe_align.py
"""

import glob
import json
import pathlib
import struct
import sys

import numpy as np
import torch

torch.set_num_threads(2)

ROOT = pathlib.Path(__file__).resolve().parent.parent
BARUN = glob.glob(str(pathlib.Path.home() / ".cache/huggingface/hub/models--harrrshall--BarunLM-35M/snapshots/*/"))[0]
sys.path.insert(0, BARUN)

from barunlm.config import BarunConfig  # noqa: E402
from barunlm.model import BarunLM  # noqa: E402
from safetensors.torch import load_file  # noqa: E402
from tokenizers import Tokenizer  # noqa: E402

SLOTS, FACT_DIM = 8, 256
N_EXAMPLES, BATCH, SEQ = 384, 16, 24
MEM_CEILING_MB = 1500

CITIES = ["Reykjavik", "Lisbon", "Nairobi", "Osaka", "Bogota", "Helsinki", "Dakar", "Perth",
          "Quito", "Riga", "Tunis", "Vilnius", "Muscat", "Bergen", "Cusco", "Hobart"]
ATTRS = ["temperature", "wind", "humidity", "population"]
PROMPTS = ["The weather report for", "Conditions today in", "A quick update from",
           "Travellers arriving in", "The city of", "Our correspondent in",
           "Temperatures across", "Overnight in", "The forecast for",
           "Life in", "Visitors to", "The streets of"]


def load_potion():
    raw = (ROOT / "public/models/potion/potion.bin").read_bytes()
    assert raw[:4] == b"PTN1"
    v, d, sc = struct.unpack_from("<IIf", raw, 4)
    emb = np.frombuffer(raw, np.int8, offset=16, count=v * d).reshape(v, d).astype(np.float32) * sc
    words = json.loads((ROOT / "public/models/potion/potion.vocab.json").read_text())
    if isinstance(words, dict):
        words = words.get("vocab", words.get("words", list(words.keys())))
    return emb, words


def unit(x, axis=-1):
    return x / np.clip(np.linalg.norm(x, axis=axis, keepdims=True), 1e-9, None)


def fit_alignment(potion_emb, potion_words, tok, barun_emb, lam=1.0):
    """Least squares from potion space to BarunLM embedding space.

    Only words both tables represent as a single unit are usable as anchors: a
    word BarunLM splits into pieces has no single embedding row to match against.
    Surface forms are normalised because the two tokenizers mark word boundaries
    differently (BPE prefixes a space, WordPiece prefixes continuations).
    """
    vocab = tok.get_vocab()
    lookup = {}
    for surface, tid in vocab.items():
        key = surface.replace("Ġ", "").replace("▁", "").lower()
        if key and key.isalpha() and key not in lookup:
            lookup[key] = tid

    P, B = [], []
    for i, w in enumerate(potion_words):
        key = str(w).replace("##", "").lower()
        tid = lookup.get(key)
        if tid is not None:
            P.append(potion_emb[i])
            B.append(barun_emb[tid])
    P, B = np.stack(P), np.stack(B)
    # Ridge rather than plain lstsq: the anchor set is correlated and a plain
    # solve overfits the directions the shared vocabulary happens to cover.
    W = np.linalg.solve(P.T @ P + lam * np.eye(P.shape[1]), P.T @ B)
    resid = 1 - float(np.mean(np.sum(unit(P @ W) * unit(B), 1)))
    return W.astype(np.float32), len(P), resid


def bind_state(facts, roles, bind=True):
    """HDC state, or the same facts laid out unbound.

    `bind=False` is the control that isolates binding. Multiplying a fact by a
    ±1 role makes it addressable but destroys its semantic direction — the
    result is, by construction, unlike any word. So a projection fitted to map
    *words* into the model's space cannot help a vector that is no longer a
    word. Laying the facts in unbound keeps their meaning and gives up the
    addressing; if the head can read that and not the bound version, binding is
    the thing in the way.
    """
    state = np.zeros((SLOTS, FACT_DIM), np.float32)
    for i, f in enumerate(facts):
        state[i % SLOTS] += f * roles[i] if bind else f
    return state


def embed_fact(text, emb, index):
    vecs = [emb[index[w]] for w in text.lower().split() if w in index]
    if not vecs:
        return np.zeros(FACT_DIM, np.float32)
    return unit(np.mean(vecs, 0))


def ridge_probe(X, y, classes, folds=4, lam=1.0):
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
        W = np.linalg.solve(X[~va].T @ X[~va] + lam * np.eye(X.shape[1]), X[~va].T @ Y[~va])
        hits += int((np.argmax(X[va] @ W, 1) == y[va]).sum())
    return hits / n


@torch.no_grad()
def run(m, cfg, proj, states, ids):
    pre = torch.tensor(states) @ proj
    x = torch.cat([pre, m.embedding(ids)], 1)
    checkpoint, si = x, 0
    for i, layer in enumerate(m.layers):
        x = layer(x, None)
        stride = cfg.residual_select_every
        if stride and (i + 1) % stride == 0:
            x = m.selectors[si](checkpoint, x)
            checkpoint, si = x, si + 1
    hidden = m.final_norm(x)
    return hidden[:, -1], m.lm_head(hidden[:, -1])


@torch.no_grad()
def main():
    cfg = BarunConfig(**json.load(open(BARUN + "/barun_config.json")))
    est = (35.2e6 * 4 + BATCH * (SEQ + SLOTS) * cfg.dim * 4 * 14 + BATCH * cfg.vocab_size * 4) / 1e6
    print(f"estimated peak ≈ {est:.0f} MB (ceiling {MEM_CEILING_MB} MB, threads {torch.get_num_threads()})")
    if est > MEM_CEILING_MB:
        sys.exit("aborting: over ceiling")

    emb, words = load_potion()
    index = {w: i for i, w in enumerate(words)}
    tok = Tokenizer.from_file(BARUN + "/tokenizer.json")
    m = BarunLM(cfg)
    m.load_state_dict(load_file(BARUN + "/model.safetensors"), strict=False)
    m.eval()
    barun_emb = m.embedding.weight.detach().numpy()

    W, n_anchor, resid = fit_alignment(emb, words, tok, barun_emb)
    print(f"alignment fitted on {n_anchor} shared words; mean cosine to target = {1-resid:.3f}")

    rng = np.random.default_rng(0)
    roles = (rng.integers(0, 2, (SLOTS, FACT_DIM)) * 2 - 1).astype(np.float32)

    # Magnitude is not cosmetic. A soft token an order of magnitude smaller than
    # a real embedding is simply not attended to, so each projection is rescaled
    # so a typical bound state lands at the norm the model's own tokens have.
    target = float(np.linalg.norm(barun_emb, axis=1).mean())
    sample = np.stack([
        bind_state([embed_fact(f"{c} {a} 50", emb, index) for a in ATTRS[:2]], roles)
        for c in CITIES
    ]).reshape(-1, FACT_DIM)

    def scaled(M):
        got = float(np.linalg.norm(sample @ M, axis=1).mean())
        return torch.tensor((M * (target / max(got, 1e-9))).astype(np.float32))

    R = (rng.standard_normal((FACT_DIM, cfg.dim)) / float(np.sqrt(FACT_DIM)))
    projections = {"random": scaled(R), "aligned": scaled(W), "aligned+unbound": scaled(W)}
    print(f"embedding norm {target:.3f}; soft tokens rescaled to match")

    # ── 1. recoverability, random vs aligned ────────────────────────────────
    print(f"\n══ 1. linear recovery of WHICH CITY at the generation position")
    print(f"   {N_EXAMPLES} examples, {len(CITIES)} cities, chance = {1/len(CITIES):.3f}\n")
    prompt = tok.encode(PROMPTS[0]).ids[:SEQ]
    ids = torch.tensor([prompt] * BATCH)

    for label, proj in projections.items():
        feats, ys = [], []
        r2 = np.random.default_rng(0)
        for _ in range(N_EXAMPLES // BATCH):
            states, batch_y = [], []
            for _ in range(BATCH):
                ci = int(r2.integers(len(CITIES)))
                picks = r2.choice(len(ATTRS), size=2, replace=False)
                fs = [f"{CITIES[ci]} {ATTRS[a]} {int(r2.integers(0, 99))}" for a in picks]
                states.append(bind_state([embed_fact(f, emb, index) for f in fs], roles, bind="unbound" not in label))
                batch_y.append(ci)
            h, _ = run(m, cfg, proj, np.stack(states), ids)
            feats.append(h.numpy()); ys.extend(batch_y)
        X, y = np.concatenate(feats, 0), np.array(ys)
        acc = ridge_probe(X, y, len(CITIES))
        ctl = ridge_probe(X, np.random.default_rng(1).permutation(y), len(CITIES))
        print(f"   {label:<9} {acc:.3f}  (shuffled {ctl:.3f})  {'█' * int(acc*40)}")

    # ── 2. does the MODEL'S OWN HEAD prefer the right city? ─────────────────
    # No probe, no fitting: the 16 cities' first tokens are scored directly off
    # the output distribution. This is the sufficient condition.
    first_tok = [tok.encode(" " + c).ids[0] for c in CITIES]
    print(f"\n══ 2. the model's own head, forced choice over {len(CITIES)} cities")
    print(f"   chance = {1/len(CITIES):.3f}\n")

    for label, proj in projections.items():
        hits = total = 0
        for pi, ptext in enumerate(PROMPTS):
            pids = torch.tensor([tok.encode(ptext).ids[:SEQ]] * len(CITIES))
            states = []
            r3 = np.random.default_rng(100 + pi)
            for ci in range(len(CITIES)):
                picks = r3.choice(len(ATTRS), size=2, replace=False)
                fs = [f"{CITIES[ci]} {ATTRS[a]} {int(r3.integers(0, 99))}" for a in picks]
                states.append(bind_state([embed_fact(f, emb, index) for f in fs], roles, bind="unbound" not in label))
            _, logits = run(m, cfg, proj, np.stack(states), pids)
            choice = logits[:, first_tok].argmax(-1)
            hits += int((choice == torch.arange(len(CITIES))).sum()); total += len(CITIES)
        print(f"   {label:<9} {hits/total:.3f}  ({hits}/{total})  {'█' * int(hits/total*40)}")


if __name__ == "__main__":
    main()
