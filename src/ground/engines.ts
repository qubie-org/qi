/**
 * Where the results come from.
 *
 * Two families, and the split is the whole reliability argument:
 *
 *   corpora   Open JSON APIs — Wikipedia, Hacker News, OpenAlex, the Internet
 *             Archive, CommonCrawl. No key, no captcha, no markup to drift, and
 *             a documented response shape. These are the floor: when every
 *             scraper is being served a challenge page, these still answer.
 *
 *   serps     Search engines' no-JavaScript results pages, parsed. Broader
 *             coverage of the live web than any corpus, and structurally
 *             fragile — they are someone else's HTML, and half of them would
 *             rather not be read by a program at all.
 *
 * Every adapter is the same pair — a URL to fetch and a parse that turns the
 * body into `[{title, url, snippet, rank}]` — so the orchestrator fans out to
 * all of them identically and the ranker fuses whatever comes back.
 *
 * Parsing is best-effort by contract. A blocked page, a challenge, a redesign
 * or a truncated body yields `[]`; nothing here throws, because one engine
 * having a bad day must not cost the user their answer.
 */
import type { Raw } from './rank'

export type Corpus = 'wikipedia' | 'hackernews' | 'openalex' | 'archive' | 'commoncrawl'
export type Serp = 'ddg' | 'mojeek' | 'startpage' | 'bing'
export type Engine = Corpus | Serp

export const CORPORA: Corpus[] = ['wikipedia', 'hackernews', 'openalex', 'archive', 'commoncrawl']
export const SERPS: Serp[] = ['ddg', 'mojeek', 'startpage', 'bing']

const enc = encodeURIComponent

/**
 * The CommonCrawl index to query.
 *
 * Pinned rather than discovered: the collection list is itself a fetch, and a
 * stale-but-present index is worth more here than a current one that costs an
 * extra round trip on every search.
 */
const CC_INDEX = 'CC-MAIN-2024-10'

// ── corpora ───────────────────────────────────────────────────────────────────

export function corpusUrl(source: Corpus, query: string, limit = 10): string {
  switch (source) {
    case 'wikipedia':
      return `https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=${limit}&srsearch=${enc(query)}`
    case 'hackernews':
      return `https://hn.algolia.com/api/v1/search?tags=story&hitsPerPage=${limit}&query=${enc(query)}`
    case 'openalex':
      return `https://api.openalex.org/works?per-page=${limit}&search=${enc(query)}`
    case 'archive':
      return `https://archive.org/advancedsearch.php?output=json&rows=${limit}&fl[]=identifier&fl[]=title&fl[]=description&q=${enc(query)}`
    case 'commoncrawl':
      // CommonCrawl indexes by host, not by topic — it answers "what pages exist
      // here", so the query is read as a domain when it looks like one.
      return `https://index.commoncrawl.org/${CC_INDEX}-index?output=json&limit=${limit}&url=${enc(`${domainOf(query)}/*`)}`
  }
}

/** A query read as a hostname, for the one engine that only speaks hostnames. */
function domainOf(query: string): string {
  const q = query.trim()
  if (/^[\w.-]+\.[a-z]{2,}$/i.test(q)) return q
  return `${q.split(/\s+/)[0] || 'example'}.com`
}

export function parseCorpus(source: Corpus, body: string): Raw[] {
  try {
    // CommonCrawl answers newline-delimited JSON, not a JSON document.
    if (source === 'commoncrawl') return rank(commonCrawlRows(body))
    const json = JSON.parse(body) as Record<string, unknown>
    return rank(corpusRows(source, json))
  } catch {
    return []
  }
}

type Row = { title: string; url: string; snippet: string }

function corpusRows(source: Corpus, json: Record<string, unknown>): Row[] {
  switch (source) {
    case 'wikipedia': {
      const hits = (json.query as { search?: unknown[] } | undefined)?.search
      if (!Array.isArray(hits)) return []
      return hits.map((raw) => {
        const h = raw as Record<string, unknown>
        const title = String(h.title ?? '')
        return {
          title,
          url: `https://en.wikipedia.org/wiki/${enc(title.replace(/ /g, '_'))}`,
          snippet: stripTags(String(h.snippet ?? '')),
        }
      })
    }
    case 'hackernews': {
      const hits = json.hits
      if (!Array.isArray(hits)) return []
      return hits
        .map((raw) => {
          const h = raw as Record<string, unknown>
          const story = `https://news.ycombinator.com/item?id=${String(h.objectID ?? '')}`
          const points = h.points ? `${h.points} points` : ''
          const text = stripTags(String(h.story_text ?? h.comment_text ?? ''))
          return {
            // The linked page is the curated artefact; the discussion is the
            // fallback when a story has no link (an Ask HN).
            title: String(h.title ?? h.story_title ?? ''),
            url: present(h.url) ?? story,
            snippet: [points, text].filter(Boolean).join(' — '),
          }
        })
        .filter((r) => r.title || r.url)
    }
    case 'openalex': {
      const works = json.results
      if (!Array.isArray(works)) return []
      return works.map((raw) => {
        const w = raw as Record<string, unknown>
        const loc = w.primary_location as Record<string, unknown> | undefined
        const venue = (loc?.source as Record<string, unknown> | undefined)?.display_name
        const year = w.publication_year
        return {
          title: String(w.title ?? w.display_name ?? ''),
          url:
            present(loc?.landing_page_url) ??
            present(w.doi) ??
            `https://openalex.org/${String(w.id ?? '').split('/').pop() ?? ''}`,
          snippet: [venue, year].filter(Boolean).map(String).join(', '),
        }
      })
    }
    case 'archive': {
      const docs = (json.response as { docs?: unknown[] } | undefined)?.docs
      if (!Array.isArray(docs)) return []
      return docs
        .map((raw) => {
          const d = raw as Record<string, unknown>
          return {
            title: asStr(d.title),
            url: `https://archive.org/details/${String(d.identifier ?? '')}`,
            snippet: asStr(d.description),
          }
        })
        .filter((r) => r.url !== 'https://archive.org/details/')
    }
    default:
      return []
  }
}

function commonCrawlRows(body: string): Row[] {
  const out: Row[] = []
  for (const line of body.split('\n')) {
    if (!line.trim()) continue
    try {
      const o = JSON.parse(line) as Record<string, unknown>
      const url = o.url
      if (typeof url !== 'string') continue
      out.push({ title: url, url, snippet: `${o.mime ?? ''} ${o.timestamp ?? ''}`.trim() })
    } catch {
      /* one bad line is not a bad response */
    }
  }
  return out
}

// ── HTML results pages ────────────────────────────────────────────────────────

type SerpSpec = {
  url: (q: string) => string
  /** The class marking a result's title link. `null` means "any <a> in an <h2>". */
  titleClass: string | null
  /** The class marking a result's snippet. */
  snippetClass: string
}

const SERP_SPEC: Record<Serp, SerpSpec> = {
  ddg: {
    url: (q) => `https://html.duckduckgo.com/html/?q=${enc(q)}`,
    titleClass: 'result__a',
    snippetClass: 'result__snippet',
  },
  mojeek: {
    url: (q) => `https://www.mojeek.com/search?q=${enc(q)}`,
    titleClass: 'title',
    snippetClass: 's',
  },
  startpage: {
    url: (q) => `https://www.startpage.com/sp/search?query=${enc(q)}`,
    titleClass: 'result-title',
    snippetClass: 'description',
  },
  bing: {
    // Bing gives its title links no class at all; what marks them is being the
    // anchor inside a result's <h2>.
    url: (q) => `https://www.bing.com/search?q=${enc(q)}`,
    titleClass: null,
    snippetClass: 'b_caption',
  },
}

export const serpUrl = (engine: Serp, query: string): string => SERP_SPEC[engine].url(query)

/**
 * Parse a results page.
 *
 * Attributes are read from the tag rather than matched in a fixed order — the
 * previous parser tried two arrangements of `class` and `href` and would have
 * missed the third. DuckDuckGo currently emits `rel` first, which neither
 * arrangement covered.
 */
export function parseSerp(engine: Serp, html: string): Raw[] {
  const spec = SERP_SPEC[engine]
  const titles =
    spec.titleClass === null ? h2Anchors(html) : anchorsWithClass(html, spec.titleClass)
  if (!titles.length) return []

  const snippets = elementsWithClass(html, spec.snippetClass).map(text)

  return rank(
    titles.map((t, i) => ({
      title: text(t.inner),
      url: t.href,
      snippet: snippets[i] ?? '',
    })),
  )
}

type Anchor = { href: string; inner: string }

/** Every `<a>` whose class list contains `want` (as a whole word or substring). */
function anchorsWithClass(html: string, want: string): Anchor[] {
  const out: Anchor[] = []
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const cls = attr(m[1], 'class')
    if (!cls || !cls.split(/\s+/).some((c) => c === want || c.includes(want))) continue
    const href = attr(m[1], 'href')
    if (href) out.push({ href: decodeEntities(href), inner: m[2] })
  }
  return out
}

/** Every `<a>` inside an `<h2>` — Bing's only marker for a result title. */
function h2Anchors(html: string): Anchor[] {
  const out: Anchor[] = []
  for (const m of html.matchAll(/<h2\b[^>]*>\s*<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = attr(m[1], 'href')
    if (href) out.push({ href: decodeEntities(href), inner: m[2] })
  }
  return out
}

/**
 * The inner HTML of every element carrying a class, whatever tag it is.
 *
 * Not a parser: it finds the opening tag and takes text until the matching
 * close of that same tag name, without tracking nesting. Snippets are leaf-ish
 * containers, so the failure mode is a snippet that runs slightly long — which
 * is trimmed anyway — rather than a wrong one.
 */
function elementsWithClass(html: string, want: string): string[] {
  const out: string[] = []
  const open = new RegExp(`<([a-z0-9]+)\\b([^>]*\\bclass=["'][^"']*${escapeRe(want)}[^"']*["'][^>]*)>`, 'gi')
  for (const m of html.matchAll(open)) {
    const cls = attr(m[2], 'class') ?? ''
    if (!cls.split(/\s+/).some((c) => c === want || c.includes(want))) continue
    const start = (m.index ?? 0) + m[0].length
    const close = html.indexOf(`</${m[1]}`, start)
    out.push(html.slice(start, close === -1 ? start + 400 : close))
  }
  return out
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** One attribute out of a tag's attribute text, quoted either way. */
function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attrs)
  return m ? (m[1] ?? m[2] ?? m[3] ?? null) : null
}

// ── shared text handling ──────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  '#x27': "'", '#39': "'", '#x2F': '/', '#47': '/', '#x26': '&', '#38': '&',
}

export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, name: string) => {
    const direct = ENTITIES[name] ?? ENTITIES[name.toLowerCase()]
    if (direct) return direct
    // Numeric references the table does not list, resolved arithmetically.
    const num = /^#x/i.test(name)
      ? parseInt(name.slice(2), 16)
      : /^#/.test(name)
        ? parseInt(name.slice(1), 10)
        : NaN
    return Number.isFinite(num) ? String.fromCodePoint(num) : whole
  })
}

/** Tags out, entities decoded, whitespace collapsed. */
export function text(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
}

const stripTags = (s: string) => text(s)

/** 1-based positions, which is what reciprocal-rank fusion consumes. */
const rank = (rows: Row[]): Raw[] =>
  rows
    .filter((r) => r.url)
    .map((r, i) => ({ title: r.title, url: r.url, snippet: r.snippet, rank: i + 1 }))

const present = (v: unknown): string | null =>
  typeof v === 'string' && v !== '' ? v : null

function asStr(v: unknown): string {
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return asStr(v[0])
  return ''
}
