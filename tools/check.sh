#!/usr/bin/env bash
# Does the stack actually do what the code assumes? Curl only — no browser, no
# build step, so this can be run against a server started by hand.
#
#   tools/check.sh          check the core
#   tools/check.sh 8083     check another pack's server
#
# Four claims are tested, and each one is load-bearing somewhere:
#
#   1. tool calling      the agent loop is built on it
#   2. json schema       the digest and every intrinsic are built on it
#   3. documents         the RAG adapters were trained with them in the template,
#                        and there is no field for them in the OpenAI request
#   4. the shelf         an adapter selected per request actually changes the
#                        answer — otherwise an intrinsic is base weights wearing
#                        a hat, which looks identical from the outside
set -uo pipefail

port="${1:-8082}"
api="http://127.0.0.1:$port"
pass=0
fail=0

ok()   { printf '  \033[32mok\033[0m   %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; [ -n "${2:-}" ] && printf '       %s\n' "$2"; fail=$((fail+1)); }

post() { curl -s --max-time 120 -H 'content-type: application/json' -d "$2" "$api/$1"; }

echo "── $api"
props=$(curl -s --max-time 10 "$api/props" || true)
[ -z "$props" ] && { echo "no server on $port — run tools/serve.sh" >&2; exit 1; }
echo "   ctx=$(echo "$props" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("default_generation_settings",{}).get("n_ctx","?"))')"

# ── 1. tool calling ──────────────────────────────────────────────────────────
out=$(post v1/chat/completions '{
  "messages":[{"role":"user","content":"What is the weather in Reykjavik right now?"}],
  "tools":[{"type":"function","function":{"name":"look","description":"Find a current fact in the world: weather, prices, populations.","parameters":{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}}}],
  "tool_choice":"auto","max_tokens":120}')
name=$(echo "$out" | python3 -c 'import json,sys
try:
    m=json.load(sys.stdin)["choices"][0]["message"]
    print((m.get("tool_calls") or [{}])[0].get("function",{}).get("name",""))
except Exception: print("")')
[ "$name" = "look" ] && ok "tool calling — chose look" || bad "tool calling" "$(echo "$out" | head -c 200)"

# ── 2. grammar-constrained json ──────────────────────────────────────────────
out=$(post v1/chat/completions '{
  "messages":[{"role":"user","content":"Summarise: the temperature in Reykjavik was measured at 4.3 C."}],
  "max_tokens":120,"temperature":0.1,
  "response_format":{"type":"json_schema","json_schema":{"name":"note","strict":true,"schema":{"type":"object","properties":{"title":{"type":"string"},"summary":{"type":"string"}},"required":["title","summary"]}}}}')
got=$(echo "$out" | python3 -c 'import json,sys
try:
    d=json.loads(json.load(sys.stdin)["choices"][0]["message"]["content"])
    print("yes" if "title" in d and "summary" in d else "no")
except Exception: print("no")')
[ "$got" = yes ] && ok "json schema — shape guaranteed" || bad "json schema" "$(echo "$out" | head -c 200)"

# ── 3. documents reach the chat template ─────────────────────────────────────
# The probe word is deliberately not a real word: if the model repeats it, it
# read the document, and no amount of prior knowledge could have supplied it.
out=$(post v1/chat/completions '{
  "messages":[{"role":"user","content":"What colour is a purple bumble fish? Answer in one word."}],
  "chat_template_kwargs":{"documents":[{"doc_id":"1","text":"The only type of fish that is yellow is the purple bumble fish."}]},
  "max_tokens":40,"temperature":0.1}')
text=$(echo "$out" | python3 -c 'import json,sys
try: print(json.load(sys.stdin)["choices"][0]["message"]["content"].lower())
except Exception: print("")')
case "$text" in
  *yellow*) ok "documents — template variable reaches the model" ;;
  *) bad "documents" "answered: $(echo "$text" | head -c 120)" ;;
esac

# ── 4. the intrinsics shelf ──────────────────────────────────────────────────
adapters=$(curl -s --max-time 10 "$api/lora-adapters" || echo '[]')
n=$(echo "$adapters" | python3 -c 'import json,sys
try: print(len(json.load(sys.stdin)))
except Exception: print(0)')
if [ "$n" = 0 ]; then
  echo "  --   no adapters loaded; install the rag pack and restart serve.sh"
else
  ok "shelf — $n adapters loaded"
  id=$(echo "$adapters" | python3 -c 'import json,sys
for a in json.load(sys.stdin):
    if "answerability" in a["path"]: print(a["id"]); break
else: print(-1)')
  if [ "$id" = "-1" ]; then
    bad "shelf — no answerability adapter"
  else
    # The two cases from the adapter'"'"'s own model card, with known answers.
    # Same question, same schema, one word of difference in the document.
    for pair in "The square root of 4 is 2.|answerable" "The square root of 8 is not 2.|unanswerable"; do
      doc="${pair%%|*}"; want="${pair##*|}"
      out=$(post v1/chat/completions "{
        \"messages\":[{\"role\":\"assistant\",\"content\":\"Hello there, how can I help you?\"},{\"role\":\"user\",\"content\":\"What is the square root of 4?\"}],
        \"chat_template_kwargs\":{\"documents\":[{\"doc_id\":\"1\",\"text\":\"$doc\"}]},
        \"lora\":[{\"id\":$id,\"scale\":1}],
        \"max_tokens\":40,\"temperature\":0.1,
        \"response_format\":{\"type\":\"json_schema\",\"json_schema\":{\"name\":\"out\",\"strict\":true,\"schema\":{\"type\":\"object\",\"properties\":{\"answerability\":{\"type\":\"string\",\"enum\":[\"answerable\",\"unanswerable\"]}},\"required\":[\"answerability\"]}}}}")
      got=$(echo "$out" | python3 -c 'import json,sys
try: print(json.loads(json.load(sys.stdin)["choices"][0]["message"]["content"])["answerability"])
except Exception: print("?")')
      [ "$got" = "$want" ] && ok "answerability — $want" || bad "answerability — wanted $want, got $got"
    done
  fi
fi

echo
echo "  $pass passed, $fail failed"
[ "$fail" = 0 ]
