/**
 * The loop: decide, act, observe, repeat, answer.
 *
 * toki used to be call-and-response with the tools bolted on in front — the
 * host guessed a source from the question's embedding, fetched it, and handed
 * the result to the model as a fait accompli. The model never chose anything,
 * so it could never do anything that took two moves.
 *
 * Here A1 chooses. It is given four verbs and a working set, and it either
 * calls one or answers. What comes back from a call is compressed by the 800M
 * summariser before the agent sees it, so a step costs the context one line
 * rather than a payload, and four steps still fit in a prompt a 4B model can
 * hold in its head.
 *
 * Everything streams, including the turn where a tool is called: llama-server
 * emits tool calls as deltas like any other token, so accumulating them costs
 * nothing and means a direct answer animates in from the first word instead of
 * waiting on a round trip that might not have needed to happen.
 *
 * The depth cap is four. It is not a safety rail so much as an admission: past
 * four steps this size of model stops making progress and starts restating the
 * question as a new tool call, and a cap produces a worse answer faster, which
 * is the better failure.
 */
import type { Digest, Note } from './digest'
import { execute, subject, TOOLS, VERB, type ToolContext, type ToolName } from './tools'
import type { Fact } from '../ground'
import { all } from '../pages/space'
import { workingSet } from '../store/working'
import { embed } from '../engine/embed'

const ENDPOINT = '/llm/v1/chat/completions'
const MAX_STEPS = 4
const SOFT_LIMIT = 18

/**
 * Voice first, agency second. The order matters: brevity is the brief, and a
 * model told it is an agent before it is told to be terse writes like an agent.
 */
const SYSTEM = [
  'You are toki. You answer in very few words — usually one short sentence.',
  'Never explain your reasoning. Never preface. Never offer to help further.',
  'Never write a URL or a file path. Images and sources are attached for you.',
  '',
  'You may use tools before answering. Use one only when you need something you',
  'do not have. If the context already answers the question, just answer.',
  'Never call the same tool twice with the same argument.',
  '',
  'The context block says what this conversation is about and what you have',
  'already found. Treat it as things you know. Answer as a continuation of that',
  'conversation, not as a fresh question — if the user says "why" or "and it",',
  'they mean the thing named in the context.',
  '',
  'Place one or two emoji per reply, each directly after a concrete noun it',
  'depicts — a thing you could photograph. Never on a verb, an adjective or an',
  'abstract idea, and never two for the same thing.',
].join('\n')

export type StepEvent = {
  t: 'step'
  id: number
  kind: ToolName
  subject: string
  state: 'running' | 'done' | 'failed'
  /** Present once the summariser has named it. */
  note?: Note
}
export type AgentEvent =
  | StepEvent
  /** First-person, present tense — what it is doing right now. */
  | { t: 'status'; text: string }
  /** The reply so far. */
  | { t: 'token'; text: string }

export type Outcome = { reply: string; facts: Fact[] }

type Call = { id: string; name: string; args: string }
type Message = Record<string, unknown>

export class Agent {
  ready = false
  private digest: Digest

  constructor(digest: Digest) {
    this.digest = digest
  }

  async load(): Promise<void> {
    const res = await fetch('/llm/v1/models')
    if (!res.ok) throw new Error(`no agent server (${res.status})`)
    this.ready = true
  }

  async run(
    user: string,
    ctx: ToolContext,
    on: (e: AgentEvent) => void,
  ): Promise<Outcome> {
    if (!this.ready) throw new Error('agent: load() first')

    const store = ctx.store
    store.openTask(user)

    // Retrieval runs against the same vector the theme engine is about to use,
    // so what the agent recalls and what the page looks like come from one
    // reading of the sentence rather than two.
    const query = embed(ctx.table, user)
    const set = workingSet(store, query)
    const skills = all().filter((p) => p.kind === 'skill')

    const context = [
      set.text,
      skills.length ? `skills: ${skills.map((s) => s.title).join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('\n')

    const messages: Message[] = [
      { role: 'system', content: SYSTEM },
      ...store.recentTurns(4).map((t) => ({
        role: t.role === 'user' ? 'user' : 'assistant',
        content: t.text,
      })),
      { role: 'user', content: context ? `[context]\n${context}\n[end context]\n\n${user}` : user },
    ]

    const facts: Fact[] = []
    let reply = ''

    for (let depth = 0; depth <= MAX_STEPS; depth++) {
      // Tools are withheld on the last pass, so the loop always terminates in a
      // sentence rather than in a call it has no budget left to run.
      const last = depth === MAX_STEPS
      const { text, calls } = await this.stream(messages, !last, (soFar) => {
        if (soFar) on({ t: 'token', text: soFar })
      })

      if (!calls.length) {
        reply = text
        break
      }

      messages.push({
        role: 'assistant',
        content: text || null,
        tool_calls: calls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: c.args },
        })),
      })

      for (const call of calls) {
        const name = call.name as ToolName
        let args: Record<string, unknown> = {}
        try {
          args = JSON.parse(call.args || '{}')
        } catch {
          /* a truncated argument object is treated as an empty one */
        }
        const what = subject(name, args)
        const started = performance.now()
        const id = store.addStep(name, what)
        on({ t: 'step', id, kind: name, subject: what, state: 'running' })
        on({ t: 'status', text: `${VERB[name] ?? 'working on'} ${what}`.trim() })

        let work: string
        let failed = false
        try {
          const result = await execute(name, args, ctx)
          work = result.work
          failed = !!result.empty
          if (result.fact) facts.push(result.fact)
        } catch (err) {
          work = `${name} failed: ${String(err)}`
          failed = true
        }

        // The summariser is what stands between a response body and the agent's
        // context. Its `summary` is all the agent ever sees of this step.
        const note = await this.digest.note(work, `${name} ${what}`.trim())
        const ms = Math.round(performance.now() - started)
        store.finishStep(id, note.summary, ms, failed ? 'failed' : 'done')
        on({ t: 'step', id, kind: name, subject: what, state: failed ? 'failed' : 'done', note })
        if (note.curTask) on({ t: 'status', text: note.curTask })

        messages.push({ role: 'tool', tool_call_id: call.id, content: note.summary })
      }
    }

    store.closeTask()
    return { reply: tighten(reply), facts }
  }

  /**
   * One exchange, streamed, accumulating any tool calls that arrive alongside
   * the text. Returns when the model stops, or early once a complete sentence
   * has run past the soft limit — a reply that keeps going after it has said
   * the thing is just tokens the reader will not be shown.
   */
  private async stream(
    messages: Message[],
    withTools: boolean,
    onText: (soFar: string) => void,
  ): Promise<{ text: string; calls: Call[] }> {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages,
        ...(withTools ? { tools: TOOLS, tool_choice: 'auto' } : {}),
        max_tokens: 220,
        temperature: 0.6,
        top_p: 0.9,
        stream: true,
        // Belt and braces: llama-server also takes this at launch, but a server
        // someone started by hand should still not emit a reasoning trace.
        chat_template_kwargs: { enable_thinking: false },
      }),
    })
    if (!res.ok || !res.body) throw new Error(`agent: ${res.status}`)

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    const calls: Call[] = []
    let buffer = ''
    let acc = ''

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const payload = line.trim()
        if (!payload.startsWith('data:')) continue
        const data = payload.slice(5).trim()
        if (!data || data === '[DONE]') continue
        let delta: Record<string, unknown>
        try {
          delta = JSON.parse(data)?.choices?.[0]?.delta ?? {}
        } catch {
          continue // a partial frame; the next chunk completes it
        }
        if (typeof delta.content === 'string') acc += delta.content

        // Tool calls arrive in pieces keyed by index, with the name in the
        // first fragment and the argument JSON dribbling in across the rest.
        for (const tc of (delta.tool_calls ?? []) as {
          index?: number
          id?: string
          function?: { name?: string; arguments?: string }
        }[]) {
          const i = tc.index ?? 0
          calls[i] ??= { id: tc.id ?? `call_${i}`, name: '', args: '' }
          if (tc.id) calls[i].id = tc.id
          if (tc.function?.name) calls[i].name = tc.function.name
          if (tc.function?.arguments) calls[i].args += tc.function.arguments
        }
      }

      const clean = strip(acc)
      // While a tool call is forming there is nothing worth showing; the model
      // often emits a word or two of preamble that the answer will not include.
      if (!calls.length) onText(clean)
      if (!calls.length && endsSentence(clean) && words(clean) >= SOFT_LIMIT) {
        await reader.cancel()
        break
      }
    }

    return { text: strip(acc), calls: calls.filter((c) => c.name) }
  }
}

/** Some builds emit a reasoning block regardless; it is never shown. */
const strip = (s: string) =>
  s
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/<\|[^|]*\|>/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)?/g, '')
    .replace(/\[[^\]]*\]\(\s*\)/g, '')
    .replace(/\bhttps?:\/\/\S+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()

const words = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0)
const endsSentence = (s: string) => /[.!?]["')\]]?$/.test(s.trim())

/** Whole sentences only; a trailing fragment is dropped rather than ellipsised. */
export function tighten(raw: string, softLimit = SOFT_LIMIT): string {
  const s = strip(raw)
  if (!s) return ''
  const sentences = s.match(/[^.!?]+[.!?]+(?=\s|$)/g)
  if (!sentences?.length) return s
  let out = ''
  for (const sentence of sentences) {
    const next = (out + sentence).trim()
    if (out && words(next) > softLimit) break
    out = next
    if (words(out) >= softLimit) break
  }
  return out || sentences[0].trim()
}
