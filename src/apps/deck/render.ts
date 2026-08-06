/**
 * A deck's markdown, turned into slides.
 *
 * reveal.js can parse markdown itself, via a plugin that reads a `<textarea
 * data-template>` and splits it on a separator. That path is not taken here,
 * and the reason is the same one that runs through the rest of this codebase:
 * a document assembled by code is a document you can test, and one assembled by
 * a plugin from a string is one you can only look at.
 *
 * So the split happens here, in a function that takes text and returns
 * sections, and reveal is handed finished DOM. It also means a slide can carry
 * things markdown has no syntax for — a citation with its source URL, a note
 * that a claim came from a source the gate had refused — without inventing a
 * markdown extension nobody else will ever read.
 *
 * ── The separator ───────────────────────────────────────────────────────────
 *
 * `---` alone on a line, which is reveal's own convention and also markdown's
 * horizontal rule. The ambiguity is real and is resolved the way reveal
 * resolves it: at the top level it is a slide break, and a rule inside a slide
 * has to be written some other way. In a deck, wanting a horizontal rule is
 * rare; wanting a slide break is the entire format.
 *
 * A leading `---` block is frontmatter, not an empty first slide — `/present`
 * writes one, and a deck that opened on a blank screen because its own metadata
 * counted as a slide would be an obvious bug that is easy to avoid here.
 */

export type Slide = {
  /** The heading, if the slide opens with one. */
  heading?: string
  /** Everything else, as markdown. */
  body: string
  /** Sources cited on this slide, in the order they appear. */
  cites: { title: string; url: string }[]
}

/** `key: value` lines in a leading `---` block. */
export function frontmatterOf(text: string): { fields: Record<string, string>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text)
  if (!m) return { fields: {}, body: text }
  const fields: Record<string, string> = {}
  for (const line of m[1].split('\n')) {
    const at = line.indexOf(':')
    if (at > 0) fields[line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }
  return { fields, body: text.slice(m[0].length) }
}

/**
 * A citation line.
 *
 * `> quote` followed by `[title](url)` is exactly what `/research` already
 * writes into a note, so a deck built from research output and a deck someone
 * typed by hand use one syntax. Parsed rather than rendered as a link because a
 * source belongs in the slide's footer, not inline in the middle of a bullet.
 */
const CITE = /^\s*\[([^\]]+)\]\(([^)\s]+)\)\s*$/

export function slidesFrom(markdown: string): Slide[] {
  const { body } = frontmatterOf(markdown)

  return body
    .split(/\n---[ \t]*\n/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const lines = chunk.split('\n')
      const cites: Slide['cites'] = []
      const kept: string[] = []

      for (const line of lines) {
        const c = CITE.exec(line)
        if (c) cites.push({ title: c[1], url: c[2] })
        else kept.push(line)
      }

      let heading: string | undefined
      const first = kept.findIndex((l) => l.trim())
      if (first >= 0) {
        const h = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(kept[first])
        if (h) {
          heading = h[2].trim()
          kept.splice(first, 1)
        }
      }

      return { heading, body: kept.join('\n').trim(), cites }
    })
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * Just enough markdown for a slide.
 *
 * Bullets, blockquotes, bold, italic and code — which is the whole vocabulary a
 * slide actually uses. Deliberately not a markdown library: the input is not
 * arbitrary text off the internet, it is text this app wrote or a person typed
 * into this app, and 40 lines that handle the five constructs a deck needs beat
 * a dependency that handles ninety it never will.
 *
 * Everything is escaped before any markup is added, so a claim containing `<` —
 * a comparison, an arrow, a snippet of code — renders as itself rather than as
 * a broken tag.
 */
export function inlineHtml(md: string): string {
  const out: string[] = []
  let list: 'ul' | null = null
  let quote = false

  const closeList = () => {
    if (list) {
      out.push(`</${list}>`)
      list = null
    }
  }
  const closeQuote = () => {
    if (quote) {
      out.push('</blockquote>')
      quote = false
    }
  }

  const spans = (s: string): string =>
    esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*]+)\*/g, '$1<em>$2</em>')

  for (const raw of md.split('\n')) {
    const line = raw.trimEnd()
    if (!line.trim()) {
      closeList()
      closeQuote()
      continue
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line)
    if (bullet) {
      closeQuote()
      if (!list) {
        list = 'ul'
        out.push('<ul>')
      }
      out.push(`<li>${spans(bullet[1])}</li>`)
      continue
    }

    const q = /^\s*>\s?(.*)$/.exec(line)
    if (q) {
      closeList()
      if (!quote) {
        quote = true
        out.push('<blockquote>')
      }
      out.push(`<p>${spans(q[1])}</p>`)
      continue
    }

    const h = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      closeList()
      closeQuote()
      out.push(`<h${h[1].length}>${spans(h[2])}</h${h[1].length}>`)
      continue
    }

    closeList()
    closeQuote()
    out.push(`<p>${spans(line)}</p>`)
  }

  closeList()
  closeQuote()
  return out.join('\n')
}

/** One slide, as a reveal `<section>`. */
export function slideHtml(slide: Slide): string {
  const parts: string[] = []
  if (slide.heading) parts.push(`<h2>${esc(slide.heading)}</h2>`)
  if (slide.body) parts.push(inlineHtml(slide.body))
  if (slide.cites.length) {
    // Sources are shown, never linked out of. A deck opened full-screen that
    // navigates away on a stray click has lost the reader's place, and the
    // whole point of carrying the citation is that it is visible.
    parts.push(
      `<footer class="cites">${slide.cites
        .map((c) => `<span title="${esc(c.url)}">${esc(c.title)}</span>`)
        .join('')}</footer>`,
    )
  }
  return `<section>\n${parts.join('\n')}\n</section>`
}

export const deckHtml = (markdown: string): string => slidesFrom(markdown).map(slideHtml).join('\n')
