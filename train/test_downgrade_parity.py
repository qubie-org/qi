#!/usr/bin/env python3
"""Prove the Python downgrade matches the TypeScript one, byte for byte.

If these two ever disagree, the model is trained on a format the renderer does
not produce, and every reply is subtly malformed. This is the gate.
"""
import json, pathlib, subprocess, sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from downgrade import downgrade  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent

CASES = [
    "# Big Title\n\nsome text",
    "try this:\n```js\nconst a = 1\nconsole.log(a)\n```\ndone",
    "things:\n- one\n- two\n\n1. first\n2. second",
    "| a | b |\n|---|---|\n| 1 | 2 |",
    "> wisdom here\nafter",
    "before\n\n---\n\nafter",
    "steps:\n1. preheat the oven\n2. mix the batter\n3. bake it",
    "options:\na) stay\nb) go\nc) decide later",
    "acts:\ni. setup\nii. conflict\niii. resolution",
    "Note. this is a sentence, not a list item.",
    "## Plan\n- research\n1. draft\n2. revise",
    "**bold** and *em* and `code` and ==sweep== and [link](/x) and ~~gone~~",
    "Setext Heading\n==============\nbody text",
    "a paragraph\n\n\n\nwith lots of air",
    "<div>html</div> should vanish",
    "mixed\n\n- bullet with **bold**\n- another\n\nclosing line",
    "trailing spaces   \n   and leading",
    "1) paren numbered\n2) second one",
    "",
    "just one line",
]

# Drive the real TypeScript implementation through bun.
harness = ROOT / "train" / ".parity_harness.ts"
harness.write_text(
    "import { downgrade } from '../src/inline/downgrade'\n"
    "const cases = JSON.parse(process.argv[2])\n"
    "console.log(JSON.stringify(cases.map((c: string) => downgrade(c))))\n"
)
try:
    proc = subprocess.run(
        ["bun", str(harness), json.dumps(CASES)],
        capture_output=True, text=True, cwd=ROOT, check=True,
    )
    ts_out = json.loads(proc.stdout.strip().splitlines()[-1])
finally:
    harness.unlink(missing_ok=True)

fails = 0
for case, ts in zip(CASES, ts_out):
    py = downgrade(case)
    if py != ts:
        fails += 1
        print(f"MISMATCH for {case!r}")
        print(f"   ts: {ts!r}")
        print(f"   py: {py!r}")

print(f"\n{len(CASES) - fails}/{len(CASES)} identical between TypeScript and Python")
sys.exit(1 if fails else 0)
