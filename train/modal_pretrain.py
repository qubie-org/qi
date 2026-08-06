"""toki v2 pretraining on Modal: BitNet b1.58 QAT over FineWeb-edu.

Run:
    modal run --detach train/modal_pretrain.py                 # dense baseline
    modal run --detach train/modal_pretrain.py --experts 8     # MoE variant

Dense goes first. Recurrence, ternary QAT and expert routing are three things
that can each ruin a loss curve, and v1 already paid for the lesson that you
cannot tell them apart after the fact (prune-after-QAT quietly took val 0.043
to 0.19).

Checkpoints land on the volume every CKPT_EVERY steps and the run resumes from
the newest one, so a preemption costs minutes rather than the run.
"""
import json
import modal

app = modal.App("toki-v2-pretrain")
vol = modal.Volume.from_name("toki-v2", create_if_missing=True)

image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("torch==2.13.0", "numpy")
    .add_local_file(__file__.replace("modal_pretrain.py", "common.py"), "/root/common.py")
)

GPU = "A100-80GB"
SEQ = 512
MICRO_BATCH = 32          # sequences per forward
GRAD_ACCUM = 8            # -> 131,072 tokens per optimiser step
LR = 2e-3
MIN_LR_FRAC = 0.1
WARMUP_FRAC = 0.02
WEIGHT_DECAY = 0.1
GRAD_CLIP = 1.0
VAL_EVERY = 500
CKPT_EVERY = 1000
LOG_EVERY = 25
# L1 on the shadow weights. v1 found that pruning *after* QAT destroys the
# model; the untried alternative was to pressure the shadows toward zero during
# training so the sparsity is real and the entropy coder can exploit it.
L1_SHADOW = 1e-6


@app.function(
    image=image,
    gpu=GPU,
    volumes={"/vol": vol},
    timeout=60 * 60 * 8,
)
def pretrain(
    steps: int = 15000,
    experts: int = 1,
    top_k: int = 1,
    tag: str = "dense",
    resume: bool = True,
    compile_model: bool = True,
):
    import math, os, sys, time
    import numpy as np
    import torch

    sys.path.insert(0, "/root")
    import common as C

    cfg = dict(C.CFG, EXPERTS=experts, TOP_K=top_k)
    dev = "cuda"
    torch.manual_seed(1234)
    torch.backends.cuda.matmul.allow_tf32 = True
    torch.backends.cudnn.allow_tf32 = True

    meta = json.load(open("/vol/meta.json"))
    print(json.dumps({**C.param_count(cfg), "corpus": meta}, indent=1), flush=True)

    # ── data: memmap the shards, sample windows uniformly ──────────────────
    shard_paths = sorted(
        os.path.join("/vol/tokens", f) for f in os.listdir("/vol/tokens") if f.startswith("train-")
    )
    shards = [np.memmap(p, dtype=np.uint16, mode="r") for p in shard_paths]
    val = np.memmap("/vol/tokens/val.bin", dtype=np.uint16, mode="r")
    print(f"{len(shards)} shards, {sum(s.size for s in shards)/1e9:.2f}B tokens", flush=True)

    rng = np.random.default_rng(0)

    window = np.arange(SEQ + 1)

    def batch(source, n):
        """(n, SEQ+1) windows — inputs and shifted targets come from one draw.

        One vectorised gather, not a Python loop over sequences. The loop
        version assembled 256 sequences per optimiser step on the main thread
        and stalled the GPU between every micro-batch.
        """
        src = source[int(rng.integers(len(source)))] if isinstance(source, list) else source
        starts = rng.integers(0, src.size - SEQ - 1, size=n)
        out = np.asarray(src[(starts[:, None] + window[None, :])], dtype=np.int64)
        t = torch.from_numpy(out).pin_memory().to(dev, non_blocking=True)
        return t[:, :-1], t[:, 1:]

    # ── model ─────────────────────────────────────────────────────────────
    model = C.build_model(cfg).to(dev)
    shadows = [p for p in model.parameters() if p.dim() == 2]
    decayed = {id(p) for p in shadows}
    opt = torch.optim.AdamW(
        [
            {"params": shadows, "weight_decay": WEIGHT_DECAY},
            {"params": [p for p in model.parameters() if id(p) not in decayed], "weight_decay": 0.0},
        ],
        lr=LR,
        betas=(0.9, 0.95),
        eps=1e-8,
    )

    # Fusing the ternary elementwise ops into the surrounding matmuls is worth
    # a lot here, since QAT adds a quantise pass over every weight. The STE is
    # a custom autograd path, so failure is plausible — fall back rather than
    # lose the run.
    if compile_model:
        try:
            model = torch.compile(model)
            print("torch.compile enabled", flush=True)
        except Exception as err:  # noqa: BLE001
            print(f"torch.compile unavailable ({err}); running eager", flush=True)

    start = 1
    ckpt_path = f"/vol/ckpt-{tag}.pt"
    if resume and os.path.exists(ckpt_path):
        state = torch.load(ckpt_path, map_location=dev, weights_only=False)
        getattr(model, "_orig_mod", model).load_state_dict(state["model"])
        opt.load_state_dict(state["opt"])
        start = state["step"] + 1
        print(f"resumed {tag} at step {start}", flush=True)

    warmup = max(1, int(steps * WARMUP_FRAC))

    def lr_at(step):
        if step <= warmup:
            return LR * step / warmup
        p = (step - warmup) / max(1, steps - warmup)
        return LR * (MIN_LR_FRAC + (1 - MIN_LR_FRAC) * 0.5 * (1 + math.cos(math.pi * p)))

    def loss_on(x, y):
        logits = model(x)
        loss = torch.nn.functional.cross_entropy(
            logits.reshape(-1, cfg["V"]).float(), y.reshape(-1)
        )
        aux = getattr(getattr(model, "_orig_mod", model), "aux_loss", None)
        if aux is not None:
            loss = loss + cfg["AUX_LOSS"] * aux
        return loss

    @torch.no_grad()
    def validate(batches=20):
        model.eval()
        total = 0.0
        for _ in range(batches):
            x, y = batch(val, MICRO_BATCH)
            with torch.autocast("cuda", dtype=torch.bfloat16):
                logits = model(x)
            total += float(
                torch.nn.functional.cross_entropy(
                    logits.reshape(-1, cfg["V"]).float(), y.reshape(-1)
                )
            )
        model.train()
        return total / batches

    print(f"training {tag}: {steps} steps x {MICRO_BATCH*GRAD_ACCUM*SEQ/1e3:.0f}k tokens", flush=True)
    model.train()
    t0 = time.time()
    seen = 0
    WARM = 5   # steps excluded from the rate: compile happens here

    for step in range(start, steps + 1):
        for g in opt.param_groups:
            g["lr"] = lr_at(step)

        opt.zero_grad(set_to_none=True)
        acc = 0.0
        for _ in range(GRAD_ACCUM):
            x, y = batch(shards, MICRO_BATCH)
            with torch.autocast("cuda", dtype=torch.bfloat16):
                loss = loss_on(x, y) / GRAD_ACCUM
            loss.backward()
            acc += loss.detach()
            if step > start + WARM - 1:
                seen += x.numel()

        if L1_SHADOW:
            # Applied to the gradient rather than the loss: the shadows are
            # what the optimiser moves, and pressuring them toward zero is what
            # makes the ternarised weights genuinely sparse.
            with torch.no_grad():
                for p in shadows:
                    if p.grad is not None:
                        p.grad.add_(L1_SHADOW * p.sign())

        torch.nn.utils.clip_grad_norm_(model.parameters(), GRAD_CLIP)
        opt.step()

        if step == start + WARM - 1:
            t0 = time.time()   # clock starts once the graphs are compiled

        if step % LOG_EVERY == 0:
            dt = max(1e-6, time.time() - t0)
            # BitNet rounds |w|/gamma to the nearest integer, so a weight lands on
            # zero when |w| < gamma/2 — not gamma.
            zeros = sum(
                float((a := p.abs()).lt(a.mean() * 0.5).float().mean()) for p in shadows
            ) / len(shadows)
            print(
                f"step {step:>6} loss {float(acc):.4f} lr {lr_at(step):.2e} "
                f"tok {seen/1e6:.0f}M {seen/dt/1e3:.0f}k tok/s sparsity ~{zeros:.0%}",
                flush=True,
            )

        if step % VAL_EVERY == 0 or step == steps:
            v = validate()
            print(f"  val {v:.4f}  ({v/math.log(2):.3f} bits/token)", flush=True)

        if step % CKPT_EVERY == 0 or step == steps:
            torch.save(
                {"model": getattr(model, "_orig_mod", model).state_dict(),
                 "opt": opt.state_dict(), "step": step, "cfg": cfg},
                ckpt_path,
            )
            vol.commit()
            print(f"  checkpoint @ {step}", flush=True)

    # ── export shadows for packing ────────────────────────────────────────
    raw = getattr(model, "_orig_mod", model)
    out = {k: v.detach().float().cpu().numpy() for k, v in raw.state_dict().items()}
    np.savez(f"/vol/export-{tag}.npz", **out, __config__=np.frombuffer(
        json.dumps(cfg).encode(), dtype=np.uint8))
    vol.commit()
    print(f"exported /vol/export-{tag}.npz", flush=True)


@app.local_entrypoint()
def main(steps: int = 15000, experts: int = 1, top_k: int = 1, tag: str = "",
         resume: bool = True, compile_model: bool = True):
    pretrain.remote(steps, experts, top_k,
                    tag or ("dense" if experts <= 1 else f"moe{experts}"), resume, compile_model)
