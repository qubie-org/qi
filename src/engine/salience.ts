/**
 * Which words carry the sentence.
 *
 * Colour was being spent on words that *depicted* a colour — "ocean" blue
 * because oceans are blue. That is a pun, not information: it tells a reader
 * nothing they did not already know from the word itself.
 *
 * Emphasis is the useful signal. A coloured word should be the word the
 * sentence is *about*, so the eye lands on the meaning rather than on whichever
 * noun happened to rhyme with a hue.
 *
 * Two things make a word carry a sentence, and they multiply:
 *
 *   alignment — how close the word sits to the sentence's own centroid. Topic
 *               words point the same way the sentence does; asides do not.
 *   rarity    — how much a word narrows the world. "temperatures" says more
 *               than "areas". BPE vocabularies are built frequency-first, so a
 *               token's own id is a usable proxy for how common it is, and
 *               needs no corpus statistics shipped alongside.
 */
import { cosine, embed, tokenize, type Table } from './embed'

export type Salient = { word: string; score: number; alignment: number; rarity: number }

/**
 * Rarity from vocabulary position.
 *
 * WordPiece and BPE both allocate low ids to the most frequent pieces, so mean
 * token id rises with how unusual a word is. Crude next to a real IDF table,
 * and free — the alternative is shipping corpus counts to say what the vocab
 * already encodes.
 */
export function rarity(t: Table, word: string): number {
  const ids = tokenize(t, word)
  if (!ids.length) return 0
  const mean = ids.reduce((a, b) => a + b, 0) / ids.length
  // Normalised to roughly 0..1 across the vocabulary, then softened: the top of
  // the range is dominated by fragments nobody writes on purpose.
  return Math.min(1, Math.log1p(mean) / Math.log1p(t.words.length))
}

/**
 * Rank the content words of a sentence by how much they carry it.
 *
 * The centroid is the sentence's own embedding, so this is self-referential by
 * design: a word is important *relative to what is being said*, not against any
 * fixed notion of importance.
 */
export function salient(text: string, t: Table, stop: Set<string>): Salient[] {
  const centroid = embed(t, text)
  const seen = new Set<string>()
  const out: Salient[] = []

  for (const raw of text.split(/\s+/)) {
    const word = raw.toLowerCase().replace(/[^a-z0-9'-]/g, '')
    if (word.length < 4 || stop.has(word) || seen.has(word)) continue
    seen.add(word)
    const alignment = cosine(centroid, embed(t, word))
    if (alignment <= 0) continue
    const r = rarity(t, word)
    // Multiplied, not summed: a word must be both on-topic and informative.
    // Summing lets a very rare irrelevant token outrank the actual subject.
    out.push({ word, score: alignment * (0.35 + r), alignment, rarity: r })
  }
  return out.sort((a, b) => b.score - a.score)
}
