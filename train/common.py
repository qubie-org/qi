"""toki v2 — shared config, model, ternary QAT.

v1 was 1 block x T=6 loops, D=160, char-level, 323K ternary params, ~65 KB
packed. It hit 74.5% exact-match on tool calls after 12k steps on a T4, which
was never enough training to say anything about the architecture's ceiling.

v2 keeps the two ideas that made v1 interesting — recurrent depth and BitNet
b1.58 ternary weights — and fixes what limited it:

  * scale        D=160 -> 768, one block -> prelude/loop/coda
  * tokenizer    96 chars -> 8192 BPE (chars cannot carry a real corpus)
  * stability    input injection h <- block(h + e), per Parcae/Universal
                 Transformer. Without it a T=8 loop drifts.
  * structure    the loop no longer has to do input encoding and output
                 decoding as well as reasoning; prelude and coda own those.

The point is NOT to build a general language model. In toki the facts come
from grounded sources and the sandbox; the talker only supplies connective
language. That job is small, and a model trained for it should beat a much
larger one borrowed for it.
"""
import json

CFG = dict(
    V=8192,        # BPE vocab
    R=384,         # factorised embedding rank
    D=768,
    H=12,          # head dim 64
    FFN=3072,
    PRELUDE=2,     # blocks before the loop
    T=8,           # loop iterations (recurrent depth)
    CODA=1,        # blocks after the loop
    MAXLEN=512,
    NORM_EPS=1e-6,
    DROPOUT=0.0,   # raised only for the small SFT pass
    # --- MoE, off by default -------------------------------------------
    # MoEUT (arXiv:2405.16039) exists because layer sharing starves a model of
    # parameters: a looped block has the compute of N layers and the capacity
    # of one. Experts buy that capacity back at constant FLOPs.
    #
    # EXPERTS=1 is the dense baseline and must stay bit-identical to the
    # pre-MoE model — train it first, or a bad loss curve has three suspects
    # (recurrence, ternary QAT, routing) instead of one.
    #
    # TOP_K=1 keeps active FLOPs equal to dense; top-2 doubles FFN compute,
    # which wasm CPU cannot spare.
    EXPERTS=1,
    TOP_K=1,
    EXPERT_BLOCKS="loop",   # "loop" | "all" — where the expert bank lives
    AUX_LOSS=0.01,          # load-balancing coefficient (Switch-style)
    CAPACITY_FACTOR=1.5,    # per-expert buffer headroom; keeps shapes static
    # --- fact conditioning ---------------------------------------------
    # Grounded values must reach the model WITHOUT becoming tokens. Shown a
    # fact as text, a small model copies it back mangled ("Bend 25C in the
    # direction of the equator"); there is nothing to copy if the fact never
    # enters the vocabulary.
    #
    # Facts arrive as potion vectors, are bound to learned role vectors, and
    # are projected to FACT_SLOTS soft tokens prepended to the sequence. The
    # binding is HDC: several facts bundle into a fixed budget instead of
    # costing K soft tokens each.
    #
    # Needed only from SFT onward — pretraining never sees a fact — so this
    # can be trained after the base run without touching it.
    FACT_SLOTS=4,
    FACT_DIM=256,           # potion's dimension
)

PAD, UNK, BOS, EOS, SEP = 0, 1, 2, 3, 4
SPECIAL_TOKENS = ["<pad>", "<unk>", "<bos>", "<eos>", "<sep>"]


def expert_blocks(cfg=CFG):
    """Which stored blocks carry an expert bank."""
    if cfg["EXPERTS"] <= 1:
        return set()
    return {"prelude", "loop", "coda"} if cfg["EXPERT_BLOCKS"] == "all" else {"loop"}


def param_count(cfg=CFG):
    """Ternary parameters, what they weigh at 1.58 bits, and what's active."""
    D, R, V, FFN = cfg["D"], cfg["R"], cfg["V"], cfg["FFN"]
    E, K = cfg["EXPERTS"], cfg["TOP_K"]
    which = expert_blocks(cfg)
    attn = 4 * D * D
    ffn = 2 * D * FFN

    def block(kind):
        return attn + ffn * (E if kind in which else 1)

    stored = block("prelude") * cfg["PRELUDE"] + block("loop") + block("coda") * cfg["CODA"]
    embed = V * R + R * D
    total = stored + embed

    # What a single token actually multiplies against.
    def active(kind):
        return attn + ffn * (K if kind in which else 1)

    per_token = (
        active("prelude") * cfg["PRELUDE"]
        + active("loop") * cfg["T"]      # the loop runs T times
        + active("coda") * cfg["CODA"]
    )
    return {
        "experts": E,
        "top_k": K,
        "blocks_stored": cfg["PRELUDE"] + 1 + cfg["CODA"],
        "effective_depth": cfg["PRELUDE"] + cfg["T"] + cfg["CODA"],
        "embed": embed,
        "ternary_params": total,
        "packed_mb": total * 1.58 / 8 / 1e6,
        "active_params_per_token": per_token,
        "router_params": (D * E * len(which)) if E > 1 else 0,
    }


# ---------------------------------------------------------------- model
def build_model(cfg=CFG, dropout=None):
    import math

    import torch
    import torch.nn as nn
    import torch.nn.functional as F

    D, R, V, H, FFN = cfg["D"], cfg["R"], cfg["V"], cfg["H"], cfg["FFN"]
    T, PRELUDE, CODA = cfg["T"], cfg["PRELUDE"], cfg["CODA"]
    HD = D // H
    EPS = cfg["NORM_EPS"]
    P = cfg["DROPOUT"] if dropout is None else dropout

    def ternary(w):
        """BitNet b1.58: absmean scale, round-clip to {-1,0,1}, straight-through."""
        gamma = w.abs().mean().clamp(min=1e-8)
        wq = (w / gamma).round().clamp(-1, 1) * gamma
        return w + (wq - w).detach()

    def rope(x):
        B, nH, S, hd = x.shape
        pos = torch.arange(S, device=x.device, dtype=torch.float32)
        inv = 10000.0 ** (-torch.arange(0, hd, 2, device=x.device, dtype=torch.float32) / hd)
        ang = pos[:, None] * inv[None, :]
        cos, sin = ang.cos(), ang.sin()
        xp = x.view(B, nH, S, hd // 2, 2)
        x0, x1 = xp[..., 0], xp[..., 1]
        out = torch.stack([x0 * cos - x1 * sin, x0 * sin + x1 * cos], dim=-1)
        return out.view(B, nH, S, hd)

    def param(*shape, scale=0.02):
        t = torch.empty(*shape)
        nn.init.trunc_normal_(t, std=scale)
        return nn.Parameter(t)

    E, K = cfg["EXPERTS"], cfg["TOP_K"]
    WHICH = expert_blocks(cfg)
    # Headroom over a perfectly even split. Too tight drops real tokens; too
    # loose wastes compute on empty slots.
    CAPACITY_FACTOR = cfg.get("CAPACITY_FACTOR", 1.5)

    class Block(nn.Module):
        """Pre-norm attention + FFN. Every matmul weight is ternary.

        With `experts > 1` the FFN becomes a bank and a router picks TOP_K of
        them per token. Attention stays shared — routing it as well is a much
        larger change for a much smaller win at this scale.
        """

        def __init__(self, res_scale, experts=1):
            super().__init__()
            self.E = experts
            self.Wq, self.Wk, self.Wv = param(D, D), param(D, D), param(D, D)
            self.Wo = param(D, D, scale=res_scale)
            if experts > 1:
                self.W1 = param(experts, FFN, D)
                self.W2 = param(experts, D, FFN, scale=res_scale)
                # The router stays dense fp32. It is D x E — a rounding error
                # in size, and ternarising the thing that decides routing is
                # asking for expert collapse.
                self.router = nn.Parameter(torch.zeros(D, experts))
            else:
                self.W1 = param(FFN, D)
                self.W2 = param(D, FFN, scale=res_scale)
            self.g1 = nn.Parameter(torch.ones(D))
            self.g2 = nn.Parameter(torch.ones(D))
            self.drop = nn.Dropout(P)

        def quantize(self):
            """Ternarise once per forward.

            The loop block is applied T times against identical weights, so
            quantising inside `forward` did the same elementwise work T times
            and re-read every weight T times. Hoisted here and passed in.
            """
            return {
                "Wq": ternary(self.Wq), "Wk": ternary(self.Wk),
                "Wv": ternary(self.Wv), "Wo": ternary(self.Wo),
                "W1": ternary(self.W1) if self.E <= 1 else None,
                "W2": ternary(self.W2) if self.E <= 1 else None,
            }

        def rms(self, x, g):
            return x * torch.rsqrt(x.pow(2).mean(-1, keepdim=True) + EPS) * g

        def ffn(self, x, aux, q):
            if self.E <= 1:
                return F.gelu(x @ q["W1"].T) @ q["W2"].T

            B, S, _ = x.shape
            flat = x.reshape(-1, D)
            N = flat.shape[0]
            probs = (flat @ self.router).softmax(-1)              # (N, E)
            weight, idx = probs.topk(K, dim=-1)                   # (N, K)

            # Capacity-based dispatch, not boolean masking.
            #
            # `flat[mask]` yields a different shape for every expert on every
            # step, so torch.compile recompiled per expert, blew its recompile
            # limit and fell back to eager — measured at 132k tok/s against
            # dense's 254k, for identical FLOPs. A fixed per-expert buffer keeps
            # every shape static, so the graph compiles once.
            cap = max(1, int(math.ceil(N / self.E * CAPACITY_FACTOR)))
            out = torch.zeros_like(flat)

            for slot in range(K):
                pick, gate = idx[:, slot], weight[:, slot]
                # Rank of each token within its own expert; anything past the
                # buffer is dropped and simply keeps its residual.
                onehot = F.one_hot(pick, self.E)                       # (N, E)
                rank = (onehot.cumsum(0) - 1).gather(1, pick[:, None]).squeeze(1)
                keep = rank < cap

                # (E, cap) token indices, zero-filled where unused.
                pos = pick * cap + rank.clamp(max=cap - 1)
                slots = torch.zeros(self.E * cap, dtype=torch.long, device=flat.device)
                slots.scatter_(0, pos[keep], torch.arange(N, device=flat.device)[keep])
                live = torch.zeros(self.E * cap, dtype=flat.dtype, device=flat.device)
                live.scatter_(0, pos[keep], 1.0)

                xe = flat[slots].view(self.E, cap, D) * live.view(self.E, cap, 1)
                W1q = ternary(self.W1)                                  # (E, FFN, D)
                W2q = ternary(self.W2)                                  # (E, D, FFN)
                y = F.gelu(torch.bmm(xe, W1q.transpose(1, 2)))
                y = torch.bmm(y, W2q.transpose(1, 2)).view(self.E * cap, D)

                out.index_add_(0, slots, y * (live * gate[slots])[:, None])

            # Switch-style load balancing: without it a couple of experts win
            # everything and the rest are dead weight in the download.
            frac = F.one_hot(idx[:, 0], self.E).float().mean(0)
            aux.append(self.E * (frac * probs.mean(0)).sum())
            return out.view(B, S, D)

        def forward(self, h, mask, aux, qw=None):
            B, S, _ = h.shape
            qw = qw or self.quantize()
            x = self.rms(h, self.g1)
            q = (x @ qw["Wq"].T).view(B, S, H, HD).transpose(1, 2)
            k = (x @ qw["Wk"].T).view(B, S, H, HD).transpose(1, 2)
            v = (x @ qw["Wv"].T).view(B, S, H, HD).transpose(1, 2)
            q, k = rope(q), rope(k)
            # SDPA instead of a hand-rolled softmax: materialising (B,H,S,S) is
            # ~400 MB a block at B=32/S=512, eleven times over. `mask is None`
            # is the common path and lets it take the causal fast kernel.
            a = F.scaled_dot_product_attention(
                q, k, v, attn_mask=mask, is_causal=mask is None
            )
            a = a.transpose(1, 2).reshape(B, S, D)
            h = h + self.drop(a @ qw["Wo"].T)
            x = self.rms(h, self.g2)
            return h + self.drop(self.ffn(x, aux, qw))

    class FactConditioner(nn.Module):
        """Facts -> soft tokens, via HDC binding.

        Each fact is a potion vector. It is bound (elementwise) to a learned
        role vector per slot, then projected to model width. Because binding
        and bundling are both cheap and dimension-preserving, N facts collapse
        into the same FACT_SLOTS budget as one — the sequence cost of grounding
        does not grow with how much was grounded.

        Deliberately fp32 and outside the ternary set: this is the only channel
        facts arrive on, and quantising it quantises the evidence.
        """

        def __init__(self, slots, fact_dim):
            super().__init__()
            self.slots = slots
            self.roles = nn.Parameter(torch.randn(slots, fact_dim) * 0.5)
            self.proj = nn.Linear(fact_dim, D, bias=False)
            self.gate = nn.Parameter(torch.zeros(1))  # starts closed

        def forward(self, facts):
            """facts: (B, N, FACT_DIM) L2-normalised potion vectors."""
            bundled = facts.sum(1)                                   # bundle
            bundled = bundled / bundled.norm(dim=-1, keepdim=True).clamp(min=1e-6)
            bound = bundled[:, None, :] * self.roles[None, :, :]     # bind per slot
            return self.proj(bound) * self.gate.tanh()               # (B, slots, D)

    class Toki(nn.Module):
        def __init__(self):
            super().__init__()
            res_scale = 0.02 / (2 * (PRELUDE + T + CODA)) ** 0.5
            # Factorised, tied embedding: V x R -> R x D, and the head is its
            # transpose. At V=8192 a dense table would cost 2x the whole model.
            self.E1 = param(V, R)
            self.E2 = param(R, D)
            ep = E if "prelude" in WHICH else 1
            el = E if "loop" in WHICH else 1
            ec = E if "coda" in WHICH else 1
            self.prelude = nn.ModuleList(Block(res_scale, ep) for _ in range(PRELUDE))
            self.loop = Block(res_scale, el)   # applied T times, weights shared
            self.coda = nn.ModuleList(Block(res_scale, ec) for _ in range(CODA))
            self.gf = nn.Parameter(torch.ones(D))
            self.facts = FactConditioner(cfg["FACT_SLOTS"], cfg["FACT_DIM"])
            # Attention bias on the soft columns, learned, starting shut. With
            # only a zero-valued gate the soft tokens would still take up
            # positions and dilute attention, so bolting the conditioner onto a
            # pretrained checkpoint would perturb it. Masked, SFT starts from
            # exactly the pretrained behaviour and opens the channel itself.
            self.fact_bias = nn.Parameter(torch.tensor(-12.0))
            # Load-balancing term from the last forward, for the training loop.
            self.aux_loss = None

        def rms(self, x, g):
            return x * torch.rsqrt(x.pow(2).mean(-1, keepdim=True) + EPS) * g

        def forward(self, ids, loops=None, facts=None):
            B, S = ids.shape
            steps = T if loops is None else loops
            E1q, E2q = ternary(self.E1), ternary(self.E2)
            h = E1q[ids] @ E2q

            # Facts ride in front of the prompt as soft tokens. They are
            # attendable but not predictable — the loss never covers them, so
            # there is no way for the model to learn to emit one.
            n_soft = 0
            if facts is not None:
                soft = self.facts(facts)
                n_soft = soft.shape[1]
                h = torch.cat([soft, h], dim=1)
                S = S + n_soft

            # None means "plain causal", which SDPA has a dedicated kernel for.
            # An explicit mask is built only when soft tokens need damping.
            mask = None
            if n_soft:
                mask = torch.full((S, S), float("-inf"), device=ids.device).triu(1)
                # Soft tokens are visible to everything (they are conditioning,
                # not sequence) but damped by the learned bias.
                mask[:, :n_soft] = self.fact_bias
                mask[:n_soft, :n_soft] = torch.full(
                    (n_soft, n_soft), float("-inf"), device=ids.device
                ).triu(1)
            aux: list = []

            for blk in self.prelude:
                h = blk(h, mask, aux)
            # Input injection: re-adding the prelude state every iteration is
            # what stops a deep loop from drifting away from the prompt.
            e = h
            # Quantised once for all T iterations rather than once per pass.
            loop_w = self.loop.quantize()
            for _ in range(steps):
                # The router runs fresh each iteration, so a token can take a
                # different expert at depth 1 than at depth 6 — depth
                # specialisation out of a single stored bank.
                h = self.loop(h + e, mask, aux, loop_w)
            for blk in self.coda:
                h = blk(h, mask, aux)

            self.aux_loss = torch.stack(aux).mean() if aux else None
            h = self.rms(h, self.gf)
            # Drop the soft positions before the head: they are conditioning,
            # not sequence, and must never appear in the logits.
            if n_soft:
                h = h[:, n_soft:]
            return (h @ E2q.T) @ E1q.T

    return Toki()


def ternary_tensor_names(cfg=CFG):
    """Every tensor that packs to trits, in load order."""
    names = ["E1", "E2"]
    for i in range(cfg["PRELUDE"]):
        names += [f"prelude.{i}.{w}" for w in ("Wq", "Wk", "Wv", "Wo", "W1", "W2")]
    names += [f"loop.{w}" for w in ("Wq", "Wk", "Wv", "Wo", "W1", "W2")]
    for i in range(cfg["CODA"]):
        names += [f"coda.{i}.{w}" for w in ("Wq", "Wk", "Wv", "Wo", "W1", "W2")]
    return names


def config_json(cfg=CFG):
    return json.dumps(cfg)


if __name__ == "__main__":
    for k, v in param_count().items():
        print(f"  {k:<18}{v:,.4g}" if isinstance(v, float) else f"  {k:<18}{v:,}")
