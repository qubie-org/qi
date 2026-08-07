---
name: qi-develop
description: Edit the qi codebase correctly — house style, the docblock convention, the test suite, and the verify-against-the-real-app loop. Use when adding or changing a command, an app, a grounding source, a pack, a verb, a sigil, the inline renderer, the engine (colour, glyphs, key, sound), the agent loop, or the store; and before writing any commit that touches src/, cli/ or native/.
license: AGPL-3.0-or-later
compatibility: Requires bun for tests, Node 20+, and a running qi app for the MCP verification tools.
metadata:
  org.qubie.qi.role: develop
---

# Editing qi

## Read before you write

Find the docblock above the thing you are changing and read it. In this
codebase the headers are not decoration — they record what was measured, what
was tried, and what killed each rejected approach. Several of them exist
specifically to stop someone re-introducing a design that has already failed
here.

The four worth reading in full before any substantial change:

- `src/ground/research.ts` — the research process, and five rejected approaches
  with the measurement that killed each.
- `src/pages/sigils.ts` — the namespace design, and why two of four namespaces
  were deleted.
- `src/agent/loop.ts` — why the system prompt is ordered the way it is.
- `src/engine/key.ts` and `sound.ts` — why nothing is a recording.

If your change contradicts a docblock, you owe a measurement in its place. Edit
the docblock in the same commit; a stale one is worse than none, because the
next person will believe it.

## The one design rule

**Every fix that has worked here took latitude away from the model.** In order
of preference:

1. Make the wrong answer unexpressible. A grammar the model cannot violate; a
   schema; an enumeration it picks from by number. This is why the research
   extractor does not write quotes — it chooses a sentence index, and a
   paraphrase is not a thing it is able to emit.
2. Filter afterwards. `tidy()` strips the reporting voice because a 3B opens
   with "The source establishes that" about a third of the time and no amount
   of prompt wording fixed it. Cheap, reliable, cannot lose content.
3. Measure it and write it down.

Adding a paragraph of prompt is last, and has repeatedly failed here. Wording
that works today is not a mechanism.

## House style

Full detail in [house-style.md](references/house-style.md). The short version:

- **TypeScript, no semicolons, single quotes, two-space indent.** Match the
  file you are in.
- **Docblocks explain *why*, and name the failure.** "A page rendered to text
  here reads `distribution , so`" is a useful docblock. "Normalises whitespace"
  is not.
- **No new dependencies without a reason that survives being stated.** The CLI
  has zero. `tools/mcp-qi.mjs` is hand-rolled JSON-RPC because the protocol
  surface needed is three methods.
- **Nothing block-shaped in the river.** If you are adding a `<div>` with a
  margin to the reply renderer, stop.
- **Fail open, not closed.** Every intrinsic call returns `null` for "nobody
  knows". Only `false` is a verdict, and only a verdict stops anything.
- **One authority per fact.** `src/model/catalog.json` for packs,
  `cli/models.mjs` for sizes, `src/pages/sigils.ts` for namespaces. A second
  copy is a place for a stale answer to hide.

## Common changes

| Task | Guide |
|---|---|
| Add or change a `/command` | [adding-a-command.md](references/adding-a-command.md) |
| Add a grounding source, or change routing | [adding-a-source.md](references/adding-a-source.md) |
| Add an app under `@`/`/` | Same shape as a command; see `src/apps/note/APP.md` and `src/apps/index.ts`. An app has a `surface` and no `run`. |
| Add a pack | Add it to `src/model/catalog.json` — that one file feeds `pull.sh`, `packs.ts` and the Swift installer. Then bind its verbs in `src/packs/`. See `qi-models`. |
| Add an agent verb | `src/agent/tools.ts`. **Think hard first**: tool selection degrades sharply past about five options, and there are already three core verbs plus whatever packs bind. A fourth core verb was deleted for exactly this reason. |
| Change the research process | Load `qi-research`. Do not change it without running the domain eval. |

## Testing

```sh
bun test
```

Twelve suites, no network, fast. This is the gate for every edit. Details and
the list of suites that are deliberately *not* in it:
[testing.md](references/testing.md).

## Verify against the real app

Tests do not tell you whether the page looks right or whether the model behaves.
For that, drive the running app.

This plugin declares an MCP server (`mcp.json` → `tools/mcp-qi.mjs`) that talks
to the Swift shell's control port on 8777:

| Tool | What |
|---|---|
| `qi_eval` | Run an async function body inside the real page. `const m = await import("/src/engine/sound.ts"); return m.currentKey()` |
| `qi_console` | Recent console output, including uncaught errors and unhandled rejections, which never reach `console.error` on their own |
| `qi_console_clear` | Drop the buffer, so the next read is only what happened after now |
| `qi_screenshot` | A PNG of the real window, native shell included |
| `qi_health` | Whether the app is up, what URL it loaded, whether it is still loading |
| `qi_reload` | Reload — note this clears in-page state, including the audio unlock |

Without the plugin: `claude mcp add qi -- node tools/mcp-qi.mjs`.

**Do not verify in Chrome.** It is a different engine, a different window with
none of the native shell, and its dev-server module registry hands back a *fresh
copy* of a module after any edit — so a module holding state reads as empty
from the console while the app is using a different instance entirely. Several
measurements in this project's history were taken against that phantom.

The eval endpoint is also how the expensive tests are driven:

```sh
curl -s -X POST http://127.0.0.1:8777/eval --data \
  'const m = await import("/src/ground/__tests__/domains.ts"); return m.ask(0, 2)'
```

## Committing

- Do not commit weights, `dist/`, `dist-dmg/`, `native/.build/` or
  `native/Qi.app/`. They are gitignored; keep it that way.
- Commit messages in this repository are prose, in the same voice as the
  docblocks: what changed, what it was measured against, and what failed on the
  way. Read `git log` before writing one.
- Never commit or push unless asked.
