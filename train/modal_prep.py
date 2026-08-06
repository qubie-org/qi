"""toki v2 data prep on Modal: train an 8192 BPE, tokenise FineWeb-edu to shards.

v1 was char-level (V=96). Characters cannot carry a real corpus — every word
costs 5-8 positions, so a 512-token window held about 80 words. An 8192 BPE
gets roughly 4x the text into the same context and makes the loop's depth
worth spending.

Writes to the `toki-v2` volume:
    tokenizer.json          the trained BPE
    tokens/train-XXXX.bin   uint16 token ids, concatenated documents
    tokens/val.bin
    meta.json               counts, so training knows what it has
"""
import json
import modal

app = modal.App("toki-v2-prep")
vol = modal.Volume.from_name("toki-v2", create_if_missing=True)

image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("datasets==5.0.1", "tokenizers==0.23.1", "numpy", "huggingface_hub")
    .env({"HF_HUB_ENABLE_HF_TRANSFER": "0", "HF_XET_HIGH_PERFORMANCE": "1"})
)

DATASET = "HuggingFaceFW/fineweb-edu"
SUBSET = "sample-10BT"
VOCAB = 8192
SPECIALS = ["<pad>", "<unk>", "<bos>", "<eos>", "<sep>"]
TOKENIZER_DOCS = 300_000     # documents used to fit the BPE
SHARD_TOKENS = 100_000_000   # uint16 -> 200 MB a shard
VAL_TOKENS = 5_000_000


@app.function(image=image, volumes={"/vol": vol}, timeout=60 * 60 * 3, cpu=8.0)
def train_tokenizer():
    from datasets import load_dataset
    from tokenizers import Tokenizer, models, trainers, pre_tokenizers, decoders
    import os

    if os.path.exists("/vol/tokenizer.json"):
        print("tokenizer already present, skipping")
        return

    ds = load_dataset(DATASET, name=SUBSET, split="train", streaming=True)

    def corpus():
        for i, row in enumerate(ds):
            if i >= TOKENIZER_DOCS:
                break
            if i % 25_000 == 0:
                print(f"  fitting on doc {i:,}", flush=True)
            yield row["text"]

    tok = Tokenizer(models.BPE(unk_token="<unk>"))
    tok.pre_tokenizer = pre_tokenizers.ByteLevel(add_prefix_space=True)
    tok.decoder = decoders.ByteLevel()
    trainer = trainers.BpeTrainer(
        vocab_size=VOCAB,
        special_tokens=SPECIALS,
        initial_alphabet=pre_tokenizers.ByteLevel.alphabet(),
        show_progress=False,
    )
    tok.train_from_iterator(corpus(), trainer=trainer)
    tok.save("/vol/tokenizer.json")
    vol.commit()

    sample = "The line is the visual narrator. It moves around and discovers things."
    ids = tok.encode(sample).ids
    print(f"vocab {tok.get_vocab_size()}")
    print(f"sample -> {len(ids)} tokens for {len(sample)} chars "
          f"({len(sample)/len(ids):.2f} chars/token)")


@app.function(image=image, volumes={"/vol": vol}, timeout=60 * 60 * 6, cpu=16.0)
def tokenize(target_tokens: int = 2_000_000_000):
    """Stream the corpus and write uint16 shards until the target is reached."""
    from datasets import load_dataset
    from tokenizers import Tokenizer
    import numpy as np
    import os

    os.makedirs("/vol/tokens", exist_ok=True)
    tok = Tokenizer.from_file("/vol/tokenizer.json")
    eos = tok.token_to_id("<eos>")

    ds = load_dataset(DATASET, name=SUBSET, split="train", streaming=True)
    it = iter(ds)
    exhausted = False

    def take(limit: int) -> "np.ndarray":
        """Tokenise until `limit` ids are collected. Works in numpy blocks —
        yielding ids one at a time would put 2e9 Python-level iterations in the
        hot path and turn a few hours into days."""
        nonlocal exhausted
        blocks, got = [], 0
        while got < limit and not exhausted:
            texts = []
            for _ in range(2000):
                try:
                    texts.append(next(it)["text"])
                except StopIteration:
                    exhausted = True
                    break
            if not texts:
                break
            flat = []
            for enc in tok.encode_batch(texts):
                flat.extend(enc.ids)
                flat.append(eos)
            block = np.asarray(flat, dtype=np.uint16)
            blocks.append(block)
            got += block.size
        if not blocks:
            return np.empty(0, dtype=np.uint16)
        return np.concatenate(blocks)[:limit]

    # Validation split first, so it is never seen during training.
    val = take(VAL_TOKENS)
    val.tofile("/vol/tokens/val.bin")
    vol.commit()
    print(f"val.bin {len(val):,} tokens", flush=True)

    # Resume past whatever is already on the volume rather than rewriting it.
    # Restarting at shard 0 overwrites files a running job may have memmapped;
    # it happened to be harmless here only because the stream is deterministic
    # and the bytes came out identical.
    existing = sorted(f for f in os.listdir("/vol/tokens") if f.startswith("train-"))
    shard = len(existing)
    total = sum(os.path.getsize(f"/vol/tokens/{f}") // 2 for f in existing)
    if shard:
        print(f"resuming: {shard} shards, {total/1e9:.2f}B tokens already present", flush=True)
        # Skip the stream forward so new shards are new text, not a repeat.
        skipped = 0
        while skipped < total and not exhausted:
            chunk = take(min(SHARD_TOKENS, total - skipped))
            if chunk.size == 0:
                break
            skipped += chunk.size
        print(f"  stream advanced {skipped/1e9:.2f}B", flush=True)

    while total < target_tokens and not exhausted:
        arr = take(min(SHARD_TOKENS, target_tokens - total))
        if arr.size == 0:
            print("corpus exhausted", flush=True)
            break
        path = f"/vol/tokens/train-{shard:04d}.bin"
        arr.tofile(path)
        total += arr.size
        shard += 1
        vol.commit()
        print(f"{path} {arr.size:,} tokens (total {total/1e9:.3f}B)", flush=True)

    meta = {"train_tokens": total, "val_tokens": int(len(val)), "shards": shard, "vocab": VOCAB}
    with open("/vol/meta.json", "w") as f:
        json.dump(meta, f, indent=1)
    vol.commit()
    print(json.dumps(meta, indent=1))


@app.local_entrypoint()
def main(tokens: int = 2_000_000_000):
    train_tokenizer.remote()
    tokenize.remote(tokens)
