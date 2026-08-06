/**
 * The address space.
 *
 * TinyOS's shape, borrowed: documents are outlines, links between them are the
 * navigation, and addresses resolve two ways — an explicit id wins, otherwise
 * the vector space decides. "Soft + deterministic", in its words.
 *
 * Here the documents are rivers. A page is just text that goes through the same
 * `parse` → `place` → `River` path a reply does, so pages inherit the inline
 * system, the emoji, the marks and the theme for free. An app is a page that
 * also *does* something.
 *
 * Addresses look like `qi:weather` in a link href. Anything else stays an
 * ordinary external link and opens in a new tab.
 */
import { cosine, embed, nullSample } from '../model/vectors'

export const SCHEME = 'qi:'

export type PageKind = 'page' | 'app' | 'source' | 'image' | 'skill' | 'action'

export type Page = {
  id: string
  kind: PageKind
  title: string
  /** Inline-format body. Rendered through the same river as a reply. */
  body: string
  /** Extra phrasings that should resolve here, beyond the title. */
  aliases?: string[]
  /** Set for `kind: 'image'` — the picture this page is about. */
  image?: string
  /** Where the content came from, if anywhere. */
  src?: string
  srcUrl?: string
}

const pages = new Map<string, Page>()
/** Rebuilt lazily whenever the set of pages changes. */
let index: { id: string; vec: Float32Array }[] | null = null

export function put(page: Page): Page {
  pages.set(page.id, page)
  index = null; softFloor = null
  return page
}

export function get(id: string): Page | undefined {
  return pages.get(id)
}

export function all(): Page[] {
  return [...pages.values()]
}

export function clear(): void {
  pages.clear()
  index = null; softFloor = null
}

/** `qi:id` → `id`. Returns null for ordinary links. */
export function addressOf(href: string): string | null {
  if (!href.startsWith(SCHEME)) return null
  return decodeURIComponent(href.slice(SCHEME.length)).trim().toLowerCase()
}

export const address = (id: string) => `${SCHEME}${encodeURIComponent(id)}`

/** Ids are stable, lowercase and hyphenated, so a title always maps to one. */
export function slug(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

/**
 * Resolve an address to a page.
 *
 * Deterministic first: an exact id always wins, so a link that names something
 * precisely can never drift. Soft second: if nothing matches, the address is
 * embedded and compared against every page, which is what makes a link to
 * something merely *described* still land somewhere sensible.
 */
/**
 * Async, unlike the render path, and deliberately so. Resolving a name is a
 * navigation — it happens when someone follows a link or the agent opens a
 * page, never inside a paint — so it can afford to wait for a vector rather
 * than miss and degrade.
 */
/**
 * How well an address that means nothing matches the best page.
 *
 * Measured alongside the index rather than fixed, for the same reason the glyph
 * bank measures its own: 0.55 was right for a static embedding table and
 * meaningless for a contextual one, where it sat either side of the noise
 * depending on the model. A description has to beat the words that describe
 * nothing here — which is a claim that survives changing the model.
 */
let softFloor: number | null = null

export async function resolve(
  addr: string,
  threshold?: number,
): Promise<{ page: Page; exact: boolean; score: number } | null> {
  const id = addr.trim().toLowerCase()
  const exact = pages.get(id) ?? pages.get(slug(id))
  if (exact) return { page: exact, exact: true, score: 1 }
  if (pages.size === 0) return null

  if (!index) {
    const entries = [...pages.values()]
    const vecs = await Promise.all(
      entries.map((p) => embed(`${p.title} ${p.aliases?.join(' ') ?? ''}`)),
    )
    index = entries.map((p, i) => ({ id: p.id, vec: vecs[i] }))

    const noise = await Promise.all(nullSample(40).map((w) => embed(w)))
    const best = noise
      .map((v) => Math.max(...index!.map((e) => cosine(v, e.vec))))
      .sort((a, b) => a - b)
    // The 90th percentile, not the maximum: one unrelated word will always
    // happen to sit near one page, and letting that single case set the bar
    // would make every soft match impossible.
    softFloor = best[Math.floor(0.9 * (best.length - 1))] ?? 0.3
  }
  const v = await embed(addr)
  let best: { id: string; score: number } | null = null
  for (const entry of index) {
    const score = cosine(v, entry.vec)
    if (!best || score > best.score) best = { id: entry.id, score }
  }
  if (!best || best.score < (threshold ?? softFloor ?? 0.3)) return null
  const page = pages.get(best.id)
  return page ? { page, exact: false, score: best.score } : null
}
