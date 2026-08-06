/**
 * What the agent can do out of the box, and what doing it means.
 *
 * Three verbs, deliberately. A small model's tool selection degrades sharply
 * past about five options — it starts picking the one whose description shares
 * the most words with the question rather than the one that would answer it —
 * and every verb here already exists as a concept in the page space, so the
 * agent is choosing between things the rest of qi can already render:
 *
 *   look    find something out in the world   → grounding, the ten sources
 *   recall  find something out from memory    → the store, by embedding
 *   open    go to a page already known        → the qi: address space
 *
 * There used to be a fourth, `do`, which ran a named source. It is gone: a
 * person reaches those directly through the composer now (see pages/sigils.ts),
 * and `look` already reaches all of them automatically. Two ways in was one
 * concept too many, and it cost a slot on a model whose tool selection degrades
 * past about five options.
 *
 * Packs add more. `see` arrives with the vision pack, `read` with the document
 * parser, `forecast` with the timeseries one — and the loop offers whatever is
 * bound rather than a fixed list, which is the entire reason the four above are
 * expressed in the same shape a pack uses. There is no privileged core verb;
 * these are just the ones that need no weights beyond the model itself.
 *
 * Nothing here returns raw text to the model. Every executor returns a string
 * that the summariser compresses before it reaches the agent's context, so the
 * agent reasons over one-line results and never over a response body. That
 * separation is the whole reason a small model can run several steps without
 * losing the thread.
 */
import { factContext, ground, type Fact, type Router } from '../ground'
import type { Verb } from '../model/packs'
import { embed } from '../model/vectors'
import { pageFromFact } from '../pages/build'
import { address, all, resolve } from '../pages/space'
import type { Store } from '../store/db'

export type ToolContext = {
  router: Router
  store: Store
  /** Set by the loop when a step produces a citable fact. */
  facts?: Fact[]
}

/** The argument a badge shows, and the string the summariser is given as fallback. */
export function subject(name: string, args: Record<string, unknown>): string {
  return String(args.query ?? args.name ?? args.question ?? '')
}

const ctxOf = (ctx: unknown) => ctx as ToolContext

/**
 * Descriptions are written for a small model: what the verb is for, and when
 * *not* to use it. The second half is what stops a four-tool agent calling
 * `look` for everything.
 */
export const CORE_VERBS: Verb[] = [
  {
    verb: 'looking up',
    declaration: {
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
    async run(args, raw) {
      const ctx = ctxOf(raw)
      const query = String(args.query ?? '').trim()
      if (!query) return { work: 'no query given', empty: true }
      const fact = await ground(query, ctx.router).catch(() => null)
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
        await embed(`${query} ${fact.label}`),
      )
      ctx.facts?.push(fact)
      return `Looked up "${query}". ${factContext(fact)}`
    },
  },
  {
    verb: 'remembering',
    declaration: {
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
    async run(args, raw) {
      const ctx = ctxOf(raw)
      const query = String(args.query ?? '').trim()
      const hits = ctx.store.recall(await embed(query), 3)
      if (!hits.length) return { work: `Nothing remembered about "${query}".`, empty: true }
      return `Remembered about "${query}": ${hits.map((h) => h.text).join('; ')}.`
    },
  },
  {
    verb: 'opening',
    declaration: {
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
    async run(args) {
      const name = String(args.name ?? '').trim()
      // Exact only. No soft match, at any threshold.
      //
      // `resolve` will happily land near a name, which is right for following a
      // link — a person clicking "the apollo mission" means the page about it.
      // An agent naming a page is the opposite case: it invents names it has
      // never been told exist. "red lighthouse photo" soft-matched the page
      // *describing the image source*, the model read it, learned that qi has
      // an image search, and concluded from that page that it could not provide
      // an image. A confident wrong answer assembled entirely out of a near
      // miss, and raising the threshold only moves which names do it.
      //
      // Telling it the page does not exist costs nothing, because the list of
      // real ones goes back with the refusal.
      const hit = (await resolve(address(name), 1.1)) ?? (await resolve(name, 1.1))
      if (!hit) {
        // Naming what does exist turns a dead end into a usable next step, which
        // is the difference between an agent that recovers and one that repeats
        // the same failing call until the depth cap stops it.
        const near = all()
          .slice(0, 6)
          .map((p) => p.title)
          .join(', ')
        return {
          work: `No page called "${name}". Pages that exist: ${near || 'none yet'}.`,
          empty: true,
        }
      }
      return `Opened "${hit.page.title}". ${hit.page.body}`
    },
  },
]
