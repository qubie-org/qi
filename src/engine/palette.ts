/**
 * Which colour a word takes, decided by what the word means.
 *
 * Colour was previously a decoration: a conversation-level scalar rotated a
 * hue and every accented word got whatever came out. That is colour for its own
 * sake — it varies without signifying, and a reader learns nothing from it.
 *
 * Here each accented word is embedded and matched against colour concepts, so
 * "ocean" is blue because oceans are blue, "fire" is red because fire is red,
 * and "forest" is green. The palette is fixed and vibrant — Google's four,
 * measured in OKLCH — so the meaning is carried by *which* colour appears
 * rather than by inventing new ones.
 *
 * A word with no colour association gets none. Not everything should be
 * coloured, and the ones that are should be the ones that earn it.
 */
import { cosine, embed, type Table } from './embed'

/** Fixed, saturated, mutually unmistakable. Never interpolated between. */
export const TONES = ['blue', 'red', 'gold', 'green'] as const
export type Tone = (typeof TONES)[number]

/**
 * What each colour is *about*. Deliberately concrete and sensory: these are the
 * associations a reader already has, not a taxonomy.
 */
const CONCEPTS: Record<Tone, string[]> = {
  blue: ['ocean', 'water', 'sea', 'sky', 'ice', 'cold', 'winter', 'rain', 'deep', 'night', 'calm'],
  red: ['fire', 'flame', 'blood', 'heat', 'hot', 'danger', 'anger', 'urgent', 'alarm', 'burning'],
  gold: ['sun', 'gold', 'light', 'warm', 'money', 'honey', 'sand', 'summer', 'bright', 'harvest'],
  green: ['grass', 'forest', 'tree', 'leaf', 'plant', 'nature', 'growth', 'spring', 'garden', 'moss'],
}

export type ToneBank = { tone: Tone; vec: Float32Array }[]

export function buildToneBank(t: Table): ToneBank {
  const bank: ToneBank = []
  for (const tone of TONES) {
    for (const concept of CONCEPTS[tone]) bank.push({ tone, vec: embed(t, concept) })
  }
  return bank
}

/**
 * The colour a word means, or null if it means none of them.
 *
 * The threshold matters more than the ranking: almost every word is *nearest*
 * to something, and colouring on nearest-alone would paint the page. Only a
 * word that genuinely evokes a colour should carry one.
 */
export function toneFor(
  word: string,
  vec: Float32Array,
  bank: ToneBank,
  threshold = 0.42,
): { tone: Tone; index: number; score: number } | null {
  let best: { tone: Tone; score: number } | null = null
  for (const entry of bank) {
    const score = cosine(vec, entry.vec)
    if (!best || score > best.score) best = { tone: entry.tone, score }
  }
  if (!best || best.score < threshold) return null
  return { tone: best.tone, index: TONES.indexOf(best.tone), score: best.score }
}
