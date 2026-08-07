/**
 * The rag pack: five LoRA adapters that judge the core's own work.
 *
 * This is the pack that justifies the whole architecture. It is not a model. It
 * is 376 MB of low-rank deltas — rank 32 on q/k/v/o only — trained by IBM
 * against the exact weights the core is already running, passed to llama-server
 * at startup with `--lora-init-without-apply` and named per request. Nothing
 * extra is resident. Switching from "answer" to "was that answer supported by
 * the documents" is a field in a request body.
 *
 *   answerability           can this question be answered from these documents
 *   citations               which sentence of which document supports which sentence of the reply
 *   hallucination_detection which sentences of the reply are not supported
 *   query_rewrite           rewrite the last turn as a standalone question
 *   query_clarification     ask for the missing detail, or say CLEAR
 *
 * Two of these change what qi does rather than merely checking it.
 * `query_rewrite` is the fix for the oldest bug in the grounding layer — "why?"
 * and "and it?" carry no searchable content, and the router was being asked to
 * embed them. `citations` is what lets a claim on screen point at the sentence
 * it came from, which is the difference between a fact and an assertion.
 *
 * What is deliberately not claimed: this is standard LoRA, not aLoRA. IBM
 * trained both, but only the LoRA variants are published as GGUF, and llama.cpp
 * needs `adapter.alora.invocation_tokens` in the file to do the KV-cache reuse
 * its server already implements. So an intrinsic here re-processes the prompt
 * rather than continuing from the base model's cache. Converting the aLoRA
 * safetensors ourselves would remove that cost; it is a known, measurable
 * improvement rather than a rewrite.
 */
import type { Binding, PackSpec, Verb } from '../model/packs'
import { granite } from '../model/granite'

/** A document as Granite's chat template expects it. */
export type Doc = { doc_id: string; text: string }

export type Turn = { role: 'user' | 'assistant'; content: string }

/**
 * Output shapes, taken from each adapter's own card rather than invented. The
 * grammar makes them guarantees: the shelf is only useful if its verdicts can
 * be read by code, and a free-text "the second sentence seems unsupported" is
 * not a verdict.
 */
const SCHEMA = {
  answerability: {
    type: 'object',
    properties: { answerability: { type: 'string', enum: ['answerable', 'unanswerable'] } },
    required: ['answerability'],
  },
  query_rewrite: {
    type: 'object',
    properties: { rewritten_question: { type: 'string' } },
    required: ['rewritten_question'],
  },
  query_clarification: {
    type: 'object',
    properties: { clarification: { type: 'string' } },
    required: ['clarification'],
  },
  hallucination_detection: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        response_begin: { type: 'integer' },
        response_end: { type: 'integer' },
        response_text: { type: 'string' },
        faithfulness: { type: 'string', enum: ['faithful', 'unfaithful'] },
        explanation: { type: 'string' },
      },
      required: ['response_begin', 'response_end', 'response_text', 'faithfulness'],
    },
  },
  citations: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        response_begin: { type: 'integer' },
        response_end: { type: 'integer' },
        response_text: { type: 'string' },
        citation_doc_id: { type: 'string' },
        citation_begin: { type: 'integer' },
        citation_end: { type: 'integer' },
        citation_text: { type: 'string' },
      },
      required: ['response_begin', 'response_end', 'citation_doc_id', 'citation_text'],
    },
  },
} as const

export type Intrinsic = keyof typeof SCHEMA

/**
 * Run one intrinsic over a conversation.
 *
 * Documents go through `chat_template_kwargs`, not into a system message.
 * Granite's template has a `documents` variable with its own framing, and these
 * adapters were trained on that framing — pasting the same text into a system
 * prompt is a different input to the one they saw, and the verdict degrades
 * quietly rather than failing.
 */
async function run<T>(name: Intrinsic, turns: Turn[], documents: Doc[] = []): Promise<T> {
  if (!granite.has(name)) throw new Error(`intrinsic '${name}' is not loaded`)

  const opts = {
    adapter: name,
    maxTokens: name === 'citations' || name === 'hallucination_detection' ? 1200 : 160,
    ...(documents.length ? { templateVars: { documents } } : {}),
  }

  // Which endpoint depends on how the conversation ends, not on which
  // intrinsic this is. An intrinsic that judges a reply has the reply as its
  // last turn, and the chat endpoint cannot take a grammar in that shape — see
  // `granite.judge` for the whole diagnosis. Deciding on the message rather
  // than on the name means a new intrinsic gets the right path for free.
  const judging = turns[turns.length - 1]?.role === 'assistant'
  return judging ? granite.judge<T>(turns, SCHEMA[name], opts) : granite.fill<T>(turns, SCHEMA[name], opts)
}

export const answerable = async (turns: Turn[], documents: Doc[]): Promise<boolean> =>
  (await run<{ answerability: string }>('answerability', turns, documents)).answerability ===
  'answerable'

export const rewrite = async (turns: Turn[]): Promise<string> =>
  (await run<{ rewritten_question: string }>('query_rewrite', turns)).rewritten_question

export const clarify = async (turns: Turn[]): Promise<string | null> => {
  const { clarification } = await run<{ clarification: string }>('query_clarification', turns)
  return clarification === 'CLEAR' ? null : clarification
}

export type Span = {
  response_begin: number
  response_end: number
  response_text?: string
  faithfulness?: 'faithful' | 'unfaithful'
  explanation?: string
  citation_doc_id?: string
  citation_text?: string
}

export const unsupported = async (turns: Turn[], documents: Doc[]): Promise<Span[]> =>
  (await run<Span[]>('hallucination_detection', turns, documents)).filter(
    (s) => s.faithfulness === 'unfaithful',
  )

export const cite = async (turns: Turn[], documents: Doc[]): Promise<Span[]> =>
  run<Span[]>('citations', turns, documents)

/**
 * The one intrinsic the agent itself should be able to reach for.
 *
 * The others run on qi's behalf, after a reply exists — they are checks, and
 * a model asked to check its own work mid-sentence will simply agree with
 * itself. Rewriting a question is different: it is a thing the agent wants
 * before it searches, and it knows when the conversation has left the question
 * unsayable on its own.
 */
const rewriteVerb: Verb = {
  verb: 'rephrasing',
  declaration: {
    type: 'function',
    function: {
      name: 'rephrase',
      description:
        'Turn the conversation so far into one standalone question. Use before looking something up ' +
        'when the user\'s words only make sense in context — "why?", "and the other one?".',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  async run(_args, ctx) {
    const turns = (ctx as { turns?: Turn[] }).turns ?? []
    if (!turns.length) return { work: 'Nothing to rephrase yet.', empty: true }
    const q = await rewrite(turns)
    return `The question, standalone: ${q}`
  },
}

export default async function bind(_spec: PackSpec): Promise<Binding> {
  return {
    async start() {
      // The adapters live on the core's server, so there is nothing to load
      // here — only something to check. A pack whose files are on disk but
      // whose adapters were never passed to llama-server is the failure this
      // catches, and it is otherwise invisible until a verdict comes back
      // written by base weights.
      const missing = (Object.keys(SCHEMA) as Intrinsic[]).filter((n) => !granite.has(n))
      if (missing.length === Object.keys(SCHEMA).length) {
        throw new Error('rag: no adapters on the server — restart tools/serve.sh')
      }
      if (missing.length) console.warn('rag: adapters missing from the shelf:', missing.join(', '))
    },
    verbs: [rewriteVerb],
    capabilities: { answerable, rewrite, clarify, unsupported, cite },
  }
}
