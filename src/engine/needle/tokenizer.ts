/**
 * SentencePiece BPE for needle, in TypeScript.
 *
 * Shipping the .model protobuf plus a JS SentencePiece binding would cost more
 * bytes than the tokenizer is worth, so tools/needle_prep.py dumps the pieces
 * and scores to JSON and this reimplements encode/decode over them.
 *
 * Correctness is not assumed — needle.tokenizer.golden.json holds pairs
 * produced by the real sentencepiece, and the test asserts byte equality.
 */

const SPACE = '▁' // SentencePiece's word-boundary marker

export type TokenizerSpec = {
  type: string
  byteFallback: boolean
  addDummyPrefix: boolean
  unkId: number
  specials: Record<string, number>
  /** [piece, score, type] — type 6 is BYTE, 2 is UNKNOWN, 3 is CONTROL. */
  pieces: [string, number, number][]
}

export class NeedleTokenizer {
  readonly pieces: [string, number, number][]
  readonly specials: Record<string, number>
  readonly vocabSize: number
  private readonly ids = new Map<string, number>()
  private readonly scores = new Map<string, number>()
  private readonly byteToken = new Map<number, number>()
  private readonly spec: TokenizerSpec

  constructor(spec: TokenizerSpec) {
    this.spec = spec
    this.pieces = spec.pieces
    this.specials = spec.specials
    this.vocabSize = spec.pieces.length

    spec.pieces.forEach(([piece, score, type], id) => {
      this.ids.set(piece, id)
      this.scores.set(piece, score)
      if (type === 6) {
        // Byte pieces look like <0x0A>.
        const m = /^<0x([0-9A-Fa-f]{2})>$/.exec(piece)
        if (m) this.byteToken.set(parseInt(m[1], 16), id)
      }
    })
  }

  static async load(base: string): Promise<NeedleTokenizer> {
    const res = await fetch(`${base}/needle.tokenizer.json`)
    if (!res.ok) throw new Error(`needle tokenizer: ${res.status}`)
    return new NeedleTokenizer(await res.json())
  }

  /**
   * Greedy highest-score pair merging — SentencePiece's BPE, not a
   * longest-match walk. Symbols start as single characters and the best
   * scoring adjacent pair is merged until nothing in the vocab matches.
   */
  encode(text: string): number[] {
    const prepared = (this.spec.addDummyPrefix ? ' ' + text : text).replace(/ /g, SPACE)
    if (!prepared) return []

    let symbols = [...prepared] // code points, not UTF-16 units

    for (;;) {
      let bestScore = -Infinity
      let bestAt = -1
      for (let i = 0; i + 1 < symbols.length; i++) {
        const merged = symbols[i] + symbols[i + 1]
        const score = this.scores.get(merged)
        if (score !== undefined && score > bestScore) {
          bestScore = score
          bestAt = i
        }
      }
      if (bestAt < 0) break
      symbols.splice(bestAt, 2, symbols[bestAt] + symbols[bestAt + 1])
    }

    const out: number[] = []
    const utf8 = new TextEncoder()
    for (const sym of symbols) {
      const id = this.ids.get(sym)
      if (id !== undefined) {
        out.push(id)
      } else if (this.spec.byteFallback) {
        // Anything with no piece is emitted as its raw UTF-8 bytes.
        for (const b of utf8.encode(sym)) {
          const bid = this.byteToken.get(b)
          out.push(bid ?? this.spec.unkId)
        }
      } else {
        out.push(this.spec.unkId)
      }
    }
    return out
  }

  decode(ids: number[]): string {
    const bytes: number[] = []
    const utf8 = new TextEncoder()
    for (const id of ids) {
      const entry = this.pieces[id]
      if (!entry) continue
      const [piece, , type] = entry
      if (type === 3) continue // control tokens contribute nothing
      if (type === 6) {
        const m = /^<0x([0-9A-Fa-f]{2})>$/.exec(piece)
        if (m) bytes.push(parseInt(m[1], 16))
        continue
      }
      for (const b of utf8.encode(piece)) bytes.push(b)
    }
    const text = new TextDecoder().decode(new Uint8Array(bytes))
    return text.replace(new RegExp(SPACE, 'g'), ' ').replace(/^ /, '')
  }

  /** Exact characters each id contributes — what the constraint matcher sees. */
  tokenStrings(): string[] {
    return this.pieces.map(([piece, , type]) => {
      if (type === 3 || type === 2) return ''
      if (type === 6) {
        const m = /^<0x([0-9A-Fa-f]{2})>$/.exec(piece)
        return m ? String.fromCharCode(parseInt(m[1], 16)) : ''
      }
      return piece.replace(new RegExp(SPACE, 'g'), ' ')
    })
  }
}
