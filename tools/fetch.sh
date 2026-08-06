#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../models"
dl(){ [ -f "$2" ] && { echo "have $2"; return; }; echo "GET $2"; curl -sL --retry 3 -o "$2.part" "$1" && mv "$2.part" "$2"; }

# --- needle-onnx (tool caller, browser-ready) ---
B=https://huggingface.co/onnx-community/needle-onnx/resolve/main
mkdir -p needle && cd needle
dl $B/encoder.onnx encoder.onnx
dl $B/decoder_step.onnx decoder_step.onnx
dl $B/needle.model needle.model
dl $B/tokenizer-specials.json tokenizer-specials.json
cd ..

# --- Supra2-100M-Instruct (talker) f16 gguf -> quantize later ---
mkdir -p supra && cd supra
dl https://huggingface.co/SupraLabs/Supra2-100M-Instruct/resolve/main/Supra2-100M-SFT-F16.gguf supra2-100m-f16.gguf
cd ..

# --- potion static embeddings (motif NN + theme vibe) ---
mkdir -p potion && cd potion
P=https://huggingface.co/minishlab/potion-base-8M/resolve/main
dl $P/model.safetensors potion.safetensors
dl $P/tokenizer.json tokenizer.json
dl $P/config.json config.json
cd ..
echo "ALL FETCHED"
ls -la */
