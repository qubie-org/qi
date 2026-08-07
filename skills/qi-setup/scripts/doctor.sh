#!/usr/bin/env bash
# What is missing before qi can run. Reports; downloads nothing, starts nothing.
#
#   bash scripts/doctor.sh
#
# Deliberately read-only. A doctor that fixes things is a doctor you cannot run
# to find out what state you are in.
set -uo pipefail

# The plugin root, whether or not the client exported it.
root="${PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}"

ok=0
bad=0
say_ok()   { printf '  \033[32mok\033[0m    %s\n' "$1"; ok=$((ok+1)); }
say_bad()  { printf '  \033[31mmiss\033[0m  %s\n' "$1"; [ -n "${2:-}" ] && printf '        %s\n' "$2"; bad=$((bad+1)); }
say_note() { printf '  \033[2m--\033[0m    %s\n' "$1"; }

echo "── qi doctor  ($root)"

# ── prerequisites ────────────────────────────────────────────────────────────
if command -v node >/dev/null 2>&1; then
  major=$(node -p 'process.versions.node.split(".")[0]')
  if [ "$major" -ge 20 ]; then say_ok "node $(node -v)"
  else say_bad "node $(node -v)" "qi needs Node 20 or newer"; fi
else
  say_bad "node" "install Node 20+ — https://nodejs.org"
fi

command -v bun >/dev/null 2>&1 \
  && say_ok "bun $(bun --version)" \
  || say_note "bun absent — only needed to build from source"

command -v llama-server >/dev/null 2>&1 \
  && say_ok "llama-server on PATH" \
  || say_bad "llama-server" "brew install llama.cpp"

command -v lightpanda >/dev/null 2>&1 \
  && say_ok "lightpanda on PATH" \
  || say_note "lightpanda absent — reads fall back to a plain fetch"

command -v python3 >/dev/null 2>&1 \
  && say_ok "python3 $(python3 -V 2>&1 | cut -d' ' -f2)" \
  || say_bad "python3" "tools/pull.sh and tools/serve.sh read the catalogue with it"

# ── the machine ──────────────────────────────────────────────────────────────
if [ "$(uname -s)" = "Darwin" ]; then
  arch=$(uname -m)
  [ "$arch" = "arm64" ] \
    && say_ok "macOS $(sw_vers -productVersion) on $arch" \
    || say_note "macOS on $arch — every measurement in this project is Apple silicon"
  gb=$(( $(sysctl -n hw.memsize) / 1073741824 ))
  if   [ "$gb" -ge 32 ]; then say_ok  "${gb} GB RAM — any size"
  elif [ "$gb" -ge 16 ]; then say_ok  "${gb} GB RAM — 3b or 8b"
  elif [ "$gb" -ge 8  ]; then say_ok  "${gb} GB RAM — 3b only"
  else                        say_bad "${gb} GB RAM" "3b wants about 8 GB"; fi
else
  say_note "not macOS — the native app is macOS-only; the page may still run"
fi

# ── the weights ──────────────────────────────────────────────────────────────
for dir in "$root/packs" "${QI_HOME:-$HOME/.qi}/packs"; do
  [ -d "$dir" ] || continue
  core=$(ls "$dir"/core/*.gguf 2>/dev/null | head -1)
  if [ -n "$core" ]; then
    say_ok "core: $(basename "$core") ($(du -h "$core" | cut -f1)) in $dir"
  else
    say_note "no core pack in $dir"
  fi
  plain=$(ls "$dir"/rag/*.gguf 2>/dev/null | wc -l | tr -d ' ')
  activated=$(ls "$dir"/rag/alora/*.gguf 2>/dev/null | wc -l | tr -d ' ')
  [ "$plain$activated" != "00" ] && say_note "rag: $plain plain, $activated activated"
  [ -f "$dir/embed/model.onnx" ] && say_ok "embed: model.onnx present"
  # A partial download that was never resumed.
  parts=$(find "$dir" -name '*.part*' 2>/dev/null | wc -l | tr -d ' ')
  [ "$parts" != "0" ] && say_bad "$parts partial download(s) under $dir" "delete the pack directory and fetch again"
done

# ── what is answering ────────────────────────────────────────────────────────
for port in 8082 8083 8085 8777; do
  if curl -s --max-time 2 "http://127.0.0.1:$port/health" >/dev/null 2>&1 \
     || curl -s --max-time 2 "http://127.0.0.1:$port/props" >/dev/null 2>&1; then
    say_ok "something is answering on :$port"
  fi
done

# The failure that produces no error anywhere.
scales=$(curl -s --max-time 3 http://127.0.0.1:8082/lora-adapters 2>/dev/null || true)
if [ -n "$scales" ]; then
  hot=$(printf '%s' "$scales" | python3 -c '
import json,sys
try: print(sum(1 for a in json.load(sys.stdin) if a.get("scale", 0) != 0))
except Exception: print(-1)' 2>/dev/null)
  case "$hot" in
    0)  say_ok  "adapter shelf loaded, every scale zero" ;;
    -1) say_note "could not read /lora-adapters" ;;
    *)  say_bad "$hot adapter(s) applied at non-zero scale" \
                "stacked deltas make the model emit <tool_call></tool_response> forever — see troubleshooting.md" ;;
  esac
fi

echo
printf '   %d ok, %d missing\n' "$ok" "$bad"
[ "$bad" -eq 0 ] || exit 1
