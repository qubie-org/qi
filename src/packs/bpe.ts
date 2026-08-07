/**
 * Byte-level BPE, the GPT-2 scheme, as Granite's embedding models use it.
 *
 * Written out rather than pulled in. A tokenizer library would arrive with its
 * own copy of an inference runtime and its own idea of where weights live, and
 * this is 120 lines of pure function with a spec that has not moved since 2019.
 *
 * The scheme, in order:
 *
 *   1. split on a fixed regex that keeps a leading space attached to its word,
 *      which is why "the" and " the" are different tokens
 *   2. encode each piece as UTF-8 bytes, then map every byte to a printable
 *      character — so any byte sequence is representable and nothing is ever
 *      out-of-vocabulary
 *   3. merge adjacent pairs, always taking the lowest-ranked merge available,
 *      until no pair in the table remains
 *
 * Only step 3 is interesting, and only because doing it naively is quadratic on
 * long words. The merge loop below is the plain O(n²) form on purpose: pieces
 * are words, words are short, and a heap here would be slower than the scan.
 */

export type Vocab = Record<string, number>

/**
 * The 256 printable stand-ins for raw bytes. Bytes that are already printable
 * ASCII map to themselves; the rest are shifted into a private range so that a
 * token string is always safe to put in a JSON vocabulary.
 */
function byteTable(): { enc: string[]; dec: Map<string, number> } {
  const enc: string[] = new Array(256)
  const printable: number[] = []
  for (let i = 33; i <= 126; i++) printable.push(i)
  for (let i = 161; i <= 172; i++) printable.push(i)
  for (let i = 174; i <= 255; i++) printable.push(i)
  const keep = new Set(printable)
  let next = 0
  for (let b = 0; b < 256; b++) {
    enc[b] = keep.has(b) ? String.fromCharCode(b) : String.fromCharCode(256 + next++)
  }
  const dec = new Map<string, number>()
  enc.forEach((ch, b) => dec.set(ch, b))
  return { enc, dec }
}

const { enc: BYTE } = byteTable()

/**
 * The GPT-2 pre-tokenizer, verbatim. The leading `?` on the space in each
 * alternative is the load-bearing part — it is what makes word-initial position
 * a property of the token rather than something the model has to infer.
 */
const SPLIT =
  /'s|'t|'re|'ve|'m|'ll|'d| ?[\p{L}]+| ?[\p{N}]+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu

export class BPE {
  private vocab: Vocab
  private ranks: Map<string, number>
  private cache = new Map<string, number[]>()
  readonly bos: number
  readonly eos: number
  readonly pad: number

  constructor(vocab: Vocab, merges: string[], specials: { bos: string; eos: string; pad: string }) {
    this.vocab = vocab
    this.ranks = new Map()
    merges.forEach((m, i) => this.ranks.set(m, i))
    this.bos = vocab[specials.bos] ?? 0
    this.pad = vocab[specials.pad] ?? 1
    this.eos = vocab[specials.eos] ?? 2
  }

  /**
   * Build from a HuggingFace tokenizer.json.
   *
   * Merges are accepted in both shapes the format has used: a list of "a b"
   * strings, and a list of ["a","b"] pairs. Newer exports write the second, and
   * a tokenizer that silently produces zero merges still returns plausible
   * garbage rather than failing, so both are handled explicitly.
   */
  static fromJson(json: {
    model: { vocab: Vocab; merges: (string | [string, string])[] }
  }): BPE {
    const merges = json.model.merges.map((m) => (Array.isArray(m) ? m.join(' ') : m))
    return new BPE(json.model.vocab, merges, { bos: '<s>', eos: '</s>', pad: '<pad>' })
  }

  /** Ids for one string, wrapped in the sentence markers the model expects. */
  encode(text: string, max = 512): number[] {
    const ids: number[] = [this.bos]
    for (const piece of text.match(SPLIT) ?? []) {
      for (const id of this.piece(piece)) {
        if (ids.length >= max - 1) break
        ids.push(id)
      }
    }
    ids.push(this.eos)
    return ids
  }

  private piece(raw: string): number[] {
    const hit = this.cache.get(raw)
    if (hit) return hit

    // UTF-8 first, then the byte map: a multi-byte character becomes several
    // symbols, which is what lets one 50k vocabulary cover every script.
    const bytes = new TextEncoder().encode(raw)
    let symbols = Array.from(bytes, (b) => BYTE[b])

    for (;;) {
      let bestRank = Infinity
      let bestAt = -1
      for (let i = 0; i < symbols.length - 1; i++) {
        const rank = this.ranks.get(`${symbols[i]} ${symbols[i + 1]}`)
        if (rank !== undefined && rank < bestRank) {
          bestRank = rank
          bestAt = i
        }
      }
      if (bestAt < 0) break
      symbols = [
        ...symbols.slice(0, bestAt),
        symbols[bestAt] + symbols[bestAt + 1],
        ...symbols.slice(bestAt + 2),
      ]
    }

    // An unknown symbol here means the byte map and the vocabulary disagree,
    // which cannot happen for a well-formed tokenizer.json — but dropping it is
    // still better than emitting a token id the model will read as something
    // else entirely.
    const ids = symbols.map((s) => this.vocab[s]).filter((n): n is number => n !== undefined)
    if (this.cache.size < 8192) this.cache.set(raw, ids)
    return ids
  }
}
