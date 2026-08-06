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
 * Addresses look like `toki:weather` in a link href. Anything else stays an
 * ordinary external link and opens in a new tab.
 */
import { cosine, embedContent, type Table } from '../engine/embed'

export const SCHEME = 'toki:'

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
  index = null
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
  index = null
}

/** `toki:id` → `id`. Returns null for ordinary links. */
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
export function resolve(
  addr: string,
  t?: Table,
  threshold = 0.55,
): { page: Page; exact: boolean; score: number } | null {
  const id = addr.trim().toLowerCase()
  const exact = pages.get(id) ?? pages.get(slug(id))
  if (exact) return { page: exact, exact: true, score: 1 }
  if (!t || pages.size === 0) return null

  if (!index) {
    index = [...pages.values()].map((p) => ({
      id: p.id,
      vec: embedContent(t, `${p.title} ${p.aliases?.join(' ') ?? ''}`),
    }))
  }
  const v = embedContent(t, addr)
  let best: { id: string; score: number } | null = null
  for (const entry of index) {
    const score = cosine(v, entry.vec)
    if (!best || score > best.score) best = { id: entry.id, score }
  }
  if (!best || best.score < threshold) return null
  const page = pages.get(best.id)
  return page ? { page, exact: false, score: best.score } : null
}
