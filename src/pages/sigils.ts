/**
 * Two sigils, two different kinds of thing.
 *
 * The split is by *what happens when you invoke it*, because that is the only
 * distinction a person actually feels. Anything else — where it is implemented,
 * what language it is written in, whether a model is involved — is invisible at
 * the point of use and therefore the wrong thing to organise a namespace by.
 *
 *   /  command   A script. It runs and returns one fact. The body may be
 *                anything the sandbox can execute; a command is defined by
 *                having an answer, not by being written in a particular
 *                language. Code owns the process; where judgement is needed it
 *                is asked for in small, grammar-constrained pieces.
 *
 *   @  app       A surface. It takes over the page rather than returning
 *                something into it, and while it has the page there is a
 *                breadcrumb back to the conversation.
 *
 * ── There were four, and the two that went are the interesting part ─────────
 *
 * `#` was search: a question about what already exists — a concept, a cluster,
 * a file. It was the odd one out and was defended on that basis, since the
 * other two resolve to an entry in a registry and this one resolved to
 * *results*. That is a real distinction and it was the wrong thing to spend a
 * sigil on. Finding something you already have is what `@` does; splitting
 * "find the app" from "find the note" put the burden of knowing which kind of
 * thing you were looking for onto the person doing the looking, before they had
 * found it. A namespace that asks you to classify your own question is asking
 * for the answer.
 *
 * `$` was a skill: a folder with frontmatter and a brief, loaded into the
 * agent's context when summoned, either because a person named it or because
 * the model read its one-line `when` and decided it applied. That is exactly
 * how Claude skills work and it is a good design — for a model that can be
 * handed prose and trusted to act on it.
 *
 * This app runs a 3B model, and everything measured about it says the opposite.
 * Asked to reason about an ambiguous topic it invented "the Mamba video game
 * engine". Shown examples it copied them verbatim instead of using them. Asked
 * to hold a sentence index for three tokens and then summarise it, it
 * summarised a different sentence. Every fix that worked took latitude away —
 * a grammar it cannot violate, a filter over what it produced, one call split
 * into two smaller ones. A brief saying "write a deck" is latitude, and it
 * would fail in precisely the ways already paid for.
 *
 * The mechanism was complete and wired into the agent loop, and in the whole
 * life of the codebase it held zero skills. Deleting an abstraction that never
 * acquired an instance is not a loss of capability; it is the removal of a
 * thing that had to be explained.
 *
 * One file, because the whole value is that these cannot drift: a single
 * `Entry` shape means one picker draws all of them, and a single `SIGILS` table
 * means the parser, the composer and the renderer agree about what a leading
 * character means.
 */
import { reduce, type Fact } from '../ground/sandbox'
import { SOURCES } from '../ground/sources'

export type Sigil = '/' | '@'

/**
 * What every invocable thing has, whatever its sigil.
 *
 * Enough for the picker to draw it and for the composer to become it, and
 * nothing about how it runs — that differs, and lives on the specific types.
 */
type Entry = {
  id: string
  /** What it is called, in the picker and in the composer's mode chip. */
  name: string
  /**
   * What the composer asks for while this has it, phrased as a question to a
   * person rather than as a parameter name — it replaces "say something", so it
   * is read as speech. Empty means it takes no argument and runs on choice.
   */
  needs: string
  /** What comes back, in three or four words. Shown under the name. */
  gives: string
  /** Which of the four tones it draws in, so the picker reads as a palette. */
  tone: number
}

/**
 * One control a long-lived command offers.
 *
 * A glyph and a verb. The glyph is what appears in the chrome — there is very
 * little room next to the status line and a word would not fit — and the verb
 * is what gets dispatched, so the two never have to agree about spelling.
 */
export type Control = { glyph: string; action: string; title: string }

/**
 * `/` — runs a script.
 *
 * Most commands are over the moment they return: one argument in, one fact out.
 * Some are not. A set that plays underneath the conversation is still running
 * ten minutes later, and something that keeps running has to be stoppable from
 * outside the sentence that started it — otherwise the only way to end it is to
 * remember the exact words, which is not an interface.
 *
 * So a command may declare `controls`, and the chrome renders them while
 * `running()` says yes. That is the whole mechanism: a command is long-lived if
 * it says it is, and the shell does not need to know what it is doing.
 */
export type Command = Entry & {
  sigil: '/'
  run: (argument: string) => Promise<Fact | null>
  /** Declared in frontmatter. Empty for a command that simply returns. */
  controls?: Control[]
  /** Whether it is running right now. Absent means it never is. */
  running?: () => boolean
  /** Act on a running command — the `action` of one of its controls. */
  control?: (action: string) => void
}

/**
 * `@` — takes over the page.
 *
 * `enter` returns nothing on purpose: an app is not a function producing a
 * value into the river, it is a place the page becomes. What it returns to is
 * the breadcrumb, which the shell owns.
 *
 * `surface` is the page it becomes. It has to live on the entry rather than in
 * a table the shell keeps, because a second registry keyed by the same ids is a
 * second thing to fall out of step with this one — the failure this file exists
 * to prevent. Typed loosely on purpose: `sigils.ts` is imported by the parser,
 * the composer and the renderer, and none of them should acquire an opinion
 * about React because one of the four namespaces draws itself. `apps/index.ts`
 * has the precise type and is the only thing that constructs one.
 */
export type App = Entry & {
  sigil: '/'
  enter: (argument: string) => void
  surface: unknown
  /**
   * The command that makes one of these, by id.
   *
   * A place you can open is nearly always a place you can add to, and the two
   * are different acts: `/deck` on its own is ambiguous between "show me my
   * decks" and "make me a deck". Naming the maker here is what lets the picker
   * ask which, and lets `create` route into the command that already does it
   * rather than growing a second path to the same result.
   *
   * Declared in frontmatter as `makes:`. Absent means this place has nothing
   * that makes one, and the picker offers no `create`.
   */
  makes?: string
}

/**
 * `@` — something you already have.
 *
 * Not a registry. Every other namespace resolves a name to an entry someone
 * declared; this one resolves what has been typed to *results*, computed from
 * the store when the picker asks. That is why there is no `FINDS` array below
 * and no `register` call that fills one — a list of "everything you have ever
 * written" is not a list anyone picks from, it is a query.
 *
 * `open` rather than `run`: finding a note is not an act with a result, it is a
 * way of getting to the note. What it does is enter the app that owns the
 * thing, with the thing's id.
 */
export type Find = Entry & {
  sigil: '@'
  open: () => void
}

export type Invocable = Command | App | Find

/** True when choosing it runs it immediately, with nothing left to type. */
export const immediate = (entry: Invocable): boolean => !entry.needs

// ── the registries ──────────────────────────────────────────────────────────

/**
 * Commands, and the apps that live alongside them.
 *
 * One array, because `register` routes by sigil and an app's sigil is `/`.
 * There was a separate `APPS` for a while after the merge and it was never
 * filled again — a second array that nothing writes to is a place for a stale
 * answer to hide. Apps are found by shape: `entries.filter((e) => 'surface' in e)`.
 *
 * One. The ten that used to be here were the ten grounding sources exposed
 * directly, which was a category error twice over: most are not things anyone
 * wants to invoke by name, and having ten made the list read as a menu of the
 * app's capabilities when it is really a menu of shortcuts past the model.
 *
 * A coin price survives because it is the shape a command should be: one
 * argument, one number back, obviously wrong when it fails, and genuinely
 * faster to type than to ask for. The others are still reachable — they are the
 * same `SOURCES` the agent's `look` verb routes over automatically, so nothing
 * was removed from what the app can do, only from what it advertises.
 */
export const COMMANDS: Command[] = [
  {
    sigil: '/',
    id: 'crypto',
    name: 'coin price',
    needs: 'which coin?',
    gives: 'the current price',
    tone: 0,
    run: (argument) => runSource('crypto', argument),
  },
]

/**
 * The two namespaces.
 *
 * `/` holds both commands and apps, which used to be `/` and `@` and are now
 * one thing for one reason: a command already took over the page. `/present`
 * writes a deck and opens it, so "returns a fact" against "becomes a place" had
 * already stopped being a distinction the sigil could carry. Both are things
 * you invoke by name and both are chosen the same way; what differs is what
 * happens next, and that is legible from the entry itself rather than from the
 * character in front of it.
 *
 * `@` has no entries and never will. It is a query.
 */
export const SIGILS: Record<Sigil, { kind: string; entries: Invocable[] }> = {
  '/': { kind: 'command', entries: COMMANDS as Invocable[] },
  '@': { kind: 'find', entries: [] },
}

export const isSigil = (c: string): c is Sigil => c === '/' || c === '@'

/**
 * Register entries discovered at load time.
 *
 * Commands come from a folder rather than from this file, so the arrays above
 * start empty and are filled once. Mutating the exported array rather than
 * reassigning it matters: `SIGILS` holds a reference to it, and so does every
 * module that imported it.
 */
export function register(entries: Invocable[]): void {
  for (const entry of entries) {
    const into = SIGILS[entry.sigil].entries
    if (!into.some((e) => e.id === entry.id)) into.push(entry)
  }
}

// ── lookup ──────────────────────────────────────────────────────────────────

/**
 * Match what has been typed after a sigil.
 *
 * Prefix on the name first, then anywhere in it — so "co" reaches `coin price`
 * before anything that merely contains those letters.
 */
export function match(sigil: Sigil, query: string): Invocable[] {
  const all = SIGILS[sigil].entries
  const q = query.trim().toLowerCase()
  if (!q) return all
  const starts = all.filter((e) => e.name.toLowerCase().startsWith(q))
  const rest = all.filter(
    (e) => !starts.includes(e) && (e.name.toLowerCase().includes(q) || e.id.includes(q)),
  )
  return [...starts, ...rest]
}

/** Find one by id or name, across every namespace. */
export function find(id: string): Invocable | undefined {
  for (const { entries } of Object.values(SIGILS)) {
    const hit = entries.find((e) => e.id === id || e.name === id)
    if (hit) return hit
  }
  return undefined
}

/**
 * Run a source with exactly what was typed.
 *
 * The whole point of a command: the source is called with the argument as
 * given, so nothing has to guess which source was meant or extract an argument
 * from a sentence. The sandbox still reduces the response — a command is a
 * shortcut past the model, never past the guard rail.
 */
async function runSource(id: string, argument: string): Promise<Fact | null> {
  const source = SOURCES.find((s) => s.id === id)
  if (!source) return null
  try {
    const payload = await source.fetch(argument.trim())
    return await reduce(source.reducer, payload)
  } catch (err) {
    console.warn(`command ${id} failed`, err)
    return null
  }
}
