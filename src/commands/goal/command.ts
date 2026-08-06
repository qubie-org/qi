/**
 * `/goal` — work until a different model says it is done.
 *
 * The loop is the easy half. The hard half is deciding when to stop, and every
 * cheap answer to that is wrong in a way this codebase has already paid for.
 *
 * Asking the working model whether it has finished does not work, and the
 * reason is structural rather than a matter of prompting. It has just spent its
 * context arguing for what it produced; asked immediately afterwards whether
 * that was enough, it is not evaluating the work, it is continuing it. The same
 * failure was measured twice today at smaller scale — a model that emitted a
 * sentence index and then summarised a *different* sentence, and one that
 * judged its own extraction "relevant" for sources that answered nothing. A
 * judgement made in the context that produced the work inherits the work's
 * commitments.
 *
 * A fixed iteration count avoids that by not judging at all, which trades a
 * wrong answer for no answer: three turns is too few for some questions and
 * three too many for most.
 *
 * So the judge is a separate call to the same weights with its own system
 * prompt and none of the working context — it sees the goal and what was
 * produced, and nothing about how hard that was to produce or what was intended
 * next. That is the same move as splitting `extract` into pick-then-summarise,
 * applied one level up: not a better model, a model that cannot see the thing
 * that would mislead it.
 *
 * ── What it costs, and the stop button ──────────────────────────────────────
 *
 * A judge that says "not yet" forever is a loop that runs forever, so there are
 * two brakes. `ROUNDS` is a ceiling, not a target — reaching it is reported as
 * reaching it, never as success. And the command declares a stop control, so
 * the person who started it can end it between rounds without waiting for
 * either the judge or the ceiling.
 *
 * It stops at a round boundary rather than mid-turn on purpose: a half-finished
 * round has written nothing anyone can use, and killing the agent inside a tool
 * call leaves the tool call's side effects behind.
 */
import type { Fact } from '../../ground/sandbox'
import { Agent } from '../../agent/loop'
import { Digest } from '../../agent/digest'
import { buildRouter } from '../../ground'
import { openStore } from '../../store/db'
import { granite } from '../../model/granite'

/** The ceiling. Reaching it is a result to report, not a success. */
const ROUNDS = 6

let running = false
let cancelled = false
let stage = ''

export const isRunning = (): boolean => running
export const status = (): string => stage

export function control(action: string): void {
  if (action === 'stop') cancelled = true
}

export type Verdict = { done: boolean; why: string }

/**
 * A fresh reader, asked one question.
 *
 * No conversation, no tool output, no memory of the rounds before this one —
 * only the goal and the latest work. `done` is emitted before `why` so the
 * verdict is not a rationalisation of a sentence already written; the model
 * conditions on its own tokens, and today that ordering was worth measuring
 * every time it came up.
 *
 * Fails open to "not done". A judge that cannot be reached must not be able to
 * end the work early — the ceiling and the stop button are the brakes, and a
 * broken judge should fall back to them rather than become one.
 */
export async function judge(goal: string, work: string): Promise<Verdict> {
  try {
    const out = await granite.fill<{ done?: boolean; why?: string }>(
      [
        {
          role: 'system',
          content:
            'You decide whether a piece of work satisfies what was asked for. ' +
            'You did not do the work and have no stake in it. Judge only what is in front of you.',
        },
        { role: 'user', content: [`Asked for: ${goal}`, '', 'Produced:', work].join('\n') },
      ],
      {
        type: 'object',
        properties: {
          done: {
            type: 'boolean',
            description: 'True only if what was produced already satisfies what was asked for.',
          },
          why: {
            type: 'string',
            // 300, not 180. At 180 this truncated mid-word on its first real
            // run — "nor does it indicate which of." — because the grammar's
            // only legal move at the ceiling is a full stop. Exactly the
            // failure `research.ts` records for its own claims, reintroduced
            // here by copying the shape of the rule without its measurement.
            // The bound has to sit above what the model actually writes, or it
            // is a truncator rather than a limit.
            pattern: '^[^"]{10,300}[.!?]$',
            description:
              'If it is not done, what is still missing — one sentence, addressed to whoever ' +
              'continues the work.',
          },
        },
        required: ['done', 'why'],
      },
      { maxTokens: 200 },
    )
    const why = (out.why ?? '').trim()
    // A reason that landed exactly on the ceiling was cut off, and a cut-off
    // instruction is worse than none: it becomes the next round's brief.
    return { done: out.done === true, why: why.length >= 301 ? '' : why }
  } catch {
    return { done: false, why: '' }
  }
}

export async function run(argument: string): Promise<Fact | null> {
  const goal = argument.trim()
  if (!goal) return null
  if (running) return { label: 'goal', value: 'already running', src: 'goal', hint: 'a goal is already being worked on' }

  running = true
  cancelled = false
  try {
    const [store] = await Promise.all([openStore()])
    await granite.load().catch(() => {})
    const router = await buildRouter()

    // One digest across all rounds. What round two knows about round one is
    // whatever the working set carries, which is the same mechanism the river
    // uses — rounds are turns, not a separate kind of thing.
    const agent = new Agent(new Digest())

    let round = 0
    let last = ''
    let why = ''
    let pushed = false

    while (round < ROUNDS && !cancelled) {
      round += 1
      stage = `round ${round}`

      // The first round is the goal as written. Later rounds are the goal plus
      // what the judge said was missing — which is why `why` is one sentence
      // addressed to whoever continues, rather than a score.
      const ask = round === 1 ? goal : `${goal}\n\nStill missing: ${why}`
      let steps = 0
      const out = await agent.run(ask, { router, store }, (ev) => {
        if (ev.t === 'step' && ev.state === 'running') steps += 1
      })
      last = out.reply?.trim() || last

      if (cancelled) break
      if (!last) continue

      /**
       * A round that looked nothing up is not trusted, once.
       *
       * The first goal this command was ever given was "compare the population
       * of reykjavik and oslo, and say which is bigger". It took zero steps,
       * answered "Reykjavík is larger than Oslo" — Oslo is five times the size
       * — and the judge passed it in one round.
       *
       * The judge was not wrong to. It sees the goal and the work and has no
       * sources of its own, so it can decide whether an answer is *complete*
       * and never whether it is *true*: a fluent lie is a perfectly shaped
       * answer to the question asked. `adversarial.ts` records the same failure
       * one level down, where a confabulated inventor of the thermos flask
       * scored a pass.
       *
       * So the check is on the work rather than on the answer, and it is
       * counted rather than judged: no tool call means the reply came out of
       * the weights, and this model's weights confabulate confidently.
       *
       * Once, deliberately. Some goals genuinely need no sources — write a
       * haiku, rephrase this — and refusing those forever would be a loop that
       * cannot finish. Being told to check and declining again is treated as
       * "there was nothing to check", which is the honest reading.
       */
      if (steps === 0 && !pushed) {
        pushed = true
        why = 'Nothing was looked up. Check the facts with a source before answering.'
        stage = `round ${round} — unverified`
        continue
      }

      stage = `round ${round} — checking`
      const verdict = await judge(goal, last)
      if (verdict.done) {
        return {
          label: 'goal',
          value: `done in ${round} round${round === 1 ? '' : 's'}${steps === 0 ? ', unverified' : ''}`,
          src: 'goal',
          hint: last.slice(0, 160),
        }
      }
      why = verdict.why
    }

    if (cancelled) {
      return { label: 'goal', value: `stopped after ${round} round${round === 1 ? '' : 's'}`, src: 'goal', hint: last.slice(0, 160) }
    }

    // The ceiling, reported as the ceiling. Saying "done" here would be the one
    // lie this command is in a position to tell.
    return {
      label: 'goal',
      value: `${ROUNDS} rounds, not finished`,
      src: 'goal',
      hint: why ? `still missing: ${why}` : last.slice(0, 160),
    }
  } catch (err) {
    console.warn('goal failed', err)
    return null
  } finally {
    running = false
    stage = ''
  }
}
