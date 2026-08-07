# House style

## Prose

The docblocks are the tonal reference for everything written in this repository
— comments, commit messages, `COMMAND.md` bodies, and the README.

- Precise, unhurried, willing to say what failed.
- Short sentences carry the weight.
- No marketing language. No emoji headers. No "blazingly fast".
- Name the measurement. `16.98s against 0.04s per call` is worth ten adjectives.
- Name the failure concretely enough that someone could reproduce it. "The model
  once wrote *'Hugging Face was founded in March 2023 by three former
  schoolmates from Tsinghua University'*" is a docblock. "The model sometimes
  hallucinates" is not.
- A rejected approach is worth more written down than deleted. Several headers
  here have a `── What was tried instead, and why it is not here ──` section.
  Add to them.

## TypeScript

- No semicolons. Single quotes. Two-space indent. Trailing commas in multiline
  literals.
- `type` over `interface` unless you need declaration merging.
- Explicit return types on exported functions.
- Prefer a pure function taking its inputs over a module reaching for state.
  `src/skills/index.ts` takes the file maps as an argument precisely so it can be
  tested by a runner with no bundler.
- Comments sit *above* the thing, not beside it, and explain why.

## Swift

- Swift 6, SwiftPM, `swift-tools-version: 6.2`. There is no `.pbxproj` and there
  will not be one.
- The module is `@MainActor` by default (`SE-0466`, set in `Package.swift`).
  Anything off the main actor says `nonisolated` explicitly.
- `native/build.sh` owns the bundle layout, the Info.plist and the signature.
  SwiftPM produces a bare executable and stops there.

## Shell and Python

- `set -euo pipefail` in bash; `set -uo pipefail` where a non-zero exit is a
  reportable result rather than a fault (`tools/check.sh`, `doctor.sh`).
- Python appears only in `tools/*.py` and `train/`. It reads catalogues and
  builds indexes; it is not in the app's path.

## Structural rules

**One authority per fact.** When two files describe the same thing, one is the
authority and the other is a copy waiting to go stale.

| Fact | Authority |
|---|---|
| What a pack is, its files, hashes, port, bytes | `src/model/catalog.json` |
| The three model sizes, which have activated adapters | `cli/models.mjs` |
| What a sigil means | `src/pages/sigils.ts` |
| What a command is called and what it asks for | its `COMMAND.md` frontmatter |
| The block-to-river transformation | `src/inline/downgrade.ts` (and its Python port, gated) |

`Packs.swift` reads `catalog.json` as a bundled resource rather than
reimplementing it in Swift, for this reason. Do not add a second copy in a new
language.

**Fail open.** Everything in `src/ground/judge.ts` returns `null` when the pack
is absent or the call failed. A judgement that cannot be made must not become a
refusal to answer — the app is exactly as capable without the rag pack as it was
before it existed, and better with it. Keep that asymmetry.

**Nothing block-shaped.** The renderer has no headings, lists, fences, tables or
paragraphs. `downgrade()` guarantees the parser only ever sees one river, which
is why `parse()` has no block loop. If you find yourself adding one, the change
belongs in `downgrade()` instead.

**No raw payload reaches the model.** Every tool executor returns a string the
digest compresses to one line. The agent reasons over one-line results, never
over a response body. That is what lets a 3B run several steps without losing
the thread.

**Determinism where a person can notice.** Glyph placement, colour and sound are
computed from embeddings with measured thresholds — no sampling. The same
sentence always decorates the same way. Do not introduce randomness into the
presentation layer.

## Thresholds

Any number that gates a decision must be either measured or explained.
`src/engine/place.ts` measures where "no relation" actually sits for the current
bank and model, because the old constant (0.42) was right for a static embedding
table and meaningless for a contextual encoder — swapping the model moved the
whole distribution and every word suddenly cleared the bar.

If you hard-code a threshold, say in the comment what it was measured against.

## Naming

- Files and directories: lowercase, no underscores in TypeScript
  (`scrollTheme.ts`, `emojiColor.ts`). Python keeps snake_case.
- A command's directory name is its id unless frontmatter says otherwise.
- Skill directories in `/skills` must be lowercase alphanumeric with single
  hyphens, and the `name` in the frontmatter must match the directory.

## Dependencies

Adding one needs a reason that survives being stated out loud.

- `cli/` has **zero** dependencies. Node 20 already has `fetch`,
  `readline/promises`, `createHash` and an HTTP server. A setup tool that itself
  needs an install step has failed at the one job it has.
- `tools/mcp-qi.mjs` is hand-rolled JSON-RPC rather than the MCP SDK: three
  methods, and the whole file is shorter than the dependency's install
  footprint. A debugging tool that can break the build it is debugging is worse
  than no debugging tool.
- The page's dependencies are load-bearing and few: React, Vite, sqlite-wasm,
  onnxruntime-web, wllama, wasmer, strudel, reveal, valibot, animejs, emojibase.
