/**
 * The catalogue: every API the open web offers, findable by meaning.
 *
 * The question "how do we give a small model access to thousands of APIs" has
 * an obvious wrong answer — hand it thousands of tools — and it is wrong for a
 * reason already measured in this codebase: a 3B's tool selection collapses
 * past about five options, because it starts matching on shared words rather
 * than on what would answer the question. Ten thousand would not be a bigger
 * version of that problem; it would be noise.
 *
 * So the catalogue is a retrieval index, not a tool list. 2,529 APIs from
 * APIs.guru, each embedded from its title, description and category, sitting in
 * the same centred vector space as everything else in the app. A question
 * retrieves the nearest few and only those are ever named to the model.
 *
 * This is the same mechanism as the source router, which does exactly this over
 * ten. Nothing new was needed to go to thousands except somewhere to put them.
 */
import { cosine, embed } from '../model/vectors'

export type ApiEntry = {
  id: string
  title: string
  /** One line of description, as its publisher wrote it. */
  what: string
  cats: string[]
  /** Where its OpenAPI description or documentation lives. */
  spec: string
  provider: string
  /**
   * Callable without a key.
   *
   * The deciding property, and not a small one. APIs.guru is the larger
   * catalogue — 2,529 APIs — but a sample of its specs put the keyless share
   * near 12%, most of that enterprise infrastructure nobody asks a personal
   * assistant about. public-apis is a quarter the size and 761 of its entries
   * need no key at all: exchange rates, transit, space, trivia, cat facts.
   *
   * qi holds no credentials and should not start asking for them, so an API
   * behind a key is not an option it has. It stays in the index because knowing
   * a thing exists is worth something, and it is excluded from retrieval by
   * default.
   */
  keyless: boolean
  /** Whether the API sends CORS headers; only matters without the net bridge. */
  cors?: boolean
}

export type ApiHit = ApiEntry & { score: number }

type Index = { entries: ApiEntry[]; vecs: Float32Array[] }

let index: Index | null = null
let loading: Promise<Index | null> | null = null

/**
 * Load the index, once.
 *
 * A megabyte of int8 and a megabyte of JSON, fetched only when something first
 * asks the catalogue a question — most conversations never do, and the ten
 * built-in sources answer without it.
 */
export function loadCatalogue(base = '/apis'): Promise<Index | null> {
  loading ??= (async () => {
    try {
      const [metaRes, vecRes] = await Promise.all([
        fetch(`${base}/apis.json`),
        fetch(`${base}/apis.vec`),
      ])
      if (!metaRes.ok || !vecRes.ok) throw new Error(`${metaRes.status}/${vecRes.status}`)
      const entries: ApiEntry[] = await metaRes.json()

      const buf = await vecRes.arrayBuffer()
      const dv = new DataView(buf)
      const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3))
      if (magic !== 'API1') throw new Error(`bad catalogue magic ${magic}`)
      const n = dv.getUint32(4, true)
      const d = dv.getUint32(8, true)
      const scale = dv.getFloat32(12, true)
      if (n !== entries.length) throw new Error(`catalogue vectors ${n} != entries ${entries.length}`)
      const q = new Int8Array(buf, 16, n * d)

      const vecs = entries.map((_, i) => {
        const v = new Float32Array(d)
        for (let j = 0; j < d; j++) v[j] = q[i * d + j] * scale
        return v
      })
      index = { entries, vecs }
      return index
    } catch (err) {
      // Not fatal, and not silent. Without it `look` still has its ten sources
      // and the web; it simply cannot name a specific API for a question.
      console.warn('catalogue unavailable — run tools/pack_apis.py', err)
      return null
    }
  })()
  return loading
}

/**
 * The APIs nearest a question.
 *
 * Returned with their scores so the caller can decide whether the best of them
 * is actually close to anything. A catalogue this size always has a nearest
 * entry, which is precisely why the distance matters more than the ranking.
 */
export async function findApis(
  question: string,
  k = 5,
  opts: { includeKeyed?: boolean } = {},
): Promise<ApiHit[]> {
  const idx = await loadCatalogue()
  if (!idx) return []
  const q = await embed(question)
  return idx.entries
    .map((entry, i) => ({ ...entry, score: cosine(q, idx.vecs[i]) }))
    .filter((e) => opts.includeKeyed || e.keyless)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
}
