/**
 * The editing surface: a contenteditable whose DOM *is* the document.
 *
 * The rule this file exists to enforce is that **no markdown character is ever
 * on screen**. A heading is a block with larger type, not a line beginning with
 * a hash; a list item has a bullet drawn by CSS, not a hyphen someone typed.
 * Markdown is what `doc.ts` writes when the note is saved and what it reads
 * when the note is opened, and in between it does not exist.
 *
 * Two decisions keep this from becoming an editor framework.
 *
 * **The browser does the editing.** Typing, Return, Backspace, selection,
 * paste-as-text, IME and the native undo stack are all left alone, and this
 * file only *normalises* afterwards: every top-level child must be a block with
 * a kind, and blocks created by splitting inherit a kind chosen by rule. The
 * alternative — intercepting keys and rebuilding the DOM by hand — is how a
 * hand-rolled editor loses undo and breaks input methods, and it is a great
 * deal more code for a worse result.
 *
 * **Input rules use `execCommand`.** Turning `**x**` into bold means deleting
 * four characters and inserting an element; done through `execCommand` it stays
 * one undoable step, and done by assigning DOM properties it silently empties
 * the undo stack. WebKit still implements the two commands used here, which was
 * verified in this shell rather than assumed. What is *not* undoable is a
 * change of block kind, because that is an attribute rather than an edit —
 * Tab twice to come back rather than ⌘Z.
 */
import { isKind, markerFor, readBlock, type BlockKind } from './blocks'
import { parseDoc, parseInline, writeInline, type Block, type Inline } from './doc'

const BLOCK = 'blk'

// ── blocks to DOM ───────────────────────────────────────────────────────────

function spanEl(s: Inline): Node {
  if (!s.strong && !s.em && !s.code) return document.createTextNode(s.text)
  // Nested rather than one element with several classes, so the DOM says the
  // same thing the markdown does and reading it back needs no special case.
  let node: Node = document.createTextNode(s.text)
  if (s.code) {
    const c = document.createElement('code')
    c.appendChild(node)
    node = c
  }
  if (s.em) {
    const i = document.createElement('em')
    i.appendChild(node)
    node = i
  }
  if (s.strong) {
    const b = document.createElement('strong')
    b.appendChild(node)
    node = b
  }
  return node
}

export function blockEl(block: Block): HTMLElement {
  const el = document.createElement('div')
  el.className = BLOCK
  el.dataset.kind = block.kind
  const spans = block.spans.filter((s) => s.text)
  if (!spans.length) {
    // An empty block still needs a line box, or it collapses to nothing and
    // there is nowhere to put the caret.
    el.appendChild(document.createElement('br'))
  } else for (const s of spans) el.appendChild(spanEl(s))
  return el
}

export function renderInto(root: HTMLElement, blocks: Block[]): void {
  root.replaceChildren(...blocks.map(blockEl))
}

// ── DOM back to blocks ──────────────────────────────────────────────────────

/**
 * Read the marks off an element tree.
 *
 * Marks are inherited down the walk rather than looked up per text node, which
 * is what makes `<strong><em>x</em></strong>` come back as one span carrying
 * both instead of two spans that each forgot the other.
 */
function spansOf(node: Node, marks: Omit<Inline, 'text'> = {}, out: Inline[] = []): Inline[] {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      // Two kinds of invisible character are scaffolding rather than content
      // and must not reach the file: the zero-width spaces the inline rule
      // leaves behind to park the caret outside a new element, and the
      // non-breaking spaces WebKit substitutes for a space typed at the end of
      // a line. A note full of U+00A0 looks identical and behaves differently
      // in every other tool that opens it.
      const text = (child.textContent ?? '').replace(/​/g, '').replace(/ /g, ' ')
      if (text) out.push({ text, ...marks })
      continue
    }
    if (!(child instanceof HTMLElement)) continue
    if (child.tagName === 'BR') continue
    const tag = child.tagName
    spansOf(
      child,
      {
        ...marks,
        strong: marks.strong || tag === 'STRONG' || tag === 'B',
        em: marks.em || tag === 'EM' || tag === 'I',
        code: marks.code || tag === 'CODE',
      },
      out,
    )
  }
  return out
}

export function readDoc(root: HTMLElement): Block[] {
  const out: Block[] = []
  for (const el of Array.from(root.children)) {
    if (!(el instanceof HTMLElement)) continue
    const kind = el.dataset.kind
    out.push({ kind: isKind(kind ?? '') ? (kind as BlockKind) : 'paragraph', spans: spansOf(el) })
  }
  return out.length ? out : [{ kind: 'paragraph', spans: [{ text: '' }] }]
}

// ── the invariant ───────────────────────────────────────────────────────────

/**
 * Every top-level child is a block with a known kind, and there is at least
 * one.
 *
 * Contenteditable is a shared surface: the browser adds nodes on Return, paste
 * and drag, and not all of them look like the ones this file makes. Rather than
 * forbid that — which means intercepting every gesture — the shape is repaired
 * afterwards, so an unexpected node is a transient rather than a corruption.
 */
export function normalize(root: HTMLElement): void {
  if (!root.firstChild) {
    root.appendChild(blockEl({ kind: 'paragraph', spans: [] }))
    return
  }
  for (const node of Array.from(root.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (!node.textContent?.trim()) {
        node.remove()
        continue
      }
      // Loose text at the top level: give it a block rather than dropping it.
      const el = blockEl({ kind: 'paragraph', spans: [{ text: node.textContent }] })
      node.replaceWith(el)
      continue
    }
    if (!(node instanceof HTMLElement)) continue
    node.classList.add(BLOCK)
    if (!isKind(node.dataset.kind ?? '')) node.dataset.kind = 'paragraph'
    // A block emptied by deleting its last character loses its line box with
    // it, and the caret has nowhere to sit.
    if (!node.firstChild) {
      node.appendChild(document.createElement('br'))
      continue
    }
    // And once there is real content, that placeholder must go, or the block
    // carries a blank line in front of its own first word.
    if ((node.textContent ?? '') !== '') {
      for (const br of Array.from(node.querySelectorAll('br'))) br.remove()
    }
  }
}

// ── where the caret is ──────────────────────────────────────────────────────

export function blockOf(node: Node | null, root: HTMLElement): HTMLElement | null {
  let el: Node | null = node
  while (el && el !== root) {
    if (el instanceof HTMLElement && el.parentElement === root) return el
    el = el.parentNode
  }
  return null
}

export function caretBlock(root: HTMLElement): HTMLElement | null {
  const sel = document.getSelection()
  if (!sel || !sel.anchorNode || !root.contains(sel.anchorNode)) return null
  return blockOf(sel.anchorNode, root)
}

export function kindAt(root: HTMLElement): BlockKind {
  const el = caretBlock(root)
  const kind = el?.dataset.kind
  return isKind(kind ?? '') ? (kind as BlockKind) : 'paragraph'
}

/** Put the caret at the very start of a block. */
export function caretToStart(el: HTMLElement): void {
  const range = document.createRange()
  range.setStart(el, 0)
  range.collapse(true)
  const sel = document.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
}

// ── input rules ─────────────────────────────────────────────────────────────

/**
 * `# ` at the start of a block makes it a heading, and the characters go away.
 *
 * This is the whole reason the editor can be markdown-native without ever
 * showing markdown: the marker is a gesture, consumed at the moment it is
 * complete. Only at the very start of a block, so a hyphen mid-sentence is a
 * hyphen.
 */
function markerRule(root: HTMLElement): boolean {
  const sel = document.getSelection()
  const el = caretBlock(root)
  if (!sel?.isCollapsed || !el || !sel.rangeCount) return false

  // Everything between the start of the block and the caret, whatever the DOM
  // in between happens to be. The first version of this compared the caret's
  // node against `el.firstChild` and never fired, because an empty block's
  // first child is the `<br>` that gives it a line box — so the marker was
  // typed into the second node and the rule looked at the wrong one. A range
  // has no opinion about structure, which is the point.
  const caret = sel.getRangeAt(0)
  const pre = document.createRange()
  pre.selectNodeContents(el)
  pre.setEnd(caret.startContainer, caret.startOffset)

  // A trailing space typed at the end of a line is a non-breaking space in
  // WebKit — that is how contenteditable stops the browser collapsing it — so
  // `# ` arrives as `# ` and matches no pattern written with a real space.
  // This cost an hour and is invisible in every editor that shows you the DOM.
  const kind = markerFor(pre.toString().replace(/ /g, ' '))
  if (!kind || el.dataset.kind === kind) return false

  sel.removeAllRanges()
  sel.addRange(pre)
  // Through the command so the deletion joins the undo stack rather than
  // wiping it.
  if (!document.execCommand('delete')) return false
  el.dataset.kind = kind
  return true
}

/**
 * `**x**`, `*x*` and `` `x` `` become marks the moment they close.
 *
 * Applied only to the text immediately before the caret, and only when the
 * match ends exactly there — so a closing marker is what triggers it, and
 * emphasis written earlier in the line is never silently re-parsed while
 * somebody edits the other end of the sentence.
 */
const CLOSERS = /(?:\*\*([^*\n]+)\*\*|(?<!\*)\*([^*\n]+)\*(?!\*)|`([^`\n]+)`)$/

function inlineRule(root: HTMLElement): boolean {
  const sel = document.getSelection()
  if (!sel || !sel.isCollapsed || !sel.anchorNode || sel.anchorNode.nodeType !== Node.TEXT_NODE) return false
  const el = caretBlock(root)
  // Code blocks are literal. Everything in them is text, including asterisks.
  if (!el || el.dataset.kind === 'code') return false

  const node = sel.anchorNode
  const before = (node.textContent ?? '').slice(0, sel.anchorOffset)
  const m = CLOSERS.exec(before)
  if (!m) return false

  const inner = m[1] ?? m[2] ?? m[3]
  const tag = m[1] ? 'strong' : m[2] ? 'em' : 'code'

  const range = document.createRange()
  range.setStart(node, sel.anchorOffset - m[0].length)
  range.setEnd(node, sel.anchorOffset)
  sel.removeAllRanges()
  sel.addRange(range)
  const html = `<${tag}>${escapeHtml(inner)}</${tag}>​`
  if (!document.execCommand('insertHTML', false, html)) return false
  // Order matters: scrub first, then place the caret. Scrubbing moves nodes
  // around and would invalidate a selection set before it.
  scrub(el)
  escapeMark(tag)
  return true
}

/**
 * Undo what `insertHTML` adds on its way past.
 *
 * WebKit preserves the *computed* style of whatever it replaced, so every
 * inline rule leaves `style="font-size: clamp(…)"` frozen at the size that
 * block happened to be — Tab the block to a heading afterwards and the words
 * inside the bold run stay small. It also wraps loose text in `<span>`s that
 * mean nothing and nest one level deeper on every keystroke.
 *
 * This runs here rather than in `normalize` on purpose. Rearranging nodes
 * destroys any selection pointing into them, and `normalize` runs after *every*
 * input — including the ordinary ones where nothing needs scrubbing and the
 * caret is the only thing that matters. Doing it only where the mess is made,
 * and re-placing the caret immediately after, is what keeps typing from
 * silently continuing inside the element that was just created.
 */
function scrub(el: HTMLElement): void {
  for (const styled of Array.from(el.querySelectorAll<HTMLElement>('[style]'))) {
    styled.removeAttribute('style')
  }
  for (const span of Array.from(el.querySelectorAll('span'))) {
    span.replaceWith(...Array.from(span.childNodes))
  }
}

/** The command whose *typing state* each mark leaves switched on. */
const TYPING_STATE: Record<string, string | undefined> = { strong: 'bold', em: 'italic' }

/**
 * Stop the next keystroke from landing inside the mark just made.
 *
 * This one took three wrong theories to pin down, so it is worth writing the
 * answer next to them. Typing `milk and **good** bread` produced "milk and
 * **good bread**" — the word after the closing marker was silently absorbed
 * into the bold run.
 *
 * It was not the caret's position: after the rule ran, the caret was already in
 * a text node that is a *sibling* of the `<strong>`, not a child. It was not
 * the trailing zero-width space, which was there and correct. It was not
 * `normalize()` merging text nodes and invalidating the range, though it was
 * doing that too and is fixed separately.
 *
 * It is that WebKit models bold as a **typing style** — an editing state that
 * outlives the selection — and `queryCommandState('bold')` returns true the
 * moment the caret has been inside a bold element. Everything typed afterwards
 * is bold by that state, wherever the caret happens to be, and WebKit merges it
 * into the adjacent element. Toggling the command off is the only thing that
 * clears it; `removeFormat` returns false on a collapsed selection and does
 * nothing. Code has no typing style and never showed the bug, which is exactly
 * why it looked like a caret problem for so long.
 */
function escapeMark(tag: string): void {
  const sel = document.getSelection()
  const node = sel?.anchorNode
  if (!sel || !node) return
  const from = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
  const marked = from?.closest(tag)

  if (marked?.parentNode) {
    let after = marked.nextSibling
    if (!after || after.nodeType !== Node.TEXT_NODE) {
      after = document.createTextNode('​')
      marked.parentNode.insertBefore(after, marked.nextSibling)
    }
    const range = document.createRange()
    range.setStart(after, (after.textContent ?? '').length)
    range.collapse(true)
    sel.removeAllRanges()
    sel.addRange(range)
  }

  const command = TYPING_STATE[tag]
  if (command && document.queryCommandState(command)) document.execCommand(command)
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'))

/** Both rules, cheapest first. Returns true when the document changed. */
export function runInputRules(root: HTMLElement): boolean {
  return markerRule(root) || inlineRule(root)
}

/**
 * The safety net: re-read a whole block as markdown.
 *
 * `inlineRule` only fires on the keystroke that closes a marker, which is the
 * right trigger while someone is typing forwards and the wrong one for every
 * other way text arrives — pasted mid-line, dictated, autocorrected, or typed
 * out of order by going back and adding the opening asterisks afterwards. In
 * all of those the markers end up sitting in the text as characters, which is
 * exactly the leak this editor exists to prevent.
 *
 * So when the caret leaves a block, that block is re-parsed from its own plain
 * text. Only when it would actually change, because rebuilding a block moves
 * the caret and this must not touch the one being typed in.
 */
export function reflowInline(el: HTMLElement): boolean {
  if (el.dataset.kind === 'code') return false
  const text = (el.textContent ?? '').replace(/​/g, '').replace(/ /g, ' ')
  const spans = parseInline(text)
  // Nothing to do unless a marker was actually found and consumed.
  if (spans.length === 1 && !spans[0].strong && !spans[0].em && !spans[0].code) return false
  const fresh = blockEl({ kind: el.dataset.kind as BlockKind, spans })
  el.replaceChildren(...Array.from(fresh.childNodes))
  return true
}

/**
 * What a new block should be, given what was split.
 *
 * Lists and code continue — that is what those constructs are for. A heading or
 * a quote does not: the line after a heading is prose, and having to Tab out of
 * a heading every time is the sort of thing that makes people stop using
 * headings.
 */
export const kindAfter = (kind: BlockKind): BlockKind =>
  kind === 'list' || kind === 'code' ? kind : 'paragraph'

/**
 * Repair the split the browser just made.
 *
 * WebKit clones the block being split, attributes and all, so the new block
 * arrives claiming to be a heading. This runs after the event, sets the kind by
 * rule, and implements the one behaviour every editor has: Return on an empty
 * list item leaves the list rather than making another empty one.
 */
export function afterReturn(root: HTMLElement, was: BlockKind): void {
  normalize(root)
  const el = caretBlock(root)
  if (!el) return
  const previous = el.previousElementSibling
  // The block just left is finished, so any markers still sitting in it as
  // characters are markers the incremental rule did not catch. This is the
  // last moment they can be turned into marks without disturbing anyone.
  if (previous instanceof HTMLElement) reflowInline(previous)
  const leftEmpty = previous instanceof HTMLElement && !(previous.textContent ?? '').trim()

  if (leftEmpty && was !== 'paragraph') {
    // Stepping out of a list: the empty item becomes the new paragraph, and the
    // block the browser made is redundant.
    previous.dataset.kind = 'paragraph'
    if (!(el.textContent ?? '').trim()) {
      el.remove()
      caretToStart(previous)
      return
    }
  }
  el.dataset.kind = kindAfter(was)
}

/**
 * Backspace at the very start of a block un-marks it before it merges it.
 *
 * The gesture everyone already has for "this should not be a list": put the
 * caret in front and press Backspace. Returns true when it handled the press,
 * so ordinary merging is left to the browser.
 */
export function backspaceAtStart(root: HTMLElement): boolean {
  const sel = document.getSelection()
  const el = caretBlock(root)
  if (!sel?.isCollapsed || !el || el.dataset.kind === 'paragraph') return false
  const range = sel.getRangeAt(0)
  const start = document.createRange()
  start.selectNodeContents(el)
  start.setEnd(range.startContainer, range.startOffset)
  if (start.toString().length) return false
  el.dataset.kind = 'paragraph'
  return true
}

/**
 * Paste arrives as markdown, never as HTML.
 *
 * Whatever was copied, what lands is text, and text is parsed by the same
 * function that reads a note off the store. So pasting a heading from anywhere
 * gives a heading here, and pasting a page of foreign HTML gives its words
 * rather than its stylesheet.
 */
export function pasteMarkdown(root: HTMLElement, text: string): boolean {
  const blocks = parseDoc(text)
  if (!blocks.length) return false
  const html = blocks.map((b) => blockEl(b).outerHTML).join('')
  // Single-block pastes stay inline — pasting three words mid-sentence should
  // not break the sentence into its own paragraph.
  if (blocks.length === 1) {
    const one = blocks[0]
    const inline = one.kind === 'code' ? escapeHtml(writeInline(one.spans)) : blockEl(one).innerHTML
    const ok = document.execCommand('insertHTML', false, inline)
    const el = caretBlock(root)
    if (el) scrub(el)
    return ok
  }
  const ok = document.execCommand('insertHTML', false, html)
  for (const el of Array.from(root.children)) if (el instanceof HTMLElement) scrub(el)
  return ok
}

/** Re-parse a line of markdown, for tests and for reading a note in. */
export const lineToBlock = (line: string): Block => {
  const { kind, text } = readBlock(line)
  return { kind, spans: kind === 'code' ? [{ text }] : parseInline(text) }
}
