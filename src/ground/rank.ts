/**
 * Fusing several engines' opinions into one ranked list.
 *
 * This is the only clever part of a metasearch and it is deliberately pure: no
 * network, no model, no clock. Given per-engine result lists it canonicalizes
 * every URL, dedupes by the canonical form, and scores by reciprocal rank —
 * so a page three engines each put fourth beats a page one engine put first.
 *
 * Canonicalization is what makes the dedupe real. The same Wikipedia article
 * arrives from DuckDuckGo wrapped in a `uddg=` redirector, from Bing wrapped in
 * a base64 `ck/a` redirector, and from the Wikipedia adapter bare — three
 * strings, one destination. Without unwrapping, cross-engine agreement can
 * never be observed and the fusion degenerates into "whatever the first engine
 * said", which is the thing it exists to replace.
 *
 * Ported from the Elixir that proved it (`Nexus.Browse.Search.Rank`).
 */

/** One engine's opinion: where it ranked a result, 1-based. */
export type Raw = { title: string; url: string; snippet: string; rank: number }

/** The merged verdict, with provenance kept so the caller can see agreement. */
export type Fused = {
  title: string
  url: string
  snippet: string
  score: number
  engines: string[]
}

/**
 * What a second engine's agreement is worth.
 *
 * Small on purpose. It has to be enough to lift a result that two engines
 * ranked mid-page over one that a single engine ranked first, and not so much
 * that agreement alone outweighs position — five engines agreeing on a bad
 * result is still a bad result.
 */
const AGREEMENT_BONUS = 0.1

/**
 * Parameters that identify the click rather than the page. Two URLs differing
 * only in these are the same document, and keeping them splits the vote.
 */
const STRIP_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'fbclid', 'gclid', 'msclkid', 'ref', 'ref_src', 'ref_url', 'rut', 'spm',
])

/** Whitespace collapsed, ends trimmed. Engines indent their HTML. */
export const collapse = (s: string | null | undefined): string =>
  (s ?? '').replace(/\s+/g, ' ').trim()

/**
 * Bing hides the destination in base64: `?u=a1<base64url of the real url>`.
 * Not obfuscation so much as an artefact of their click tracker, and trivially
 * reversible — but only if you know to look, which is why it is here rather
 * than in the Bing adapter: the ranker owns every notion of "same page".
 */
function unBing(param: string): string | null {
  const raw = param.startsWith('a1') ? param.slice(2) : param
  const b64 = raw.replace(/-/g, '+').replace(/_/g, '/')
  try {
    const out = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
    return out.startsWith('http') ? out : null
  } catch {
    return null
  }
}

/**
 * Follow a redirector to what it actually points at.
 *
 * Handles DuckDuckGo's `uddg=`, Bing's base64 `u=`, and the generic `?url=` /
 * `?u=` shape that half the web uses. One hop is enough in practice; looping
 * would invite a crafted URL to spin here.
 */
function unwrap(input: string): string {
  const url = input.startsWith('//') ? `https:${input}` : input
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url
  }

  const host = parsed.hostname.toLowerCase()
  const p = parsed.searchParams

  if (host.includes('duckduckgo.com')) {
    const target = p.get('uddg')
    if (target?.startsWith('http')) return target
  }
  if (host.includes('bing.com')) {
    const u = p.get('u')
    const target = u && unBing(u)
    if (target) return target
  }
  const generic = p.get('url') ?? p.get('u')
  if (generic?.startsWith('http')) return generic

  return url
}

/**
 * A URL reduced to a stable identity, or null if it is not one.
 *
 * Everything here is about making equal things compare equal: the scheme is
 * forced to https because http/https duplicates are the same document, `www.`
 * goes because it is a deployment detail, the fragment goes because it names a
 * position within a page rather than a page, tracking parameters go, and what
 * survives is sorted so parameter order stops mattering.
 */
export function canonicalUrl(input: string | null | undefined): string | null {
  if (!input) return null
  let parsed: URL
  try {
    parsed = new URL(unwrap(input.trim()))
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (!parsed.hostname) return null

  const host = parsed.hostname.toLowerCase().replace(/^www\./, '')

  const kept: [string, string][] = []
  parsed.searchParams.forEach((v, k) => {
    if (!STRIP_PARAMS.has(k.toLowerCase())) kept.push([k, v])
  })
  kept.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1))
  const query = new URLSearchParams(kept).toString()

  // A trailing slash is not a different page — except on the root, where the
  // empty path is not a URL at all.
  const path = (parsed.pathname || '/').replace(/\/$/, '') || '/'

  return `https://${host}${path}${query ? `?${query}` : ''}`
}

/** The same fields, but the URL may have failed to canonicalize. */
export type Normalized = Omit<Raw, 'url'> & { url: string | null }

/** Canonical URL, collapsed text, and a rank that is always a number. */
export function normalize(r: Partial<Raw>): Normalized {
  return {
    title: collapse(r.title),
    snippet: collapse(r.snippet),
    rank: r.rank ?? 99,
    url: canonicalUrl(r.url),
  }
}

/** First occurrence of each canonical URL wins; the rest are the same page. */
export function dedupe(results: Partial<Raw>[]): Raw[] {
  const seen = new Set<string>()
  const out: Raw[] = []
  for (const r of results.map(normalize)) {
    if (!r.url || seen.has(r.url)) continue
    seen.add(r.url)
    out.push(r as Raw)
  }
  return out
}

/** The longer of two strings — engines truncate titles differently. */
const better = (a: string, b: string): string => (b.length > a.length ? b : a)

/**
 * Reciprocal-rank fusion.
 *
 * Each engine contributes `weight / position` to whatever it ranked, results
 * are pooled by canonical URL, and a result several engines found gets a bonus
 * per extra engine. Reciprocal rank rather than raw position because the gap
 * between first and second matters far more than the gap between ninth and
 * tenth, and no engine's absolute score is comparable to another's anyway.
 */
export function fuse(
  lists: [string, Partial<Raw>[]][],
  weights: Record<string, number> = {},
): Fused[] {
  type Rec = { url: string; title: string; snippet: string; score: number; engines: Set<string> }
  const pool = new Map<string, Rec>()

  for (const [engine, results] of lists) {
    const w = weights[engine] ?? 1
    for (const raw of results) {
      const r = normalize(raw)
      if (!r.url) continue
      const contribution = w / Math.max(r.rank, 1)
      const prev = pool.get(r.url)
      if (prev) {
        prev.score += contribution
        prev.engines.add(engine)
        prev.title = better(prev.title, r.title)
        prev.snippet = better(prev.snippet, r.snippet)
      } else {
        pool.set(r.url, {
          url: r.url,
          title: r.title,
          snippet: r.snippet,
          score: contribution,
          engines: new Set([engine]),
        })
      }
    }
  }

  return [...pool.values()]
    .map((rec) => ({
      title: rec.title,
      url: rec.url,
      snippet: rec.snippet,
      score: rec.score + (rec.engines.size - 1) * AGREEMENT_BONUS,
      engines: [...rec.engines].sort(),
    }))
    .sort((a, b) => b.score - a.score)
}
