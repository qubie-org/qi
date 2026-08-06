/**
 * What the agent can do, and what doing it means.
 *
 * Four verbs, deliberately. A 4B model's tool selection degrades sharply past
 * about five options — it starts picking the one whose description shares the
 * most words with the question rather than the one that would answer it — and
 * every verb here already exists as a concept in the page space, so the agent
 * is choosing between things the rest of toki can already render:
 *
 *   look    find something out in the world   → grounding, the ten sources
 *   recall  find something out from memory    → the store, by embedding
 *   open    go to a page already known        → the toki: address space
 *   do      run a registered skill            → toki:do/<verb>/<argument>
 *
 * Nothing here returns raw text to the model. Every executor returns a string
 * that the summariser compresses before it reaches the agent's context, so the
 * agent reasons over one-line results and never over a response body. That
 * separation is the whole reason a small model can run several steps without
 * losing the thread.
 */
import type { Table } from '../engine/embed'
import { embed } from '../engine/embed'
import { factContext, ground, type Fact, type Router } from '../ground'
import { pageFromFact } from '../pages/build'
import { actionAddress, parseAction, runAction } from '../pages/actions'
import { address, all, resolve } from '../pages/space'
import type { Store } from '../store/db'

export type ToolContext = {
  table: Table
  router: Router
  store: Store
  /**
   * Typed from what `ground` expects rather than from ActionContext: the two
   * differ only in how tightly the returned tool calls are described, and
   * ground's is the stricter of the pair, so it is the one that has to hold.
   */
  needle: Parameters<typeof ground>[3]
}

/** What an executor gives back: prose for the summariser, plus anything visual. */
export type ToolResult = {
  /** Raw-ish text, headed for the summariser and never straight to the agent. */
  work: string
  /** Set when the step produced a citable fact, so the reply can attribute it. */
  fact?: Fact
  /** True when the step found nothing; the agent is told plainly rather than fudged. */
  empty?: boolean
}

/**
 * OpenAI-shaped declarations, handed to llama-server which folds them into A1's
 * own chat template. Descriptions are written for a small model: what it is
 * for, and when *not* to use it, since the second is what stops a four-tool
 * agent calling `look` for everything.
 */
export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'look',
      description:
        'Find a current fact in the world: weather, prices, populations, definitions, pictures. ' +
        'Use for anything you do not already know or were not just told. Do not use to repeat something already in the context.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'What to find out, in a few words.' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'recall',
      description:
        'Search what this conversation has already established. Use when the question refers to something said earlier, ' +
        'or before looking something up a second time.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'What to remember, in a few words.' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open',
      description: 'Open a page that already exists by name, and read it.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'The page name.' } },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'do',
      description: 'Run a skill. Only use a verb listed as available in the context.',
      parameters: {
        type: 'object',
        properties: {
          verb: { type: 'string', description: 'The skill to run.' },
          argument: { type: 'string', description: 'What to run it on. May be empty.' },
        },
        required: ['verb'],
      },
    },
  },
] as const

export type ToolName = 'look' | 'recall' | 'open' | 'do'

/** The word shown on the badge while a step runs, before the summariser names it. */
export const VERB: Record<ToolName, string> = {
  look: 'looking up',
  recall: 'remembering',
  open: 'opening',
  do: 'running',
}

/** The argument a badge shows, and the string the summariser is given as fallback. */
export function subject(name: ToolName, args: Record<string, unknown>): string {
  if (name === 'do') return [args.verb, args.argument].filter(Boolean).join(' ')
  return String(args.query ?? args.name ?? '')
}

export async function execute(
  name: ToolName,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  switch (name) {
    case 'look': {
      const query = String(args.query ?? '').trim()
      if (!query) return { work: 'no query given', empty: true }
      const fact = await ground(query, ctx.table, ctx.router, ctx.needle).catch(() => null)
      if (!fact) return { work: `Looked up "${query}" and found nothing.`, empty: true }

      // A fact found is a fact kept: it becomes an addressable page and a row
      // in the store, so the next turn can `recall` or `open` it instead of
      // asking a stranger's endpoint the same question again.
      pageFromFact(fact, query)
      ctx.store.putFact(
        {
          key: query.toLowerCase(),
          label: fact.label,
          value: fact.value,
          unit: fact.unit,
          src: fact.src,
          url: fact.srcUrl,
        },
        embed(ctx.table, `${query} ${fact.label}`),
      )
      return { work: `Looked up "${query}". ${factContext(fact)}`, fact }
    }

    case 'recall': {
      const query = String(args.query ?? '').trim()
      const hits = ctx.store.recall(embed(ctx.table, query), 3)
      if (!hits.length) return { work: `Nothing remembered about "${query}".`, empty: true }
      return { work: `Remembered about "${query}": ${hits.map((h) => h.text).join('; ')}.` }
    }

    case 'open': {
      const name_ = String(args.name ?? '').trim()
      const hit = resolve(address(name_), ctx.table) ?? resolve(name_, ctx.table)
      if (!hit) {
        // Naming what does exist turns a dead end into a usable next step, which
        // is the difference between an agent that recovers and one that repeats
        // the same failing call until the depth cap stops it.
        const near = all()
          .slice(0, 6)
          .map((p) => p.title)
          .join(', ')
        return { work: `No page called "${name_}". Pages that exist: ${near || 'none yet'}.`, empty: true }
      }
      return { work: `Opened "${hit.page.title}". ${hit.page.body}` }
    }

    case 'do': {
      const verb = String(args.verb ?? '').trim()
      const argument = String(args.argument ?? '').trim()
      const addr = actionAddress(verb, argument)
      if (!parseAction(addr)) return { work: `"${verb}" is not a skill.`, empty: true }
      const result = await runAction(addr, {
        table: ctx.table,
        router: ctx.router,
        needle: ctx.needle as never,
      })
      if (result.kind === 'fact') {
        return { work: `Ran ${verb} on "${argument}". ${factContext(result.fact)}`, fact: result.fact }
      }
      if (result.kind === 'page') return { work: `Ran ${verb}. ${result.page.body}` }
      return { work: `Ran ${verb}: ${result.reason}`, empty: true }
    }
  }
}
