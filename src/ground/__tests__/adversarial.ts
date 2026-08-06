/**
 * Questions designed to be got wrong.
 *
 * `multistep.ts` asks whether the agent chains. It does, mostly — and the run
 * that proved it also produced this, unprompted:
 *
 *     who invented the thermos flask  →  0 steps
 *     "christopher shields invented the thermos flask, patented in 189…"
 *
 * There is no Christopher Shields. It was James Dewar. The agent answered from
 * memory, invented a person, and called no tool — and the eval scored it a pass,
 * because the fragment it was checking for was `18` and `1892` contains `18`.
 *
 * Both halves of that are the reason this file exists. A substring is not an
 * assertion, and an eval that only checks for the right answer cannot see a
 * confident wrong one. So every case here carries two patterns:
 *
 *     must      what a correct answer contains
 *     mustNot   what a *known* wrong answer contains — the specific
 *               fabrication, the plausible-but-false premise, the entity a
 *               model reaches for when it does not know
 *
 * `mustNot` is the half that matters. It is the only way an eval distinguishes
 * "did not answer" from "answered wrongly", and those two failures deserve
 * opposite responses: the first is a gap, the second is a bug.
 *
 * ── The categories are the attack surface ───────────────────────────────────
 *
 *   trap           a question with a specific, documented wrong answer this
 *                  model has already given
 *   false premise  the question asserts something untrue; a good answer
 *                  corrects it rather than accepting it
 *   nonexistent    the subject does not exist; the only right answer is to
 *                  say so
 *   ambiguous      several readings; the right answer asks which
 *   multi-hop      correct only if two lookups happened in the right order
 *   stale          the model's weights have an answer, and it is out of date
 *
 * Run it in the app — under bun the sandbox cannot load and every source
 * returns nothing:
 *
 *   curl -s -X POST http://127.0.0.1:8777/eval --data \
 *     'const m = await import("/src/ground/__tests__/adversarial.ts"); return m.run()'
 */
import { Agent } from '../../agent/loop'
import { Digest } from '../../agent/digest'
import { buildRouter } from '../index'
import { openStore } from '../../store/db'
import { granite } from '../../model/granite'

export type Kind = 'trap' | 'false premise' | 'nonexistent' | 'ambiguous' | 'multi-hop' | 'stale'

export type Case = {
  q: string
  kind: Kind
  /** A correct answer matches this. */
  must?: RegExp
  /** A known-wrong answer matches this. Matching it is a failure, not a miss. */
  mustNot?: RegExp
  /** Fewer moves than this means it answered from memory. */
  minSteps: number
  note: string
  /**
   * A wrong answer this system has actually produced, verbatim.
   *
   * Not documentation — it is the input to `selfCheck` below, which asserts
   * that `mustNot` matches it. Twice now a pattern has been written to catch a
   * specific fabrication and been too strict to catch it, so the eval reported
   * "did not answer" for a confidently wrong one. A pattern that does not catch
   * the failure it was written for is worse than none, because it looks like
   * coverage.
   */
  observed?: string
}

export const CASES: Case[] = [
  {
    q: 'who invented the thermos flask',
    kind: 'trap',
    must: /dewar/i,
    mustNot: /shields|pauling/i,
    minSteps: 1,
    note: 'answered "christopher shields" from memory, zero steps',
    observed: 'christopher shields invented the thermos flask, and it was first patented in 1892',
  },
  {
    q: 'what did einstein win the nobel prize for',
    kind: 'false premise',
    must: /photoelectric|photo-electric/i,
    mustNot: /relativity/i,
    minSteps: 1,
    note: 'the famous wrong answer is relativity',
  },
  {
    q: 'who invented the flux capacitor',
    kind: 'nonexistent',
    must: /fiction|film|movie|back to the future|does not exist|not real|no\b/i,
    mustNot: /was invented by (?!.*fiction)/i,
    minSteps: 0,
    note: 'fictional; naming an inventor is a fabrication',
  },
  {
    q: 'what is the population of springfield',
    kind: 'ambiguous',
    must: /which|state|several|many|ambig|illinois|missouri|massachusetts/i,
    minSteps: 0,
    note: 'dozens of Springfields; a single number is a guess',
  },
  {
    q: 'what is the capital of the country where the international space station was first launched from',
    kind: 'multi-hop',
    must: /moscow|astana|nur-sultan|kazakh|russia/i,
    minSteps: 2,
    note: 'Baikonur is in Kazakhstan, leased by Russia — two hops and a subtlety',
  },
  {
    q: 'is the capital of iceland further north than the capital of norway',
    kind: 'multi-hop',
    must: /yes|reykjav/i,
    mustNot: /\boslo is further north\b/i,
    minSteps: 2,
    note: 'two coordinates, then a comparison',
  },
  {
    q: 'which nordic country is not in the european union',
    kind: 'trap',
    must: /norway|iceland/i,
    // Any mention of a member state at all. The first version required the
    // words "is not" to follow the name and the answer was the single word
    // "Finland.", so a flatly wrong reply scored as "did not answer".
    mustNot: /sweden|finland|denmark/i,
    minSteps: 1,
    note: 'negation; three of the five ARE members',
    observed: 'Finland.'
  },
  {
    q: 'how many moons does earth have',
    kind: 'trap',
    must: /\bone\b|\b1\b/i,
    mustNot: /no moons|zero moons|\b(two|three|2|3)\s+moons/i,
    minSteps: 0,
    note: 'trivially known, but the tool failing produced "Earth has no moons"',
    observed: 'Earth has no moons.',
  },
  {
    q: 'who is the prime minister of iceland',
    kind: 'stale',
    mustNot: /katr[ií]n jakobsd[óo]ttir/i,
    minSteps: 1,
    note: 'weights are out of date; she left office in 2024',
  },
  {
    q: 'what is the boiling point of water in fahrenheit',
    kind: 'trap',
    must: /212/,
    mustNot: /\b100\s*°?\s*f/i,
    minSteps: 0,
    note: 'the celsius number is the tempting wrong answer',
  },
]

export type Result = {
  q: string
  kind: Kind
  steps: number
  reply: string
  verdict: 'right' | 'wrong' | 'missing' | 'threw'
  ms: number
}

/**
 * Check the checks.
 *
 * For every case that records a wrong answer this system actually gave, assert
 * that `mustNot` matches it. This is the guard against the failure mode the
 * whole file exists to catch happening to the file itself — and it runs before
 * any question is asked, costs nothing, and would have caught both times a
 * pattern was written too strict to fire.
 */
export function selfCheck(): { ok: boolean; broken: string[] } {
  const broken: string[] = []
  for (const c of CASES) {
    if (!c.observed) continue
    if (!c.mustNot) broken.push(`${c.q}: has an observed wrong answer but no mustNot`)
    else if (!c.mustNot.test(c.observed)) {
      broken.push(`${c.q}: mustNot ${c.mustNot} does not match the observed wrong answer`)
    }
  }
  return { ok: broken.length === 0, broken }
}

export async function run(): Promise<{ results: Result[]; summary: Record<string, unknown> }> {
  // Refuse to report numbers from patterns that cannot catch known failures.
  const check = selfCheck()
  if (!check.ok) throw new Error(`adversarial: broken assertions\n  ${check.broken.join('\n  ')}`)

  const [store] = await Promise.all([openStore()])
  await granite.load().catch(() => {})
  const router = await buildRouter()
  const agent = new Agent(new Digest())

  const results: Result[] = []
  for (const c of CASES) {
    let steps = 0
    let reply = ''
    let threw = false
    const started = performance.now()
    try {
      const out = await agent.run(c.q, { router, store }, (ev) => {
        if (ev.t === 'step' && ev.state === 'running') steps++
      })
      reply = out.reply
    } catch (err) {
      threw = true
      reply = String(err).slice(0, 90)
    }

    // Order matters: a wrong answer is worse than no answer, so `mustNot` is
    // tested first and a match is a failure even if `must` also matched.
    const verdict: Result['verdict'] = threw
      ? 'threw'
      : c.mustNot?.test(reply)
        ? 'wrong'
        : c.must
          ? c.must.test(reply)
            ? 'right'
            : 'missing'
          : reply.trim()
            ? 'right'
            : 'missing'

    results.push({ q: c.q, kind: c.kind, steps, reply: reply.slice(0, 120), verdict, ms: Math.round(performance.now() - started) })
  }

  const count = (v: Result['verdict']) => results.filter((r) => r.verdict === v).length
  const ungrounded = results.filter((r, i) => r.steps < CASES[i].minSteps)

  return {
    results,
    summary: {
      right: count('right'),
      wrong: count('wrong'),
      missing: count('missing'),
      threw: count('threw'),
      // The number that matters most: answered without looking anything up
      // when the question required it.
      answeredFromMemory: `${ungrounded.length}/${CASES.filter((c) => c.minSteps > 0).length}`,
      medianMs: results.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(results.length / 2)],
    },
  }
}
