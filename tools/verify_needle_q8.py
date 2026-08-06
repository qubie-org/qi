#!/usr/bin/env python3
"""fp32 vs int8 needle — do the quantized graphs still emit the same tool calls?

Dynamic quantization can silently degrade a model, and a tool-caller that
drifts is worse than no tool-caller. This runs the exact Cactus decode loop
(encoder input = query + <tools> + tools; decoder seeded with EOS; greedy
argmax; stop at EOS) against both graph pairs and diffs the decoded text.
"""
import json, pathlib, sys

import numpy as np
import onnxruntime as ort
import sentencepiece as spm

root = pathlib.Path(__file__).resolve().parent.parent
FP32 = root / "models" / "needle"
Q8 = root / "public" / "models" / "needle"

PAD, EOS, TOOLS = 0, 1, 5
LAYERS, KV_HEADS, HEAD_DIM = 8, 4, 64

sp = spm.SentencePieceProcessor(model_file=str(FP32 / "needle.model"))

TOOLS_JSON = json.dumps(
    [
        {"name": "get_weather", "description": "Current weather.",
         "parameters": {"location": {"type": "string", "description": "city"}}},
        {"name": "set_timer", "description": "Set a timer.",
         "parameters": {"time_human": {"type": "string", "description": "duration"}}},
        {"name": "search", "description": "Look something up.",
         "parameters": {"query": {"type": "string", "description": "what to find"}}},
    ]
)

QUERIES = [
    "set a 5 min timer",
    "What's the weather in San Francisco?",
    "how far away is the moon",
    "what is the weather like in Tokyo right now",
    "look up the population of Iceland",
    "tell me a joke",
]


def encoder_input(query: str, tools: str, max_enc_len: int = 1024) -> np.ndarray:
    q = sp.encode(query)[: max_enc_len - 2]
    t = sp.encode(tools)[: max_enc_len - len(q) - 1]
    return np.array([q + [TOOLS] + t], dtype=np.int64)


def generate(enc_path, dec_path, query, max_gen=64):
    enc = ort.InferenceSession(str(enc_path), providers=["CPUExecutionProvider"])
    dec = ort.InferenceSession(str(dec_path), providers=["CPUExecutionProvider"])
    encoder_out = enc.run(None, {"input_ids": encoder_input(query, TOOLS_JSON)})[0]
    past = np.zeros((LAYERS, 2, 1, KV_HEADS, 0, HEAD_DIM), dtype=np.float32)
    nxt, produced = EOS, []
    for _ in range(max_gen):
        logits, past = dec.run(
            None,
            {
                "decoder_input_ids": np.array([[nxt]], dtype=np.int64),
                "encoder_out": encoder_out,
                "past_self_kv": past,
            },
        )
        nxt = int(np.argmax(logits[0, 0]))
        if nxt == EOS:
            break
        produced.append(nxt)
    text = sp.decode(produced)
    return text[len("<tool_call>"):] if text.startswith("<tool_call>") else text, produced


same = 0
print(f"{'query':<44}{'match':<7}output")
for q in QUERIES:
    a, ida = generate(FP32 / "encoder.onnx", FP32 / "decoder_step.onnx", q)
    b, idb = generate(Q8 / "encoder.q8.onnx", Q8 / "decoder_step.q8.onnx", q)
    ok = a == b
    same += ok
    print(f"{q[:42]:<44}{'OK' if ok else 'DRIFT':<7}{b[:66]}")
    if not ok:
        print(f"{'':<44}{'fp32:':<7}{a[:66]}")

print(f"\n{same}/{len(QUERIES)} identical between fp32 and int8")
sys.exit(0 if same == len(QUERIES) else 1)
