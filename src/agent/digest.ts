/**
 * The compressor.
 *
 * Two problems share one answer. Tool results are large — a weather payload is
 * a quarter of a megabyte before the sandbox reduces it, and a page body is
 * still a paragraph after — and putting them into the agent's context is what
 * makes a small model lose the thread. Separately, the step badges need a human
 * label for work that is described in the code only as `look('reykjavik
 * weather')`.
 *
 * This used to be a second model: an 800M summariser on its own port, with its
 * own ChatML template and its own quirks. It is gone. What it was actually
 * providing was a guaranteed shape, and the shape comes from the grammar, not
 * from the weights — llama.cpp compiles a JSON schema to GBNF and constrains
 * sampling with it, so the core model cannot emit a malformed note however
 * small a slice of its attention this task gets.
 *
 * Four fields, one call:
 *
 *   title      two or three words          → the badge caption
 *   sub_title  one line, what it did       → the badge's detail on hover
 *   summary    past tense, what happened   → what enters the agent's context
 *   cur_task   present tense, what it is doing now → the live status line
 *
 * That last field is why this model rather than a prompt on the big one. The
 * agent is being asked to *continue* a conversation, and `cur_task` is a
 * first-person statement of where it is up to — written by a model whose whole
 * training set is that sentence. It costs 800M parameters and ~75 tok/s to have
 * a running narration that is grounded in what actually happened, instead of a
 * spinner.
 *
 * Three details are load-bearing, each found the hard way:
 *
 *  - It must be given its ChatML template. Prompted raw it free-associates —
 *    asked to summarise a 4.3 C reading it reported 20 C.
 *  - The JSON is enforced by llama.cpp's `json_schema` rather than requested in
 *    the prompt, so a malformed reply is impossible rather than merely unlikely.
 *  - The schema carries no `maxLength`. The grammar enforces those as a hard
 *    character stop, which severs the last word mid-token; lengths are trimmed
 *    here instead.
 */

import { granite } from '../model/granite'

/**
 * The second clause is the load-bearing one: a summariser that invents a number
 * is worse than no summariser, because its output is trusted downstream as
 * fact — it is the only thing about a step that reaches the agent's context.
 */
/**
 * Written as a job description, not as an instruction to follow.
 *
 * The previous version opened "Summarise the work below…" and the model
 * summarised *the instruction*: the badge came back titled "Summarisation" and
 * cur_task read "I write the summary in the past tense and present tense
 * respectively." Grammar-constrained, correctly shaped, and about nothing.
 *
 * Two changes fixed it, and both were needed. Telling it what it *is* ("you
 * label work that has already happened") rather than what to do, and marking
 * the input as a result rather than letting it arrive as a bare user turn —
 * without the marker the model still drifted into describing the photograph
 * instead of the step.
 */
const SYSTEM = [
  'You label work that has already happened. Never restate these instructions.',
  'title: two or three words naming the thing found.',
  'sub_title: one short line about it.',
  'summary: one past-tense sentence of what happened.',
  'cur_task: first person present, what is being done now.',
  'English only. Never state a number that is not in the input.',
].join(' ')

/** Words that only appear when the model has described the brief, not the work. */
const ECHOED = /^(summar|label|instruct|i (write|am to|will)\b)/i

const SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    sub_title: { type: 'string' },
    summary: { type: 'string' },
    cur_task: { type: 'string' },
  },
  required: ['title', 'sub_title', 'summary', 'cur_task'],
} as const

export type Note = {
  /** Two or three words. The badge caption. */
  title: string
  /** One line. What the step was. */
  subTitle: string
  /** Past tense. This is what the agent gets to keep. */
  summary: string
  /** Present tense, first person. The live status line. */
  curTask: string
}

const clip = (s: string, n: number) => {
  const t = s.trim().replace(/\s+/g, ' ')
  if (t.length <= n) return t
  // Cut on a word boundary; the grammar can no longer do it for us and a
  // half-word in a badge reads as a bug.
  const cut = t.slice(0, n).lastIndexOf(' ')
  return `${t.slice(0, cut > n * 0.6 ? cut : n).trimEnd()}…`
}

export class Digest {
  /** No weights of its own: it is ready exactly when the core model is. */
  get ready(): boolean {
    return granite.ready
  }

  /**
   * One step's worth of raw work, compressed.
   *
   * `fallback` is what the caller already knows — usually the tool name and its
   * argument. It is returned whole if the summariser is down, so a missing
   * 800M model degrades the badges to terse labels rather than breaking a turn.
   */
  async note(work: string, fallback: string): Promise<Note> {
    const plain: Note = {
      title: clip(fallback, 28),
      subTitle: clip(fallback, 70),
      summary: clip(work, 200),
      curTask: clip(fallback, 90),
    }
    if (!this.ready || !work.trim()) return plain
    try {
      const d = await granite.json<Record<string, string>>(
        SYSTEM,
        `WORK RESULT:\n${work}`,
        SCHEMA,
        200,
      )
      // Belt and braces. The prompt above stops this in every case measured,
      // but a badge reading "Summarisation" is worse than one reading `look
      // reykjavik`, so an echo falls back to what the caller already knew.
      if (ECHOED.test(d.title ?? '')) return plain
      return {
        title: clip(d.title || fallback, 28),
        subTitle: clip(d.sub_title || '', 70),
        summary: clip(d.summary || work, 200),
        curTask: clip(d.cur_task || '', 90),
      }
    } catch (err) {
      console.warn('digest failed', err)
      return plain
    }
  }

  /**
   * The rolling topic line.
   *
   * Rewritten from the last few turns rather than extended, so it stays one
   * sentence however long the conversation runs. This is the single line that
   * carries "what are we talking about" across turns, and it is why the agent
   * can answer a bare "why?" three exchanges later.
   */
  async topic(turns: { role: string; text: string }[]): Promise<string | null> {
    if (!this.ready || !turns.length) return null
    const script = turns.map((t) => `${t.role}: ${t.text}`).join('\n')
    try {
      const { summary } = await granite.json<{ summary?: string }>(
        SYSTEM,
        `CONVERSATION:\n${script}\n\nState what it is about.`,
        { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
        90,
      )
      return summary ? clip(summary, 150) : null
    } catch (err) {
      console.warn('topic failed', err)
      return null
    }
  }
}
