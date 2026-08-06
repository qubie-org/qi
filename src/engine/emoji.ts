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
import { cosine } from '../model/vectors'

export type EmojiBank = {
  glyph: string[]
  label: string[]
  vecs: Float32Array[]
  /** Exact label → index. "fire" must reach 🔥, not 🚒 fire engine. */
  exact: Map<string, number>
  /**
   * Every emoji that carries a word as one of its CLDR tags.
   *
   * A tag is a human sitting down and deciding that 🌊 is about the ocean. That
   * is better evidence than a cosine, and the cosine on its own gets it wrong:
   * "ocean" matched 🐙 octopus, because 🌊's tag list ("surf surfer surfing")
   * drags its vector toward surfing. The tag does not replace the cosine — many
   * emoji share a tag — it selects the candidates the cosine then chooses
   * between.
   */
  tagged: Map<string, number[]>
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

/**
 * The lexicon, with its vectors already computed.
 *
 * Roughly eighteen hundred emoji, each embedded from its label and tags
 * together — the label alone is often a description ("grinning face") rather
 * than the concept someone would actually write. That is eighteen hundred
 * forward passes, which is fine once on a build machine and unacceptable every
 * time the app boots, so tools/pack_emoji.py runs them ahead of time against
 * the same granite weights the embed pack uses and writes the matrix out
 * quantised to int8.
 *
 * The vectors and the model are therefore a matched pair. If the embed pack
 * ever changes model, this file has to be regenerated — the dimension check
 * below is what catches that rather than letting every emoji quietly become
 * equally wrong.
 */
export function loadEmoji(base = '/emoji', threshold = 0.5): Promise<EmojiBank | null> {
  loading ??= (async () => {
    try {
      const [metaRes, vecRes] = await Promise.all([
        fetch(`${base}/emoji.json`),
        fetch(`${base}/emoji.vec`),
      ])
      if (!metaRes.ok || !vecRes.ok) throw new Error(`${metaRes.status}/${vecRes.status}`)
      const rows: [string, string, string][] = await metaRes.json()

      // PTN-style header: magic, count, dim, scale — then int8 rows.
      const buf = await vecRes.arrayBuffer()
      const dv = new DataView(buf)
      const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3))
      if (magic !== 'EMJ1') throw new Error(`bad emoji vector magic ${magic}`)
      const n = dv.getUint32(4, true)
      const d = dv.getUint32(8, true)
      const scale = dv.getFloat32(12, true)
      if (n !== rows.length) throw new Error(`emoji vectors ${n} != labels ${rows.length}`)
      const q = new Int8Array(buf, 16, n * d)

      const glyph: string[] = []
      const label: string[] = []
      const vecs: Float32Array[] = []
      const exact = new Map<string, number>()
      const tagged = new Map<string, number[]>()
      rows.forEach(([g, l, tags], i) => {
        // First writer wins: the list is in CLDR order, so the plain glyph
        // ("fire") precedes its compounds ("fire engine", "fire extinguisher").
        const key = l.toLowerCase()
        if (!exact.has(key)) exact.set(key, glyph.length)
        glyph.push(g)
        label.push(l)
        for (const tag of (tags ?? '').split(' ')) {
          if (tag.length < 3) continue
          const list = tagged.get(tag)
          if (list) list.push(i)
          else tagged.set(tag, [i])
        }
        const v = new Float32Array(d)
        for (let j = 0; j < d; j++) v[j] = q[i * d + j] * scale
        vecs.push(v)
      })
      bank = { glyph, label, vecs, exact, tagged, threshold }
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

  // Tagged only.
  //
  // There used to be a fallback that searched the whole lexicon by cosine when
  // a word carried no tag. Everything embarrassing came out of it: "stock"
  // found 🧦 socks, "lighthouse" found 💡 a light bulb. A vector near enough to
  // win is not the same as a picture of the thing, and at display size the
  // difference is the whole impression.
  //
  // So a picture is placed only where a person has already said this word
  // belongs to it. That covers 2,558 words — every concrete noun worth
  // illustrating — and covers none of the ones that were going wrong.
  // Tagged candidates answer to a lower bar than an open search does. The set
  // is already curated — someone decided this word belongs to these pictures —
  // so the cosine is only choosing between them, not deciding whether a match
  // exists at all.
  const TAGGED_BAR = b.threshold * 0.8
  const candidates = b.tagged.get(word)
  let best = -1
  let at = -1
  if (candidates?.length) {
    for (const i of candidates) {
      const s = cosine(vec, b.vecs[i])
      if (s > best) {
        best = s
        at = i
      }
    }
    // Narrowing the search is all the tag does. It does *not* confer
    // confidence: forcing the score to 0.9 gave "steam" the person in a steamy
    // room and "night" a bridge at night, because both carry the tag and
    // nothing then had to clear a bar. The candidate still has to look like the
    // word, and the score reported is the real one.
    return at >= 0 && best >= TAGGED_BAR
      ? { glyph: b.glyph[at], label: b.label[at], score: best }
      : null
  }

  return null
}
