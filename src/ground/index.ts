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
import { cosine, embed } from '../model/vectors'
import type { Node } from '../inline/types'
import { age, format, formatParts } from './quantity'
import { reduce, type Fact } from './sandbox'
import { SOURCES, type Source } from './sources'
import { read, search } from './search'
import { answers } from './judge'
import { ask, findDatasets } from './clickhouse'
import {
  BARS, calibrateBars, callOperation, factFrom, findOperations, verify,
  type Bars, type Verdict,
} from './operations'

export type { Fact } from './sandbox'
export { bootSandbox, sandboxReady } from './sandbox'

/**
 * The calibrated API bars, as this module sees them.
 *
 * Exported because a threshold that is measured at boot and then invisible is
 * only marginally better than one that was hardcoded — the calibration report
 * needs to print what the bars actually came out at on this model.
 */
export const apiBars = (): Bars => ({ ...BARS })

/**
 * A sentence has to be *about* the source, not merely near it.
 *
 * Measured against the router rather than fixed. 0.34 was a number that
 * described a static embedding table; in a contextual space the same figure is
 * either the noise floor or unreachable depending on the model. What survives a
 * model swap is the claim itself — beat the score an unrelated sentence gets —
 * so that is what is stored.
 */
let ROUTE_THRESHOLD = 0.34

/** The small-talk anchors, embedded at boot. Empty until `buildRouter` runs. */
let SMALL_TALK_VECS: Float32Array[] = []

/**
 * How near a sentence has to sit to the small-talk anchors to be treated as
 * small talk. Measured rather than chosen: the anchors score 0.55–0.75 against
 * each other and a real question sits well below that against all of them.
 */
const CHATTER_BAR = 0.5

/**
 * Is this someone talking, rather than asking?
 *
 * The decline used to be "no hand-written source matched", which is a different
 * statement and a much stronger one. Nothing in the ten sources is about
 * thermos flasks or why the sky is blue, so both were declined before the web
 * was ever consulted — the general path was gated behind the specialist router,
 * which is backwards. Measured across a spread of question kinds, that single
 * line was the reason explanations, entities, enumerations, comparisons and
 * dates all returned nothing.
 *
 * This asks the question the decline actually meant. "thanks" is near the
 * anchors; "who invented the thermos flask" is not, however far it sits from
 * every source qi happens to have been given.
 */
async function chatter(text: string): Promise<boolean> {
  if (!SMALL_TALK_VECS.length) return false
  const v = await embed(text)
  return SMALL_TALK_VECS.some((n) => cosine(v, n) >= CHATTER_BAR)
}

/**
 * Things people say that no source can answer. The router must score every one
 * of them below its threshold, which is how the threshold is chosen.
 */
const SMALL_TALK = [
  'what do you think',
  'hi there',
  'thanks',
  'i need help',
  'that is really beautiful',
  'i feel tired today',
  'never mind',
  'go on',
  'tell me more',
  'that makes sense',
]

/**
 * "tell me about X" and "what is X" are explicitly encyclopedia requests, and
 * the encyclopedia is therefore always in the running for them — but as the
 * *fallback*, after any source that actually claimed the sentence.
 *
 * This used to be a margin: a specialised source had to beat the router's
 * threshold by 0.18 or the encyclopedia was tried first. It was added to stop
 * "tell me about the apollo moon landing" reaching the ISS tracker, and it no
 * longer does anything of the kind — with the threshold calibrated at boot,
 * that sentence matches no source at all, and neither do "what is the moon",
 * "who was Ada Lovelace" or "tell me about the eiffel tower". Every one of them
 * comes back empty and falls to the encyclopedia on its own.
 *
 * What the margin still did was demote real matches. "what is the weather in
 * oslo" scores 0.490 against the weather anchors — comfortably over the bar,
 * comfortably under bar + 0.18 — so it was answered with a Wikipedia article
 * about Oslo. `route()` said weather and `ground()` fetched an encyclopedia
 * entry; the suite asserted the former and the app did the latter, which is how
 * it survived. Asserting the path rather than the routing decision is what
 * surfaced it.
 */

export type Router = { source: Source; vec: Float32Array }[]

/**
 * Anchors, embedded once at boot. Every source describes itself in a handful of
 * phrases and the router is the matrix of those — so adding a source is adding
 * prose, not code.
 */
export async function buildRouter(): Promise<Router> {
  const pairs = SOURCES.flatMap((source) => source.anchors.map((a) => ({ source, a })))
  const vecs = await Promise.all(pairs.map((p) => embed(p.a)))
  const router = pairs.map((p, i) => ({ source: p.source, vec: vecs[i] }))

  // The bar is whatever small talk scores, plus a little.
  //
  // The glyph bank calibrates against single common words, which is right for
  // it — it is scoring single words. Routing is not: it scores sentences, and a
  // sentence has a floor a lone word never reaches. Calibrating on words put
  // the bar under "what do you think", which then fetched an encyclopedia
  // article about nothing.
  //
  // So the null sample here is what it is actually trying to reject: things
  // people say that are not questions about the world. A route has to beat all
  // of them, because a wrong route is not cosmetic — it fetches a stranger's
  // endpoint and puts the result on screen as fact.
  const noise = await Promise.all(SMALL_TALK.map((t) => embed(t)))
  const worst = Math.max(...noise.map((v) => Math.max(...router.map((e) => cosine(v, e.vec)))))
  ROUTE_THRESHOLD = worst + 0.03

  // Kept, not discarded. The threshold above answers "is this near a
  // *specialist*", and the decline needs a different question — "is this a
  // question at all" — which only these vectors can answer. See `chatter`.
  SMALL_TALK_VECS = noise

  // The API path's bars are measured here too, against the same model, for the
  // same reason and at the same moment. A bar that is hardcoded while the
  // router's is calibrated is a bar that quietly stops meaning anything the
  // first time the embedding pack changes.
  await calibrateBars(SMALL_TALK, CALIBRATION_QUESTIONS).catch((err) => {
    console.warn('ground: could not calibrate the API bars — using defaults', err)
    return BARS
  })

  return router
}

/**
 * Real questions, used only as the positive end of the path-relevance scale.
 *
 * They are not test cases and nothing asserts on them: calibration needs to
 * know what an ordinary question looks like in this embedding space so it can
 * measure how close a meaningless field name gets to one.
 */
const CALIBRATION_QUESTIONS = [
  'what is the weather in oslo',
  'what is the population of bend oregon',
  'how much is bitcoin worth',
  'how far away is the international space station',
  'what is the exchange rate for euros',
  'when was the eiffel tower built',
]

/**
 * Questions whose honest answer is an enumeration rather than a sentence.
 * Lived in the talker until the talker was deleted; it is a property of the
 * question, so it belongs next to the thing that reads questions.
 */
const LIST_FORM =
  /^\s*(?:how (?:do|to|does|can)\b|what are\b|top\s+\d+\b|list\b|steps?\b|ways?\s+to\b|recipes?\b|ingredients\b|give me\s+\d+\b|name\s+\d+\b|\d+\s+(?:ways|things|reasons|steps)\b)/i

export const wantsList = (text: string) => LIST_FORM.test(text)

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
export async function routeAll(
  text: string,
  router: Router,
  n = 3,
): Promise<{ source: Source; score: number }[]> {
  const v = await embed(text)
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
/**
 * "Show me a photo of X" is a request for a picture, and that is a fact about
 * the sentence's *grammar*, not its topic.
 *
 * The same split LOOKUP_FORM makes, for the same reason, found the same way.
 * "show me a photo of a lighthouse in a storm at night with rain" routed to the
 * weather service: the topic words really are weather words, and the weather
 * anchors outscored the photo anchors 0.39 to 0.36. No amount of rewriting the
 * anchors fixes that, because the sentence genuinely is about a storm — it is
 * just asking for a picture of one.
 */
const PICTURE_FORM =
  /^\s*(?:show|find|get|give)\s+(?:me\s+)?(?:a|an|the|some)?\s*(?:photo|photograph|picture|pic|image|shot)\b|^\s*(?:photo|picture|image)\s+of\b|\bwhat (?:does|did) .+ look like\b/i

function pictureFallback(text: string): Source | null {
  if (!PICTURE_FORM.test(text)) return null
  return SOURCES.find((s) => s.id === 'image') ?? null
}

function lookupFallback(text: string): Source | null {
  if (!LOOKUP_FORM.test(text) || wantsList(text)) return null
  // Only if something is actually being asked *about*. This used to test
  // whether the sentence produced a non-zero vector, which was a way of asking
  // "did any word survive the vocabulary" — a static table could answer that. A
  // contextual encoder embeds everything to something, so the question has to
  // be asked directly: is there a content word here at all?
  const hasSubject = text.split(/\s+/).some((w) => w.replace(/[^a-z]/gi, '').length >= 3)
  return hasSubject ? (SOURCES.find((s) => s.id === 'wiki') ?? null) : null
}

export async function route(
  text: string,
  router: Router,
): Promise<{ source: Source; score: number } | null> {
  const v = await embed(text)
  let best: { source: Source; score: number } | null = null
  for (const entry of router) {
    const score = cosine(v, entry.vec)
    if (!best || score > best.score) best = { source: entry.source, score }
  }
  if (best && best.score >= ROUTE_THRESHOLD) return best

  const wiki = lookupFallback(text)
  return wiki ? { source: wiki, score: 0 } : null
}

/**
 * Route → fetch → sandbox → Fact. Returns null whenever anything at all goes
 * wrong; an ungrounded reply is fine, a wrong one is not.
 *
 * Routing is the embedding bank; the argument is pulled by each source's own
 * regex. There used to be a 26M encoder-decoder in this path whose whole job
 * was turning a sentence into a tool call — it is gone, because the core model
 * emits real tool calls now and a second, worse tool-caller in front of it was
 * only ever a workaround for the first model being too small to be trusted.
 */
/** Facts for repeated questions, so a turn never refetches what it just had. */
const cache = new Map<string, Grounded>()
const CACHE_MAX = 64

/** Which path produced the answer: a hand-written source, the API index, or the web. */
export type Via = string | null

export type Grounded = {
  fact: Fact | null
  via: Via
  /** Why the API path did or did not survive its gates. Absent if it never ran. */
  verdict?: Verdict
}

export async function ground(text: string, router: Router): Promise<Fact | null> {
  return (await groundTraced(text, router)).fact
}

/**
 * The same work, with the route it took reported.
 *
 * The app only ever wants the fact. A test wants to know *how* it was obtained,
 * because "returned the right value" and "returned the right value for the
 * right reason" are different properties and only the second one keeps holding
 * next week.
 */
export async function groundTraced(text: string, router: Router): Promise<Grounded> {
  const key = text.trim().toLowerCase()
  if (cache.has(key)) return cache.get(key)!

  // 1. Selection: embeddings. Instant, and unlike needle it can decline.
  const hits = await routeAll(text, router)
  const wiki = lookupFallback(text)
  const picture = pictureFallback(text)

  // An explicit lookup goes to the encyclopedia first unless something else
  // clearly outscores it. Without this, any source whose anchors happen to
  // brush the topic wins on a narrow margin — and a no-argument source like
  // the ISS tracker always "succeeds", so the fallback never runs.
  // Only the best specialist, then the encyclopedia.
  //
  // Falling through from one specialist to another is not a fallback, it is a
  // change of subject. "dollars to euros" scores 1.000 against the exchange-rate
  // anchors and 0.429 against the crypto ones; when the exchange-rate endpoint
  // was down, the crypto ticker answered and the screen said 64536 — a real
  // number, from a real host, with a real link, for a question about euros.
  //
  // The encyclopedia is different in kind and stays: it is general-purpose, so
  // it is a legitimate second answer to *any* question rather than the right
  // answer to a different one.
  const ordered = hits.slice(0, 1).map((h) => h.source)
  if (wiki) {
    const at = ordered.findIndex((s) => s.id === wiki.id)
    if (at >= 0) ordered.splice(at, 1)
    ordered.push(wiki)
  }
  // A picture request goes to the front outright, with no margin to beat.
  // Asking for a photograph is unambiguous in a way that "what is X" is not:
  // there is no reading of "show me a photo of a lighthouse" that wants a
  // temperature, however much the rest of the sentence talks about weather.
  if (picture) {
    const at = ordered.findIndex((s) => s.id === picture.id)
    if (at >= 0) ordered.splice(at, 1)
    ordered.unshift(picture)
  }
  // Nothing was even asked about. This is the decline, and it comes before any
  // fetching at all: "thanks" and "i feel tired today" must not reach an API
  // index or a search engine, because both of those always have *something* to
  // return and returning it would be an answer to a question nobody asked.
  if (!ordered.length && (await chatter(text))) {
    return remember(key, { fact: null, via: null })
  }

  // With no specialist and no small talk, the general paths below are the whole
  // answer — which is the point of having them.
  //
  // Sources are tried in order rather than all at once: these are strangers'
  // free endpoints, and firing three requests to answer one question is rude.
  // The cost is latency only when the first choice actually fails.
  //
  // These stay first and stay sequential. Each was written by someone who knew
  // what its response meant, so they are right by construction rather than by
  // inference — there is nothing for a second opinion to add.
  for (const source of ordered) {
    const fact = await attempt(text, source)
    if (fact) return remember(key, { fact, via: source.id })
  }

  // Nothing hand-written answers it. Now both remaining paths run at once.
  //
  // They used to be a fallback chain — API, then the web only if the API
  // returned nothing. That ordering encoded a belief that turns out to be
  // backwards: the API path is the one that cannot be checked. A JSON number
  // arrives with no context, no phrasing and no way to tell whether it answers
  // this question or a similar one, while a passage arrives with its own URL
  // and says what it is about. Running them together buys the one thing the
  // sequential version could never have: a second, independent opinion, which
  // is what the adjudication below spends.
  // A third path, for the questions the other two structurally cannot answer.
  //
  // "how many hacker news posts mention rust" has no endpoint and no page —
  // nobody publishes that number, it has to be counted. `clickhouse.ts` counts
  // it against a public read-only demo, and it is tried first among the general
  // paths because when it fits it is exact, and when it does not fit it returns
  // null in one embedding call.
  // All three at once, not two-then-one.
  //
  // `fromData` used to run first and be awaited before the other two started,
  // which put a model call — the one that turns a question into a query spec —
  // on the critical path of every question, including the ones no dataset can
  // answer. Measured on a turn that used none of it, the `look` step took 24 s.
  // Concurrency costs nothing here: they are independent, and the slowest is
  // the floor either way.
  const [data, api, web] = await Promise.all([fromData(text), fromApi(text), fromWeb(text)])

  // Exact beats inferred. A count over records either answers the question or
  // returns null; it has no way to be plausibly wrong the way the generic API
  // reducer does.
  if (data) return remember(key, { fact: data, via: 'data' })
  return remember(key, await adjudicate(api, web))
}

/**
 * Two answers, or one, or none.
 *
 * When both paths produce something the tie is broken by *checkability*, not by
 * confidence. If they agree, the API's value is the better thing to render — it
 * is a clean scalar rather than a sentence — and the web result is kept as
 * corroboration, which is the whole reason for having asked twice. If they
 * disagree, the web wins: a number cannot be verified by looking harder at it,
 * whereas a passage carries the URL that a person can go and read.
 */
async function adjudicate(api: ApiAnswer, web: Fact | null): Promise<Grounded> {
  if (api.fact && web) {
    const agreed = await agrees(api.fact.value, web.value)
    return agreed
      ? { fact: { ...api.fact, corroboration: web.srcUrl }, via: 'api', verdict: api.verdict }
      : { fact: web, via: 'web', verdict: api.verdict }
  }
  if (api.fact) return { fact: api.fact, via: 'api', verdict: api.verdict }
  if (web) return { fact: web, via: 'web', verdict: api.verdict }
  return { fact: null, via: null, verdict: api.verdict }
}

/**
 * Do these two say the same thing?
 *
 * Literal containment first, because it is free and because it is the case that
 * actually happens: the API says "11.3" and the passage says "currently 11.3°C
 * in Oslo". Meaning is only consulted when the strings genuinely differ, and
 * the bar it must clear was measured at boot against pairs known to disagree.
 */
async function agrees(a: string, b: string): Promise<boolean> {
  const x = a.trim().toLowerCase()
  const y = b.trim().toLowerCase()
  if (!x || !y) return false
  if (y.includes(x) || x.includes(y)) return true
  const [va, vb] = await Promise.all([embed(a), embed(b)])
  return cosine(va, vb) >= BARS.agree
}

/**
 * The catalogue, called.
 *
 * The ten built-in sources are better than this and are tried first: each one
 * was written by someone who knew what its response meant. This is what happens
 * when nobody has written that — an operation retrieved by meaning, its
 * parameters filled by the model, called through the bridge, and its response
 * read back by inference rather than by knowledge.
 *
 * The bar is deliberately high. A retrieval index of three thousand operations
 * always has a nearest one, and calling something merely near produces an
 * answer that looks exactly like a good one. Below the bar it is better to read
 * a web page, which at least says where it came from.
 */
type ApiAnswer = { fact: Fact | null; verdict: Verdict }

async function fromApi(text: string): Promise<ApiAnswer> {
  const ops = await findOperations(text, 3).catch(() => [])
  if (!ops.length) return { fact: null, verdict: { ok: false, why: 'no_op' } }

  let last: Verdict = { ok: false, why: 'below_op_bar' }
  for (const op of ops) {
    // Calibrated at boot rather than fixed at 0.5. A retrieval index of three
    // thousand operations always has a nearest one, and "nearest" is not a
    // claim about relevance until you know what nearest means in this space.
    if (op.score < BARS.op) break

    const called = await callOperation(op, text).catch(() => null)
    if (!called) {
      last = { ok: false, why: 'guessed_param' }
      continue
    }
    const read = await factFrom(op, called, text).catch(() => null)
    if (!read) {
      last = { ok: false, why: 'no_read' }
      continue
    }

    // The gate. Everything above this line produced a plausible answer; this is
    // where a plausible answer has to become a checked one or be thrown away.
    const verdict = await verify(called, read, text).catch(
      () => ({ ok: false, why: 'no_read' }) as Verdict,
    )
    last = verdict
    if (!verdict.ok) {
      console.warn(`ground: dropped ${op.title} — ${verdict.why} (${read.value})`)
      continue
    }

    let host = ''
    try {
      host = new URL(op.base).hostname.replace(/^www\./, '')
    } catch {
      host = op.title
    }
    return {
      fact: {
        label: read.label,
        value: read.value,
        src: host,
        srcUrl: called.url,
        hint: read.label.split(/\s+/).slice(0, 8).join(' '),
      },
      verdict,
    }
  }
  return { fact: null, verdict: last }
}

/**
 * The open web, reduced to one fact.
 *
 * The top result is read rather than trusted from its snippet, because a
 * snippet is written to be clicked and frequently answers a different question
 * to the one asked.
 *
 * What comes back is a stranger's text on its way into a model's context, which
 * is a prompt-injection surface and should be treated as one. Two things make
 * that survivable: it is capped hard, and it is handed on labelled as a
 * quotation from a named source rather than pasted in as though qi had
 * thought it. The model is told whose words these are.
 */
/**
 * A computation over records, when one of the public datasets covers it.
 *
 * Gated on the dataset actually being near the question rather than on the
 * question looking like a count: "how many countries are in the EU" is a
 * counting question that none of these tables can answer, and asking anyway
 * would spend a model call to produce a query over taxi trips.
 */
async function fromData(text: string): Promise<Fact | null> {
  try {
    const [near] = await findDatasets(text, 1)
    // The bar is deliberately high. This path costs a model call, and a
    // dataset that is merely the nearest of eleven is not evidence that any of
    // them is relevant.
    if (!near || near.score < 0.45) return null

    const got = await ask(text)
    if (!got) return null

    const row = got.rows[0]
    const value =
      got.rows.length === 1 && Object.keys(row).length === 1
        ? String(Object.values(row)[0])
        : got.rows
            .slice(0, 5)
            .map((r) => Object.values(r).join(' — '))
            .join('; ')

    return {
      label: got.table,
      value,
      src: 'clickhouse',
      srcUrl: 'https://play.clickhouse.com',
      // The query is the provenance. Unlike an API answer, the reader can see
      // exactly what was counted and disagree with it.
      hint: `${got.table}: ${value.slice(0, 40)}`,
    }
  } catch {
    return null
  }
}

async function fromWeb(text: string): Promise<Fact | null> {
  const hits = await search(text, 3).catch(() => [])
  if (!hits.length) return null
  const top = hits[0]

  const page = await read(top.url, 1200).catch(() => '')
  const passage = (page || top.snippet).slice(0, 900).trim()
  if (!passage) return null

  // Does this page actually answer the question, or merely mention the subject?
  //
  // Retrieval ranks by similarity, and similarity cannot tell those apart — a
  // page about Reykjavik scores well against "what is the rainfall in
  // Reykjavik" whether or not it says. Everything upstream is a proxy for this
  // question; `answerability` is the thing that was trained on it.
  //
  // Only a verdict stops anything. `null` means the pack is not installed and
  // this reads exactly as it did before.
  if ((await answers(text, passage)) === false) return null

  let host = ''
  try {
    host = new URL(top.url).hostname.replace(/^www\./, '')
  } catch {
    host = 'the web'
  }

  return {
    label: top.title.slice(0, 120),
    value: passage,
    src: host,
    srcUrl: top.url,
    hint: top.title.split(/\s+/).slice(0, 8).join(' '),
  }
}

function remember(key: string, got: Grounded): Grounded {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!)
  cache.set(key, got)
  return got
}

async function attempt(text: string, source: Source): Promise<Fact | null> {
  // 2. Argument: each source pulls its own out of the sentence.
  const arg = source.arg ? source.arg(text) : text

  // 3. Fetch on the host, reduce in the sandbox, capped on the way back.
  let payload: unknown
  try {
    payload = await source.fetch(arg)
  } catch (err) {
    console.warn(`ground: ${source.id} fetch failed`, err)
    return null
  }
  const fact = await reduce(source.reducer, payload)
  return fact ? await rerank(text, fact) : null
}

/**
 * Rerank a shortlist against the query and collapse to the winner.
 *
 * A bi-encoder, which is what the embed pack is, scores query and candidate
 * separately and compares. That is enough to reorder a shortlist and it costs
 * one batch. `[0]` is the API's notion of relevance; this substitutes ours.
 * The `rerank` pack replaces this with a cross-encoder that reads both at once,
 * which is strictly better and strictly heavier.
 */
export async function rerank(query: string, fact: Fact): Promise<Fact> {
  const list = fact.candidates
  if (!list?.length) return fact

  const [q, ...cands] = await Promise.all([
    embed(query),
    ...list.map((c) => embed(`${c.label} ${c.value}`)),
  ])
  let best = list[0]
  let bestScore = -Infinity
  list.forEach((c, i) => {
    const score = cosine(q, cands[i])
    if (score > bestScore) {
      bestScore = score
      best = c
    }
  })
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
