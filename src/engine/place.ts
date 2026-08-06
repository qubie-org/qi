/**
 * Where the glyphs go.
 *
 * Every content word is embedded and compared against a bank of motif
 * prototypes. Whatever clears the bar, and survives a density budget, gets a
 * glyph dropped beside it or a mark drawn over it. No model is involved and
 * nothing is sampled — the same sentence always decorates the same way.
 */
import { cosine, embed, type Table } from './embed'
import { plain, type DecoKind, type MotifKind, type Node } from '../inline/types'
import { matchEmoji, type EmojiBank, type EmojiHit } from './emoji'
import { salient } from './salience'

/** What each glyph is *about*, in words, so the embedding can find it. */
const MOTIF_ANCHORS: Record<MotifKind, string[]> = {
  shapes: ['shape', 'form', 'geometry', 'pattern', 'structure', 'design', 'block'],
  arrow: ['next', 'toward', 'direction', 'forward', 'leads', 'becomes', 'therefore'],
  curve: ['turn', 'bend', 'around', 'return', 'back', 'curve', 'loop'],
  dot: ['point', 'item', 'dot', 'bit', 'unit'],
}

/**
 * Marks drawn *over* a word rather than beside it.
 *
 * Only the two that sit under the text. `circle` and `box` both wrap the word
 * in an absolutely-positioned overlay, and when the word happens to start a
 * line that overlay lands off-register and cuts through the letters — it reads
 * as a rendering fault, not as someone marking up a page. Underlines and
 * scribbles are anchored to the baseline and never do this.
 */
const DECOS: DecoKind[] = ['underline']

/** A mark is a strong claim about a word, so it needs more than a glyph does. */
const DECO_MARGIN = 0.16

const STOP = new Set(
  ('a an the and or but if then than that this these those of in on at to for from by with as is are was were be been being it its it\'s ' +
    'i you he she they we me him her them us my your his their our not no yes do does did done have has had will would can could should ' +
    'about into over under out up down so very just really more most some any all what when where who how why there here')
    .split(' '),
)

export type Bank = {
  motif: { kind: MotifKind; vec: Float32Array }[]
  /** Cosine a word must clear before it earns a glyph. */
  threshold: number
}

export function buildBank(t: Table, threshold = 0.42): Bank {
  const motif: Bank['motif'] = []
  for (const [kind, anchors] of Object.entries(MOTIF_ANCHORS)) {
    for (const a of anchors) motif.push({ kind: kind as MotifKind, vec: embed(t, a) })
  }
  return { motif, threshold }
}

type Hit = { word: string; score: number; kind: MotifKind; emoji?: EmojiHit }

function best(bank: Bank, vec: Float32Array): { kind: MotifKind; score: number } {
  let kind: MotifKind = 'dot'
  let score = -1
  for (const p of bank.motif) {
    const s = cosine(vec, p.vec)
    if (s > score) {
      score = s
      kind = p.kind
    }
  }
  return { kind, score }
}

export type PlaceOpts = {
  /** Roughly one glyph per this many words. */
  perWords?: number
  maxMotifs?: number
  /** Draw a mark over the single strongest word. */
  decorate?: boolean
  /** Rotates so consecutive turns don't all get circled. */
  seed?: number
  /** How many words take an accent colour. Colour spread beats colour saved. */
  colorWords?: number
  /**
   * Emoji lexicon. Concrete nouns ("rocket", "pizza") have a picture; the
   * abstract motif bank does not, so the two complement rather than compete —
   * whichever scores higher for a word wins it.
   */
  emoji?: EmojiBank | null
  /**
   * potion-code, for `code` spans. English WordPiece shreds identifiers —
   * `useMemo` becomes `use ##me ##mo` — so code is embedded against a table
   * that has seen it. The AST already tags code nodes, so routing is free.
   */
  codeTable?: Table
}

/**
 * Returns a new tree. Text nodes are split so a glyph can sit between two
 * words; every other node type is walked but left alone.
 */
export function place(nodes: Node[], t: Table, bank: Bank, opts: PlaceOpts = {}): Node[] {
  const { perWords = 9, maxMotifs = 3, decorate = true, seed = 0, codeTable, colorWords = 2, emoji } = opts

  // Salience is judged over the whole sentence, so the flattened text is
  // needed before any per-word work begins.
  const plainText = plain(nodes)

  // 1. Score every content word in the tree, in reading order.
  const hits: (Hit & { path: number[]; index: number })[] = []
  // Every content word, glyph-worthy or not. Colour is judged separately:
  // gating it behind the motif bank meant "ocean" could never be blue unless it
  // also happened to resemble an arrow or a run of shapes.
  const seen: { word: string; vec: Float32Array; path: number[]; index: number }[] = []
  let words = 0

  const scan = (ns: Node[], path: number[]) => {
    ns.forEach((n, i) => {
      if (n.t === 'text') {
        const parts = n.v.split(/(\s+)/)
        parts.forEach((w, j) => {
          const clean = w.toLowerCase().replace(/[^a-z'-]/g, '')
          if (!clean || clean.length < 4 || STOP.has(clean)) return
          words++
          const vec = embed(t, clean)
          seen.push({ word: clean, vec, path: [...path, i], index: j })
          const { kind, score } = best(bank, vec)
          const pic = matchEmoji(clean, vec, emoji ?? null)
          // A picture of the actual thing beats an abstract mark for it.
          if (pic && pic.score >= score) {
            hits.push({ word: clean, score: pic.score, kind, emoji: pic, path: [...path, i], index: j })
          } else if (score >= bank.threshold) {
            hits.push({ word: clean, score, kind, path: [...path, i], index: j })
          }
        })
      } else if (n.t === 'item') {
        // A list is read, not declaimed. Dropping a glyph into "learn ⬭ to ski"
        // splits the phrase and reads as corruption rather than decoration.
        words += 4
      } else if (n.t === 'code' && codeTable) {
        // Identifiers get a glyph placed after the span, never inside it.
        const { kind, score } = best(bank, embed(codeTable, n.v))
        if (score >= bank.threshold) {
          hits.push({ word: n.v, score, kind, path: [...path, i], index: -1 })
        }
        words++
      } else if ('kids' in n) {
        scan(n.kids, [...path, i])
      }
    })
  }
  scan(nodes, [])

  // A copy, never the input array — callers append to what they get back, and
  // handing them the original makes that a mutation of the parsed tree.
  // Note it is `seen`, not `hits`: a sentence with no glyph-worthy word can
  // still have a word worth colouring.
  if (!seen.length) return [...nodes]

  // 2. Density budget. Strongest first, one glyph per word, spread out.
  const budget = Math.max(1, Math.min(maxMotifs, Math.round(words / perWords)))
  const ranked = [...hits].sort((a, b) => b.score - a.score)
  const chosen = ranked.slice(0, budget + (decorate ? 1 : 0))
  // Only mark a word the bank is genuinely confident about; otherwise the
  // page ends up circling whichever noun happened to score least badly.
  const decoTarget = decorate && chosen[0] && chosen[0].score >= bank.threshold + DECO_MARGIN
    ? chosen[0]
    : undefined
  const motifTargets = new Set(chosen.filter((h) => h !== decoTarget).map(key))

  // Colour is earned by meaning, not handed out by position. A word is only
  // coloured if it actually evokes one of the four — "ocean" blue, "fire" red,
  // "forest" green — so the colour tells the reader something instead of just
  // varying. Words that evoke nothing stay in ink.
  // Colour is emphasis. The coloured words are the ones the sentence is about —
  // ranked by how much they carry it — not the ones that happen to name a hue.
  // Which colour they take is the theme's, set from the turn's emoji, so the
  // page reads as one palette rather than a spelling test.
  const tones = new Map<string, number>()
  if (colorWords > 0) {
    const taken = new Set(motifTargets)
    if (decoTarget) taken.add(key(decoTarget))
    const rank = new Map(salient(plainText, t, STOP).map((s, i) => [s.word, i]))
    const chosen = seen
      .filter((w) => rank.has(w.word) && !taken.has(key(w)))
      .sort((a, b) => rank.get(a.word)! - rank.get(b.word)!)
      .slice(0, colorWords)
    // Tone 0 is the theme accent; a second emphasis takes the companion.
    chosen.forEach((w, i) => tones.set(key(w), i === 0 ? 0 : 1))
  }

  // 3. Rebuild, splicing at the chosen words.
  const deco = DECOS[Math.abs(seed) % DECOS.length]

  const rebuild = (ns: Node[], path: number[]): Node[] =>
    ns.flatMap((n, i): Node[] => {
      const here = [...path, i]
      if (n.t === 'text') {
        const parts = n.v.split(/(\s+)/)
        const out: Node[] = []
        let buf = ''
        parts.forEach((w, j) => {
          const id = `${here.join('.')}:${j}`
          const hit = hits.find((h) => key(h) === id)
          // Not gated on `hit`: colour is judged over every content word, so a
          // word can deserve a tone without ever having deserved a glyph.
          // Requiring a glyph match first is why "ocean" was never blue.
          if (!hit && !tones.has(id)) {
            buf += w
            return
          }
          if (decoTarget && key(decoTarget) === id) {
            // Punctuation stays outside the mark — a circle drawn round
            // "cycles," should not swallow the comma.
            const [, lead, core, trail] = /^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/su.exec(w)!
            if (buf + lead) out.push({ t: 'text', v: buf + lead })
            buf = ''
            out.push({ t: 'deco', deco, kids: [{ t: 'text', v: core }] })
            if (trail) buf = trail
          } else if (tones.has(id)) {
            const [, lead, core, trail] = /^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/su.exec(w)!
            if (buf + lead) out.push({ t: 'text', v: buf + lead })
            buf = ''
            out.push({ t: 'deco', deco: 'color', tone: tones.get(id), kids: [{ t: 'text', v: core }] })
            if (trail) buf = trail
          } else if (hit && motifTargets.has(id)) {
            buf += w
            if (buf) out.push({ t: 'text', v: buf })
            buf = ''
            out.push(
              hit.emoji
                ? { t: 'emoji', glyph: hit.emoji.glyph, label: hit.emoji.label }
                : { t: 'motif', kind: hit.kind },
            )
          } else {
            buf += w
          }
        })
        if (buf) out.push({ t: 'text', v: buf })
        return out
      }
      if (n.t === 'code') {
        const hit = hits.find((h) => key(h) === `${here.join('.')}:-1`)
        return hit && motifTargets.has(key(hit))
          ? [n, { t: 'motif', kind: hit.kind } as Node]
          : [n]
      }
      if ('kids' in n) return [{ ...n, kids: rebuild(n.kids, here) } as Node]
      return [n]
    })

  return rebuild(nodes, [])
}

const key = (h: { path: number[]; index: number }) => `${h.path.join('.')}:${h.index}`

/** Exposed for tuning: what would this sentence get, and how strongly? */
export function explain(text: string, t: Table, bank: Bank): Hit[] {
  return text
    .split(/\s+/)
    .map((w) => w.toLowerCase().replace(/[^a-z'-]/g, ''))
    .filter((w) => w.length >= 4 && !STOP.has(w))
    .map((w) => ({ word: w, ...best(bank, embed(t, w)) }))
    .sort((a, b) => b.score - a.score)
}
