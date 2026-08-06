/**
 * Markdown in, blocks out, markdown back.
 *
 * The first editor was a textarea, and a textarea can only ever show you your
 * own source: you typed `# Parts` and you looked at `# Parts`, hash and all.
 * That is a file being edited, not a note being written, and the whole point of
 * the gutter was to apologise for it.
 *
 * So the document is now a list of blocks and the markdown characters never
 * exist on screen. A heading *is* bigger. A list item *has* a bullet, drawn by
 * CSS rather than typed. A quote has a rule beside it. The `#`, the `-`, the
 * `>` and the four spaces are a serialisation detail that appears only when a
 * note is written to the store, which is the one place a markdown file is
 * genuinely wanted — what gets saved is still a file a person could have typed
 * by hand, and still readable by everything else that reads markdown.
 *
 * This file is the whole conversion and it is pure. It has no DOM in it, so
 * round-tripping can be tested without a browser, which matters because
 * round-tripping is where a format like this quietly loses your text.
 *
 * Inline emphasis is deliberately small: strong, em, code. Not because more
 * could not be parsed, but because every construct added here is one that must
 * also be produced by an input rule while typing and re-serialised on save, and
 * three that work completely are worth more than eight that mostly do.
 */
import { readBlock, type BlockKind } from './blocks'

/** A run of text with at most the three marks this editor knows. */
export type Inline = { text: string; strong?: boolean; em?: boolean; code?: boolean }

export type Block = { kind: BlockKind; spans: Inline[] }

/** What each kind writes at the front of its line when serialised. */
export const PREFIX: Record<BlockKind, string> = {
  paragraph: '',
  heading: '# ',
  list: '- ',
  quote: '> ',
  code: '    ',
}

// ── inline ──────────────────────────────────────────────────────────────────

/**
 * `**strong**`, `*em*`, `` `code` ``.
 *
 * Longest marker first, so `**` is never read as two `*`. Code is matched
 * before either, because a backtick run is opaque — whatever is inside it is
 * text, and letting emphasis into it would mean `` `a * b` `` came back with
 * half of it italic.
 */
const INLINE = /`([^`]+)`|(\*\*|__)([\s\S]+?)\2|(\*|_)([^\s][\s\S]*?)\4/

export function parseInline(text: string): Inline[] {
  const out: Inline[] = []
  let rest = text

  const push = (span: Inline) => {
    if (!span.text) return
    const last = out[out.length - 1]
    // Merge touching runs with identical marks, so a paragraph is one span
    // rather than one per parse step.
    if (last && !!last.strong === !!span.strong && !!last.em === !!span.em && !!last.code === !!span.code) {
      last.text += span.text
    } else out.push(span)
  }

  while (rest) {
    const m = INLINE.exec(rest)
    if (!m) {
      push({ text: rest })
      break
    }
    push({ text: rest.slice(0, m.index) })
    if (m[1] !== undefined) push({ text: m[1], code: true })
    else if (m[3] !== undefined) push({ text: m[3], strong: true })
    else push({ text: m[5], em: true })
    rest = rest.slice(m.index + m[0].length)
  }

  return out.length ? out : [{ text: '' }]
}

/**
 * Back to markers.
 *
 * Order matters on a span carrying both: `***x***` is not something this
 * editor produces, but a note written elsewhere can arrive with it, and
 * emitting the strong marker outside the em one is the nesting every reader
 * agrees on.
 */
export function writeInline(spans: Inline[]): string {
  let out = ''
  for (const s of spans) {
    if (!s.text) continue
    if (s.code) {
      out += `\`${s.text}\``
      continue
    }
    let t = s.text
    if (s.em) t = `*${t}*`
    if (s.strong) t = `**${t}**`
    out += t
  }
  return out
}

// ── blocks ──────────────────────────────────────────────────────────────────

/**
 * Markdown to blocks.
 *
 * Every line is its own block and blank lines are dropped, because in this
 * editor pressing Return makes a new block and the space between blocks is
 * CSS. A blank line kept as an empty paragraph would be a block you could put
 * the caret in that had nothing in it and no way to tell it apart from the gap
 * above it.
 *
 * Fenced code is unwrapped rather than preserved: the fence is a way of writing
 * a code block in a text file, and once inside the editor a code block is a
 * kind, not a pair of delimiters. It is re-serialised as an indent, which is
 * the form that survives being one line at a time.
 */
export function parseDoc(md: string): Block[] {
  const out: Block[] = []
  const lines = md.replace(/\r\n?/g, '\n').split('\n')
  let fenced = false

  for (const line of lines) {
    if (/^\s{0,3}(?:`{3,}|~{3,})/.test(line)) {
      fenced = !fenced
      continue
    }
    if (fenced) {
      out.push({ kind: 'code', spans: [{ text: line }] })
      continue
    }
    if (!line.trim()) continue

    const { kind, text } = readBlock(line)
    // Nothing inside a code block is markup; it is exactly what was written.
    out.push({ kind, spans: kind === 'code' ? [{ text }] : parseInline(text) })
  }

  return out.length ? out : [{ kind: 'paragraph', spans: [{ text: '' }] }]
}

/**
 * Blocks to markdown.
 *
 * Consecutive lines of the same run — list items, or the lines of one code
 * block — are separated by a single newline so they stay one construct;
 * everything else gets a blank line, because two adjacent paragraphs joined by
 * one newline are a single paragraph to every other markdown reader and the
 * note would come back with its shape lost.
 */
export function writeDoc(blocks: Block[]): string {
  let out = ''
  blocks.forEach((b, i) => {
    if (i > 0) {
      const prev = blocks[i - 1].kind
      const run = prev === b.kind && (b.kind === 'list' || b.kind === 'code')
      out += run ? '\n' : '\n\n'
    }
    out += PREFIX[b.kind] + (b.kind === 'code' ? b.spans.map((s) => s.text).join('') : writeInline(b.spans))
  })
  return out
}

/**
 * The name of a note, from its blocks rather than from its source.
 *
 * `store/notes.ts` derives a title by stripping markdown off the first line,
 * which is correct for text arriving from anywhere. This is the same answer
 * reached the other way, and exists so the editor can show a title without
 * serialising the whole document to ask.
 */
export const titleOfDoc = (blocks: Block[]): string => {
  const first = blocks.find((b) => b.spans.some((s) => s.text.trim()))
  return first ? first.spans.map((s) => s.text).join('').trim() : ''
}
