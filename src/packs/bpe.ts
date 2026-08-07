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

const { enc: BYTE, dec: UNBYTE } = byteTable()

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
  /** The vocabulary inverted, built once, for `decode`. */
  private byId = new Map<number, string>()
  readonly bos: number
  readonly eos: number
  readonly pad: number

  constructor(vocab: Vocab, merges: string[], specials: { bos: string; eos: string; pad: string }) {
    this.vocab = vocab
    this.ranks = new Map()
    merges.forEach((m, i) => this.ranks.set(m, i))
    for (const [token, id] of Object.entries(vocab)) this.byId.set(id, token)
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
    added_tokens?: { id: number; content: string }[]
  }): BPE {
    const merges = json.model.merges.map((m) => (Array.isArray(m) ? m.join(' ') : m))
    // Added tokens live outside `model.vocab` and are how a chat model names its
    // own turn markers. Left out, `<|im_start|>` has no id, the prompt is built
    // without it, and the model answers as though it were completing prose.
    const vocab: Vocab = { ...json.model.vocab }
    for (const a of json.added_tokens ?? []) vocab[a.content] = a.id
    return new BPE(vocab, merges, { bos: '<s>', eos: '</s>', pad: '<pad>' })
  }

  /** Ids for one string, wrapped in the sentence markers the model expects. */
  encode(text: string, max = 512): number[] {
    const ids: number[] = [this.bos]
    for (const id of this.raw(text, max - 2)) ids.push(id)
    ids.push(this.eos)
    return ids
  }

  /**
   * Ids for one string, with nothing added.
   *
   * An encoder wants its sentence markers. A chat model does not: it has its
   * own — `<|im_start|>`, a role, `<|im_end|>` — and wrapping the content in a
   * second, different pair puts two conflicting framings in the same prompt.
   */
  raw(text: string, max = 4096): number[] {
    const ids: number[] = []
    for (const piece of text.match(SPLIT) ?? []) {
      for (const id of this.piece(piece)) {
        if (ids.length >= max) return ids
        ids.push(id)
      }
    }
    return ids
  }

  /**
   * Ids back to text.
   *
   * The embedder never needed this — it reads vectors off a single forward
   * pass and the ids are the end of the story. A model that *writes* needs the
   * inverse, and the inverse is the byte table run backwards: a token string is
   * printable stand-ins for raw bytes, so decoding is those characters mapped
   * to bytes and the bytes read as UTF-8. Doing it per-token instead would cut
   * multi-byte characters in half, since one character can span two tokens.
   *
   * `skip` drops the special markers by id. They are real tokens with real
   * strings, and `<|im_end|>` rendered literally into a Strudel pattern is a
   * syntax error rather than a cosmetic problem.
   */
  decode(ids: number[], skip: Set<number> = new Set()): string {
    const bytes: number[] = []
    for (const id of ids) {
      if (skip.has(id)) continue
      const token = this.byId.get(id)
      if (token === undefined) continue
      for (const ch of token) {
        const b = UNBYTE.get(ch)
        // A character with no byte behind it is an added token — a marker the
        // caller did not list. Emitting its literal text is worse than nothing.
        if (b !== undefined) bytes.push(b)
      }
    }
    return new TextDecoder().decode(new Uint8Array(bytes))
  }

  /** The id for an exact token string, for markers like `<|im_start|>`. */
  id(token: string): number | undefined {
    return this.vocab[token]
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
