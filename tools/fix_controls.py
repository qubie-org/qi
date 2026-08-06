#!/usr/bin/env python3
"""Replace raw control characters in source with explicit \\u escapes.

Invisible bytes in a regex literal work, but nobody can read or safely edit
them. Run over src/ after any hand-authored character-class.
"""
import pathlib, re, sys

BAD = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f�]")
root = pathlib.Path(__file__).resolve().parent.parent / "src"

changed = 0
for path in sorted(root.rglob("*.ts*")):
    text = path.read_text()
    if not BAD.search(text):
        continue
    fixed = BAD.sub(lambda m: "\\u%04x" % ord(m.group()), text)
    path.write_text(fixed)
    changed += 1
    for i, line in enumerate(text.splitlines(), 1):
        if BAD.search(line):
            print(f"{path.relative_to(root.parent)}:{i}  {BAD.sub('<?>', line).strip()}")

print(f"\n{changed} file(s) cleaned", file=sys.stderr)
sys.exit(0)
