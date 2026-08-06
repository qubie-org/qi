import { isSigil } from '../pages/sigils'
import { downgrade } from './downgrade'

/** Pictographs only — not every symbol, or arrows and dingbats get captured. */
const EMOJI_RE = /^\p{Extended_Pictographic}(\uFE0F|\u200D\p{Extended_Pictographic})*/u
import { isDeco, isMotif, type DecoKind, type MotifKind, type Node } from './types'

/**
 * Inline-only parser. There is deliberately no block loop — `downgrade()` has
 * already guaranteed the input is one river, so this only ever walks
 * characters and recurses into spans.
 *
 * Anything that fails to parse degrades to literal text rather than throwing.
 * A malformed `[[` should look like two brackets, not blow up the page.
 */
export function parse(src: string): Node[] {
  return groupItems(inlineParse(downgrade(src)))
}

/**
 * Collect each list item — a marker or bullet, plus everything up to the next
 * break — into one node, so the renderer can hang its wrapped lines.
 * Non-list content is passed through untouched.
 */
export function groupItems(nodes: Node[]): Node[] {
  const starts = (n: Node) =>
    (n.t === 'deco' && n.deco === 'marker') || (n.t === 'motif' && n.kind === 'dot')

  const out: Node[] = []
  let i = 0
  while (i < nodes.length) {
    const n = nodes[i]
    if (!starts(n)) {
      out.push(n)
      i++
      continue
    }
    const kids: Node[] = [n]
    i++
    while (i < nodes.length && nodes[i].t !== 'brk' && !starts(nodes[i])) {
      kids.push(nodes[i])
      i++
    }
    // The break belongs to the item boundary, not to the river.
    if (i < nodes.length && nodes[i].t === 'brk') i++
    out.push({ t: 'item', kids })
  }
  return out
}

export function inlineParse(s: string): Node[] {
  const out: Node[] = []
  let buf = ''
  let i = 0

  const flush = () => {
    if (buf) out.push({ t: 'text', v: buf })
    buf = ''
  }
  const push = (n: Node) => {
    flush()
    out.push(n)
  }

  while (i < s.length) {
    const c = s[i]

    /**
     * `/name` and `@name`, when they start a word.
     *
     * Mid-word each is something ordinary — a path, an email address — and
     * neither wants to become a chip. So both require a boundary before them,
     * which is the single rule that keeps "and/or" and "shane@example.com" out
     * of it.
     *
     * Which sigils count is `isSigil`'s business, not this loop's, and that
     * matters: `$` was a namespace once. Had this rule carried its own list,
     * removing the namespace would have left a parser still making chips out of
     * `$name` that resolve to nothing at all.
     *
     * The name is deliberately narrow: letters, digits, dash, underscore, dot.
     * One that swallowed punctuation would take the full stop at the end of the
     * sentence with it.
     */
    if (isSigil(c) && (i === 0 || /[\s(\[]/.test(s[i - 1]))) {
      const rest = /^[\w.-]+/.exec(s.slice(i + 1))
      const name = rest?.[0]?.replace(/[.]+$/, '')
      if (name && name.length >= 2) {
        push({ t: 'invoke', sigil: c, id: name })
        i += 1 + name.length
        continue
      }
    }

    // Escapes win over everything.
    if (c === '\\' && i + 1 < s.length) {
      buf += s[i + 1]
      i += 2
      continue
    }

    if (c === '\n') {
      push({ t: 'brk' })
      i++
      continue
    }

    // `code` — a run of N backticks closes on the next run of exactly N.
    if (c === '`') {
      const open = runLength(s, i, '`')
      const close = findRun(s, i + open, '`', open)
      if (close >= 0) {
        push({ t: 'code', v: s.slice(i + open, close).trim() })
        i = close + open
        continue
      }
    }

    // [[span|deco]] — decoration and glyph substitution.
    if (c === '[' && s[i + 1] === '[') {
      const end = s.indexOf(']]', i + 2)
      if (end >= 0) {
        const body = s.slice(i + 2, end)
        const bar = body.lastIndexOf('|')
        if (bar > 0) {
          const span = body.slice(0, bar)
          const spec = body.slice(bar + 1).trim()
          const node = decoNode(spec, span)
          if (node) {
            push(node)
            i = end + 2
            continue
          }
        }
      }
    }

    // ![alt](src) — an image chip riding the baseline, never a block image.
    if (c === '!' && s[i + 1] === '[') {
      const link = readLink(s, i + 1)
      if (link) {
        push({ t: 'chip', src: link.href, alt: link.text })
        i = link.end
        continue
      }
    }

    // [text](href)
    if (c === '[') {
      const link = readLink(s, i)
      if (link) {
        push({ t: 'link', href: link.href, kids: inlineParse(link.text) })
        i = link.end
        continue
      }
    }

    // **strong**
    if (c === '*' && s[i + 1] === '*') {
      const end = s.indexOf('**', i + 2)
      if (end > i + 2) {
        push({ t: 'strong', kids: inlineParse(s.slice(i + 2, end)) })
        i = end + 2
        continue
      }
    }

    // ~~strike~~
    if (c === '~' && s[i + 1] === '~') {
      const end = s.indexOf('~~', i + 2)
      if (end > i + 2) {
        push({ t: 'strike', kids: inlineParse(s.slice(i + 2, end)) })
        i = end + 2
        continue
      }
    }

    // ==sweep==
    if (c === '=' && s[i + 1] === '=') {
      const end = s.indexOf('==', i + 2)
      if (end > i + 2) {
        push({ t: 'hl', kids: inlineParse(s.slice(i + 2, end)) })
        i = end + 2
        continue
      }
    }

    // *em* / _em_ — a lone marker, not part of a doubled one.
    if ((c === '*' || c === '_') && s[i + 1] !== c) {
      const end = s.indexOf(c, i + 1)
      if (end > i + 1 && s[end + 1] !== c && !/\s/.test(s[i + 1])) {
        push({ t: 'em', kids: inlineParse(s.slice(i + 1, end)) })
        i = end + 1
        continue
      }
    }

    // A literal emoji written by the model. Promoted to a node so it is sized
    // and animated like any other glyph rather than left as stray text at full
    // display weight.
    const glyph = EMOJI_RE.exec(s.slice(i))
    if (glyph && glyph.index === 0) {
      push({ t: 'emoji', glyph: glyph[0], label: '' })
      i += glyph[0].length
      continue
    }

    // {plain english intent} — an open slot. Resolved later against the tool,
    // widget and motif banks; the parser only has to notice it.
    if (c === '{') {
      const end = s.indexOf('}', i + 1)
      const intent = end > i + 1 ? s.slice(i + 1, end) : ''
      // A slot is a short phrase. Anything long, empty, or spanning a break is
      // almost certainly stray punctuation or code, so it stays literal.
      if (end > i + 1 && intent.length <= 80 && !/[\n{]/.test(intent)) {
        push({ t: 'slot', intent: intent.trim(), kids: [] })
        i = end + 1
        continue
      }
    }

    // :motif: — only names we actually know become glyphs. Everything else
    // (times, "note:", ratios) stays as the text the user typed.
    if (c === ':') {
      const m = /^:([a-z][a-z-]{1,14}):/.exec(s.slice(i))
      if (m && isMotif(m[1])) {
        push({ t: 'motif', kind: m[1] })
        i += m[0].length
        continue
      }
    }

    buf += c
    i++
  }

  flush()
  return out
}

/** `circle` | `color` | `sub-o:burst` → a node, or null if we don't know it. */
function decoNode(spec: string, span: string): Node | null {
  const sub = /^sub-(.):(.+)$/.exec(spec)
  if (sub && isMotif(sub[2])) {
    return { t: 'sub', ch: sub[1], kind: sub[2] as MotifKind, kids: inlineParse(span) }
  }
  if (isDeco(spec)) {
    return { t: 'deco', deco: spec as DecoKind, kids: inlineParse(span) }
  }
  return null
}

function readLink(s: string, at: number): { text: string; href: string; end: number } | null {
  if (s[at] !== '[') return null
  let depth = 0
  let close = -1
  for (let j = at; j < s.length; j++) {
    if (s[j] === '\\') { j++; continue }
    if (s[j] === '[') depth++
    else if (s[j] === ']') {
      depth--
      if (depth === 0) { close = j; break }
    }
  }
  if (close < 0 || s[close + 1] !== '(') return null
  const paren = s.indexOf(')', close + 2)
  if (paren < 0) return null
  return { text: s.slice(at + 1, close), href: s.slice(close + 2, paren).trim(), end: paren + 1 }
}

function runLength(s: string, at: number, ch: string): number {
  let n = 0
  while (s[at + n] === ch) n++
  return n
}

/** Index of the next run of exactly `n` of `ch` at or after `from`. */
function findRun(s: string, from: number, ch: string, n: number): number {
  for (let j = from; j < s.length; j++) {
    if (s[j] !== ch) continue
    const len = runLength(s, j, ch)
    if (len === n) return j
    j += len - 1
  }
  return -1
}
