/**
 * The block killer.
 *
 * Models emit CommonMark whether you ask them to or not. qi has no block
 * boxes at all — no headings, no lists, no fences, no tables, no paragraphs —
 * so every block construct is folded back into the single river of text
 * *before* the inline parser ever sees it. Nothing is dropped; it changes
 * shape.
 *
 * Output convention: a single "\n" means one flow break. Nothing else in the
 * returned string is a newline.
 */

/** Stands in for "a break survives here" while newlines are still meaningful. */
const S = '\u0001'

export function downgrade(src: string): string {
  let s = src.replace(/\r\n?/g, '\n')

  // 1. Fenced code collapses to inline code. Do this first so nothing below
  //    reinterprets a '#' or '-' that happened to live inside a snippet.
  s = s.replace(
    /^ {0,3}(`{3,}|~{3,})[^\n]*\n([\s\S]*?)^ {0,3}\1[^\n]*$/gm,
    (_m, _fence: string, body: string) => '`' + body.replace(/\s+/g, ' ').trim() + '`',
  )
  // Unterminated fence: keep the body, lose the fence.
  s = s.replace(/^ {0,3}(?:`{3,}|~{3,})[^\n]*$/gm, '')

  // 2. Tables → cells joined by a separator dot, alignment row discarded.
  s = s.replace(/^ {0,3}\|?[ :|-]*-[ :|-]*\|?[ \t]*$/gm, '')
  s = s.replace(/^ {0,3}\|(.+)\|[ \t]*$/gm, (_m, row: string) =>
    row.split('|').map((c) => c.trim()).filter(Boolean).join(' :dot: '),
  )

  // 3. Headings keep their emphasis but lose their box: they become `loud`.
  s = s.replace(/^ {0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm, (_m, txt: string) => `[[${txt}|loud]]`)
  s = s.replace(/^([^\n]+)\n {0,3}(?:={2,}|-{2,})[ \t]*$/gm, (_m, txt: string) => `[[${txt}|loud]]`)

  // 4. Thematic break → a breath with a dot in it.
  s = s.replace(/^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/gm, `${S}:dot:${S}`)

  // 5. Blockquote → a quote mark, inline.
  s = s.replace(/^ {0,3}> ?/gm, '\u201c')

  // 6. Lists keep their ordering — bullets become a dot glyph, numbers /
  //    letters / roman numerals become inline markers — and each item takes
  //    its own line. That line is a flow break in the river, not a list box:
  //    no <ul>, no <li>, no margins, nothing that can be called a block.
  s = s.replace(/^ {0,3}[-*+][ \t]+/gm, `${S}:dot: `)
  s = s.replace(/^ {0,3}(\d{1,3})[.)][ \t]+/gm, `${S}[[$1|marker]] `)
  // Single letters and roman numerals only, so a sentence opening "Note. …"
  // is never mistaken for a list item.
  s = s.replace(/^ {0,3}([a-zA-Z]|[ivxIVX]{2,4})[.)][ \t]+/gm, `${S}[[$1|marker]] `)

  // 7. Raw HTML has no place in a river of type.
  s = s.replace(/<\/?[a-zA-Z][^>]*>/g, '')

  // 8. Whitespace → flow. Blank lines are the only breaks that survive, and
  //    they collapse: however much air the model left, you get exactly one.
  s = s.replace(/[ \t]+/g, ' ')
  s = s.replace(/\n[ ]*\n[\s]*/g, S)
  s = s.replace(/\n/g, ' ')
  s = s.split(S).map((part) => part.trim()).filter(Boolean).join('\n')

  return s.replace(/ {2,}/g, ' ').trim()
}
