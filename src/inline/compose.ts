/**
 * Where a picture goes in a sentence, and how big it is when it gets there.
 *
 * Two decisions, previously both wrong. The image was appended after the last
 * word, so it stood apart from the text instead of sitting in it; and its size
 * came from aspect ratio alone, so a two-line float could be handed a six-word
 * reply with nothing left to wrap around it and end up stranded.
 *
 * Placement follows the reference sheets: a picture belongs beside the noun it
 * depicts, mid-sentence, the way "And [img] that pattern is simple" reads.
 * Size follows what the text can actually support.
 */
import { cosine, embed, type Table } from '../engine/embed'
import type { Node } from './types'

export type Shape = 'band' | 'wide' | 'tall' | 'inline'

/** Words needed before a floated picture has anything to flow around it. */
const WORDS_FOR_FLOAT = 14
/** Below this, even a panorama has to sit in the line. */
const WORDS_FOR_BAND = 26

/**
 * Pick a treatment from the picture's real shape *and* the text available.
 *
 * A float with too little text beside it reads as a dropped object, so the
 * text length is a hard gate rather than a preference: no amount of landscape
 * makes a six-word sentence able to wrap.
 */
export function shapeFor(w: number | undefined, h: number | undefined, wordCount: number): Shape {
  if (!w || !h) return 'inline'
  const ratio = w / h
  if (ratio >= 2.2) return wordCount >= WORDS_FOR_BAND ? 'band' : 'inline'
  if (ratio >= 1.25) return wordCount >= WORDS_FOR_FLOAT ? 'wide' : 'inline'
  if (ratio <= 0.8) return wordCount >= WORDS_FOR_FLOAT ? 'tall' : 'inline'
  return 'inline'
}

export function countWords(nodes: Node[]): number {
  let n = 0
  const walk = (ns: Node[]) => {
    for (const node of ns) {
      if (node.t === 'text') n += node.v.split(/\s+/).filter(Boolean).length
      else if ('kids' in node) walk(node.kids)
    }
  }
  walk(nodes)
  return n
}

/**
 * Insert a chip after the word it most resembles.
 *
 * The alt text is embedded once and compared against each content word, so a
 * lighthouse photograph lands on "lighthouse" rather than after the full stop.
 * If nothing in the sentence is close enough the chip goes at the end, which is
 * where it used to always go — the fallback, not the rule.
 */
export function placeChip(
  nodes: Node[],
  chip: Extract<Node, { t: 'chip' }>,
  t: Table,
  threshold = 0.45,
): Node[] {
  // A float only wraps text that comes *after* it. Dropped mid-sentence it
  // moves to the next line while the words already laid out stay put, and the
  // picture ends up printed over them — which is exactly what happened to
  // "lighthouse". Floats therefore lead the paragraph; only chips that sit in
  // the line can be placed beside a specific word.
  if (chip.shape === 'wide' || chip.shape === 'tall' || chip.shape === 'band') {
    return [chip, ...nodes]
  }

  type Spot = { path: number[]; index: number; score: number }
  const target = embed(t, chip.alt)

  // Collected and reduced rather than assigned inside the closure: TypeScript
  // cannot see writes through a callback, and narrows the captured variable to
  // `never` at every later use.
  const spots: Spot[] = []
  const scan = (ns: Node[], path: number[]) => {
    ns.forEach((node, i) => {
      if (node.t === 'text') {
        node.v.split(/(\s+)/).forEach((word, j) => {
          const clean = word.toLowerCase().replace(/[^a-z'-]/g, '')
          if (clean.length < 4) return
          spots.push({ path: [...path, i], index: j, score: cosine(target, embed(t, clean)) })
        })
      } else if ('kids' in node) {
        scan(node.kids, [...path, i])
      }
    })
  }
  scan(nodes, [])

  const at = spots.reduce<Spot | null>((b, s) => (!b || s.score > b.score ? s : b), null)
  if (!at || at.score < threshold) return [...nodes, chip]
  const rebuild = (ns: Node[], path: number[]): Node[] =>
    ns.flatMap((node, i): Node[] => {
      const here = [...path, i]
      const onPath = at.path.length === here.length && at.path.every((p, k) => p === here[k])
      if (node.t === 'text' && onPath) {
        const parts = node.v.split(/(\s+)/)
        const before = parts.slice(0, at.index + 1).join('')
        const after = parts.slice(at.index + 1).join('')
        return [
          ...(before ? [{ t: 'text', v: before } as Node] : []),
          chip,
          ...(after ? [{ t: 'text', v: after } as Node] : []),
        ]
      }
      if ('kids' in node) return [{ ...node, kids: rebuild(node.kids, here) } as Node]
      return [node]
    })

  return rebuild(nodes, [])
}
