"""The block killer, in Python — a faithful port of src/inline/downgrade.ts.

The model's training targets have to be exactly what the renderer will later
produce, or it learns a dialect the page cannot speak. Since downgrade() is the
renderer's front half and lives in TypeScript, training needs a port, and the
port has to be provably identical: see test_downgrade_parity.py, which runs
both over the same corpus and diffs them.

Keep this in lockstep with the TS. If one changes, both change.
"""
import re

S = ""  # stands in for "a break survives here"


def downgrade(src: str) -> str:
    s = re.sub(r"\r\n?", "\n", src)

    # 1. Fenced code collapses to inline code, first, so nothing below
    #    reinterprets a '#' or '-' that lived inside a snippet.
    def _fence(m: "re.Match") -> str:
        return "`" + re.sub(r"\s+", " ", m.group(2)).strip() + "`"

    s = re.sub(r"^ {0,3}(`{3,}|~{3,})[^\n]*\n([\s\S]*?)^ {0,3}\1[^\n]*$", _fence, s, flags=re.M)
    s = re.sub(r"^ {0,3}(?:`{3,}|~{3,})[^\n]*$", "", s, flags=re.M)

    # 2. Tables -> cells joined by a dot, alignment row discarded.
    s = re.sub(r"^ {0,3}\|?[ :|-]*-[ :|-]*\|?[ \t]*$", "", s, flags=re.M)
    s = re.sub(
        r"^ {0,3}\|(.+)\|[ \t]*$",
        lambda m: " :dot: ".join(c.strip() for c in m.group(1).split("|") if c.strip()),
        s,
        flags=re.M,
    )

    # 3. Headings keep their emphasis, lose their box.
    s = re.sub(r"^ {0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$", r"[[\1|loud]]", s, flags=re.M)
    s = re.sub(r"^([^\n]+)\n {0,3}(?:={2,}|-{2,})[ \t]*$", r"[[\1|loud]]", s, flags=re.M)

    # 4. Thematic break -> a breath with a dot in it.
    s = re.sub(r"^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$", f"{S}:dot:{S}", s, flags=re.M)

    # 5. Blockquote -> a quote mark, inline.
    s = re.sub(r"^ {0,3}> ?", "\u201c", s, flags=re.M)

    # 6. Lists keep their ordering; each item takes its own line in the river.
    s = re.sub(r"^ {0,3}[-*+][ \t]+", f"{S}:dot: ", s, flags=re.M)
    s = re.sub(r"^ {0,3}(\d{1,3})[.)][ \t]+", f"{S}[[\\1|marker]] ", s, flags=re.M)
    s = re.sub(r"^ {0,3}([a-zA-Z]|[ivxIVX]{2,4})[.)][ \t]+", f"{S}[[\\1|marker]] ", s, flags=re.M)

    # 7. Raw HTML has no place in a river of type.
    s = re.sub(r"</?[a-zA-Z][^>]*>", "", s)

    # 8. Whitespace -> flow. Blank lines are the only surviving breaks, and
    #    however much air was left, you get exactly one.
    s = re.sub(r"[ \t]+", " ", s)
    s = re.sub(r"\n[ ]*\n[\s]*", S, s)
    s = s.replace("\n", " ")
    s = "\n".join(p.strip() for p in s.split(S) if p.strip())

    return re.sub(r" {2,}", " ", s).strip()
