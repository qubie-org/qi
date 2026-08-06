/**
 * Where the glyphs go.
 *
 * Every content word is embedded and compared against a bank of motif
 * prototypes. Whatever clears the bar, and survives a density budget, gets a
 * glyph dropped beside it or a mark drawn over it. No model is involved and
 * nothing is sampled — the same sentence always decorates the same way.
 */
import { cosine, embed, known, nullSample, warm } from '../model/vectors'
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

export const STOP = new Set(
  ('a an the and or but if then than that this these those of in on at to for from by with as is are was were be been being it its it\'s ' +
    'i you he she they we me him her them us my your his their our not no yes do does did done have has had will would can could should ' +
    'about into over under out up down so very just really more most some any all what when where who how why there here')
    .split(' '),
)

export type Bank = {
  motif: { kind: MotifKind; vec: Float32Array }[]
  /** Cosine a word must clear before it earns a glyph. Measured, not chosen. */
  threshold: number
}

/**
 * Where "no relation" actually sits, for this bank and this model.
 *
 * The threshold used to be 0.42, which was right for a static embedding table
 * and meaningless for anything else — swapping the model moved the whole
 * distribution and every word suddenly cleared the bar. So it is measured:
 * score a sample of ordinary words against the prototypes, and take a high
 * percentile of *that* as the floor. A word earns a glyph by beating the words
 * that deserve nothing, whatever space they happen to live in.
 */
async function measureThreshold(motif: Bank['motif']): Promise<number> {
  const bank: Bank = { motif, threshold: -1 }
  const vecs = await Promise.all(nullSample().map((w) => embed(w)))
  const scores = vecs.map((v) => best(bank, v).score).sort((a, b) => a - b)
  return scores[Math.floor(0.92 * (scores.length - 1))] ?? 0.2
}

/**
 * The prototypes, embedded once at boot.
 *
 * Async now, and that is the whole shape of the embedding pivot: a real model
 * cannot answer during a render pass, so anything that is a fixed set of
 * strings gets encoded up front and the render path only ever reads the cache.
 */
export async function buildBank(threshold?: number): Promise<Bank> {
  const motif: Bank['motif'] = []
  const anchors = Object.entries(MOTIF_ANCHORS)
  const vecs = await Promise.all(anchors.flatMap(([, list]) => list.map((a) => embed(a))))
  let at = 0
  for (const [kind, list] of anchors) {
    for (let i = 0; i < list.length; i++) motif.push({ kind: kind as MotifKind, vec: vecs[at++] })
  }
  return { motif, threshold: threshold ?? (await measureThreshold(motif)) }
}

type Hit = { word: string; score: number; kind: MotifKind; emoji?: EmojiHit }

/** Content words that must sit between two marks, so they never cluster. */
const GAP = 3

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
  /** Roughly one mark per this many content words. */
  perWords?: number
  /** Hard ceiling on marks in one turn, whatever the length. */
  maxMotifs?: number
  /** Draw a mark over the single strongest word. */
  decorate?: boolean
  /** Rotates so consecutive turns don't all get circled. */
  seed?: number
  /**
   * Emoji lexicon. Concrete nouns ("rocket", "pizza") have a picture; the
   * abstract motif bank does not, so the two complement rather than compete —
   * whichever scores higher for a word wins it.
   */
  emoji?: EmojiBank | null
}

/**
 * Returns a new tree. Text nodes are split so a glyph can sit between two
 * words; every other node type is walked but left alone.
 */
export function place(nodes: Node[], bank: Bank, opts: PlaceOpts = {}): Node[] {
  const {
    perWords = 4,
    maxMotifs = 3,
    decorate = true,
    seed = 0,
    emoji,
  } = opts

  // Salience is judged over the whole sentence, so the flattened text is
  // needed before any per-word work begins.
  const plainText = plain(nodes)

  // 1. Score every content word in the tree, in reading order.
  const hits: (Hit & { path: number[]; index: number })[] = []
  // Every content word, glyph-worthy or not. Colour is judged separately:
  // gating it behind the motif bank meant "ocean" could never be blue unless it
  // also happened to resemble an arrow or a run of shapes.
  const seen: { word: string; vec: Float32Array; path: number[]; index: number; proper: boolean }[] = []
  let words = 0
  /**
   * Words this pass could not score because their vector is not cached yet.
   * They render plainly and are warmed on the way out, so the next pass — one
   * frame later, or the next keystroke — decorates them. A word is only ever
   * cold once in the lifetime of the app.
   */
  const cold: string[] = []

  const scan = (ns: Node[], path: number[]) => {
    ns.forEach((n, i) => {
      if (n.t === 'text') {
        const parts = n.v.split(/(\s+)/)
        parts.forEach((w, j) => {
          const clean = w.toLowerCase().replace(/[^a-z'-]/g, '')
          if (!clean || clean.length < 4 || STOP.has(clean)) return
          words++
          const vec = known(clean)
          if (!vec) {
            cold.push(clean)
            return
          }
          // A capital that is not the first word of the sentence is a name.
          // Crude, and right nearly always — which for a mark that only ever
          // offers to say more is a good enough standard.
          const bare = w.replace(/^[^\p{L}\p{N}]+/u, '')
          const proper = /^\p{Lu}/u.test(bare) && !(path.length === 0 && i === 0 && j === 0)
          seen.push({ word: clean, vec, path: [...path, i], index: j, proper })
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
      } else if (n.t === 'code') {
        // Identifiers get a glyph placed after the span, never inside it.
        // There is no second table for code any more: English WordPiece used to
        // shred `useMemo` into `use ##me ##mo`, which is what the potion-code
        // table existed to fix. A byte-level tokenizer has no such problem, so
        // 17 MB of second vocabulary went away with it.
        const codeVec = known(n.v)
        if (!codeVec) {
          cold.push(n.v)
          words++
          return
        }
        const { kind, score } = best(bank, codeVec)
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
  if (cold.length) warm(cold)

  // A copy, never the input array — callers append to what they get back, and
  // handing them the original makes that a mutation of the parsed tree.
  // Note it is `seen`, not `hits`: a sentence with no glyph-worthy word can
  // still have a word worth colouring.
  if (!seen.length) return [...nodes]

  // 2. One budget, one mark per word, and air between them.
  //
  // This used to be three independent decisions. Glyphs had a budget, colour
  // had its own, and the underline had a third, so a sentence could carry four
  // motifs, three coloured words and a rule — eight marks, none of them aware
  // of the others. The result was a word like "current" wearing a colour, a
  // dot and an underline at once, and a page that read as crowded and
  // arbitrary rather than as designed.
  //
  // Three rules fix it, and they are worth stating because they are the whole
  // difference between "decorated" and "designed":
  //
  //   one budget    every kind of mark competes for the same small allowance,
  //                 so more colour means fewer glyphs rather than both
  //   one per word  a word gets the single strongest mark it earned, never two
  //   spacing       marks may not land within GAP content words of each other,
  //                 so they punctuate the sentence instead of clustering
  //
  // Variety then comes from *which* words are marked and *how*, which changes
  // sentence to sentence, rather than from marking more of them.
  const rank = new Map(salient(plainText, STOP).map((s, i) => [s.word, i]))

  /**
   * Two marks, and both of them do something.
   *
   * There were four. A glyph beside a word because the word resembled an arrow;
   * a rule under whichever noun scored highest; a colour on the words the
   * sentence was about. All three were decoration — they varied without
   * signifying, and a reader learned nothing from any of them. Colour was the
   * last to go and the most distracting of the three, because it was the one
   * that looked most like it meant something.
   */
  type Mark =
    | { kind: 'emoji'; emoji: EmojiHit }
    /** A proper noun or a concept: pressing it asks for more about it. */
    | { kind: 'term' }
  type Candidate = { at: string; order: number; score: number; mark: Mark }

  const candidates: Candidate[] = []
  const glyphs = new Map(hits.map((h) => [key(h), h]))

  seen.forEach((w, order) => {
    const id = key(w)
    const hit = glyphs.get(id)
    // Salience decides whether a word is worth marking at all; the kind of mark
    // is decided by what the word turned out to have.
    const carries = rank.has(w.word) ? 1 - rank.get(w.word)! / Math.max(1, rank.size) : 0

    // A proper noun is the strongest candidate there is, and it is decided by
    // spelling rather than by meaning: a capital in the middle of a sentence is
    // a name, and a name is the thing a reader is most likely to want more
    // about. No embedding involved, so it is right every time it fires.
    if (w.proper) {
      candidates.push({ at: id, order, score: 1 + carries, mark: { kind: 'term' } })
      return
    }

    if (hit?.emoji) {
      candidates.push({ at: id, order, score: hit.score + carries, mark: { kind: 'emoji', emoji: hit.emoji } })
      return
    }
    // The words the sentence is actually about become terms too — that is the
    // "concepts" half of it. Anything below that bar gets nothing, because a
    // mark that means "this word was moderately important" is the decoration
    // this pass exists to stop making.
    if (carries > 0.55) {
      candidates.push({ at: id, order, score: carries, mark: { kind: 'term' } })
    }
  })

  const budget = Math.max(1, Math.min(maxMotifs, Math.round(words / perWords)))
  const taken: Candidate[] = []
  for (const c of [...candidates].sort((a, b) => b.score - a.score)) {
    if (taken.length >= budget) break
    if (taken.some((t) => Math.abs(t.order - c.order) < GAP)) continue
    taken.push(c)
  }


  const marks = new Map(taken.map((c) => [c.at, c.mark]))

  // 3. Rebuild, splicing at the chosen words.

  const rebuild = (ns: Node[], path: number[]): Node[] =>
    ns.flatMap((n, i): Node[] => {
      const here = [...path, i]
      if (n.t === 'text') {
        const parts = n.v.split(/(\s+)/)
        const out: Node[] = []
        let buf = ''
        parts.forEach((w, j) => {
          const id = `${here.join('.')}:${j}`
          const mark = marks.get(id)
          if (!mark) {
            buf += w
            return
          }
          // Punctuation stays outside the mark — a rule drawn under "cycles,"
          // should not swallow the comma.
          const split = () => {
            const [, lead, core, trail] = /^([^\p{L}\p{N}]*)(.*?)([^\p{L}\p{N}]*)$/su.exec(w)!
            if (buf + lead) out.push({ t: 'text', v: buf + lead })
            buf = trail
            return core
          }

          if (mark.kind === 'term') {
            out.push({ t: 'term', topic: w.trim().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''), kids: [{ t: 'text', v: split() }] })
          } else {
            // A picture sits *after* the whole word, punctuation and all, so
            // the word keeps its shape and the emoji reads as an aside.
            buf += w
            if (buf) out.push({ t: 'text', v: buf })
            buf = ''
            out.push({ t: 'emoji', glyph: mark.emoji.glyph, label: mark.emoji.label })
          }
        })
        if (buf) out.push({ t: 'text', v: buf })
        return out
      }
      if (n.t === 'code') {
        // Code spans no longer take a mark of their own. A glyph after an
        // identifier was decoration, and decoration is what this pass stopped
        // doing.
        return [n]
      }
      if ('kids' in n) return [{ ...n, kids: rebuild(n.kids, here) } as Node]
      return [n]
    })

  return rebuild(nodes, [])
}

const key = (h: { path: number[]; index: number }) => `${h.path.join('.')}:${h.index}`

/**
 * What one word earns, decided in isolation.
 *
 * `place` decides for a whole tree at once because it has a density budget to
 * spend and a ranking to spend it on. The streaming view has neither — it does
 * not know how long the sentence will be — so it needs the per-word half of the
 * judgement on its own. Same bank, same lexicon, same tones, so a word decorated
 * while streaming is decorated the same way once the reply settles.
 */
export type WordMark = { emoji?: EmojiHit; term?: boolean }

export function markFor(word: string, bank: Bank, emoji: EmojiBank | null): WordMark | null {
  const vec = known(word)
  if (!vec) {
    warm([word])
    return null
  }
  const pic = matchEmoji(word, vec, emoji ?? null)
  return pic ? { emoji: pic } : null
}


/** Exposed for tuning: what would this sentence get, and how strongly? */
export async function explain(text: string, bank: Bank): Promise<Hit[]> {
  const words = text
    .split(/\s+/)
    .map((w) => w.toLowerCase().replace(/[^a-z'-]/g, ''))
    .filter((w) => w.length >= 4 && !STOP.has(w))
  const vecs = await Promise.all(words.map((w) => embed(w)))
  return words
    .map((w, i) => ({ word: w, ...best(bank, vecs[i]) }))
    .sort((a, b) => b.score - a.score)
}
