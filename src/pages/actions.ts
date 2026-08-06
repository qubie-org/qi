/**
 * Links that do something.
 *
 * TinyOS's useful idea is not that documents link to each other — it is that a
 * node carries a `kind`, and the kind decides what following it means. A `dir`
 * opens, a `proc` ticks. Same shape here: a link to a `page` navigates, a link
 * to an `action` runs, a link to a `skill` shows what it can reach.
 *
 * Actions address as `toki:do/<verb>/<argument>`, so they survive being written
 * into a sentence by the model and are still readable as text. The argument is
 * carried in the address rather than in state, which means a reply from an hour
 * ago is still executable — the link is the whole request.
 */
import type { Table } from '../engine/embed'
import { ground, type Fact, type Router } from '../ground'
import { SOURCES } from '../ground/sources'
import { address, put, slug, type Page } from './space'

export const DO = 'do/'

export type ActionResult =
  | { kind: 'fact'; fact: Fact; query: string }
  | { kind: 'page'; page: Page }
  | { kind: 'miss'; reason: string }

export type ActionContext = {
  table: Table
  router: Router
  needle?: { ready: boolean; call: (q: string, tools: string) => Promise<unknown[]> }
}

/** `do/weather/bend oregon` → { verb, argument } */
export function parseAction(addr: string): { verb: string; argument: string } | null {
  if (!addr.startsWith(DO)) return null
  const rest = addr.slice(DO.length)
  const cut = rest.indexOf('/')
  return cut < 0
    ? { verb: rest.trim(), argument: '' }
    : { verb: rest.slice(0, cut).trim(), argument: decodeURIComponent(rest.slice(cut + 1)).trim() }
}

export const actionAddress = (verb: string, argument = '') =>
  address(argument ? `${DO}${verb}/${encodeURIComponent(argument)}` : `${DO}${verb}`)

/**
 * Run an action.
 *
 * Every verb is a grounded source, so an action is literally "ask this source
 * about this argument" — the same path a question takes, reached by clicking
 * instead of typing. Nothing new can happen through a link that could not
 * happen through the composer, which keeps the surface honest.
 */
export async function runAction(
  addr: string,
  ctx: ActionContext,
): Promise<ActionResult> {
  const parsed = parseAction(addr)
  if (!parsed) return { kind: 'miss', reason: 'not an action' }

  const source = SOURCES.find((s) => s.id === parsed.verb || slug(s.id) === parsed.verb)
  if (!source) return { kind: 'miss', reason: `no skill called ${parsed.verb}` }

  // Phrased back into a question so routing, argument extraction and the
  // sandbox all behave exactly as they do for typed input.
  const query = parsed.argument ? `${source.anchors[0]} ${parsed.argument}` : source.anchors[0]
  const fact = await ground(query, ctx.table, ctx.router, ctx.needle as never).catch(() => null)
  return fact
    ? { kind: 'fact', fact, query }
    : { kind: 'miss', reason: `${source.id} had nothing for that` }
}

/**
 * Register every source as a skill page: what it reaches, and a live action to
 * try it. Generated from the registry, so a new source is a new skill for free.
 */
export function registerSkills(): void {
  for (const source of SOURCES) {
    const id = slug(source.id)
    put({
      id,
      kind: 'skill',
      title: source.id,
      aliases: source.anchors,
      body:
        `reaches ${source.anchors.slice(0, 3).join(', ')}\n` +
        `[run it](${actionAddress(source.id)}) · [all skills](${address('skills')})`,
    })
  }

  put({
    id: 'skills',
    kind: 'page',
    title: 'skills',
    aliases: ['catalogue', 'index', 'directory', 'abilities', 'tools', 'lookup'],
    body: SOURCES.map((s) => `- [${s.id}](${address(slug(s.id))})`).join('\n'),
  })
}
