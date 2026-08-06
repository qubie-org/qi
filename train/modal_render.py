"""
The soft-token render experiment, on a GPU.

`train/render.py` runs the same thing and is smoke-testable on CPU, but the
question it asks — can a 35M learn to read a fixed HDC state — needs enough
steps to distinguish "cannot" from "has not yet", and that is not a Mac job.

    modal run train/modal_render.py                 # the decisive run
    modal run train/modal_render.py --steps 20000   # if it is still climbing
"""

import modal

app = modal.App("toki-render")

image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("torch", "numpy", "tokenizers", "safetensors", "huggingface_hub")
    .add_local_dir("public/models/potion", "/root/public/models/potion", copy=True)
    .add_local_file("train/render.py", "/root/train/render.py", copy=True)
)

vol = modal.Volume.from_name("toki-render", create_if_missing=True)


@app.function(image=image, gpu="A10G", timeout=60 * 60, volumes={"/cache": vol})
def run(steps: int = 12000, bs: int = 64, lr: float = 3e-4):
    import os
    import subprocess
    import sys

    # The model weights live in the volume so a re-run does not re-download.
    os.environ["HF_HOME"] = "/cache/hf"
    from huggingface_hub import snapshot_download

    snapshot_download("harrrshall/BarunLM-35M")
    vol.commit()

    sys.path.insert(0, "/root")
    os.chdir("/root")
    subprocess.run(
        [sys.executable, "train/render.py", "--steps", str(steps), "--bs", str(bs), "--lr", str(lr)],
        check=True,
    )


@app.local_entrypoint()
def main(steps: int = 12000, bs: int = 64, lr: float = 3e-4):
    run.remote(steps=steps, bs=bs, lr=lr)
