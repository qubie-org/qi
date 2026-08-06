/**
 * The model. Singular.
 *
 * qi used to run three: a 4B talker, an 800M summariser, and a 26M ONNX
 * tool-caller, each with its own weights, its own server or runtime, its own
 * prompt dialect and its own failure mode. Three models meant three things to
 * download, two ports to keep alive, and a router in front of all of it whose
 * only job was deciding which of our own models to bother.
 *
 * All of it collapses into one file of weights: ibm-granite/granite-4.1-3b,
 * Apache-2.0, ~2.1 GB at Q4_K_M. The same weights cover the three jobs that used
 * to need three models:
 *
 *   say     stream a reply, and emit tool calls     (was A1-4B + needle)
 *   fill    fill a schema, grammar-enforced         (was Supra-800M)
 *   see     read an image                           (the vision pack's server)
 *
 * Dense rather than MoE, and that was a choice with a cost: h-tiny generates
 * roughly three times faster for the same quality. But every granitelib adapter
 * is trained against *these* weights, and the intrinsics shelf — answerability,
 * citations, hallucination detection — is worth more than the tokens per second.
 *
 * Everything else in qi is a *pack*: an optional download that registers
 * bindings against this client (see packs.ts). The core is one model and this
 * file; anything else the user has to ask for.
 *
 * Requests go to a relative path that Vite proxies to llama-server on
 * localhost, which keeps the browser same-origin — no CORS on the server, and
 * cross-origin isolation stays intact for the wasm sandbox.
 */

import { GEN_AI, observe, QI } from './telemetry'

/** What the server is serving, learned at load rather than assumed. */
export type Caps = {
  /** An mmproj is loaded, so image parts are accepted. */
  vision: boolean
  /** The chat template declares tool support (Granite 4.1's does). */
  tools: boolean
  /** Whatever id the server reports; shown in the boot line, never pinned. */
  id: string
  /** Context window the server was actually started with. */
  ctx: number
}

/**
 * A message part. Images are data: URLs — the browser already has the bytes,
 * and round-tripping them through a file path would mean giving the page a
 * filesystem it has no other reason to want.
 */
export type Part =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export type Message = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | Part[] | null
  tool_call_id?: string
  tool_calls?: unknown[]
}

/** A tool call as it comes off the wire, reassembled from deltas. */
export type Call = { id: string; name: string; args: string }

export type SayOptions = {
  tools?: readonly unknown[]
  /** Called with the reply so far, cleaned. Not called while a call is forming. */
  onToken?: (soFar: string) => void
  maxTokens?: number
  temperature?: number
  /** Return early once a complete sentence has run past this many words. */
  softLimit?: number
  images?: string[]
  /**
   * An adapter to apply to this request only. Named, not numbered — the id the
   * server assigns depends on the order it was launched with, and a caller
   * that hardcodes 2 gets whatever happens to be third.
   */
  adapter?: string
  /**
   * Extra variables for the chat template. Granite's takes `documents`, which
   * is how the RAG intrinsics are told what the answer is supposed to be based
   * on — there is no field for it in the OpenAI request shape.
   */
  templateVars?: Record<string, unknown>
}

/** An adapter the server was started with. */
export type Adapter = { id: number; name: string; path: string }

export class Granite {
  ready = false
  caps: Caps = { vision: false, tools: false, id: 'granite', ctx: 0 }
  /** The shelf, as the server reports it. Empty when none were loaded. */
  adapters: Adapter[] = []

  /**
   * Where this client's server lives. The core is proxied at /llm; a pack that
   * brings its own weights gets its own path, because llama.cpp serves one
   * model per process and a second model means a second server.
   */
  constructor(private readonly base = '/llm') {}

  /**
   * Confirm a server is up and learn what it can do.
   *
   * Capabilities are probed, not configured. `/props` is llama-server's own
   * account of how it was started — if someone launched it without `--mmproj`
   * then vision is off, and the packs that assume otherwise should say so
   * plainly rather than fail on the first image.
   */
  async load(): Promise<void> {
    const res = await fetch(`${this.base}/v1/models`)
    if (!res.ok) throw new Error(`no model server (${res.status})`)
    const body = await res.json()
    // llama-server reports the model as the absolute path it was launched with,
    // which makes every span name a filesystem tour. The basename is what
    // anyone reading a trace actually wants.
    const reported = String(body?.data?.[0]?.id ?? 'granite')
    this.caps.id = (reported.split('/').pop() ?? reported).replace(/\.gguf$/i, '')

    try {
      const props = await (await fetch(`${this.base}/props`)).json()
      this.caps.vision = !!props?.modalities?.vision
      this.caps.ctx = Number(props?.default_generation_settings?.n_ctx ?? 0)
      // A template that mentions tools is one that can carry them. Granite
      // 4.1's does; the check is here so a swapped-in GGUF cannot silently
      // turn the agent loop into a model that ignores every tool it is given.
      this.caps.tools = /tool_call|available_tools/.test(String(props?.chat_template ?? ''))
    } catch {
      /* an older server without /props: assume text-only, tools on */
      this.caps.tools = true
    }

    // The intrinsics shelf. Adapters are hot-swappable per request, so the list
    // is read once and the names are what callers use — see `adapter` above for
    // why the ids are not part of the interface.
    try {
      const list = (await (await fetch(`${this.base}/lora-adapters`)).json()) as {
        id: number
        path: string
      }[]
      this.adapters = list.map((a) => ({
        id: a.id,
        path: a.path,
        name: (a.path.split('/').pop() ?? '').replace(/\.gguf$/, ''),
      }))
    } catch {
      /* no adapters loaded, which is the normal case for a pack's own server */
    }

    this.ready = true
  }

  /** True when an adapter by this name is on the shelf. */
  has(adapter: string): boolean {
    return this.adapters.some((a) => a.name === adapter)
  }

  /**
   * The request field that selects an adapter, or nothing.
   *
   * A name that is not on the shelf is an error rather than a silent
   * fall-through to the base model: an intrinsic answered by base weights looks
   * like an answer and is not one.
   */
  private loraFor(adapter?: string): Record<string, unknown> {
    if (!adapter) return {}
    const found = this.adapters.find((a) => a.name === adapter)
    if (!found) throw new Error(`adapter '${adapter}' is not loaded`)
    return { lora: [{ id: found.id, scale: 1 }] }
  }

  /**
   * One exchange, streamed, accumulating any tool calls that arrive alongside
   * the text.
   *
   * Tool calls stream like anything else, so a turn that ends up calling a tool
   * costs nothing extra to watch, and a turn that answers directly animates in
   * from the first word rather than waiting on a round trip it did not need.
   */
  async say(
    messages: Message[],
    opts: SayOptions = {},
  ): Promise<{ text: string; calls: Call[] }> {
    if (!this.ready) throw new Error('granite: load() first')
    return observe(
      'chat',
      this.caps.id,
      {
        [GEN_AI.REQUEST_MODEL]: this.caps.id,
        [GEN_AI.REQUEST_MAX_TOKENS]: opts.maxTokens ?? 220,
        [GEN_AI.REQUEST_TEMPERATURE]: opts.temperature ?? 0.6,
        [GEN_AI.REQUEST_TOP_P]: 0.9,
        'gen_ai.request.messages_count': messages.length,
        'gen_ai.request.tools_count': opts.tools?.length ?? 0,
        ...(opts.adapter ? { [QI.ADAPTER]: opts.adapter } : {}),
      },
      (span) => this.stream(messages, opts, span),
    )
  }

  private async stream(
    messages: Message[],
    opts: SayOptions,
    span: import('@opentelemetry/api').Span,
  ): Promise<{ text: string; calls: Call[] }> {
    const { onToken, softLimit = 0 } = opts

    const res = await fetch(`${this.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages,
        ...(opts.tools?.length ? { tools: opts.tools, tool_choice: 'auto' } : {}),
        ...this.loraFor(opts.adapter),
        ...(opts.templateVars ? { chat_template_kwargs: opts.templateVars } : {}),
        max_tokens: opts.maxTokens ?? 220,
        temperature: opts.temperature ?? 0.6,
        top_p: 0.9,
        stream: true,
      }),
    })
    if (!res.ok || !res.body) throw new Error(`granite: ${res.status}`)

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

        // Calls arrive in pieces keyed by index, with the name in the first
        // fragment and the argument JSON dribbling in across the rest.
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
      // While a call is forming there is nothing worth showing; the model
      // often emits a word or two of preamble the answer will not include.
      if (!calls.length) onToken?.(clean)
      if (softLimit && !calls.length && endsSentence(clean) && words(clean) >= softLimit) {
        await reader.cancel()
        break
      }
    }

    const out = { text: strip(acc), calls: calls.filter((c) => c.name) }
    // Token counts are not in the stream, so what is recorded is what is
    // actually known: how much text came back and whether it became a call.
    span.setAttributes({
      'gen_ai.response.text_length': out.text.length,
      [GEN_AI.RESPONSE_FINISH_REASONS]: out.calls.length ? ['tool_calls'] : ['stop'],
      'gen_ai.response.tool_calls': out.calls.map((c) => c.name).join(','),
    })
    return out
  }

  /**
   * Fill a schema. The shape is guaranteed, not requested.
   *
   * llama.cpp compiles the JSON schema to a GBNF grammar and constrains
   * sampling with it, so a malformed reply is impossible rather than merely
   * unlikely. This is what replaced the 800M summariser: the schema was always
   * doing the work, and a dedicated model was the expensive way to get it.
   *
   * Note what the schema deliberately does not carry: `maxLength`. The grammar
   * enforces that as a hard character stop, which severs the last word
   * mid-token. Lengths are trimmed by the caller instead.
   */
  async json<T>(system: string, user: string, schema: unknown, maxTokens = 200): Promise<T> {
    return this.fill<T>(
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      schema,
      { maxTokens },
    )
  }

  /**
   * The general form: a whole conversation, a schema, and optionally an adapter
   * and template variables.
   *
   * This is what the intrinsics run on. An intrinsic is a conversation the base
   * model has already seen, replayed with one adapter switched on and an output
   * shape it cannot deviate from — which is why "did that answer follow from
   * the documents" is a request rather than a second model.
   */
  /**
   * Grammar-constrained generation for a conversation that ends on a reply.
   *
   * The chat endpoint cannot do this, and the reason is visible in the rendered
   * prompt. Ask `/apply-template` for a conversation ending in an assistant
   * message and it comes back:
   *
   *     <|start_of_role|>assistant<|end_of_role|>Reykjavik is the capital…
   *
   * with the turn left **open** — no `<|end_of_text|>`. That is an instruction
   * to continue writing the reply, which is exactly what the model then does.
   * Adding a JSON schema on top fails differently: llama.cpp b10250 answers
   * HTTP 400, "Failed to initialize samplers", for any trailing assistant
   * message plus any grammar, with or without a LoRA. `add_generation_prompt`
   * changes neither, at the top level or inside `chat_template_kwargs`.
   *
   * That combination is precisely what two of the five RAG intrinsics need,
   * because `citations` and `hallucination_detection` judge a reply and the
   * reply has to be in the conversation to be judged. So both were dead.
   *
   * The fix is to stop using the chat endpoint for them. Render the prompt,
   * close the assistant turn, open a fresh one, and post that to `/completion`,
   * where the suffix is ours and the grammar is accepted. Everything else — the
   * adapter, the documents, the schema — is unchanged, so the intrinsics see
   * exactly the input they were trained on.
   */
  async judge<T>(
    messages: Message[],
    schema: unknown,
    opts: { maxTokens?: number; adapter?: string; templateVars?: Record<string, unknown> } = {},
  ): Promise<T> {
    if (!this.ready) throw new Error('granite: load() first')
    return observe(
      'chat',
      opts.adapter ?? this.caps.id,
      {
        [GEN_AI.REQUEST_MODEL]: this.caps.id,
        [GEN_AI.REQUEST_MAX_TOKENS]: opts.maxTokens ?? 800,
        'gen_ai.output.type': 'json',
        ...(opts.adapter ? { [QI.ADAPTER]: opts.adapter } : {}),
      },
      async (span) => {
        const rendered = await fetch(`${this.base}/apply-template`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            messages,
            ...(opts.templateVars ? { chat_template_kwargs: opts.templateVars } : {}),
          }),
        })
        if (!rendered.ok) throw new Error(`granite template: ${rendered.status}`)
        const base = String((await rendered.json())?.prompt ?? '')
        if (!base) throw new Error('granite template: empty prompt')

        // Close whatever turn the template left open, then ask for a new one.
        const prompt = `${base}${END}${HEADER}`

        const res = await fetch(`${this.base}/completion`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            prompt,
            ...this.loraFor(opts.adapter),
            n_predict: opts.maxTokens ?? 800,
            // Zero, not 0.1: these are verdicts, and a verdict that varies
            // between runs on the same input is not a verdict.
            temperature: 0,
            json_schema: schema,
          }),
        })
        if (!res.ok) throw new Error(`granite completion: ${res.status}`)
        const body = await res.json()
        span.setAttributes({
          [GEN_AI.USAGE_OUTPUT_TOKENS]: Number(body?.tokens_predicted ?? 0),
        })
        return JSON.parse(String(body?.content ?? 'null')) as T
      },
    )
  }

  async fill<T>(
    messages: Message[],
    schema: unknown,
    opts: { maxTokens?: number; adapter?: string; templateVars?: Record<string, unknown> } = {},
  ): Promise<T> {
    if (!this.ready) throw new Error('granite: load() first')
    return observe(
      'chat',
      opts.adapter ?? this.caps.id,
      {
        [GEN_AI.REQUEST_MODEL]: this.caps.id,
        [GEN_AI.REQUEST_MAX_TOKENS]: opts.maxTokens ?? 200,
        [GEN_AI.REQUEST_TEMPERATURE]: 0.1,
        'gen_ai.output.type': 'json',
        ...(opts.adapter ? { [QI.ADAPTER]: opts.adapter } : {}),
      },
      async (span) => {
    const res = await fetch(`${this.base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages,
        ...this.loraFor(opts.adapter),
        ...(opts.templateVars ? { chat_template_kwargs: opts.templateVars } : {}),
        max_tokens: opts.maxTokens ?? 200,
        temperature: 0.1,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'out', schema, strict: true },
        },
      }),
    })
    if (!res.ok) throw new Error(`granite json: ${res.status}`)
    const body = await res.json()
    span.setAttributes({
      [GEN_AI.USAGE_INPUT_TOKENS]: Number(body?.usage?.prompt_tokens ?? 0),
      [GEN_AI.USAGE_OUTPUT_TOKENS]: Number(body?.usage?.completion_tokens ?? 0),
    })
    return JSON.parse(String(body?.choices?.[0]?.message?.content ?? '{}')) as T
      },
    )
  }

  /**
   * Read an image.
   *
   * `images` are data: URLs. Granite Vision is trained on documents, charts and
   * tables as much as on photographs, so the useful questions here are closer
   * to "what does this table say" than "describe this picture".
   */
  async see(images: string[], prompt: string, opts: SayOptions = {}): Promise<string> {
    if (!this.caps.vision) throw new Error('granite: server has no vision projector')
    const content: Part[] = [
      ...images.map((url) => ({ type: 'image_url' as const, image_url: { url } })),
      { type: 'text' as const, text: prompt },
    ]
    const { text } = await this.say([{ role: 'user', content }], {
      ...opts,
      maxTokens: opts.maxTokens ?? 512,
    })
    return text
  }
}

/**
 * Cleanup that applies to anything this model says out loud.
 *
 * Models invent plausible-looking image URLs when asked about pictures. The
 * real one is attached as a chip; a hallucinated one is just a lie in link
 * form, so no URL is ever shown. Whole markdown images go first — stripping
 * only the URL leaves a dangling "![alt](" on screen.
 */
export const strip = (s: string) =>
  s
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/<\|[^|]*\|>/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)?/g, '')
    .replace(/\[[^\]]*\]\(\s*\)/g, '')
    .replace(/\bhttps?:\/\/\S+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()

export const words = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0)
export const endsSentence = (s: string) => /[.!?]["')\]]?$/.test(s.trim())

/**
 * Split into sentences without ever losing a word.
 *
 * The old expression was `[^.!?]+[.!?]+(?=\s|$)`, which cannot cross a full
 * stop — so on a string containing a dotted token it matched nothing until
 * *after* the last one, and everything before was silently dropped. "The photo
 * is by Giuseppe Milo (www.pixael.com), licensed BY." came out as "com),
 * licensed BY."; "Dr. Smith went to Washington D.C. yesterday." came out as
 * "Dr.C. yesterday.". Not a truncation — data loss, and invisible, because what
 * remained was still a grammatical fragment.
 *
 * A terminator only ends a sentence when whitespace or the end of the string
 * follows it, which is what makes "www.pixael.com" one token rather than three
 * sentences. The invariant that matters is that the pieces concatenate back to
 * the input: an abbreviation may still split a sentence in two, but no text can
 * ever go missing.
 */
export function sentences(text: string): string[] {
  const out: string[] = []
  const end = /[.!?]+["'’)\]]?(?=\s|$)/g
  let start = 0
  let m: RegExpExecArray | null
  while ((m = end.exec(text))) {
    const stop = m.index + m[0].length
    const piece = text.slice(start, stop).trim()
    if (piece) out.push(piece)
    start = stop
  }
  const tail = text.slice(start).trim()
  if (tail) out.push(tail)
  return out
}

/**
 * Whole sentences only; a trailing fragment is dropped rather than ellipsised,
 * so nothing on screen is ever cut mid-thought.
 */
export function tighten(raw: string, softLimit = 18): string {
  const s = strip(raw)
  if (!s) return ''
  const parts = sentences(s)
  if (parts.length < 2) return s
  let out = ''
  for (const part of parts) {
    const next = `${out} ${part}`.trim()
    if (out && words(next) > softLimit) break
    out = next
    if (words(out) >= softLimit) break
  }
  return out || parts[0]
}

/**
 * Granite's turn delimiters. Named here rather than inlined because `judge`
 * depends on the exact spelling, and a silent mismatch would look like the
 * model simply answering badly.
 */
const END = '<|end_of_text|>\n'
const HEADER = '<|start_of_role|>assistant<|end_of_role|>'

/** The one client, shared. Packs bind against this instance. */
export const granite = new Granite()
