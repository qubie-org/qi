/**
 * potion (model2vec) — a static embedding table. There is no forward pass:
 * a token's vector *is* a row lookup, so this costs a memcpy per word and can
 * run on every keystroke without a worker.
 *
 * Rows were L2-normalised before quantising, so cosine collapses to a dot.
 */

export type Table = {
  dim: number
  scale: number
  q: Int8Array
  words: string[]
  vocab: Map<string, number>
  unk: number
}

export async function loadTable(base: string): Promise<Table> {
  const [binRes, vocabRes] = await Promise.all([
    fetch(`${base}/potion.bin`),
    fetch(`${base}/potion.vocab.json`),
  ])
  if (!binRes.ok || !vocabRes.ok) throw new Error(`potion: cannot load from ${base}`)

  const buf = await binRes.arrayBuffer()
  const dv = new DataView(buf)
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3))
  if (magic !== 'PTN1') throw new Error(`potion: bad magic ${magic}`)

  const n = dv.getUint32(4, true)
  const dim = dv.getUint32(8, true)
  const scale = dv.getFloat32(12, true)
  const q = new Int8Array(buf, 16, n * dim)

  const words: string[] = await vocabRes.json()
  if (words.length !== n) throw new Error(`potion: vocab ${words.length} != rows ${n}`)

  const vocab = new Map<string, number>()
  words.forEach((w, i) => vocab.set(w, i))

  return { dim, scale, q, words, vocab, unk: vocab.get('[UNK]') ?? 1 }
}

/* ── tokenizer: BertNormalizer + BertPreTokenizer + WordPiece ────────────── */

const PUNCT = /[!-\/:-@\[-`{-~¡-¿‐-‧‰-⁞]/
const CONTROL = /[\u0000-\u001f\u007f-\u009f\ufffd]/g

function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}+/gu, '') // strip_accents follows lowercase in BertNormalizer
    .replace(CONTROL, '') // clean_text
    .toLowerCase()
}

/** Whitespace split, then punctuation peeled off as its own token. */
function preTokenize(s: string): string[] {
  const out: string[] = []
  for (const chunk of normalize(s).split(/\s+/)) {
    if (!chunk) continue
    let buf = ''
    for (const ch of chunk) {
      if (PUNCT.test(ch)) {
        if (buf) out.push(buf)
        out.push(ch)
        buf = ''
      } else buf += ch
    }
    if (buf) out.push(buf)
  }
  return out
}

/** Greedy longest-match-first, continuation pieces prefixed '##'. */
function wordpiece(word: string, t: Table): number[] {
  if (word.length > 100) return [t.unk]
  const ids: number[] = []
  let start = 0
  while (start < word.length) {
    let end = word.length
    let hit = -1
    while (start < end) {
      const piece = start === 0 ? word.slice(start, end) : '##' + word.slice(start, end)
      const id = t.vocab.get(piece)
      if (id !== undefined) {
        hit = id
        break
      }
      end--
    }
    if (hit < 0) return [t.unk] // BERT drops the whole word, not just the piece
    ids.push(hit)
    start = end
  }
  return ids
}

export function tokenize(t: Table, text: string): number[] {
  const ids: number[] = []
  for (const w of preTokenize(text)) ids.push(...wordpiece(w, t))
  return ids
}

/* ── vectors ─────────────────────────────────────────────────────────────── */

export function row(t: Table, id: number, into?: Float32Array): Float32Array {
  const v = into ?? new Float32Array(t.dim)
  const off = id * t.dim
  for (let i = 0; i < t.dim; i++) v[i] = t.q[off + i] * t.scale
  return v
}

/** Mean of the token rows, re-normalised so dot === cosine downstream. */
export function embed(t: Table, text: string): Float32Array {
  const ids = tokenize(t, text)
  const v = new Float32Array(t.dim)
  if (!ids.length) return v
  for (const id of ids) {
    const off = id * t.dim
    for (let i = 0; i < t.dim; i++) v[i] += t.q[off + i]
  }
  let sq = 0
  for (let i = 0; i < t.dim; i++) {
    v[i] = (v[i] * t.scale) / ids.length
    sq += v[i] * v[i]
  }
  const norm = Math.sqrt(sq) || 1
  for (let i = 0; i < t.dim; i++) v[i] /= norm
  return v
}

/**
 * Words that carry no topic. A mean-pooled bag of words is dominated by them:
 * "what is the weather in bend" and "where is the iss" share five of six
 * tokens, which is enough to route a weather question to a satellite tracker.
 */
export const STOPWORDS = new Set(
  ('a an the and or but if then than that this these those of in on at to for from by with as is are was were be been being it its ' +
    'i you he she they we me him her them us my your his their our not no yes do does did done have has had will would can could ' +
    'should about into over under out up down so very just really more most some any all what when where who how why there here ' +
    "let please tell show give me it's i'm dont don't")
    .split(' '),
)

/**
 * Embedding over content words only — for routing and topic matching, where
 * the grammar is noise. Falls back to the full text if nothing survives.
 */
export function embedContent(t: Table, text: string): Float32Array {
  const kept = text
    .toLowerCase()
    .split(/[^a-z0-9'-]+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
  return embed(t, kept.length ? kept.join(' ') : text)
}

export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

/** Both arguments are expected pre-normalised; this is here for clarity. */
export const cosine = dot
