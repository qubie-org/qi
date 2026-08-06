/**
 * The compressor: SupraLabs' reasoning-summarizer, 800M, on its own server.
 *
 * Two problems share one answer. Tool results are large — a weather payload is
 * a quarter of a megabyte before the sandbox reduces it, and a page body is
 * still a paragraph after — and putting them into the agent's context is what
 * makes a 4B model lose the thread. Separately, the step badges need a human
 * label for work that is described in the code only as `look('reykjavik
 * weather')`.
 *
 * This model produces both at once. It is a Qwen3.5-0.8B base fine-tuned on
 * 61k reasoning-trace summaries, and it emits four fields:
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

const ENDPOINT = '/sum/v1/completions'

/**
 * Being explicit about English is not optional: the base model is multilingual
 * and, undirected, ends a sentence about Iceland in Chinese. The second clause
 * is the one that matters — a summariser that invents a number is worse than no
 * summariser, because its output is trusted downstream as fact.
 */
const SYSTEM =
  'Summarise the work below in English only. Be literal: never state a number ' +
  'that does not appear in the text.'

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

const chatml = (user: string) =>
  `<|im_start|>system\n${SYSTEM}<|im_end|>\n<|im_start|>user\n${user}<|im_end|>\n<|im_start|>assistant\n`

export class Digest {
  ready = false

  async load(): Promise<void> {
    const res = await fetch('/sum/health')
    if (!res.ok) throw new Error(`no summarizer (${res.status})`)
    this.ready = true
  }

  private async complete(prompt: string, schema: unknown, tokens: number): Promise<string> {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt,
        n_predict: tokens,
        temperature: 0.1,
        json_schema: schema,
        stop: ['<|im_end|>'],
      }),
    })
    if (!res.ok) throw new Error(`digest: ${res.status}`)
    const body = await res.json()
    return String(body?.choices?.[0]?.text ?? '').trim()
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
      const raw = await this.complete(chatml(work), SCHEMA, 200)
      const d = JSON.parse(raw) as Record<string, string>
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
      const raw = await this.complete(
        chatml(`A conversation so far:\n${script}\n\nState what it is about.`),
        { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
        90,
      )
      const s = (JSON.parse(raw) as { summary?: string }).summary
      return s ? clip(s, 150) : null
    } catch (err) {
      console.warn('topic failed', err)
      return null
    }
  }
}
