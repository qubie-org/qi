#!/usr/bin/env python3
"""needle with grammar-constrained decoding — fp32 vs int8.

Unconstrained, base needle emits correct tool *names* and garbage arguments
(its own card reports 32% argument accuracy). Cactus's generate() defaults to
constrained=True: a JSON state machine masks the logits so tool names and
argument keys can only come from the supplied schema.

This checks two things at once:
  1. does constraining actually fix the arguments?
  2. under constraint, does int8 still track fp32?

Constraint should absorb most quantization drift, because the mask removes the
choices where the two graphs disagree.
"""
import json, pathlib, sys

import numpy as np
import onnxruntime as ort
import sentencepiece as spm

sys.path.insert(0, "/tmp")
from constrained import build_constrained_decoder  # noqa: E402

root = pathlib.Path(__file__).resolve().parent.parent
FP32 = root / "models" / "needle"
Q8 = root / "public" / "models" / "needle"

EOS, TOOLS = 1, 5
LAYERS, KV_HEADS, HEAD_DIM = 8, 4, 64


class Shim:
    """The two attributes constrained.py actually reaches for."""

    def __init__(self, path):
        self.sp = spm.SentencePieceProcessor(model_file=str(path))
        self.vocab_size = self.sp.get_piece_size()


tok = Shim(FP32 / "needle.model")
sp = tok.sp

TOOLS_JSON = json.dumps(
    [
        {"name": "get_weather", "description": "Current weather for a place.",
         "parameters": {"location": {"type": "string", "description": "city name"}}},
        {"name": "set_timer", "description": "Set a timer.",
         "parameters": {"time_human": {"type": "string", "description": "duration"}}},
        {"name": "search", "description": "Look something up.",
         "parameters": {"query": {"type": "string", "description": "what to find"}}},
    ]
)

QUERIES = [
    "set a 5 min timer",
    "What's the weather in San Francisco?",
    "what is the weather like in Tokyo right now",
    "look up the population of Iceland",
    "how far away is the moon",
    "search for basque cheesecake recipes",
]


def enc_input(query, tools, max_enc_len=1024):
    q = sp.encode(query)[: max_enc_len - 2]
    t = sp.encode(tools)[: max_enc_len - len(q) - 1]
    return np.array([q + [TOOLS] + t], dtype=np.int64)


def generate(enc_p, dec_p, query, constrained=True, max_gen=64):
    enc = ort.InferenceSession(str(enc_p), providers=["CPUExecutionProvider"])
    dec = ort.InferenceSession(str(dec_p), providers=["CPUExecutionProvider"])
    encoder_out = enc.run(None, {"input_ids": enc_input(query, TOOLS_JSON)})[0]
    past = np.zeros((LAYERS, 2, 1, KV_HEADS, 0, HEAD_DIM), dtype=np.float32)
    cd = build_constrained_decoder([TOOLS_JSON], tok) if constrained else None
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
        row = logits[0, 0]
        if cd and cd.is_active(0):
            row = cd.constrain_logits(np.array(row), 0)
        nxt = int(np.argmax(row))
        if nxt == EOS:
            break
        produced.append(nxt)
        if cd:
            cd.update(0, nxt)
    text = sp.decode(produced)
    return text[len("<tool_call>"):] if text.startswith("<tool_call>") else text


def valid(text):
    try:
        calls = json.loads(text)
        return isinstance(calls, list) and all("name" in c and "arguments" in c for c in calls)
    except Exception:
        return False


agree = ok32 = ok8 = 0
print(f"{'query':<40}{'fp32 valid':<12}{'int8 valid':<12}{'agree':<7}int8 output")
print("-" * 130)
for q in QUERIES:
    a = generate(FP32 / "encoder.onnx", FP32 / "decoder_step.onnx", q)
    b = generate(Q8 / "encoder.q8.onnx", Q8 / "decoder_step.q8.onnx", q)
    va, vb, same = valid(a), valid(b), a == b
    ok32 += va; ok8 += vb; agree += same
    print(f"{q[:38]:<40}{str(va):<12}{str(vb):<12}{str(same):<7}{b[:60]}")
    if not same:
        print(f"{'':<40}{'':<12}{'':<12}{'fp32:':<7}{a[:60]}")

n = len(QUERIES)
print(f"\nvalid JSON tool calls   fp32 {ok32}/{n}   int8 {ok8}/{n}")
print(f"int8 identical to fp32  {agree}/{n}")
