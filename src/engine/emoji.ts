/**
 * Inline emoji, placed automatically.
 *
 * The model has no idea these exist. It writes words; this matches them the
 * same way the motif bank does — potion vector, nearest prototype, threshold —
 * so placement is deterministic and the same sentence always decorates the same
 * way. Nothing about emoji appears in a prompt or in the training data.
 *
 * The prototypes are CLDR annotations, which are human-curated concept words
 * per glyph. That is the part worth having: a hand-written list of "which word
 * means which picture" would be thousands of lines and worse.
 *
 * Vectors are built at load rather than shipped: 1,476 labels at ~7µs each is
 * around 10ms, cheaper than a 500 KB matrix that could drift out of sync with
 * the table.
 */
import { cosine, embed, type Table } from './embed'

export type EmojiBank = {
  glyph: string[]
  label: string[]
  vecs: Float32Array[]
  /** Exact label → index. "fire" must reach 🔥, not 🚒 fire engine. */
  exact: Map<string, number>
  threshold: number
}

/**
 * Words that match an emoji strongly but should never take one: they are too
 * common for a picture to add anything, and a glyph on every other word turns
 * a page of type into a chat message.
 */
const NEVER = new Set([
  'back', 'right', 'left', 'up', 'down', 'new', 'top', 'end', 'free', 'next',
  'part', 'like', 'work', 'time', 'people', 'thing', 'things', 'name', 'place',
  'one', 'two', 'three', 'first', 'last', 'good', 'best', 'better', 'well',
])

/** Loaded once. Null until the fetch resolves; placement simply skips emoji. */
let bank: EmojiBank | null = null
let loading: Promise<EmojiBank | null> | null = null

export function emojiBank(): EmojiBank | null {
  return bank
}

export function loadEmoji(t: Table, base = '/models', threshold = 0.5): Promise<EmojiBank | null> {
  loading ??= (async () => {
    try {
      const res = await fetch(`${base}/emoji.json`)
      if (!res.ok) throw new Error(String(res.status))
      const rows: [string, string, string][] = await res.json()
      const glyph: string[] = []
      const label: string[] = []
      const vecs: Float32Array[] = []
      const exact = new Map<string, number>()
      for (const [g, l, tags] of rows) {
        // First writer wins: the list is in CLDR order, so the plain glyph
        // ("fire") precedes its compounds ("fire engine", "fire extinguisher").
        const key = l.toLowerCase()
        if (!exact.has(key)) exact.set(key, glyph.length)
        glyph.push(g)
        label.push(l)
        // Label and tags together: the label alone is often a description
        // ("grinning face") rather than the concept someone would write.
        vecs.push(embed(t, `${l} ${tags}`))
      }
      bank = { glyph, label, vecs, exact, threshold }
      return bank
    } catch (err) {
      console.warn('emoji lexicon unavailable — placement continues without it', err)
      return null
    }
  })()
  return loading
}

export type EmojiHit = { glyph: string; label: string; score: number }

/** Best emoji for a word, or null if nothing clears the bar. */
export function matchEmoji(word: string, vec: Float32Array, b: EmojiBank | null): EmojiHit | null {
  // Three letters is a real noun ('dog', 'key', 'sun'); the stopword list
  // upstream already removes the ones that are not.
  if (!b || NEVER.has(word) || word.length < 3) return null

  // An exact label match is a stronger signal than any cosine. Without this,
  // bag-of-words hands "fire" to 🚒 fire engine, whose label simply contains
  // the query word.
  const hit = b.exact.get(word)
  if (hit !== undefined) return { glyph: b.glyph[hit], label: b.label[hit], score: 1 }

  let best = -1
  let at = -1
  for (let i = 0; i < b.vecs.length; i++) {
    const s = cosine(vec, b.vecs[i])
    if (s > best) {
      best = s
      at = i
    }
  }
  return at >= 0 && best >= b.threshold
    ? { glyph: b.glyph[at], label: b.label[at], score: best }
    : null
}
