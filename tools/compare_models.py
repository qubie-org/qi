"""
Three candidate talkers on toki's actual task, not on benchmarks.

A1-4B is what ships today. The question is whether either replacement is better
on the four things this agent needs — and "better" here means the behaviours the
loop depends on, which no leaderboard measures:

  calls a tool when it needs one       the loop is dead without this
  does NOT call one when told the answer   the continuity fix depends on it
  answers from a context block         "is that cold?" with no subject
  says it in very few words            everything renders at display size

Plus the numbers that decide whether it can ship to anyone: tokens/sec, time to
first token, and resident memory.

Each model is served on its own port by llama-server --jinja, so the tool
definitions go through the model's own chat template rather than a prompt we
wrote. That is exactly how src/agent/loop.ts talks to it.

    python3 tools/compare_models.py 8082:A1-4B 8083:Qwen3-4B 8084:granite-h-tiny
"""

import json
import subprocess
import sys
import time
import urllib.request

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "look",
            "description": "Find a current fact in the world: weather, prices, populations, "
            "definitions, pictures. Use for anything you do not already know or were not just told.",
            "parameters": {
                "type": "object",
                "properties": {"query": {"type": "string"}},
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "recall",
            "description": "Search what this conversation has already established.",
            "parameters": {
                "type": "object",
                "properties": {"query": {"type": "string"}},
                "required": ["query"],
            },
        },
    },
]

SYSTEM = (
    "You are toki. You answer in very few words — usually one short sentence. "
    "Never explain your reasoning. Never preface. "
    "Use a tool only when you need something you do not have."
)

CONTEXT = (
    "[context]\nabout: the user is asking about Iceland's weather\n"
    "known:\n  Reykjavik temperature: 13 C\n  Reykjavik wind: 15 km/h\n[end context]\n\nis that cold?"
)

CASES = [
    # name, user text, wants a tool call?
    ("needs a tool", "what's the weather in reykjavik?", True),
    ("needs no tool", "say hello", False),
    ("answers from context", CONTEXT, False),
    ("brevity", "explain what an island is", False),
]


def call(port, messages, tools=True, timeout=240):
    body = {
        "messages": messages,
        "max_tokens": 200,
        "temperature": 0.6,
        "top_p": 0.9,
        "stream": False,
    }
    if tools:
        body["tools"] = TOOLS
        body["tool_choice"] = "auto"
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/v1/chat/completions",
        json.dumps(body).encode(),
        {"content-type": "application/json"},
    )
    t0 = time.time()
    out = json.load(urllib.request.urlopen(req, timeout=timeout))
    return out, time.time() - t0


def rss_mb(port):
    """Resident memory of the llama-server holding this port."""
    try:
        pid = subprocess.run(["lsof", "-nP", "-tiTCP:%d" % port, "-sTCP:LISTEN"],
                             capture_output=True, text=True).stdout.split()
        if not pid:
            return 0
        out = subprocess.run(["ps", "-o", "rss=", "-p", pid[0]], capture_output=True, text=True)
        return int(out.stdout.strip() or 0) / 1024
    except Exception:
        return 0


def evaluate(port, label):
    print(f"\n══ {label}  (port {port})")
    ok = 0
    for name, text, wants_tool in CASES:
        try:
            out, wall = call(port, [{"role": "system", "content": SYSTEM}, {"role": "user", "content": text}])
        except Exception as e:
            print(f"   {name:<22} ERROR {str(e)[:50]}")
            continue
        msg = out["choices"][0]["message"]
        calls = msg.get("tool_calls") or []
        content = (msg.get("content") or "").strip().replace("\n", " ")
        got_tool = bool(calls)
        good = got_tool == wants_tool
        ok += good
        mark = "✓" if good else "✗"
        if calls:
            fn = calls[0]["function"]
            detail = f"CALL {fn['name']}({fn['arguments'][:44]})"
        else:
            words = len(content.split())
            detail = f"{words:>2}w  {content[:70]!r}"
        print(f"   {mark} {name:<22} {detail}")

    # throughput on a short, representative generation
    out, wall = call(port, [{"role": "system", "content": SYSTEM},
                            {"role": "user", "content": "why is the sky blue?"}], tools=False)
    tm = out.get("timings", {})
    print(f"   {'':2} {'speed':<22} {tm.get('predicted_per_second', 0):.1f} tok/s gen   "
          f"{tm.get('prompt_per_second', 0):.0f} tok/s prompt   "
          f"TTFT {tm.get('prompt_ms', 0)/1000:.2f}s   RSS {rss_mb(port):.0f} MB")
    print(f"   {'':2} {'behaviour score':<22} {ok}/{len(CASES)}")
    return ok


def main():
    targets = []
    for arg in sys.argv[1:]:
        port, _, label = arg.partition(":")
        targets.append((int(port), label or port))
    if not targets:
        sys.exit(__doc__)
    for port, label in targets:
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=3)
        except Exception:
            print(f"\n══ {label} (port {port}) — not up, skipping")
            continue
        evaluate(port, label)


if __name__ == "__main__":
    main()
