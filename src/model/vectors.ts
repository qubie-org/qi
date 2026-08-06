/**
 * Vectors: one front door, two speeds.
 *
 * Everything in qi that has an opinion about meaning goes through here — the
 * colour the page takes on, which glyph lands on which word, what the working
 * set recalls, which source a question routes to. It used to be potion, an 8M
 * static table where a token's vector *was* a row lookup: microseconds, no
 * forward pass, safe to call on every keystroke.
 *
 * That is also why it was wrong. A bag of rows has no grammar and no context,
 * so it cannot know that "landed" is a verb, that the second "picture" in a
 * sentence adds nothing, or that "bank" moved rivers between clauses. Every
 * routing bug in the grounding layer traced back to the same missing thing.
 *
 * Granite's 30M embedding model has all of it, and costs a few milliseconds per
 * string instead of nothing. The gap is bridged by a cache rather than by
 * accepting a slower page:
 *
 *   known(s)   synchronous. Returns a vector only if it is already cached.
 *   embed(s)   asynchronous. Computes, caches, returns.
 *
 * The live typing path calls `known`, gets a miss on a word nobody has typed
 * before, renders that word plainly, and schedules `embed`. One frame later the
 * vector is warm and the word gets its colour. Every word after the first time
 * is free. That is the whole trick: the expensive model runs once per distinct
 * string in the lifetime of the app, not once per keystroke.
 *
 * With no embed pack installed, `hash` stands in — stable, meaningless, and
 * enough to keep the page rendering rather than throwing. Callers that care
 * about quality check `ready` and say so.
 */
import { packs } from './packs'

export type Backend = {
  dim: number
  /** A batch, because the cost here is per-call overhead, not per-token. */
  encode: (texts: string[]) => Promise<Float32Array[]>
  /**
   * Token ids for a string, if the backend has a tokenizer to hand. Used only
   * for rarity — see `rarity` below — and optional because the native ANE
   * backend may tokenize out of reach on the other side of the bridge.
   */
  tokenize?: (text: string) => number[]
  /** Vocabulary size, for normalising a token id into a 0..1 rarity. */
  vocab?: number
}

/** Vectors are L2-normalised at the source, so cosine collapses to a dot. */
export function cosine(a: Float32Array, b: Float32Array): number {
  let d = 0
  for (let i = 0; i < a.length; i++) d += a[i] * b[i]
  return d
}

const CACHE_MAX = 4096
const DIM_FALLBACK = 384

/**
 * The words the space is centred on.
 *
 * A contextual encoder's vectors are anisotropic: they occupy a narrow cone, so
 * two words with nothing to do with each other still score 0.58 together.
 * Measured on this model, unrelated words had a median cosine of 0.580 and a
 * 95th percentile of 0.660, while "ocean" and "sea" — about as related as two
 * words get — reached only 0.758. Every threshold in the visual engine sat
 * below the noise, so everything matched everything.
 *
 * Subtracting the mean of a general vocabulary and renormalising fixes it, and
 * the numbers are not subtle: the same unrelated pairs drop to a median of
 * -0.011 and a 95th percentile of 0.150, while ocean~sea holds 0.493 and
 * fire~flame 0.780. Signal goes from a tenth above the noise to several times
 * it.
 *
 * The list is ordinary English on purpose. It is not a corpus and it is not
 * tuned — it only has to describe roughly where the middle of the language is,
 * and any few hundred common words do that.
 */
const CENTRE_WORDS =
  ('time year people way day man thing woman life child world school state family student group ' +
   'country problem hand part place case week company system program question work government ' +
   'number night point home water room mother area money story fact month lot right study book ' +
   'eye job word business issue side kind head house service friend father power hour game line ' +
   'end member law car city community name president team minute idea kid body information back ' +
   'parent face level office door health person art war history party result change morning ' +
   'reason research girl guy moment air teacher force education foot boy age policy process ' +
   'music market sense nation plan college interest death experience effect use class control ' +
   'care field development role effort rate heart drug show leader light voice wife police mind ' +
   'price report decision son view relationship town road arm difference value building action ' +
   'model season society tax director position player record paper space ground form event ' +
   'official matter center couple site project activity star table need court produce eat teach ' +
   'oil situation cost industry figure street image phone data cover quality pressure answer ' +
   'sound news bank ocean fire forest river mountain food language machine number colour shape ' +
   'animal number question letter picture sky tree stone metal glass paper cloth window floor').split(' ')

/**
 * The centre of the language, learned once per backend.
 *
 * Null until `calibrate` has run. Vectors produced before it are not comparable
 * with vectors produced after, which is why the cache is emptied when it lands.
 */
let centre: Float32Array | null = null

/**
 * Insertion-ordered Map as an LRU: re-setting a key on read moves it to the
 * end, so the oldest key is always the first one iteration yields.
 */
const cache = new Map<string, Float32Array>()

const key = (s: string) => s.trim().toLowerCase()

function remember(k: string, v: Float32Array): Float32Array {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!)
  cache.set(k, v)
  return v
}

let backend: Backend | null = null

/** True once a real embedding model is behind this. */
export const ready = () => backend !== null

export const dim = () => backend?.dim ?? DIM_FALLBACK

/**
 * Called by the embed pack when it binds. Nothing else knows which model this
 * is, which is what lets the ONNX build in the browser and the CoreML build in
 * the native shell be the same capability.
 */
export function useBackend(b: Backend): void {
  backend = b
  centre = null
  // Fallback vectors computed before the real model arrived are not comparable
  // with real ones; keeping them would poison every cosine that touches them.
  cache.clear()
  for (const fn of waiters) fn()
  waiters.clear()
}

/** Recentre a raw vector and return it to unit length. */
function recentre(v: Float32Array): Float32Array {
  if (!centre) return v
  const out = new Float32Array(v.length)
  let n = 0
  for (let i = 0; i < v.length; i++) {
    out[i] = v[i] - centre[i]
    n += out[i] * out[i]
  }
  n = Math.sqrt(n) || 1
  for (let i = 0; i < v.length; i++) out[i] /= n
  return out
}

/**
 * Measure the middle of the space so everything after it can be centred on it.
 *
 * Runs against the backend directly rather than through `embed`, because
 * `embed` would centre what it returns and the mean has to be taken over raw
 * vectors. Roughly two hundred short strings: one batch, once, at boot.
 */
export async function calibrate(): Promise<void> {
  if (!backend || centre) return
  // Through the same queue as everything else: `useBackend` releases anything
  // waiting on `whenReady` the moment a backend exists, so a caller can be
  // embedding while this is still measuring, and the session tolerates exactly
  // one caller at a time.
  const run = inFlight.then(async () => {
    if (!backend || centre) return
    const raw: Float32Array[] = []
    for (let i = 0; i < CENTRE_WORDS.length; i += BATCH_MAX) {
      raw.push(...(await backend.encode(CENTRE_WORDS.slice(i, i + BATCH_MAX))))
    }
    return raw
  })
  inFlight = run.then(() => {}).catch(() => {})
  const raw = (await run) ?? []
  if (!raw.length) return
  const d = raw[0]?.length ?? DIM_FALLBACK
  const m = new Float32Array(d)
  for (const v of raw) for (let i = 0; i < d; i++) m[i] += v[i] / raw.length
  centre = m
  // Anything embedded during calibration is uncentred and therefore wrong.
  cache.clear()
}

/**
 * A sample of ordinary words, for anyone who needs to know what "no relation"
 * scores. `place` uses it to derive its own threshold rather than carrying a
 * constant that was true of a model it no longer runs.
 */
export const nullSample = (n = 80): string[] => CENTRE_WORDS.slice(0, n)

const waiters = new Set<() => void>()

/** Resolves when a real backend is available. */
export function whenReady(): Promise<void> {
  if (backend) return Promise.resolve()
  return new Promise((resolve) => waiters.add(resolve))
}

/**
 * The synchronous path. A miss is a miss — it does not block, and it does not
 * silently substitute a fallback vector when a real one is coming, because a
 * caller that mixes the two gets nonsense similarity scores.
 */
export function known(text: string): Float32Array | undefined {
  const k = key(text)
  const hit = cache.get(k)
  if (hit) {
    cache.delete(k)
    cache.set(k, hit)
    return hit
  }
  if (!backend) return remember(k, hash(k))
  return undefined
}

/** Queue of strings waiting on the model, coalesced into one batch per tick. */
let pending = new Map<string, ((v: Float32Array) => void)[]>()
let scheduled = false
const BATCH_MAX = 32

export function embed(text: string): Promise<Float32Array> {
  const k = key(text)
  const hit = known(k)
  if (hit) return Promise.resolve(hit)
  if (!backend) return Promise.resolve(remember(k, hash(k)))

  return new Promise((resolve) => {
    const list = pending.get(k)
    if (list) {
      list.push(resolve)
      return
    }
    pending.set(k, [resolve])
    if (!scheduled) {
      scheduled = true
      // A microtask, not a timer: a render pass that asks for forty words gets
      // one batched call, and nothing waits a frame longer than it has to.
      queueMicrotask(flush)
    }
  })
}

/**
 * Only one encode may be in flight at a time.
 *
 * An onnxruntime session is not re-entrant: two overlapping `run()` calls on
 * the same session corrupt its state and it throws from somewhere unhelpful —
 * "Cannot read properties of null" out of the middle of the graph. That never
 * happened while placement ran once per finished reply, and started happening
 * immediately once the streaming view began warming every cold word on every
 * token, because that is enough traffic for a second flush to be scheduled
 * while the first is still awaiting.
 *
 * Batches are therefore chained rather than raced. Throughput is unchanged —
 * the work is the same and it was never parallel inside the session anyway.
 */
let inFlight: Promise<void> = Promise.resolve()

function flush(): void {
  scheduled = false
  const batch = pending
  pending = new Map()
  if (!backend || !batch.size) return
  inFlight = inFlight.then(() => encodeBatch(batch)).catch(() => {})
}

async function encodeBatch(batch: Map<string, ((v: Float32Array) => void)[]>): Promise<void> {
  if (!backend) return

  const texts = [...batch.keys()]
  for (let i = 0; i < texts.length; i += BATCH_MAX) {
    const slice = texts.slice(i, i + BATCH_MAX)
    try {
      const out = await backend.encode(slice)
      slice.forEach((t, j) => {
        const v = remember(t, recentre(out[j]))
        for (const resolve of batch.get(t) ?? []) resolve(v)
      })
    } catch (err) {
      console.warn('vectors: encode failed', err)
      // A failed batch resolves to fallback vectors rather than hanging every
      // caller forever. The page stays up; the colours are just arbitrary.
      slice.forEach((t) => {
        const v = remember(t, hash(t))
        for (const resolve of batch.get(t) ?? []) resolve(v)
      })
    }
  }
}

/**
 * Warm a set of strings without caring about the result — what the render path
 * calls on a miss so the next pass finds them.
 */
export function warm(texts: string[]): void {
  for (const t of texts) if (!cache.has(key(t))) void embed(t)
}

/**
 * Everything a sentence needs before it can be laid out: the sentence itself,
 * for the theme and for salience, and each of its content words, for glyphs and
 * colour.
 *
 * Awaiting this before placing a turn is what keeps the first paint complete.
 * The alternative — place, miss, warm, re-place — works and is what the live
 * streaming path does, but a finished turn that pops its decorations in a frame
 * later reads as a glitch rather than as animation. One batch of twenty or so
 * strings is a single forward pass; it is cheaper than the reflow.
 */
export async function warmSentence(text: string): Promise<void> {
  const words = new Set<string>([text])
  for (const raw of text.split(/\s+/)) {
    const clean = raw.toLowerCase().replace(/[^a-z0-9'-]/g, '')
    if (clean.length >= 3) words.add(clean)
  }
  await Promise.all([...words].map((w) => embed(w)))
}

/**
 * How much a word narrows the world, from where it sits in the vocabulary.
 *
 * Byte-level BPE allocates low ids to the most frequent pieces, so the mean
 * token id of a word rises with how unusual it is. Crude next to a real IDF
 * table, and free — the alternative is shipping corpus counts to say what the
 * vocabulary already encodes.
 *
 * Returns a flat 0.5 when no tokenizer is reachable, which makes rarity a
 * constant factor and leaves ranking to alignment alone.
 */
export function rarity(word: string): number {
  if (!backend?.tokenize || !backend.vocab) return 0.5
  const ids = backend.tokenize(word)
  if (!ids.length) return 0
  const mean = ids.reduce((a, b) => a + b, 0) / ids.length
  return Math.min(1, Math.log1p(mean) / Math.log1p(backend.vocab))
}

/**
 * The stand-in. Deterministic per string, unit length, and unrelated to
 * meaning. It exists so that a qi with no packs installed still renders.
 */
function hash(s: string): Float32Array {
  const v = new Float32Array(dim())
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 16777619)
    v[(h >>> 0) % v.length] += 1
    h = Math.imul(h ^ (h >>> 13), 2654435761)
    v[(h >>> 0) % v.length] -= 1
  }
  let n = 0
  for (const x of v) n += x * x
  n = Math.sqrt(n) || 1
  for (let i = 0; i < v.length; i++) v[i] /= n
  return v
}

/** Bind the embed pack if it is installed, and point vectors at it. */
export async function startVectors(): Promise<boolean> {
  try {
    await packs.bind('embed')
    // Centring is not optional. Without it every cosine in the app sits inside
    // the noise floor of the embedding space.
    await calibrate()
    return ready()
  } catch (err) {
    console.warn('vectors: no embed pack —', String(err))
    return false
  }
}
