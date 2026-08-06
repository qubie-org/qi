#!/usr/bin/env python3
"""Can needle decline to call a tool?

needle is trained to emit a tool call, so given "i need help" it picks the
least-bad tool and toki goes and fetches a dog. The fix under test: add an
explicit `chat` tool to the schema so declining is itself a legal choice the
constrained decoder can reach.

Prints which tool is chosen for grounded vs conversational input.
"""
import json, pathlib, sys

import numpy as np
import onnxruntime as ort
import sentencepiece as spm

sys.path.insert(0, "/tmp")
from constrained import build_constrained_decoder  # noqa: E402

root = pathlib.Path(__file__).resolve().parent.parent
Q8 = root / "public" / "models" / "needle"
EOS, TOOLS = 1, 5
LAYERS, KV_HEADS, HEAD_DIM = 8, 4, 64


class Shim:
    def __init__(self, path):
        self.sp = spm.SentencePieceProcessor(model_file=str(path))
        self.vocab_size = self.sp.get_piece_size()


tok = Shim(Q8 / "needle.model")
sp = tok.sp

REAL = [
    {"name": "wiki", "description": "Look up what something is.",
     "parameters": {"topic": {"type": "string", "description": "the thing to look up"}}},
    {"name": "weather", "description": "Current weather somewhere.",
     "parameters": {"location": {"type": "string", "description": "city name"}}},
    {"name": "dog", "description": "A photo of a dog.",
     "parameters": {"_": {"type": "string", "description": "unused"}}},
    {"name": "joke", "description": "Tell a joke.",
     "parameters": {"_": {"type": "string", "description": "unused"}}},
]
ABSTAIN = {"name": "chat", "description": "Just talk. No lookup needed.",
           "parameters": {"_": {"type": "string", "description": "unused"}}}

WITHOUT = json.dumps(REAL)
WITH = json.dumps(REAL + [ABSTAIN])

# (query, should_ground)
CASES = [
    ("what is the moon", True),
    ("weather in Tokyo", True),
    ("show me a dog", True),
    ("tell me a joke", True),
    ("i need help", False),
    ("hi there", False),
    ("that's really beautiful", False),
    ("i feel tired today", False),
    ("thanks", False),
]

enc = ort.InferenceSession(str(Q8 / "encoder.q8.onnx"), providers=["CPUExecutionProvider"])
dec = ort.InferenceSession(str(Q8 / "decoder_step.q8.onnx"), providers=["CPUExecutionProvider"])


def pick(query, tools_json, max_gen=48):
    q = sp.encode(query)[:1022]
    t = sp.encode(tools_json)[: 1024 - len(q) - 1]
    ids = np.array([q + [TOOLS] + t], dtype=np.int64)
    encoder_out = enc.run(None, {"input_ids": ids})[0]
    past = np.zeros((LAYERS, 2, 1, KV_HEADS, 0, HEAD_DIM), dtype=np.float32)
    cd = build_constrained_decoder([tools_json], tok)
    nxt, produced = EOS, []
    for _ in range(max_gen):
        logits, past = dec.run(None, {
            "decoder_input_ids": np.array([[nxt]], dtype=np.int64),
            "encoder_out": encoder_out,
            "past_self_kv": past,
        })
        row = logits[0, 0]
        if cd.is_active(0):
            row = cd.constrain_logits(np.array(row), 0)
        nxt = int(np.argmax(row))
        if nxt == EOS:
            break
        produced.append(nxt)
        cd.update(0, nxt)
    text = sp.decode(produced)
    if text.startswith("<tool_call>"):
        text = text[len("<tool_call>"):]
    try:
        return json.loads(text)[0].get("name", "?")
    except Exception:
        return "?"


ok_without = ok_with = 0
print(f"{'query':<28}{'want':<10}{'no-abstain':<14}{'with chat':<12}")
print("-" * 66)
for q, should in CASES:
    a = pick(q, WITHOUT)
    b = pick(q, WITH)
    good_a = (a != "?") == should if should else False  # without abstain it can never decline
    good_b = (b != "chat") == should
    ok_without += good_a
    ok_with += good_b
    print(f"{q[:26]:<28}{('tool' if should else 'chat'):<10}{a:<14}{b:<12}")

print(f"\ncorrect without abstain tool: {ok_without}/{len(CASES)}")
print(f"correct with    abstain tool: {ok_with}/{len(CASES)}")
