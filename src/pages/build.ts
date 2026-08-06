/**
 * Turning what toki already knows into pages.
 *
 * Every grounded fact was already a small document — a title, a body, a source
 * and often a picture — it just had nowhere to live. Registering them as pages
 * means a fact answered once stays addressable afterwards, and a link in any
 * later reply can point back at it.
 *
 * The catalogue of sources is a page too, so `toki:sources` lists what toki can
 * actually reach. Nothing here is hand-written prose; it is generated from the
 * same registry the router uses, so it cannot go stale.
 */
import type { Fact } from '../ground'
import { put, slug, type Page } from './space'

/** A grounded answer, kept as a page so it can be linked to later. */
export function pageFromFact(fact: Fact, query: string): Page {
  const id = slug(fact.label || query)
  const lines: string[] = []

  if (fact.quantities?.length) {
    // Values stay as data in the fact record; the page shows them plainly.
    lines.push(fact.quantities.map((q) => `${q.n}${q.unit ? ' ' + q.unit : ''}`).join(' · '))
  } else if (fact.value) {
    lines.push(fact.value)
  }
  if (fact.srcUrl) lines.push(`\n[${fact.src}](${fact.srcUrl})`)

  return put({
    id,
    kind: fact.chip ? 'image' : 'source',
    title: fact.label || query,
    body: lines.join('\n'),
    aliases: [query],
    image: fact.chip,
    src: fact.src,
    srcUrl: fact.srcUrl,
  })
}

