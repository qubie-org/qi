"""
What the fact channel can actually hold.

The architecture being considered puts the agent's whole working memory in a
fixed slot budget: N tool results bind into the same space as one, so step 20
costs what step 1 costs. That property is the reason the design is worth
building. It is also completely unverified — `FactConditioner`'s only reported
number is a drift of 6.56e-06 measured *at initialisation*, with one fact.

So this measures the thing directly: bind N facts into the state, then ask
whether each one can still be told apart from 200 distractors. That is the
question the whole design rests on, and it is answerable in a few seconds
without training anything.

Three schemes are compared, because the current implementation may not be doing
what its docstring says:

  current  bundle first, then bind — sum(facts) is normalised into ONE vector,
           which is then multiplied by each slot's role. Every slot therefore
           carries the same sum viewed through a different mask, and no fact has
           an address of its own.
  hdc      bind first, then bundle — sum_i(f_i * r_i), the standard HDC form.
           Binding with r_i again approximately recovers f_i because the other
           terms become noise orthogonal to it.
  slotted  bind-then-bundle, spread across S slots so each slot carries N/S
           facts rather than all N.

And three vector sources, because HDC's capacity results assume random
hypervectors and real embeddings are nothing like random — potion's vectors are
heavily correlated, which is the case that actually matters here.

    python3 train/probe_hdc.py
"""

import json
import pathlib
import struct

import numpy as np

ROOT = pathlib.Path(__file__).resolve().parent.parent
POTION = ROOT / "public" / "models" / "potion" / "potion.bin"
RNG = np.random.default_rng(0)

DISTRACTORS = 200
TRIALS = 40
NS = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32]


def load_potion() -> np.ndarray:  # noqa: D401
    """PTN1 | u32 vocab | u32 dim | f32 scale | int8[vocab*dim]."""
    raw = POTION.read_bytes()
    assert raw[:4] == b"PTN1", "not a packed potion table"
    vocab, dim, scale = struct.unpack_from("<IIf", raw, 4)
    q = np.frombuffer(raw, dtype=np.int8, offset=16, count=vocab * dim)
    emb = q.reshape(vocab, dim).astype(np.float32) * scale
    # Unused vocabulary rows are all-zero and a few are degenerate; they would
    # normalise to zero vectors and pollute every distractor set.
    keep = np.isfinite(emb).all(1) & (np.linalg.norm(emb, axis=1) > 1e-6)
    return emb[keep]


def unit(x: np.ndarray) -> np.ndarray:
    n = np.linalg.norm(x, axis=-1, keepdims=True)
    return x / np.clip(n, 1e-9, None)


# ── the three memories ──────────────────────────────────────────────────────
# Each takes (N, d) facts and (slots, d) roles and returns a state, plus a way
# to interrogate that state for one particular fact.


def write_current(facts, roles):
    """What train/common.py does today."""
    bundled = unit(facts.sum(0))
    return bundled[None, :] * roles  # (slots, d)


def read_current(state, roles, i, n):
    # There is no per-fact address to query with, so the best available probe is
    # to undo the slot role — exactly recoverable, since the roles are ±1. Every
    # slot returns the same bundle, so slot 0 will do. This is the scheme's best
    # case, not a handicap: it is given a perfect unbind and still cannot say
    # *which* fact was stored, because that information was summed away.
    return state[0] * roles[0]


def write_hdc(facts, roles):
    """Standard HDC: bind each fact to its own role, then bundle."""
    n = len(facts)
    return (facts * roles[:n]).sum(0)[None, :]  # (1, d)


def read_hdc(state, roles, i, n):
    return state[0] * roles[i]  # binding is self-inverse for ±1 roles


SLOTS = 4


def write_slotted(facts, roles):
    """Bind-then-bundle across a FIXED slot budget.

    Each fact keeps its own role — that is what makes it addressable — but is
    added to only one of SLOTS accumulators. Interference is then between the
    ~N/SLOTS facts sharing a slot rather than all N, so capacity should scale
    with the budget while the state stays a fixed size.
    """
    d = facts.shape[1]
    out = np.zeros((SLOTS, d), dtype=np.float32)
    for i, f in enumerate(facts):
        out[i % SLOTS] += f * roles[i]
    return out


def read_slotted(state, roles, i, n):
    return state[i % SLOTS] * roles[i]


SCHEMES = {
    "current (bundle→bind)": (write_current, read_current),
    "hdc (bind→bundle)": (write_hdc, read_hdc),
    "slotted (fixed 4)": (write_slotted, read_slotted),
}


def capacity(pool: np.ndarray, scheme: str, n: int, slots: int, sign_roles: bool) -> float:
    """Fraction of bound facts still identifiable among DISTRACTORS others."""
    write, read = SCHEMES[scheme]
    d = pool.shape[1]
    hits = 0
    total = 0
    for _ in range(TRIALS):
        idx = RNG.choice(len(pool), size=n + DISTRACTORS, replace=False)
        facts = pool[idx[:n]]
        candidates = pool[idx]  # the n real ones first, then distractors
        roles = (
            RNG.choice([-1.0, 1.0], size=(max(slots, n), d)).astype(np.float32)
            if sign_roles
            else unit(RNG.standard_normal((max(slots, n), d)).astype(np.float32))
        )
        state = write(facts, roles)
        for i in range(n):
            probe = unit(read(state, roles, i, n)[None, :])[0]
            scores = candidates @ probe
            hits += int(np.argmax(scores) == i)
            total += 1
    return hits / total


def main() -> None:
    emb = load_potion()
    print(f"potion: {emb.shape[0]} x {emb.shape[1]}")

    pools = {
        "potion (real, correlated)": unit(emb[RNG.choice(len(emb), 4000, replace=False)]),
        "gaussian (random)": unit(RNG.standard_normal((4000, 256)).astype(np.float32)),
        "bipolar ±1 (HDC ideal)": RNG.choice([-1.0, 1.0], size=(4000, 256)).astype(np.float32),
    }

    for pool_name, pool in pools.items():
        print(f"\n══ {pool_name}   d={pool.shape[1]}")
        print("   scheme                    " + "".join(f"{n:>6}" for n in NS))
        for scheme in SCHEMES:
            row = [capacity(pool, scheme, n, slots=4, sign_roles=True) for n in NS]
            print(f"   {scheme:<26}" + "".join(f"{v:6.2f}" for v in row))

    # The dimension lever, on the scheme that works, with the vectors we have.
    print("\n══ dimension lever — hdc (bind→bundle), bipolar roles")
    print("   d      " + "".join(f"{n:>6}" for n in NS))
    for d in [256, 512, 1024, 2048, 4096]:
        pool = RNG.choice([-1.0, 1.0], size=(2000, d)).astype(np.float32)
        row = [capacity(pool, "hdc (bind→bundle)", n, slots=4, sign_roles=True) for n in NS]
        print(f"   {d:<7}" + "".join(f"{v:6.2f}" for v in row))

    # Real embeddings are the hard case; does widening help them too?
    print("\n══ dimension lever on REAL potion, via random projection up")
    print("   d      " + "".join(f"{n:>6}" for n in NS))
    base = unit(emb[RNG.choice(len(emb), 2000, replace=False)])
    for d in [256, 1024, 4096]:
        if d == 256:
            pool = base
        else:
            proj = RNG.standard_normal((256, d)).astype(np.float32) / np.sqrt(d)
            pool = unit(base @ proj)
        row = [capacity(pool, "hdc (bind→bundle)", n, slots=4, sign_roles=True) for n in NS]
        print(f"   {d:<7}" + "".join(f"{v:6.2f}" for v in row))





def frontier() -> None:
    """Where does it actually break, and which lever moves it?

    Capacity is only interesting against a fixed cost. The state here is
    slots x d floats, so 4x256 and 16x256 are NOT the same budget — the table
    below reports the budget alongside so the levers can be compared honestly.
    """
    global SLOTS
    emb = load_potion()
    base = unit(emb[RNG.choice(len(emb), 6000, replace=False)])
    ns = [8, 16, 32, 64, 128, 256]

    for label, pool in [
        ("potion (real)", base),
        ("bipolar ±1", RNG.choice([-1.0, 1.0], size=(6000, 256)).astype(np.float32)),
    ]:
        print(f"\n══ frontier — {label}, d=256")
        print("   slots  floats " + "".join(f"{n:>6}" for n in ns))
        for s in [1, 4, 8, 16, 32]:
            SLOTS = s
            row = [capacity(pool, "slotted (fixed 4)", n, slots=s, sign_roles=True) for n in ns]
            print(f"   {s:<6} {s * 256:<6} " + "".join(f"{v:6.2f}" for v in row))

    print("\n══ frontier — potion projected up, 8 slots")
    print("   d      floats " + "".join(f"{n:>6}" for n in ns))
    SLOTS = 8
    for d in [256, 512, 1024, 2048]:
        if d == 256:
            pool = base
        else:
            proj = RNG.standard_normal((256, d)).astype(np.float32) / np.sqrt(d)
            pool = unit(base @ proj)
        row = [capacity(pool, "slotted (fixed 4)", n, slots=8, sign_roles=True) for n in ns]
        print(f"   {d:<6} {8 * d:<6} " + "".join(f"{v:6.2f}" for v in row))


def whiten() -> None:
    """Can the correlation penalty be bought back?

    Real embeddings cost roughly twice the ideal because their directions are
    correlated, so binding one fact leaks into the readout of another. ZCA
    whitening removes that correlation while keeping the basis interpretable —
    it is a fixed 256x256 matrix applied once at write time, not a model change.
    """
    global SLOTS
    emb = load_potion()
    sub = emb[RNG.choice(len(emb), 8000, replace=False)]
    # float64 throughout: the covariance of 8000 x 256 float32 vectors
    # overflows intermediate accumulation and the eigendecomposition of a
    # slightly-wrong matrix fails quietly rather than loudly.
    X = (sub - sub.mean(0)).astype(np.float64)
    cov = (X.T @ X) / len(X)
    w, V = np.linalg.eigh(cov)
    W = (V @ np.diag(1.0 / np.sqrt(np.clip(w, 1e-8, None))) @ V.T)
    assert np.isfinite(W).all(), "whitening matrix is not finite"

    pools = {
        "potion raw": unit(sub),
        "potion whitened": unit((X @ W).astype(np.float32)),
        "bipolar (ideal)": RNG.choice([-1.0, 1.0], size=(8000, 256)).astype(np.float32),
    }
    ns = [8, 16, 32, 64, 128]
    SLOTS = 8
    print("══ decorrelation lever — 8 slots x d=256 (2048 floats)")
    print("   pool              " + "".join(f"{n:>6}" for n in ns))
    for k, pool in pools.items():
        row = [capacity(pool, "slotted (fixed 4)", n, slots=8, sign_roles=True) for n in ns]
        print(f"   {k:<18}" + "".join(f"{v:6.2f}" for v in row))


if __name__ == "__main__":
    import sys

    if "--whiten" in sys.argv:
        whiten()
    elif "--frontier" in sys.argv:
        frontier()
    else:
        main()
