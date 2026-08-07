# Repository map

Which file is the authority for what. When two places describe the same thing,
the one named here wins and the other is a copy that has drifted.

## The page

| Path | What |
|---|---|
| `src/app.tsx` | The shell. Turns, composer, sigil picker, breadcrumb, app slot. Large and central. |
| `src/main.tsx` | Mount point. |
| `src/styles.css` | All of it. There is no CSS-in-JS. |
| `src/inline/downgrade.ts` | **The block killer.** Folds every CommonMark block construct into one river before parsing. Ported to Python in `train/downgrade.py`; the two are gated byte-for-byte by `train/test_downgrade_parity.py`. |
| `src/inline/parse.ts` | Inline-only parser. No block loop, by construction. |
| `src/inline/Render.tsx` | The river, as DOM. Chips, motifs, decos, pressable names. |
| `src/inline/compose.ts` | Where a chip lands in a sentence, by embedding similarity. |
| `src/inline/Streaming.tsx` | Text arriving token by token. |

## The engine (everything derived from the conversation)

| Path | What |
|---|---|
| `src/engine/vibe.ts` | **The four numbers**: warmth, energy, gravity, wonder. Each an axis in embedding space between two poles. `Drift` folds readings with decay. |
| `src/engine/theme.ts` | `Vibe` type, `NEUTRAL`, blending, applying to CSS. |
| `src/engine/palette.ts` | Which colour a word *means*. Four fixed OKLCH tones, never interpolated. |
| `src/engine/place.ts` | Which words get a glyph or a mark. Threshold measured, not chosen. |
| `src/engine/key.ts` | **The key**, from the same four numbers: tonic, mode, wave, cutoff, cps. `MISS` is the only interval outside the scale. |
| `src/engine/sound.ts` | Every interface sound, synthesised via superdough. Nothing is recorded. |
| `src/engine/dj.ts` | The `/dj` set. Pins the key while it plays. |
| `src/engine/emoji.ts`, `emojiColor.ts`, `salience.ts`, `floor.ts`, `perform.ts`, `scrollTheme.ts` | Emoji matching, salience scoring, background, entrance animation, scroll-restored theme. |

## The agent

| Path | What |
|---|---|
| `src/agent/loop.ts` | Decide, act, observe, repeat, answer. `MAX_STEPS = 4`. The system prompt lives here and its **ordering is load-bearing** — tools first, voice second. |
| `src/agent/tools.ts` | The three core verbs: `look`, `recall`, `open`. Packs add more. |
| `src/agent/digest.ts` | The summariser. Compresses every tool result to one line before the agent sees it. |
| `src/agent/Steps.tsx` | The step badges. |

## Grounding and research

| Path | What |
|---|---|
| `src/ground/index.ts` | The router: which source answers a sentence. `PICTURE_FORM` and `LOOKUP_FORM` are grammar tests, not topic tests. |
| `src/ground/sources.ts` | **The ten sources.** wiki, weather, crypto, fx, iss, image, art, catfact, dog, joke. Each has anchors, a fetch, and a sandboxed reducer. |
| `src/ground/sandbox.ts` | Reducers run in a wasm sandbox. A source never gets to run code in the page. |
| `src/ground/engines.ts` | Nine search engines: five corpora (wikipedia, hackernews, openalex, archive, commoncrawl) and four SERPs (ddg, mojeek, startpage, bing). |
| `src/ground/search.ts` | `search()` and `read()`. Escalates to Lightpanda when a page is thin. |
| `src/ground/research.ts` | **The research process.** The longest and most heavily annotated file in the repo. Read its header before changing anything in it. |
| `src/ground/judge.ts` | The intrinsics as decisions: `answers()`, `unsupportedSpans()`. Everything here fails *open* — `null` means nobody knows. |
| `src/ground/render.ts`, `rank.ts`, `quantity.ts`, `catalogue.ts`, `operations.ts`, `clickhouse.ts`, `net.ts` | Fact rendering, ranking, unit handling, the API index, the query spec. |
| `src/ground/__tests__/domains.ts` | **The evaluation.** 22 questions, ten domains. Not in CI. See `qi-research`. |

## Namespaces, pages, store

| Path | What |
|---|---|
| `src/pages/sigils.ts` | **The namespace authority.** Two sigils: `/` invokes, `@` finds. Its header records why `$` and `#` were deleted. |
| `src/pages/space.ts` | The `qi:` address space. |
| `src/pages/find.ts` | `@` — a query over notes and decks, by title and opening only. |
| `src/pages/build.ts`, `autolink.ts` | Pages from facts; linking names in prose. |
| `src/store/db.ts` | SQLite over OPFS. Everything said, found and done. |
| `src/store/working.ts` | The working set, rebuilt from the store each step — O(1) in conversation length. |
| `src/store/notes.ts` | Notes and decks. |

## Commands and apps

One folder each. Frontmatter parsed by `src/skills/index.ts` — a hand-rolled
one-line-per-field reader, not YAML.

| Path | What |
|---|---|
| `src/commands/{research,present,goal,dj}/` | `COMMAND.md` (frontmatter + prose for a person) and `command.ts` (the `run`). |
| `src/apps/{note,deck}/` | `APP.md` and `app.tsx`. An app has a `surface` and takes over the page. |
| `src/skills/discover.ts` | **The only Vite-specific file.** `import.meta.glob` must appear literally, at the top level, with literal arguments. A helper that forwards to it silently returns nothing. |
| `src/skills/index.ts` | Pure loaders. Testable without a bundler. |

## Model and packs

| Path | What |
|---|---|
| `src/model/catalog.json` | **The pack authority.** Read by `tools/pull.sh`, `src/model/packs.ts` and the Swift installer, so none of them can disagree. |
| `cli/models.mjs` | **The size authority.** The two offered sizes, their hashes, and which activated adapters exist. Its header records why 30b was removed. Read by the CLI only. |
| `src/model/granite.ts` | The llama-server client: `say`, `fill`, capabilities, `sentences()`. |
| `src/model/packs.ts` | Pack bindings and verbs. |
| `src/model/vectors.ts` | `embed`, `cosine`, the warm cache. |
| `src/model/telemetry.ts` | OpenTelemetry spans. |
| `src/packs/rag.ts` | The five intrinsics as calls. |
| `src/packs/embed.ts`, `see.ts`, `bpe.ts` | The embedder, the vision pack, the tokenizer. |

## Outside the page

| Path | What |
|---|---|
| `cli/qiui.mjs` | `@qi-ui/cli`. Zero dependencies, deliberately. |
| `native/Sources/qi/Serve.swift` | The loopback HTTP server and why it is not `file://`. |
| `native/Sources/qi/Model.swift` | Starts and supervises `llama-server`. Zeroes every adapter scale after startup. |
| `native/Sources/qi/Install.swift` | Resumable, verified, parallel-range downloads. |
| `native/Sources/qi/Packs.swift` | Bundle first, then Application Support. |
| `native/Sources/qi/Control.swift` | The control port the MCP server drives: `/health`, `/eval`, `/console`, `/shot`, `/reload`. |
| `native/Sources/qi/Updates.swift` | Sparkle. Appcast is an asset on the latest release. |
| `native/build.sh` | Assemble, bundle Lightpanda and llama-server, rewrite dylibs to `@rpath`, sign inside-out. |
| `tools/pull.sh` | Every weight. Curl only — the Xet client stalls against this CDN. |
| `tools/serve.sh` | Every installed llama pack on its catalogued port. The aLoRA union rule lives here. |
| `tools/check.sh` | Four claims the stack is built on, over curl. |
| `tools/mcp-qi.mjs` | The MCP server this plugin declares. |
| `tools/render.ts`, `net.ts`, `vite-*.ts`, `pack_*.py`, `probe_*.py` | Headless render, fetch proxy, Vite plugins, index builders and endpoint probes. |

## Not part of the app

| Path | What |
|---|---|
| `train/` | The toki v2 lane: BitNet ternary QAT, HDC soft-token injection, projection probes. Pre-Granite. Nothing in `src/` imports it. `downgrade.py` and `test_downgrade_parity.py` are the one live link. |
| `.stage/` | A C bench for one HDC question carried over from TinyOS. Self-contained, no build step. |
