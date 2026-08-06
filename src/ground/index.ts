/**
 * Grounding.
 *
 * Routing is the same embedding machinery that places the glyphs: the user's
 * sentence is compared against each source's anchors and the best match wins,
 * if it wins by enough. Nothing keyword-matches.
 *
 * The contract that makes a 100M model safe to put on screen: the response
 * body never reaches the model. The sandbox reduces it to a Fact, the Fact's
 * `value` is rendered as data, and only `hint` — a dozen tokens — is shown to
 * the talker so it can write the words around it.
 */
import { cosine, embedContent, type Table } from '../engine/embed'
import type { ToolCall } from '../engine/needle'
import { wantsList } from '../engine/talker'
import type { Node } from '../inline/types'
import { age, format, formatParts } from './quantity'
import { reduce, type Fact } from './sandbox'
import { NO_ARG, SOURCES, toolJson, type Source } from './sources'

export type { Fact } from './sandbox'
export { bootSandbox, sandboxReady } from './sandbox'

/** A sentence has to be *about* the source, not merely near it. */
const ROUTE_THRESHOLD = 0.34

/**
 * "tell me about X" and "what is X" are explicitly encyclopedia requests. A
 * specialised source may still win, but it has to clearly beat the general
 * one rather than merely clear the bar — otherwise a stray anchor overlap
 * sends "tell me about the apollo moon landing" to a satellite tracker.
 */
const LOOKUP_PREFERENCE_MARGIN = 0.18

export type Router = { source: Source; vec: Float32Array }[]

export function buildRouter(t: Table): Router {
  return SOURCES.flatMap((source) => source.anchors.map((a) => ({ source, vec: embedContent(t, a) })))
}

/**
 * "Is this a lookup?" lives in the grammar, not the topic — exactly the signal
 * `embedContent` throws away. So intent is matched on form and topic on
 * content, and the encyclopedia catches anything that asks a lookup-shaped
 * question without naming a more specific source.
 *
 * This split is a symptom: a bag-of-words vector cannot represent both at
 * once. A contextual encoder would collapse these two paths into one.
 */
const LOOKUP_FORM =
  /^\s*(?:what|who|whats|what's|whos|who's)\s+(?:is|are|was|were|the|a|an)\b|^\s*(?:tell me about|explain|define|describe|what do you know about)\b/i

/** Every source that clears the bar, best score first, one entry per source. */
export function routeAll(text: string, t: Table, router: Router, n = 3): { source: Source; score: number }[] {
  const v = embedContent(t, text)
  const best = new Map<string, { source: Source; score: number }>()
  for (const entry of router) {
    const score = cosine(v, entry.vec)
    const prev = best.get(entry.source.id)
    if (!prev || score > prev.score) best.set(entry.source.id, { source: entry.source, score })
  }
  return [...best.values()]
    .filter((h) => h.score >= ROUTE_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
}

/**
 * The encyclopedia catches anything lookup-shaped that no specific source
 * claimed — or that every specific source failed to answer.
 *
 * "what are the steps to deploy" is lookup-shaped but wants an enumeration,
 * so list intent disqualifies it and the talker handles that instead.
 */
function lookupFallback(text: string, t: Table): Source | null {
  if (!LOOKUP_FORM.test(text) || wantsList(text)) return null
  const wiki = SOURCES.find((s) => s.id === 'wiki')
  // Only if something is actually being asked *about*.
  return wiki && embedContent(t, text).some((x) => x !== 0) ? wiki : null
}

export function route(text: string, t: Table, router: Router): { source: Source; score: number } | null {
  const v = embedContent(t, text)
  let best: { source: Source; score: number } | null = null
  for (const entry of router) {
    const score = cosine(v, entry.vec)
    if (!best || score > best.score) best = { source: entry.source, score }
  }
  if (best && best.score >= ROUTE_THRESHOLD) return best

  const wiki = lookupFallback(text, t)
  return wiki ? { source: wiki, score: 0 } : null
}

/**
 * Route → fetch → sandbox → Fact. Returns null whenever anything at all goes
 * wrong; an ungrounded reply is fine, a wrong one is not.
 *
 * If needle is loaded it does both jobs — picks the source *and* copies the
 * argument out of the sentence — and its constrained decoder guarantees the
 * name and key are ones this registry actually has. Without it, routing falls
 * back to the embedding bank and a regex pulls the argument.
 */
/** Facts for repeated questions, so a turn never refetches what it just had. */
const cache = new Map<string, Fact | null>()
const CACHE_MAX = 64

export async function ground(
  text: string,
  t: Table,
  router: Router,
  needle?: { ready: boolean; call: (q: string, tools: string) => Promise<ToolCall[]> },
): Promise<Fact | null> {
  const key = text.trim().toLowerCase()
  if (cache.has(key)) return cache.get(key)!

  // 1. Selection: embeddings. Instant, and unlike needle it can decline.
  const hits = routeAll(text, t, router)
  const wiki = lookupFallback(text, t)

  // An explicit lookup goes to the encyclopedia first unless something else
  // clearly outscores it. Without this, any source whose anchors happen to
  // brush the topic wins on a narrow margin — and a no-argument source like
  // the ISS tracker always "succeeds", so the fallback never runs.
  const decisive = hits.length > 0 && hits[0].score >= ROUTE_THRESHOLD + LOOKUP_PREFERENCE_MARGIN
  const ordered = hits.map((h) => h.source)
  if (wiki) {
    const at = ordered.findIndex((s) => s.id === wiki.id)
    if (at >= 0) ordered.splice(at, 1)
    ordered.splice(decisive ? ordered.length : 0, 0, wiki)
  }
  if (!ordered.length) return remember(key, null)

  // Sources are tried in order rather than all at once: these are strangers'
  // free endpoints, and firing three requests to answer one question is rude.
  // The cost is latency only when the first choice actually fails.
  for (const source of ordered) {
    const fact = await attempt(text, source, t, needle)
    if (fact) return remember(key, fact)
  }
  return remember(key, null)
}

function remember(key: string, fact: Fact | null): Fact | null {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!)
  cache.set(key, fact)
  return fact
}

async function attempt(
  text: string,
  source: Source,
  t: Table,
  needle?: { ready: boolean; call: (q: string, tools: string) => Promise<ToolCall[]> },
): Promise<Fact | null> {
  // 2. Argument: needle, handed exactly one tool so it cannot mis-select.
  let arg: string | undefined
  const schema = NO_ARG.has(source.id) ? null : toolJson(source.id)
  if (needle?.ready && schema) {
    try {
      const calls = await needle.call(text, schema)
      const first = Object.values(calls[0]?.arguments ?? {}).find((v) => typeof v === 'string')
      if (typeof first === 'string' && first.trim()) arg = first.trim()
    } catch (err) {
      console.warn('ground: needle failed, falling back to regex', err)
    }
  }
  if (arg === undefined) arg = source.arg ? source.arg(text) : text

  // 3. Fetch on the host, reduce in the sandbox, capped on the way back.
  let payload: unknown
  try {
    payload = await source.fetch(arg)
  } catch (err) {
    console.warn(`ground: ${source.id} fetch failed`, err)
    return null
  }
  const fact = await reduce(source.reducer, payload)
  return fact ? rerank(text, fact, t) : null
}

/**
 * Rerank a shortlist against the query and collapse to the winner.
 *
 * A dedicated cross-encoder reranker would be 100 MB+ of ONNX. potion is
 * already resident, already L2-normalised, and scores in microseconds — so
 * relevance ordering costs nothing extra. `[0]` is the API's notion of
 * relevance; this substitutes ours.
 */
export function rerank(query: string, fact: Fact, t: Table): Fact {
  const list = fact.candidates
  if (!list?.length) return fact

  const q = embedContent(t, query)
  let best = list[0]
  let bestScore = -Infinity
  for (const c of list) {
    const score = cosine(q, embedContent(t, `${c.label} ${c.value}`))
    if (score > bestScore) {
      bestScore = score
      best = c
    }
  }
  return {
    ...fact,
    label: best.label,
    value: best.value,
    chip: best.chip ?? fact.chip,
    chipW: best.chipW ?? fact.chipW,
    chipH: best.chipH ?? fact.chipH,
    hint: `${best.label}`.split(/\s+/).slice(0, 8).join(' '),
    candidates: undefined,
  }
}

/**
 * A fact as a few lines of plain text, for the model to answer *from*.
 *
 * Compact on purpose: the point of grounding was never to hand a model a blob,
 * and a source's whole response body still never reaches it. What it gets is
 * the reduced value, its units and its age — enough to write a true sentence,
 * too little to drown in.
 */
export function factContext(fact: Fact): string {
  const lines: string[] = []
  if (fact.quantities?.length) {
    for (const q of fact.quantities) {
      if (!Number.isFinite(q.n)) continue
      const when = age(q)
      lines.push(`${fact.label}: ${format(q)}${when ? ` (${when})` : ''}`)
    }
  } else {
    lines.push(`${fact.label}: ${fact.value}`)
  }
  lines.push(`source: ${fact.src}`)
  return lines.join('\n')
}

/** Did the model already state this number itself? */
export function statesQuantity(reply: string, fact: Fact): boolean {
  return (fact.quantities ?? []).some((q) => {
    if (!Number.isFinite(q.n)) return false
    const whole = Math.round(q.n)
    return new RegExp(`\\b${whole}\\b`).test(reply)
  })
}

/**
 * Render a Fact as inline nodes. This is where the data bypasses the model
 * entirely — the value is typeset directly, never generated.
 */
export function factNodes(fact: Fact): Node[] {
  const out: Node[] = []
  if (fact.chip) out.push({ t: 'chip', src: fact.chip, alt: fact.label, w: fact.chipW, h: fact.chipH })

  if (fact.quantities?.length) {
    // Formatted here, at the last moment, from the number the source actually
    // gave — never from a string the reducer baked. Precision, units and
    // staleness are all still first-class at this point.
    fact.quantities.forEach((q, i) => {
      if (!Number.isFinite(q.n)) return
      if (i) out.push({ t: 'text', v: ' · ' })
      // Only the numeral takes colour. Accent on the whole "26°C · 8 km/h"
      // reads as a coloured block; accent on "26" reads as emphasis.
      const { number, rest } = formatParts(q)
      out.push({ t: 'deco', deco: 'color', kids: [{ t: 'text', v: number }] })
      if (rest) out.push({ t: 'text', v: rest })
    })
    // Wrapped, not point-free: `.map(age)` would hand the array index in as
    // `now` and silently date every reading to 1970.
    const when = fact.quantities.map((q) => age(q)).find(Boolean)
    if (when) out.push({ t: 'src', label: when })
  } else {
    // A textual fact is prose and is set as prose. Colouring a whole
    // encyclopedia sentence puts a slab of accent on the page — the same
    // mistake the quantities path used to make, just longer.
    out.push({ t: 'text', v: fact.value })
  }

  out.push({ t: 'src', label: fact.src, href: fact.srcUrl })
  return out
}
