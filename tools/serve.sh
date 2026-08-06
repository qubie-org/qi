#!/usr/bin/env bash
# Both local models, on the two ports vite proxies.
#
#   :8082  /llm  Agents-A1-4B      the agent — decides, calls tools, answers
#   :8081  /sum  summarizer-800m   compresses tool results and the topic line
#
# llama-server rather than mlx_lm for two reasons that cost real debugging time:
# mlx_lm's server ignores `chat_template_kwargs` in the request body (it is a
# server-launch flag there, `--chat-template-args`), so A1's thinking was never
# actually switched off and every reply paid for a reasoning trace that was then
# thrown away by a regex; and mlx_lm has no tool-calling path, which the agent
# loop is built on. llama-server with --jinja gives both.
set -euo pipefail

hub="$HOME/.cache/huggingface/hub"
a1=$(ls "$hub"/models--InternScience--Agents-A1-4B-Q4_K_M-GGUF/snapshots/*/Agents-A1-4B-Q4_K_M.gguf 2>/dev/null | head -1 || true)
sum=$(ls "$hub"/models--SupraLabs--reasoning-summarizer-800m-pre-gguf/snapshots/*/*.gguf 2>/dev/null | head -1 || true)

if [ -z "$sum" ]; then echo "summarizer gguf missing" >&2; exit 1; fi

# The summarizer is a base-model finetune: no chat template in the GGUF, and it
# emits its {title, sub_title, summary, cur_task} JSON from a raw prompt without
# being asked. It is driven through /v1/completions, so no template is needed.
echo "── summarizer :8081  $(basename "$sum")"
llama-server -m "$sum" --port 8081 --host 127.0.0.1 \
  -c 8192 -ngl 99 --no-webui > /tmp/toki-sum.log 2>&1 &

if [ -z "$a1" ]; then
  echo "── A1 gguf not downloaded yet; summarizer only" >&2
else
  echo "── A1 :8082          $(basename "$a1")"
  # --jinja turns on the model's own template, which is what carries the tool
  # definitions and the /nothink switch. Without it A1 cannot emit tool calls.
  llama-server -m "$a1" --port 8082 --host 127.0.0.1 \
    --jinja --chat-template-kwargs '{"enable_thinking":false}' \
    -c 8192 -ngl 99 --no-webui > /tmp/toki-a1.log 2>&1 &
fi

trap 'kill $(jobs -p) 2>/dev/null' EXIT INT TERM
wait
