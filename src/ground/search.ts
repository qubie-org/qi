/**
 * Searching the web, and reading what comes back.
 *
 * qi could reach ten hand-picked endpoints and nothing else. That is not a
 * small model's limitation — a 3B is perfectly capable of using a search result
 * — it is a plumbing one, and it is what made every question outside those ten
 * subjects an invented answer.
 *
 * What replaced the single backend is a metasearch: nine adapters asked at
 * once, their answers canonicalized, deduped and fused by reciprocal rank, then
 * reordered against the question by the same embedding model that places the
 * glyphs. The argument for many engines is not coverage, it is *evidence*. One
 * engine's first result is an opinion. A page four engines independently put
 * near the top is a much stronger claim, and cross-engine agreement is a signal
 * that simply does not exist when you only ask one.
 *
 * It also removes the single point of failure, and that turns out to be the
 * common case rather than the rare one: of the four HTML results pages here,
 * Mojeek currently answers with a captcha and Startpage with a proof-of-work
 * challenge — both with HTTP 200, both parsing to nothing. A design that took
 * the first backend that returned 200 would have taken those. The five open
 * corpora (Wikipedia, Hacker News, OpenAlex, the Internet Archive,
 * CommonCrawl) are the floor underneath that: keyless JSON APIs with documented
 * shapes, no captcha, and nothing to drift.
 *
 * Everything goes through the net bridge, so none of it is subject to CORS and
 * all of it is subject to the host's SSRF rules.
 */
import { cosine, embed } from '../model/vectors'
import { net } from './net'
import { renderPage } from './render'
import {
  CORPORA, SERPS, corpusUrl, parseCorpus, parseSerp, serpUrl,
  type Engine, text as htmlText,
} from './engines'
import { fuse, type Fused, type Raw } from './rank'

export type Result = {
  title: string
  url: string
  snippet: string
  /** Blended rank-fusion + semantic score. Higher is better; not a probability. */
  score?: number
  /** Which engines surfaced this. Length > 1 is cross-engine agreement. */
  engines?: string[]
}

/**
 * How much each engine's opinion counts in the fusion.
 *
 * Editorial, not calibrated — an RRF weight expresses "how much do I trust this
 * source's ordering", which has no null sample to measure against. The shape of
 * it: general web engines are the baseline at 1; Wikipedia is trusted equally
 * because when it has an article it is usually *the* answer; the specialist
 * corpora are discounted because a scholarly or news-aggregator ordering is
 * only sometimes the ordering the question wanted; CommonCrawl is discounted
 * hard because it matches on hostname rather than on meaning and is present to
 * prove a page exists, not to say it is relevant.
 */
const WEIGHTS: Record<Engine, number> = {
  ddg: 1, bing: 1, mojeek: 1, startpage: 1,
  wikipedia: 1,
  hackernews: 0.8, openalex: 0.8, archive: 0.6,
  commoncrawl: 0.3,
}

/**
 * How much the question's meaning counts against the engines' agreement.
 *
 * `blended = (1-α)·rrf_norm + α·cosine`, α = 0.5 — an even split, which is the
 * value the Elixir shipped and the one that makes the two signals argue rather
 * than one override the other. Rank fusion knows what the web links to;
 * the embedding knows what was asked. Neither is sufficient: fusion alone
 * returns the most popular page about the topic, and cosine alone happily
 * ranks a title that restates the question over the page that answers it.
 */
const ALPHA = 0.5

/**
 * A slow engine must not become everyone's latency.
 *
 * The bridge already caps a single fetch at 12s, which is the right ceiling for
 * one request and far too long to wait when eight others have already answered.
 */
const ENGINE_DEADLINE_MS = 6000

/**
 * Repeated searches are answered from memory.
 *
 * These are strangers' free endpoints. A test suite that asks the same fifteen
 * questions twice should cost one round of requests, not two, and a user who
 * rephrases and comes back should not re-run nine fetches.
 */
const cache = new Map<string, Result[]>()
const CACHE_MAX = 64

/** Which engines to ask. Exported so a test can pin the set and stay quiet. */
export const ALL_ENGINES: Engine[] = [...CORPORA, ...SERPS]

export async function search(query: string, limit = 6, engines: Engine[] = ALL_ENGINES): Promise<Result[]> {
  const q = query.trim()
  if (!q) return []

  const key = `${q.toLowerCase()}::${engines.join(',')}`
  const hit = cache.get(key)
  if (hit) return hit.slice(0, limit)

  const lists = await gather(q, engines)
  const fused = fuse(lists, WEIGHTS)
  const ranked = await rerank(q, fused)

  // Only a real answer is remembered. Caching an empty result would turn one
  // bad minute — every engine rate-limiting at once, a dropped connection —
  // into a permanent "the web has nothing on this", which is exactly the
  // failure the fan-out exists to prevent. Observed doing precisely that.
  if (ranked.length) {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!)
    cache.set(key, ranked)
  }
  return ranked.slice(0, limit)
}

/**
 * Ask every engine at once and keep whatever arrives.
 *
 * `allSettled` rather than `all`, and a deadline on each: the contract is that
 * one engine failing, hanging, rate-limiting or serving a challenge page costs
 * exactly that engine's contribution and nothing else. There is no ordering
 * here and no fallback chain, because "try the next one" is what produces a
 * result set that silently depends on which engine happened to be up.
 */
async function gather(q: string, engines: Engine[]): Promise<[string, Raw[]][]> {
  const tasks = engines.map(async (engine): Promise<[string, Raw[]]> => {
    try {
      const rows = await Promise.race([
        askOne(engine, q),
        new Promise<Raw[]>((resolve) => setTimeout(() => resolve([]), ENGINE_DEADLINE_MS)),
      ])
      return [engine, rows]
    } catch {
      return [engine, []]
    }
  })

  const settled = await Promise.allSettled(tasks)
  return settled.map((s, i) =>
    s.status === 'fulfilled' ? s.value : ([engines[i], []] as [string, Raw[]]),
  )
}

async function askOne(engine: Engine, q: string): Promise<Raw[]> {
  const isSerp = (SERPS as string[]).includes(engine)
  const url = isSerp ? serpUrl(engine as never, q) : corpusUrl(engine as never, q)
  const res = await net(url)
  if (!res.ok || !res.body) return []
  const rows = isSerp ? parseSerp(engine as never, res.body) : parseCorpus(engine as never, res.body)

  if (!rows.length && isSerp) {
    // Loudly, not silently. An empty list here is indistinguishable from "the
    // web had nothing to say", and those need different responses — this is
    // how a captcha page and a redesign both look from the inside.
    console.warn(`search: ${engine} returned no parseable results (${res.body.length}B) — blocked or moved`)
  }
  return rows
}

/**
 * Reorder the fused list against what was actually asked.
 *
 * The RRF score is min-max normalised across this candidate set before
 * blending, because its absolute magnitude is meaningless — it depends on how
 * many engines answered — while cosine is already on a fixed scale. Blending
 * the raw score would let a query that nine engines answered outweigh its own
 * semantics, and a query that two answered be dominated by them.
 */
export async function rerank(query: string, candidates: Fused[], alpha = ALPHA): Promise<Result[]> {
  if (!candidates.length) return []

  const [q, ...vecs] = await Promise.all([
    embed(query),
    ...candidates.map((c) => embed([c.title, c.snippet].filter(Boolean).join(' — ').slice(0, 400))),
  ])

  const scores = candidates.map((c) => c.score)
  const lo = Math.min(...scores)
  const hi = Math.max(...scores)
  const span = hi - lo || 1

  return candidates
    .map((c, i) => ({
      title: c.title,
      url: c.url,
      snippet: c.snippet,
      engines: c.engines,
      score: (1 - alpha) * ((c.score - lo) / span) + alpha * cosine(q, vecs[i]),
    }))
    .sort((a, b) => b.score - a.score)
}

/**
 * Read a page as prose.
 *
 * Not a browser and not a renderer: scripts, styles, navigation and footers are
 * cut, and what is left is the text. It is enough for a model to answer from
 * and small enough to summarise, which is the whole requirement — the reply is
 * one sentence, so a perfect extraction would be wasted on it.
 *
 * A page that needs JavaScript to say anything returns nearly nothing here, and
 * that is the case the native shell's headless web view is for.
 */
/**
 * Below this many characters, a page did not tell us anything.
 *
 * A shell that strips down to a nav bar and a cookie notice lands around 200;
 * a real article does not. The number is a threshold on *usable prose*, so it
 * is deliberately low — escalating is expensive, and a page that gave us three
 * sentences is a page we can use.
 */
const THIN = 320

/**
 * Where a heading stops being a heading.
 *
 * `sentences()` splits on `.!?` followed by whitespace and on nothing else, and
 * a heading carries no terminal punctuation — so `<h2>History</h2><p>The
 * company was founded…` arrives downstream as one unsplittable run, and gets
 * quoted as one. `readable()` in `research.ts` already documents the exact
 * casualty: "History [ edit ] Founding [ edit ] The company was founded in
 * 2016…", offered as a citation.
 *
 * The newline this used to insert could never have worked, because `htmlText`
 * collapses every run of whitespace to a single space on the very next line —
 * so the break was destroyed a few characters after being made. It has to be
 * punctuation to survive, and it has to be added after the collapse. A sentinel
 * marks the spot; `closeHeadings` turns it into a stop.
 *
 * Only headings, and that is the measured boundary rather than a cautious one.
 * Terminating *every* block was tried and is not here: `research.ts` identifies
 * page chrome precisely by its lack of a full stop — "navigation has no
 * sentences in it, so nothing splits it" — and a `<div>` of tag-less nav text,
 * of which Lowe's alone has several over 40 characters, would have been handed
 * the terminal stop that makes it look like prose. A heading is a complete
 * utterance and a menu is not, so only the heading gets one.
 */
const HEAD = '\u0001'

const closeHeadings = (t: string): string =>
  t.replace(new RegExp(`\\s*${HEAD}\\s*`, 'g'), (_m, at: number, whole: string) =>
    /[.!?:;,]$/.test(whole.slice(0, at).trimEnd()) ? ' ' : '. ',
  )

/**
 * A page that is about us rather than about anything.
 *
 * Cloudflare's interlude, XenForo's "Checking your browser", People Inc.'s
 * apology — these arrive with HTTP 200 and render into perfectly well-formed
 * prose, so nothing structural tells them apart from a short article. Left
 * alone they are worse than an empty read, because they *pass*: at 319
 * characters seriouseats.com clears every downstream bar, and
 *
 *     "If you are a reader experiencing an access issue, please contact
 *      support@people.inc."
 *
 * is 84 characters, ends in a full stop, is not a question, and is therefore a
 * perfectly valid quotation about how to season a carbon steel pan.
 *
 * `research.ts` argues against word lists and is right to; this is the case
 * that earns one, because there is no structural signal to use instead. What
 * keeps it honest is the conjunction: a page is only a challenge if it is
 * *short* as well as matching. A real article that discusses bot detection is
 * long, and stays. Measured against every page this corpus produced — 266
 * rendered dumps and 76 reads — the rule fires on exactly the five challenge
 * pages and on nothing over the length bound.
 */
const CHALLENGE =
  /\b(checking your browser|verifying your connection|performing security verification|security service to protect|enable javascript and cookies|experiencing an access issue|ray id|ddos protection|are you a robot|access denied)\b/i
/** Above this a page is too substantial to be an interstitial. */
const CHALLENGE_MAX = 1200

const stopped = (text: string): boolean => text.length <= CHALLENGE_MAX && CHALLENGE.test(text)

export async function read(url: string, limit = 4000): Promise<string> {
  const res = await net(url)

  if (res.ok && res.body) {
    if (res.contentType.includes('json')) return res.body.slice(0, limit)

    const stripped = res.body
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<(nav|header|footer|aside|form|svg)[\s\S]*?<\/\1>/gi, ' ')
      // A heading has to end in a stop or it fuses to the paragraph below it.
      .replace(/<\/h[1-6]>/gi, HEAD)
      // Block-level tags become breaks so sentences do not run into each other.
      .replace(/<\/(p|div|li|tr|section|article)>/gi, '\n')

    const text = closeHeadings(htmlText(stripped)).slice(0, limit)
    if (text.length >= THIN) return stopped(text) ? '' : text

    // The escalation. Only from here — a page that read fine is never rendered,
    // because rendering costs an order of magnitude more and buys nothing.
    const rendered = await renderPage(url)
    if (rendered.ok && rendered.text.length > text.length) {
      const out = rendered.text.slice(0, limit)
      if (!stopped(out)) return out
    }
    return stopped(text) ? '' : text
  }

  /**
   * A refused fetch is a page the browser may still be able to read.
   *
   * This used to return the empty string and stop, on the reasonable-sounding
   * theory that a fetch which failed has told us the page is unreachable. It
   * has not. It has told us that *this* client was refused — and the client is
   * an honest `qi/0.1` user-agent that a great many sites answer with 403.
   *
   * Measured over 38 live URLs: 12 came back thin, and **10 of those 12 were a
   * failed fetch that never reached the renderer at all**, in under 1.3 s each.
   * The browser reads some of them outright — ftc.gov 3,000 characters of real
   * rule text where the fetch got 403, wikihow 3,000, bonappetit 1,356 —
   * because it arrives over a different stack and is judged on its own terms.
   * Bot-blocks fall hardest on exactly the domains this corpus is weakest in:
   * government, recipe, health.
   *
   * The rest of what it recovers is the challenge page rather than the article,
   * which is why `stopped` exists: congress.gov, seriouseats, allrecipes and
   * investopedia all render, and all render an interstitial. Those are counted
   * as unread, not as read.
   *
   * It is not free. Every failed fetch now buys a render attempt, which the
   * host caps at 12 s, and a third of pages hang for all of it. Median read
   * went 865 ms → 1.2 s and the 90th percentile 5.2 s → 10.7 s. That is the
   * trade being made deliberately: a source that is unreadable is worth more
   * seconds than a source that is merely slow.
   *
   * Robots is still obeyed on the other side, so a site that has said no is
   * still told no — it comes back as `navigation failed: RobotsBlocked` rather
   * than as content.
   */
  const rendered = await renderPage(url)
  if (!rendered.ok) return ''
  const out = rendered.text.slice(0, limit)
  return stopped(out) ? '' : out
}
