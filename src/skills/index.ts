/**
 * Commands and skills, loaded from folders.
 *
 * Both are a directory with a markdown file in it: frontmatter saying what it
 * is, and a body. That shape is borrowed deliberately — it is the one Claude
 * skills use, it is legible to a person editing it in a text editor, and it
 * keeps the interesting part out of TypeScript, where prose would be an
 * awkwardly-escaped string constant nobody wants to edit.
 *
 * What differs is what the body is *for*, and it is the whole distinction
 * between the two namespaces:
 *
 *   a skill's body is its **brief** — instructions loaded into the agent's
 *   context when it is summoned, so the next thing the model says is said by
 *   something that now knows how to do this;
 *
 *   a command's body is its **documentation** — read by a person, never sent
 *   anywhere. A command does not inform the agent, it runs.
 *
 * `dj` moved from the second category to the first during its own construction
 * and the move was correct: its brief was four paragraphs describing four moods
 * to a model whose only job was to pass one word through to `moodFor`. Nothing
 * in it needed a reader. It is a script.
 *
 * A skill is never shown to the model in full. It is shown an *index* — one
 * line per skill, the `when` field — and only the one it names gets its brief
 * loaded. A model handed every brief would spend its context on things it is
 * not doing, which is the cost this design exists to avoid.
 */
import { register, type Command, type Control } from '../pages/sigils'
import type { Fact } from '../ground/sandbox'

type Runner = {
  run?: (argument: string) => Promise<Fact | null>
  perform?: (argument: string) => Promise<Fact | null>
  running?: () => boolean
  control?: (action: string) => void
  status?: () => string
}

/**
 * Frontmatter, without a YAML parser.
 *
 * The fields are all `key: value` on one line, so a hundred kilobytes of YAML
 * parser would buy nothing but the ability to write frontmatter nobody would
 * want to read. Anything needing more structure than this wants to be in the
 * body.
 */
export function frontmatter(text: string): { fields: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text.trim())
  if (!match) return { fields: {}, body: text.trim() }
  const fields: Record<string, string> = {}
  for (const line of match[1].split(/\r?\n/)) {
    const at = line.indexOf(':')
    if (at === -1) continue
    fields[line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }
  return { fields, body: match[2].trim() }
}

/**
 * `controls: ⏹ stop stop the set`
 *
 * Glyph, action, then the rest as the tooltip — positional rather than named,
 * because a control is three short things and `{glyph: "⏹", action: "stop"}`
 * in a one-line frontmatter field is more punctuation than content. Several
 * controls are separated by a comma.
 */
export function parseControls(field: string | undefined): Control[] {
  if (!field) return []
  const out: Control[] = []
  for (const part of field.split(',')) {
    const [glyph, action, ...rest] = part.trim().split(/\s+/)
    if (!glyph || !action) continue
    out.push({ glyph, action, title: rest.join(' ') || action })
  }
  return out
}

/** Read the folder name out of `./dj/COMMAND.md`. */
const folderOf = (path: string): string => path.split('/').slice(-2)[0] ?? path

const common = (path: string, fields: Record<string, string>) => ({
  id: fields.id || folderOf(path),
  name: fields.name || fields.id || folderOf(path),
  needs: fields.needs ?? '',
  gives: fields.gives ?? '',
  tone: Number(fields.tone ?? 0) % 4,
})

/**
 * One command, from its path and text.
 *
 * Returns null without a `run`, because a command that cannot run is not a
 * command: the frontmatter describes it, but the code is the thing.
 */
export function commandFrom(path: string, text: string, code?: Runner): Command | null {
  const { fields } = frontmatter(text)
  const base = common(path, fields)
  if (!base.id || !code?.run) return null
  return {
    sigil: '/',
    ...base,
    run: code.run,
    controls: parseControls(fields.controls),
    running: code.running,
    control: code.control,
  }
}

export type Files = { docs: Record<string, string>; code: Record<string, Runner> }

/**
 * Build both registries from already-discovered files.
 *
 * Takes the file maps rather than finding them, because finding them is
 * `import.meta.glob` and that only exists under Vite — and it only works when
 * called *literally*, with literal arguments, at the top level. Wrapping it in
 * a helper so this file could be imported by the test runner looked fine and
 * silently returned nothing: Vite rewrites the call at build time by reading
 * the source, so a call it cannot see is not a call at all. Discovery is now
 * `discover.ts`, which is Vite-only by design; everything here is pure.
 */
export function loadFrom(commandFiles: Files): { commands: Command[] } {
  const commands: Command[] = []
  for (const [path, text] of Object.entries(commandFiles.docs)) {
    const command = commandFrom(path, text, commandFiles.code[path.replace(/COMMAND\.md$/, 'command.ts')])
    if (command) commands.push(command)
    else console.warn(`command ${path}: no id or no run() — skipped`)
  }

  commands.sort((a, b) => a.name.localeCompare(b.name))
  register(commands)
  return { commands }
}
