/**
 * Questions that cannot be answered in one fetch.
 *
 * `spread.ts` asks whether the grounding layer covers the *shapes* people ask
 * in, and it does that by calling `ground()` — one question, one route, one
 * answer. That is the right test for routing and the wrong test for the app,
 * because `ground()` is not what answers a question. The agent is, and the
 * agent can take up to four moves.
 *
 * Nothing has ever tested the moves. Every eval in this repo hands the system a
 * question one lookup could satisfy, which means the entire reason the agent
 * loop exists — that it can look something up, read the answer, and use it to
 * decide what to look up next — has never been measured. A model that silently
 * stopped chaining would pass every existing suite.
 *
 * So these are questions with a join in them. Each needs at least two facts and
 * a step where the second lookup depends on the first:
 *
 *   "the capital of iceland" → "the population of Reykjavík"
 *   "where is the ISS"       → "the weather at that latitude"
 *   "how much is a bitcoin"  → "…in euros"
 *
 * ── What is checked, and what deliberately is not ───────────────────────────
 *
 * Not the wording. A small model will phrase the same correct answer twenty
 * ways and asserting on prose would test the phrasing rather than the work. So
 * each case carries `wants`: a fragment that has to appear somewhere in the
 * reply — a name, a unit, a digit — plus how many steps it should have taken.
 *
 * The step count is the interesting column. An answer that arrives in one step
 * to a two-step question was either already known to the model, which is a
 * different thing from being grounded, or it is wrong.
 *
 * ── Run it in the app, not here ─────────────────────────────────────────────
 *
 * The reducers run in QuickJS inside Wasmer, which cannot reach its registry
 * under bun — so every hand-written source returns nothing and this measures a
 * crippled system. `run()` is exported so the real app can drive it through the
 * control server:
 *
 *   curl -s -X POST http://127.0.0.1:8777/eval --data \
 *     'const m = await import("/src/ground/__tests__/multistep.ts"); return m.run()'
 */
import { Agent } from '../../agent/loop'
import { Digest } from '../../agent/digest'
import { buildRouter } from '../index'
import { openStore } from '../../store/db'
import { granite } from '../../model/granite'

export type Case = {
  q: string
  /** Why this needs more than one move. */
  because: string
  /** Fragments the reply should contain — any one of them counts. */
  wants: string[]
  /** Moves it ought to take. */
  steps: number
}

export const CASES: Case[] = [
  {
    q: 'what is the population of the capital of iceland',
    because: 'the capital has to be resolved before it can be counted',
    wants: ['13', '14', 'reykjav'],
    steps: 2,
  },
  {
    q: 'is it colder in oslo or reykjavik right now',
    because: 'two readings, then a comparison between them',
    wants: ['oslo', 'reykjav'],
    steps: 2,
  },
  {
    q: 'how much is a bitcoin worth in euros',
    because: 'a price in dollars and a rate to convert it',
    wants: ['€', 'eur'],
    steps: 2,
  },
  {
    q: 'who invented the thermos flask and what year was it',
    because: 'one entity, then a date about that entity',
    wants: ['dewar', '18'],
    steps: 1,
  },
  {
    q: 'which is further north, oslo or reykjavik',
    because: 'two coordinates and a comparison',
    wants: ['reykjav', 'oslo'],
    steps: 2,
  },
  {
    q: 'how many hacker news posts mention rust and is that more than a thousand',
    because: 'a count, then a judgement about the count',
    wants: ['yes', 'more', '000'],
    steps: 1,
  },
  {
    q: 'show me a photo of the capital of iceland',
    because: 'resolve the place, then find a picture of it',
    wants: ['reykjav', 'photo', 'picture'],
    steps: 2,
  },
  {
    q: 'what is the weather where the international space station is right now',
    because: 'a position, then a reading at that position',
    wants: ['°', 'degree', 'ocean', 'sea'],
    steps: 2,
  },
]

export type Result = {
  q: string
  steps: number
  verbs: string[]
  reply: string
  hit: boolean
  ms: number
}

export async function run(): Promise<{ results: Result[]; summary: Record<string, string> }> {
  const [store] = await Promise.all([openStore()])
  await granite.load().catch(() => {})
  const router = await buildRouter()
  const agent = new Agent(new Digest())

  const results: Result[] = []
  for (const c of CASES) {
    const verbs: string[] = []
    const started = performance.now()
    let reply = ''
    try {
      const out = await agent.run(c.q, { router, store }, (ev) => {
        if (ev.t === 'step' && ev.state === 'running') verbs.push(ev.kind)
      })
      reply = out.reply
    } catch (err) {
      reply = `threw: ${String(err).slice(0, 80)}`
    }
    const low = reply.toLowerCase()
    results.push({
      q: c.q,
      steps: verbs.length,
      verbs,
      reply: reply.slice(0, 110),
      hit: c.wants.some((w) => low.includes(w.toLowerCase())),
      ms: Math.round(performance.now() - started),
    })
  }

  const hits = results.filter((r) => r.hit).length
  const chained = results.filter((r, i) => r.steps >= CASES[i].steps).length
  const never = results.filter((r) => r.steps === 0).length

  return {
    results,
    summary: {
      answeredWithWhatWasWanted: `${hits}/${results.length}`,
      tookEnoughSteps: `${chained}/${results.length}`,
      tookNoStepsAtAll: `${never}/${results.length}`,
    },
  }
}
