/**
 * The loop: decide, act, observe, repeat, answer.
 *
 * qi used to be call-and-response with the tools bolted on in front — the
 * host guessed a source from the question's embedding, fetched it, and handed
 * the result to the model as a fait accompli. The model never chose anything,
 * so it could never do anything that took two moves.
 *
 * Here the model chooses. It is given the verbs that are actually available —
 * four in a bare install, more for every pack bound — and a working set, and it
 * either calls one or answers. What comes back from a call is compressed before
 * the agent sees it, so a step costs the context one line rather than a payload.
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
import { CORE_VERBS, subject, type ToolContext } from './tools'
import { ground, type Fact } from '../ground'
import { pictureFor, wantsPicture } from '../ground/picture'
import { granite, tighten, type Message } from '../model/granite'
import { unsupportedSpans } from '../ground/judge'
import { packs, type Verb } from '../model/packs'
import { all } from '../pages/space'
import { workingSet } from '../store/working'
import { embed } from '../model/vectors'
import { GEN_AI, observe, QI } from '../model/telemetry'

const MAX_STEPS = 4
const SOFT_LIMIT = 18

/**
 * Tools first, voice second — the reverse of what this used to say, and the
 * order turned out to be load-bearing rather than stylistic.
 *
 * The old prompt opened with "You answer in very few words" and mentioned tools
 * fourth. Measured against this model, that prompt answered "what is the
 * weather in reykjavik" by emitting a single sun emoji and calling nothing:
 * asked to be brief above all else, a 3B obliges, and an emoji is the briefest
 * thing there is. Reordering so the tool obligation comes first fixes it — with
 * the context block present or absent, inlined or passed through the template's
 * documents slot, all four combinations call `look`.
 *
 * The emoji instruction is gone entirely, and that is a small piece of history
 * reversing. Placement moved *into* the model when the page could only score
 * words with a static embedding table — a bag of rows cannot tell that "landed"
 * is a verb, so it put a plane on it. The embed pack is a real encoder now and
 * `matchEmoji` reads context properly, so the judgement moves back out to where
 * it can be tested. Asking for it here cost more than it bought: told to place
 * emoji on concrete nouns and to be brief, the model would reply with nothing
 * but the emoji.
 */
const SYSTEM = [
  'You are qi, an agent with tools.',
  '',
  'When a question asks about the current state of the world — weather, prices,',
  'populations, pictures, definitions, anything that changes — you MUST call a',
  'tool before answering. You have no up-to-date knowledge of your own, so',
  'answering such a question from memory is always wrong.',
  '',
  'Greetings, thanks and small talk need no tool. Neither does a question the',
  'context already answers. Never call the same tool twice with the same',
  'argument.',
  '',
  'The context block says what this conversation is about and what you have',
  'already found. Treat it as things you know. Answer as a continuation of that',
  'conversation, not as a fresh question — if the user says "why" or "and it",',
  'they mean the thing named in the context.',
  '',
  'Answer in words: one short sentence, usually. Never explain your reasoning.',
  'Never preface. Never offer to help further. Never write a URL or a file path —',
  'images and sources are attached for you.',
  '',
  // The four namespaces, stated so the model can name one in a sentence and
  // have it render as a pressable chip. It is told what they mean rather than
  // given a list, because the lists change and the meanings do not — and a
  // model handed ten names will reach for whichever is nearest the question
  // instead of the one the person wants.
  'Two kinds of thing can be named inline, and each renders as something the',
  'reader can press:',
  '  /name  a command — runs, and either returns a fact or opens a place.',
  '  @name  something the person already has — a note, a deck.',
  'Name one only when it is genuinely what the person should reach for next.',
  'Never invent one; if you are not sure it exists, write the words instead.',
].join('\n')

export type StepEvent = {
  t: 'step'
  id: number
  kind: string
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

export class Agent {
  private digest: Digest

  constructor(digest: Digest) {
    this.digest = digest
  }

  get ready(): boolean {
    return granite.ready
  }

  /**
   * Everything the agent may call this turn: the four that need no weights,
   * plus one for every pack currently bound. Asked fresh each turn rather than
   * captured at boot, so installing a pack mid-conversation adds a verb to the
   * very next question.
   */
  private verbs(): Verb[] {
    return [...CORE_VERBS, ...packs.verbs()]
  }

  async run(
    user: string,
    ctx: ToolContext,
    on: (e: AgentEvent) => void,
  ): Promise<Outcome> {
    if (!this.ready) throw new Error('agent: the core model is not loaded')

      // ── a picture is not a question ──────────────────────────────────────
      //
      // Answered before the model sees the turn, because all three attempts to
      // route it *through* the model failed and each failed differently: it
      // refused outright having called nothing, and when a fallback caught
      // refusals it began emitting `/look?query=…` as literal prose instead.
      // Both are the disposition that answered a two-city comparison backwards
      // without looking — where a tool would answer, it prefers its memory, and
      // its memory says it cannot show pictures.
      //
      // "Show me a photo of a humpback whale" has one reading. There is nothing
      // here for a model to decide and three demonstrated ways for it to decide
      // wrong. `pictureFor` still refuses when the best candidate is about
      // something else, so this goes past the model, not past the checking.
      if (wantsPicture(user)) {
        const shown = await pictureFor(user).catch(() => null)
        // The caption is the only sentence worth putting next to a photograph.
        if (shown) return { reply: String(shown.fact.label ?? ''), facts: [shown.fact] }
      }


    const store = ctx.store
    const verbs = this.verbs()
    const byName = new Map(verbs.map((v) => [v.declaration.function.name, v]))
    store.openTask(user)

    // Retrieval runs against the same vector the theme engine is about to use,
    // so what the agent recalls and what the page looks like come from one
    // reading of the sentence rather than two.
    const query = await embed(user)
    const set = workingSet(store, query)

    const context = set.text

    // The question, made able to stand on its own.
    //
    // "what about london" carries no subject, so grounding had nothing to route
    // on. The query_rewrite adapter puts the subject back — "what is the weather
    // in london?" — and leaves small talk alone, which is what makes it safe to
    // run on everything.
    let asked = user
    const priorTurns = store.recentTurns(6).filter((t) => t.text !== user)
    const rewrite = packs.provide<(turns: { role: 'user' | 'assistant'; content: string }[]) => Promise<string>>('rewrite')
    if (rewrite && priorTurns.length) {
      asked = await rewrite([
        ...priorTurns.map((t) => ({
          role: (t.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
          content: t.text,
        })),
        { role: 'user', content: user },
      ]).catch(() => user)
    }

    // No transcript. This is what working.ts says in its own header and what the
    // loop was not doing: "a transcript answers *what has happened*, which is
    // the wrong question".
    //
    // It is also, measurably, what broke every follow-up. With a prior
    // assistant turn in the messages this model will not call a tool at all —
    // not for "what about london", and not even for the rewritten "what is the
    // weather in london?". Same question, same tools, same context block: with
    // the transcript it answers from memory, without it it calls `look`. So the
    // conversation is carried by the working set, which is what the working set
    // is for, and the question is carried by the rewrite above.
    const messages: Message[] = [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: context ? `[context]\n${context}\n[end context]\n\n${asked}` : asked },
    ]

    const facts: Fact[] = []
    let reply = ''

    return observe(
      'invoke_agent',
      'qi',
      {
        [GEN_AI.AGENT_NAME]: 'qi',
        'gen_ai.request.tools_count': verbs.length,
        'qi.verbs': verbs.map((v) => v.declaration.function.name).join(','),
      },
      async (turnSpan) => {
    for (let depth = 0; depth <= MAX_STEPS; depth++) {
      // Tools are withheld on the last pass, so the loop always terminates in a
      // sentence rather than in a call it has no budget left to run.
      const last = depth === MAX_STEPS
      const { text, calls } = await granite.say(messages, {
        tools: last ? undefined : verbs.map((v) => v.declaration),
        softLimit: SOFT_LIMIT,
        onToken: (soFar) => {
          if (soFar) on({ t: 'token', text: soFar })
        },
      })

      if (!calls.length) {
        reply = text
        break
      }

      messages.push({
        role: 'assistant' as const,
        content: text || null,
        tool_calls: calls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: c.args },
        })),
      })

      for (const call of calls) {
        const name = call.name
        let args: Record<string, unknown> = {}
        try {
          args = JSON.parse(call.args || '{}')
        } catch {
          /* a truncated argument object is treated as an empty one */
        }
        const tool = byName.get(name)
        const what = subject(name, args)
        const started = performance.now()
        const id = store.addStep(name, what)
        on({ t: 'step', id, kind: name, subject: what, state: 'running' })
        on({ t: 'status', text: `${tool?.verb ?? 'working on'} ${what}`.trim() })

        let work: { work: string; empty?: boolean } = { work: '' }
        let failed = false
        if (!tool) {
          // A model that invents a verb is told so plainly rather than being
          // handed silence, which it reliably answers by inventing it again.
          work = { work: `There is no tool called "${name}".`, empty: true }
          failed = true
        } else {
          try {
            // One span per tool call, nested under the turn. This is the row
            // that matters most later: which verb the model reached for, given
            // what context, and whether it found anything.
            work = await observe(
              'execute_tool',
              name,
              {
                [GEN_AI.TOOL_NAME]: name,
                [GEN_AI.TOOL_CALL_ID]: call.id,
                [QI.DEPTH]: depth,
                'gen_ai.tool.arguments': JSON.stringify(args).slice(0, 500),
              },
              async (span) => {
                const out = await tool.run(args, { ...ctx, facts })
                const done: { work: string; empty?: boolean } =
                  typeof out === 'string' ? { work: out } : out
                const missed = !!done.empty || !done.work.trim()
                span.setAttribute(QI.EMPTY, missed)
                return { ...done, empty: missed }
              },
            )
            failed = !!work.empty
          } catch (err) {
            work = { work: `${name} failed: ${String(err)}`, empty: true }
            failed = true
          }
        }

        // The summariser is what stands between a response body and the agent's
        // context. Its `summary` is all the agent ever sees of this step.
        const note = await this.digest.note(work.work, `${name} ${what}`.trim())
        const ms = Math.round(performance.now() - started)
        store.finishStep(id, note.summary, ms, failed ? 'failed' : 'done')
        on({ t: 'step', id, kind: name, subject: what, state: failed ? 'failed' : 'done', note })
        if (note.curTask) on({ t: 'status', text: note.curTask })

        messages.push({ role: 'tool', tool_call_id: call.id, content: note.summary })
      }
    }

    // Counted before the task closes: `stepsFor` defaults to the *open* task,
    // and closing it first would report zero every time.
    const stepCount = store.stepsFor()?.length ?? 0
    store.closeTask()

    // The exit gate: is what was just said supported by what was fetched?
    //
    // This is the failure the codebase keeps rediscovering under new names —
    // the generic API reducer inferring a field, a query filtering the wrong
    // column, a page that mentioned the subject without answering. Every one
    // produces a fluent sentence with a real source link, and nothing
    // downstream can tell it from a true one.
    //
    // `hallucination_detection` was trained against these exact weights to mark
    // the spans a set of documents does not support. It is only consulted when
    // there were documents to be supported *by*: a reply written from the
    // model's own knowledge is not ungrounded, it is unsourced, and marking it
    // unfaithful would be a category error.
    const sources = facts.map((f) => String(f.value ?? '')).filter((v) => v.length > 40)
    const bad = sources.length ? await unsupportedSpans(user, reply, sources) : []
    if (bad.length) {
      // Recorded, not suppressed. A wrong sentence removed silently leaves a
      // reply that reads as complete and is not, which is worse than one that
      // is wrong out loud — and this is the signal worth having in telemetry
      // long before it is worth acting on automatically.
      turnSpan.setAttributes({ 'qi.unsupported_spans': bad.length })
      console.warn(`agent: ${bad.length} unsupported span(s)`, bad.map((b) => b.response_text ?? ''))
    }

    turnSpan.setAttributes({
      'qi.steps': stepCount,
      'qi.facts': facts.length,
      'gen_ai.response.text_length': reply.length,
    })
    return { reply: tighten(reply), facts }
      },
    )
  }

}

