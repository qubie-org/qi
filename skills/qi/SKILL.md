---
name: qi
description: Entry point for working on the qi repository — a local-first text river running IBM Granite 4.1 via llama.cpp, with inline-only rendering, a citation-verifying research process, and a standalone macOS app. Load this first for any qi task, then follow it to the specific skill. Use when the user mentions qi, qiui, @qi-ui/cli, the text river, sigils, Granite intrinsics, aLoRA adapters, answerability, the research note or deck, or asks to set up, run, edit, evaluate, convert models for, or ship this project.
license: AGPL-3.0-or-later
compatibility: macOS on Apple silicon. Needs Node 20+ and llama-server on PATH for anything that runs the app.
metadata:
  org.qubie.qi.role: entry
---

# qi

Read this before touching anything else in the repository. It is short on
purpose; each section names the skill that carries the detail.

## What qi is

One line of text you type into, and one river of text that answers in place.
No chat bubbles, no sidebar, no settings panel. A 3B model runs locally behind
it. Everything else in the design follows from that one constraint: a 3B model
will not impose order on itself, so the process is code and only the judgement
is the model's.

Concretely:

- **Generation** — IBM Granite 4.1 3B, Q4_K_M, served by `llama-server` on
  `:8082` with Metal offload.
- **Intrinsics** — five LoRA adapters from `granitelib-rag-r1.0` loaded onto the
  same weights, selected per request. Three are *activated* (aLoRA) and that
  distinction is load-bearing; see `qi-models`.
- **Embedding** — Granite Embedding 30M, ONNX, in the page. It does retrieval,
  source routing, colour and glyph placement.
- **Reading** — Lightpanda for pages that only exist after their own
  JavaScript. Optional; without it, reads fall back to a plain fetch.
- **Shell** — Vite in development; a Swift app with its own loopback HTTP
  server in production.

## Which skill to load

| The task | Load |
|---|---|
| Install, run, verify, or diagnose a broken setup | `qi-setup` |
| Edit any source file; add a command, source or pack; run tests | `qi-develop` |
| Anything about a model, a pack, an adapter, sizes, RAM, hashes | `qi-models` |
| Convert an adapter, fine-tune, or touch anything under `train/` | `qi-train` |
| Change the research process or run the domain evaluation | `qi-research` |
| Build the app, sign, notarise, cut a release, publish weights | `qi-ship` |

Load one. They are written to be read alone, and each links the references it
needs.

## Standing rules

These apply to every task in this repository. They were each bought with a
failure.

1. **Never train or benchmark on the Mac.** A number measured on a Mac is not
   comparable to any published result and not comparable to the next run. GPU
   work goes to a real GPU. See `qi-train`.
2. **The code is the authority, and the docblocks are the evidence.** The
   headers in `src/ground/research.ts`, `src/pages/sigils.ts`,
   `src/engine/key.ts` and `native/Sources/qi/*.swift` record what was measured
   and what was rejected. Read the docblock before changing the function under
   it. If you contradict a docblock, you owe a new measurement in its place.
3. **Every fix that has worked took latitude away from the model.** Prefer a
   grammar the model cannot violate, then a filter over what it produced, then
   a measurement written down. Adding a paragraph of prompt is the option of
   last resort and has failed here repeatedly.
4. **Do not commit weights.** `packs/`, `dist/`, `dist-dmg/`, `native/.build/`
   and `native/Qi.app/` are gitignored and must stay that way.
5. **Verify against the real app, not a browser copy.** This plugin ships an
   MCP server (`mcp.json` → `tools/mcp-qi.mjs`) that drives the running Swift
   app over a loopback control port. A Chrome tab is a different engine, a
   different window, and — the part that actually costs time — a dev server
   whose module registry hands back a fresh copy of a module after any edit, so
   a module holding state reads as empty while the app uses another instance.

## Two things named "skills"

`/skills` at the repository root is this plugin — instructions for *you*.

`src/skills/` inside the app is the loader for `COMMAND.md` and `APP.md`
frontmatter. It is named after a namespace (`$`) that was deleted. Do not
confuse them, and do not put agent instructions in `src/skills/`.

## References

- [repository-map.md](references/repository-map.md) — every directory, what
  lives in it, and which file is the authority for what.
- [glossary.md](references/glossary.md) — river, sigil, vibe, pack, intrinsic,
  aLoRA, gate, angle, claim, loss. Terms used precisely throughout the code.
