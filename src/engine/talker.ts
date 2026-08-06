/**
 * The mouth: Agents-A1-4B, served locally by mlx_lm on Apple Silicon.
 *
 * This replaces the in-browser 100M model. That one ran entirely client-side —
 * the founding constraint — but produced "sheep are a breed of sheep" and
 * "Bend 25C in the direction of the equator". A 4B model is roughly 40x larger
 * and cannot be shipped to a page, so toki now talks to a server on localhost
 * and gives up being self-contained in exchange for answers that are actually
 * right.
 *
 * Nothing else moves. Grounding, the sandbox, needle, potion, the inline
 * system and the theme engine are unchanged and still run in the page; only
 * the source of the words has changed.
 *
 * Requests go to a relative path that Vite proxies to the server, which keeps
 * the browser same-origin and avoids needing CORS on mlx_lm.
 */

export type Turn = { role: 'user' | 'agent'; text: string }

const ENDPOINT = '/llm/v1/chat/completions'
/**
 * Pinned, not discovered. `/v1/models` lists everything in the local cache —
 * TTS models, transcribers — so taking the first entry picks whatever happens
 * to sort first rather than the model we mean.
 */
const MODEL = 'wcamon/Agents-A1-4B-MLX-4bit'
const MAX_TOKENS = 220
const SOFT_LIMIT = 18

/**
 * toki speaks in a handful of words at display size, so brevity is the whole
 * brief. A1 is a reasoning model; thinking is disabled below, and this keeps
 * it from narrating its way to an answer anyway.
 */
const SYSTEM = [
  'You are toki. You answer in very few words — usually one short sentence.',
  'Never explain your reasoning. Never preface. Never offer to help further.',
  'No markdown headings, no code fences, no bullet symbols unless asked to list.',
  'Never write a URL or a file path. Images and sources are attached for you.',
  'When asked to list things, give a plain numbered list, one item per line, at most five.',
  // Emoji used to be placed automatically by embedding similarity, which put
  // 🛬 on "landed" and 🖼️ on both "picture" and "image" in one sentence. A
  // bag-of-words matcher sees one word at a time with no grammar and no
  // context, so it cannot know that "landed" is a verb or that the second
  // picture adds nothing. The model has both, so the judgement moves here.
  'Place one or two emoji per reply, each directly after a concrete noun it',
  'depicts — a thing you could photograph. Never on a verb, an adjective or an',
  'abstract idea, and never two for the same thing.',
].join(' ')

/** Questions whose honest answer is an enumeration rather than a sentence. */
const LIST_FORM =
  /^\s*(?:how (?:do|to|does|can)\b|what are\b|top\s+\d+\b|list\b|steps?\b|ways?\s+to\b|recipes?\b|ingredients\b|give me\s+\d+\b|name\s+\d+\b|\d+\s+(?:ways|things|reasons|steps)\b)/i

export const wantsList = (text: string) => LIST_FORM.test(text)

const LIST_ITEMS = 5

export class Talker {
  ready = false
  model = MODEL

  /** Confirms a server is up and learns which model it is serving. */
  async load(onProgress?: (loaded: number, total: number) => void): Promise<void> {
    onProgress?.(0, 1)
    const res = await fetch('/llm/v1/models')
    if (!res.ok) throw new Error(`no local model server (${res.status})`)
    const body = await res.json()
    const ids: string[] = (body?.data ?? []).map((m: { id: string }) => m.id)
    if (!ids.includes(MODEL)) {
      throw new Error(`${MODEL} not served; found ${ids.slice(0, 3).join(', ') || 'nothing'}`)
    }
    this.model = MODEL
    this.ready = true
    onProgress?.(1, 1)
  }

  async say(
    user: string,
    history: Turn[] = [],
    onToken?: (soFar: string) => void,
    grounding?: string,
  ): Promise<string> {
    if (!this.ready) throw new Error('talker: load() first')

    const listy = wantsList(user)

    // Grounding is folded into the leading system message, not appended as a
    // second one: mlx_lm rejects that outright with "System message must be at
    // the beginning", which surfaced as a 404 and a silent fallback.
    const system = grounding
      ? `${SYSTEM}\n\nKnown to be true right now:\n${grounding}\n` +
        'Answer using these facts. Do not invent numbers. ' +
        'Do not mention that you were given facts.'
      : SYSTEM

    const messages = [
      { role: 'system', content: system },
      ...history.slice(-6).map((t) => ({
        role: t.role === 'user' ? 'user' : 'assistant',
        content: t.text,
      })),
      { role: 'user', content: user },
    ]

    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages,
        max_tokens: listy ? MAX_TOKENS : 96,
        temperature: 0.7,
        top_p: 0.9,
        stream: true,
        // A1 needs thinking switched off explicitly; left on it emits a long
        // reasoning trace before the answer, which is the opposite of the brief.
        chat_template_kwargs: { enable_thinking: false },
      }),
    })
    if (!res.ok || !res.body) throw new Error(`talker: ${res.status}`)

    let acc = ''
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

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
        try {
          acc += JSON.parse(data).choices?.[0]?.delta?.content ?? ''
        } catch {
          /* partial frame; the next chunk completes it */
        }
      }
      const clean = strip(acc)
      onToken?.(clean)
      if (!listy && endsSentence(clean) && words(clean) >= SOFT_LIMIT) {
        await reader.cancel()
        break
      }
    }

    return listy ? tightenList(acc) : tighten(acc)
  }
}

/** Some builds emit a reasoning block regardless; it is never shown. */
const strip = (s: string) =>
  s
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/<\|[^|]*\|>/g, '')
    // Models invent plausible-looking image URLs when asked about pictures.
    // The real one is attached as a chip; a hallucinated one is just a lie in
    // link form, so no URL is ever shown. Whole markdown images go first —
    // stripping only the URL leaves a dangling "![alt](" on screen.
    .replace(/!\[[^\]]*\]\([^)]*\)?/g, '')
    .replace(/\[[^\]]*\]\(\s*\)/g, '')
    .replace(/\bhttps?:\/\/\S+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()

const words = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0)
const endsSentence = (s: string) => /[.!?]["')\]]?$/.test(s.trim())
const countItems = (s: string) => (s.match(/^\s*\d{1,2}[.)]\s/gm) ?? []).length

/**
 * Keep whole sentences only. A trailing fragment is dropped rather than
 * ellipsised, so nothing on screen is ever cut mid-thought.
 */
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

/** Whole numbered items only, renumbered 1..n when the model loses count. */
export function tightenList(raw: string, max = LIST_ITEMS): string {
  const s = strip(raw)
  if (countItems(s) < 2) return tighten(raw)
  const items = s
    .split(/\n+/)
    .map((l) => l.replace(/^\s*\d{1,2}[.)]\s*/, '').trim())
    .filter(Boolean)
  const complete = endsSentence(s) || items.length > max ? items : items.slice(0, -1)
  const kept = complete.slice(0, max)
  return kept.length ? kept.map((t, i) => `${i + 1}. ${t}`).join('\n') : tighten(raw)
}
