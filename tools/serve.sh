#!/usr/bin/env bash
# Every installed llama pack, each on the port the catalog gives it.
#
#   :8082  core   granite-4.1-3b       thinks, calls tools, fills schemas
#   :8083  see    granite-vision-4.1   reads images        (only if installed)
#   :8085  fast   granite-4.0-h-tiny   the MoE alternative (only if installed)
#
# There is no configuration here. What runs is what is on disk: install a pack
# and it gets a server on the next start, remove it and it does not. The page
# discovers the same thing over /packs/installed, so neither side is ever
# holding a stale list.
#
# llama.cpp rather than MLX for generation, and the reason is specific: this is
# the only runtime that gives all four of tool calling, JSON-schema grammars, a
# vision projector, and adapter hot-swap — and qi's loop is built on the first
# two while the intrinsics shelf is built on the fourth. MLX is still the right
# tool for fine-tuning, but an adapter trained there comes back here to be
# served.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
catalog="$root/src/model/catalog.json"

# Context, and why it is not the model's maximum.
#
# Granite 4.1-3B is dense — 40 layers, 8 KV heads, 64-dim heads — which costs
# about 80 KB of KV cache per token at f16. Its advertised 131k window would
# therefore want ~10 GB of cache on top of the weights, which does not fit
# alongside a browser on a 16 GB machine. 32k with an 8-bit cache is ~1.3 GB and
# holds a genuinely long conversation.
#
# (The `fast` pack is the opposite case: 36 of its 40 layers are Mamba2 with
# fixed-size state, so its window is nearly free. It gets the full length.)
CTX="${QI_CTX:-32768}"

plan=$(python3 -c "
import json
for p in json.load(open('$catalog'))['packs']:
    if p['runtime'] == 'llama' and p.get('port'):
        names = [f['to'] if isinstance(f, dict) else f.split('/')[-1] for f in p['files']]
        print('\t'.join([p['id'], str(p['port']), ' '.join(names)]))
")

# The intrinsics shelf, in a stable order. Every adapter is passed to the core
# at startup but none is applied — a request names the one it wants and the
# server reuses the prompt it has already processed. Sorted so that the ids the
# server hands out do not depend on how the filesystem feels today.
# aLoRA where it exists, plain LoRA otherwise.
#
# The difference is a single key in the file — `adapter.alora.invocation_tokens`
# — and what it buys is the whole reason to prefer one: a standard LoRA changes
# the weights, so the server cannot reuse the prompt it has already processed
# under the base model and reprocesses the lot. An activated LoRA applies only
# from the invocation point, so the prefix stays cached.
#
# IBM publishes aLoRA for three of the five against granite-4.1-3b —
# answerability, query_rewrite, query_clarification. `citations` and
# `hallucination_detection` have no aLoRA variant, so they stay standard and
# keep paying the reprocess. Both live under packs/rag; the alora/ directory
# simply wins when a file of the same name is in it.
#
# The name of an adapter is its filename, because that is what the app matches
# on (see model/granite.ts) — so the two directories must not disagree about
# spelling, and a file in alora/ replaces rather than joins its twin.
# The union of both directories, aLoRA winning on a name collision.
#
# Driving the loop off the plain-LoRA files and checking for an aLoRA twin
# looked equivalent and was not: deleting a superseded plain file removed the
# only thing that named its intrinsic, so three adapters silently stopped
# loading. `check.sh` caught it in one run, which is the argument for it
# existing. Enumerate every name either directory offers.
loras=()
if [ -d "$root/packs/rag" ]; then
  while IFS= read -r name; do
    [ -z "$name" ] && continue
    if [ -f "$root/packs/rag/alora/$name" ]; then
      loras+=(--lora "$root/packs/rag/alora/$name")
    else
      loras+=(--lora "$root/packs/rag/$name")
    fi
  done < <(ls "$root"/packs/rag/*.gguf "$root"/packs/rag/alora/*.gguf 2>/dev/null \
             | xargs -n1 basename 2>/dev/null | sort -u)
fi

started=0
while IFS=$'\t' read -r id port files; do
  [ -z "$id" ] && continue
  dir="$root/packs/$id"
  main=""
  mmproj=""
  for name in $files; do
    path="$dir/$name"
    [ -s "$path" ] || { main=""; break; }
    case "$name" in
      mmproj*) mmproj="$path" ;;
      *) main="$path" ;;
    esac
  done
  [ -z "$main" ] && { echo "── $id not installed; skipping"; continue; }

  ctx="$CTX"
  adapters=()
  case "$id" in
    core)
      # Only the core hosts the shelf: every granitelib adapter is trained
      # against these exact weights, and applying one to the vision model or to
      # h-tiny would be applying it to a model it has never seen.
      adapters=("${loras[@]}")
      ;;
    # Not 0. `-c 0` means "take the window the GGUF was trained with", and this
    # model was trained at 1,048,576 — so with four slots the server tried to
    # reserve four million tokens of state and every request came back
    # "Compute error." The Mamba layers make a long window cheap, not free.
    # 32k matches the core, which is what the app's context budget assumes.
    fast) ctx=32768 ;;
  esac

  echo "── $id :$port  $(basename "$main")${mmproj:+ + mmproj}  ctx=${ctx}$([ ${#adapters[@]} -gt 0 ] && echo "  +$(( ${#adapters[@]} / 2 )) adapters")"

  # --jinja turns on the model's own chat template, which is what carries the
  # tool declarations and the documents block. Without it Granite cannot emit a
  # tool call at all.
  #
  # The 8-bit KV cache is the difference between a long conversation and an
  # out-of-memory kill; the quality cost at q8_0 is not measurable here.
  # `${adapters[@]+...}` rather than `"${adapters[@]}"`.
  #
  # The script runs under `set -u`, and expanding an array that was never
  # assigned is an unbound-variable error there — not an empty expansion. Only
  # the core pack gets adapters, so every *other* pack hit that error and the
  # loop died before starting it. The hybrid model has therefore never once
  # come up, silently, since the day it was added to the catalogue.
  llama-server -m "$main" ${mmproj:+--mmproj "$mmproj"} \
    ${adapters[@]+"${adapters[@]}"} \
    --port "$port" --host 127.0.0.1 \
    --jinja -c "$ctx" -ngl 99 --no-webui \
    -ctk q8_0 -ctv q8_0 \
    > "/tmp/qi-$id.log" 2>&1 &
  started=$((started + 1))

  # Silence the shelf.
  #
  # `--lora-init-without-apply` is documented to load adapters without applying
  # them. In b10250 it does not: /lora-adapters reports every one of them at
  # scale 1.0, and five rank-32 deltas stacked on top of each other turn the
  # model into a machine that emits <tool_call></tool_response> forever. It
  # passes no test and fails no startup check — the server comes up fine and the
  # weights are quietly wrong.
  #
  # So the scales are zeroed explicitly once the server answers. After this the
  # base model is the base model, and a request that names an adapter gets that
  # one and only that one.
  if [ ${#adapters[@]} -gt 0 ]; then
    (
      for _ in $(seq 1 60); do
        curl -sf --max-time 2 "http://127.0.0.1:$port/props" > /dev/null && break
        sleep 2
      done
      n=$(( ${#adapters[@]} / 2 ))
      body=$(python3 -c "import json;print(json.dumps([{'id':i,'scale':0} for i in range($n)]))")
      curl -sf -X POST -H 'content-type: application/json' -d "$body" \
        "http://127.0.0.1:$port/lora-adapters" > /dev/null \
        && echo "   $id: $n adapters loaded, all at scale 0" \
        || echo "   $id: WARNING could not zero adapter scales — replies will be garbage" >&2
    ) &
  fi
done <<< "$plan"

if [ "$started" = 0 ]; then
  echo "nothing installed — run tools/pull.sh" >&2
  exit 1
fi

trap 'kill $(jobs -p) 2>/dev/null' EXIT INT TERM
wait
