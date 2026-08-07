# Adding or changing a `/command`

A command is a folder under `src/commands/` with exactly two files. Nothing
registers it by hand — `src/skills/discover.ts` globs the folder at build time
and `src/skills/index.ts` builds the entry.

```
src/commands/<id>/
├── COMMAND.md    frontmatter + prose for a person
└── command.ts    the code
```

## `COMMAND.md`

```markdown
---
id: research
name: research
needs: what should I look into?
gives: a note, with sources
tone: 1
controls: ⏹ stop abandon the research
---

Investigates a question properly and leaves a note behind.

…
```

Frontmatter is parsed by a hand-rolled reader in `src/skills/index.ts`, **not by
YAML**. Every field is `key: value` on one line. Anything needing more structure
than that wants to be in the body.

| Field | Meaning |
|---|---|
| `id` | Defaults to the folder name. What `find()` matches. |
| `name` | What appears in the picker and the composer's mode chip. |
| `needs` | What the composer asks for while this has it, **phrased as a question to a person** — it replaces "say something", so it is read as speech. Empty means the command takes no argument and runs the moment it is chosen. |
| `gives` | What comes back, in three or four words. Shown under the name. |
| `tone` | 0–3. Which of the four colours it draws in, so the picker reads as a palette. |
| `controls` | Optional. Positional: `glyph action rest-is-the-tooltip`, several separated by commas. Rendered in the chrome while `running()` says yes. |
| `makes` | Apps only. The id of the command that creates one of these. |

The body is **documentation, read by a person, sent nowhere**. A command does
not inform the agent; it runs. (This is the distinction that killed the `$`
skill namespace: a skill's body was a brief loaded into the model's context, and
a 3B model handed a brief does not act on it usefully.)

Write the body in the codebase's voice. Say what the command is for, what it
costs, and what it does *not* do. `src/commands/goal/COMMAND.md` is the model to
copy.

## `command.ts`

Must export `run`. Everything else is optional.

```ts
import type { Fact } from '../../ground/sandbox'

export async function run(argument: string): Promise<Fact | null> { … }

// Only for something that outlives the sentence that started it:
export const isRunning = (): boolean => running
export const status = (): string => stage
export function control(action: string): void { … }
```

`commandFrom()` returns `null` without an `id` or a `run`, and logs a warning
naming the path — a command that cannot run is not a command.

Keep it thin. `/research` is twenty lines: the process lives in
`src/ground/research.ts` and the destination in `src/store/notes.ts`, and the
command is only the decision that a note gets written at all. If your
`command.ts` is growing a process, the process belongs somewhere else.

## The `Fact` it returns

```ts
{
  label: 'research',
  value: '4 findings from 3 sources, 6 set aside',
  src: 'research',
  srcUrl: 'https://…',   // optional
  hint: 'a note with 4 sourced findings',
}
```

`label` and `value` are what the river shows. `hint` is what the summariser is
given. Return `null` for "nothing happened" — the shell handles it.

Return an honest failure rather than nothing when something *did* happen:
`/research` returns `value: 'stopped'` when cancelled, because a silent return
is indistinguishable from a crash.

## Long-lived commands

A command that is still running ten minutes later has to be stoppable from
outside the sentence that started it — otherwise the only way to end it is to
remember the exact words, which is not an interface.

Declare `controls` in frontmatter, export `running()` and `control(action)`, and
the shell renders the controls while `running()` is true. The shell does not
need to know what the command is doing.

Stopping should take effect at a boundary the command chooses. `/goal` stops at
the end of the current round, because killing a round halfway leaves the work
unwritten and the tool calls already done.

## Apps are the same shape

`src/apps/<id>/` with `APP.md` and `app.tsx`. An app exports a `surface`
component instead of a `run`, takes over the page, and publishes its breadcrumb
trail via `setCrumbs`. It registers under `/` — `/present` already opened a
page, so "returns a fact" against "becomes a place" had stopped being a
distinction a sigil could carry.

An app with an empty `needs` opens the moment it is chosen. Putting a text field
between a person and a place they asked for is a doorman.

## Before you add one

Ask whether it should be a command at all. The registry once held ten entries —
the ten grounding sources exposed directly — and that was a category error twice
over: most are not things anyone wants to invoke by name, and having ten made
the list read as a menu of the app's capabilities when it is really a menu of
shortcuts past the model. One survives (`coin price`) because it is the shape a
command should be: one argument, one number back, obviously wrong when it fails,
and genuinely faster to type than to ask for.

Everything else is still reachable — `look` routes over the same `SOURCES`
automatically. Nothing was removed from what the app can do, only from what it
advertises.

## Test

`src/pages/__tests__/sigils.ts` covers registration and matching. Add a case
there if you change the loader. The command's own behaviour is usually verified
by driving the real app — see the MCP tools in the parent skill.
