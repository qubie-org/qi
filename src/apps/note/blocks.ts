/**
 * The five kinds of thing a line can be.
 *
 * This is the vocabulary shared by three otherwise unrelated pieces: the
 * markdown parser in `doc.ts`, the CSS that draws a heading as a heading, and
 * the Tab key. Keeping it in one small file with no imports is what stops those
 * three from disagreeing about how many kinds there are.
 *
 * The cycle is fixed and short — paragraph, heading, list, quote, code, back —
 * because Tab is a key you press repeatedly to hunt for what you want, and a
 * cycle you cannot exhaust in five presses is a menu wearing a keystroke.
 *
 * Note what a kind is *not*: it is not a prefix. In the editor a heading is a
 * block with `data-kind="heading"` and larger type, and the `#` exists only in
 * the file on disk. `readBlock` below is therefore a *parser* — it is how
 * markdown arriving from the store, or from a paste, is understood — and not
 * how the editor represents anything.
 */

export type BlockKind = 'paragraph' | 'heading' | 'list' | 'quote' | 'code'

/** The order Tab walks. Ordinary first, then progressively more marked-up. */
export const CYCLE: BlockKind[] = ['paragraph', 'heading', 'list', 'quote', 'code']

/**
 * The gutter's vocabulary.
 *
 * Glyphs rather than words because the gutter sits beside the writing and a
 * word there is a label on a form. Now that the blocks draw themselves, the
 * gutter is no longer explaining markup you can see — it names what Tab is
 * about to change, which is the only thing about a block that is invisible.
 */
export const GLYPH: Record<BlockKind, string> = {
  paragraph: '¶',
  heading: '#',
  list: '•',
  quote: '❝',
  code: '›',
}

/** What the gutter's tooltip says, and what a screen reader announces. */
export const LABEL: Record<BlockKind, string> = {
  paragraph: 'paragraph',
  heading: 'heading',
  list: 'list item',
  quote: 'quote',
  code: 'code',
}

export const isKind = (s: string): s is BlockKind => (CYCLE as string[]).includes(s)

/**
 * Read one line of markdown: what kind it is, and what it says.
 *
 * Code is tested first: four leading spaces are unambiguous, and testing them
 * later would let `    - item` be read as a list whose prefix starts four
 * characters in, so the indentation would be silently eaten.
 *
 * The list pattern accepts ordered markers as well as bullets, so a line typed
 * `1. ` is recognised as the list it plainly is. It comes back as a bullet,
 * which is the honest cost of having one list kind in the cycle rather than
 * two.
 */
export function readBlock(line: string): { kind: BlockKind; prefix: string; text: string } {
  const code = /^ {4}/.exec(line)
  if (code) return { kind: 'code', prefix: code[0], text: line.slice(code[0].length) }

  const heading = /^ {0,3}#{1,6}[ \t]+/.exec(line)
  if (heading) return { kind: 'heading', prefix: heading[0], text: line.slice(heading[0].length) }

  const list = /^ {0,3}(?:[-*+]|\d{1,3}[.)])[ \t]+/.exec(line)
  if (list) return { kind: 'list', prefix: list[0], text: line.slice(list[0].length) }

  const quote = /^ {0,3}>[ \t]?/.exec(line)
  if (quote) return { kind: 'quote', prefix: quote[0], text: line.slice(quote[0].length) }

  return { kind: 'paragraph', prefix: '', text: line }
}

export const kindOf = (line: string): BlockKind => readBlock(line).kind

/** The next kind round the cycle. */
export function nextKind(kind: BlockKind): BlockKind {
  const at = CYCLE.indexOf(kind)
  return CYCLE[(at + 1) % CYCLE.length]
}

/**
 * What typing a marker at the start of a block means.
 *
 * The input rule that makes the editor feel like markdown without ever
 * containing any: type `# ` and the block becomes a heading and the two
 * characters vanish. Returns null for anything that is not a complete marker,
 * so an ordinary sentence beginning "1980 was" is not turned into a list by its
 * first four characters.
 */
export function markerFor(typed: string): BlockKind | null {
  if (/^#{1,6} $/.test(typed)) return 'heading'
  if (/^[-*+] $/.test(typed)) return 'list'
  if (/^\d{1,3}[.)] $/.test(typed)) return 'list'
  if (/^> $/.test(typed)) return 'quote'
  if (/^ {4}$/.test(typed)) return 'code'
  if (/^```$/.test(typed)) return 'code'
  return null
}
