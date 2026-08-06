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
import { cosine, known, rarity, warm } from '../model/vectors'

export type Salient = { word: string; score: number; alignment: number; rarity: number }

/**
 * Rank the content words of a sentence by how much they carry it.
 *
 * The centroid is the sentence's own embedding, so this is self-referential by
 * design: a word is important *relative to what is being said*, not against any
 * fixed notion of importance.
 */
export function salient(text: string, stop: Set<string>): Salient[] {
  // Cache-only, like everything on the render path. A sentence whose centroid
  // is not warm yet ranks nothing and asks for it instead; one frame later it
  // ranks everything. Returning a half-computed ranking would be worse than
  // returning none, because the words missing from it are exactly the novel
  // ones most likely to matter.
  const cold: string[] = []
  const centroid = known(text)
  if (!centroid) cold.push(text)

  const seen = new Set<string>()
  const out: Salient[] = []

  for (const raw of text.split(/\s+/)) {
    const word = raw.toLowerCase().replace(/[^a-z0-9'-]/g, '')
    if (word.length < 4 || stop.has(word) || seen.has(word)) continue
    seen.add(word)
    const vec = known(word)
    if (!vec) {
      cold.push(word)
      continue
    }
    if (!centroid) continue
    const alignment = cosine(centroid, vec)
    if (alignment <= 0) continue
    const r = rarity(word)
    // Multiplied, not summed: a word must be both on-topic and informative.
    // Summing lets a very rare irrelevant token outrank the actual subject.
    out.push({ word, score: alignment * (0.35 + r), alignment, rarity: r })
  }
  if (cold.length) warm(cold)
  return out.sort((a, b) => b.score - a.score)
}
