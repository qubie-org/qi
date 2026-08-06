/**
 * Calling an API nobody wrote a source for.
 *
 * qi's ten sources each carry a hand-written fetch and a hand-written reducer.
 * That is why there are ten: every one is a small piece of code someone had to
 * think about. It does not scale to three thousand, and writing three thousand
 * badly would be worse than having ten good ones.
 *
 * An OpenAPI description already contains what those hand-written pieces
 * encoded — where to send the request, what to put in it, and what comes back.
 * So the operations index carries the callable ones, retrieval picks the
 * operation, and the model does the one part that genuinely needs judgement:
 * turning a question into parameter values.
 *
 * The division of labour matters. The model never sees the catalogue, never
 * chooses a host, never writes a URL, and never sees a response body it has not
 * been handed in a fixed shape. It fills in blanks. Everything else — which
 * operation, which host, how the URL is assembled, whether the fetch is allowed
 * — is code, and can be tested.
 */
import { granite } from '../model/granite'
import { cosine, embed } from '../model/vectors'
import { net } from './net'

export type Param = {
  name: string
  in: 'path' | 'query'
  req: boolean
  type: string
  what: string
}

export type Operation = {
  api: string
  title: string
  /** Scheme and host, already resolved — never a template. */
  base: string
  path: string
  what: string
  params: Param[]
}

export type OpHit = Operation & { score: number }

type Index = { ops: Operation[]; vecs: Float32Array[] }

let loading: Promise<Index | null> | null = null

export function loadOperations(base = '/apis'): Promise<Index | null> {
  loading ??= (async () => {
    try {
      const [metaRes, vecRes] = await Promise.all([fetch(`${base}/ops.json`), fetch(`${base}/ops.vec`)])
      if (!metaRes.ok || !vecRes.ok) throw new Error(`${metaRes.status}/${vecRes.status}`)
      const ops: Operation[] = await metaRes.json()

      const buf = await vecRes.arrayBuffer()
      const dv = new DataView(buf)
      const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3))
      if (magic !== 'OPS1') throw new Error(`bad operations magic ${magic}`)
      const n = dv.getUint32(4, true)
      const d = dv.getUint32(8, true)
      const scale = dv.getFloat32(12, true)
      if (n !== ops.length) throw new Error(`operation vectors ${n} != entries ${ops.length}`)
      const q = new Int8Array(buf, 16, n * d)

      const vecs = ops.map((_, i) => {
        const v = new Float32Array(d)
        for (let j = 0; j < d; j++) v[j] = q[i * d + j] * scale
        return v
      })
      return { ops, vecs }
    } catch (err) {
      console.warn('operations index unavailable — run tools/pack_ops.py', err)
      return null
    }
  })()
  return loading
}

/**
 * A key wearing a different hat.
 *
 * Some APIs declare no security scheme and then require the key as an ordinary
 * query parameter. Interzoid names its one `license`, so its spec reads as
 * keyless and its calls are not — and the failure is quiet, because the model
 * asked to fill a required parameter it has no value for will invent a
 * plausible one and the request simply fails.
 *
 * Checked here as well as in the packer so an index built before this rule
 * existed is still filtered.
 */
const KEYLIKE =
  /^(x-)?(api[-_]?key|key|token|access[-_]?token|auth|license|secret|app[-_]?(id|key)|client[-_]?(id|secret)|subscription[-_]?key|signature|password)$/i

export const needsKey = (op: Operation): boolean =>
  op.params.some((p) => p.req && KEYLIKE.test(p.name.replace(/-/g, '_')))

/** The operations nearest a question, best first. */
export async function findOperations(question: string, k = 4): Promise<OpHit[]> {
  const idx = await loadOperations()
  if (!idx) return []
  const q = await embed(question)
  return idx.ops
    .map((op, i) => ({ ...op, score: cosine(q, idx.vecs[i]) }))
    .filter((op) => !needsKey(op))
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
}

/**
 * Assemble the URL.
 *
 * Deliberately code rather than a model. Asked for a URL a model will produce a
 * plausible one, and a plausible URL to a real host is worse than no URL: it
 * fetches something, and whatever comes back is treated as the answer. Here the
 * host comes from the index, the path comes from the index, and the only thing
 * that varies is the values — which are encoded on the way in, so a value
 * cannot become part of the structure.
 */
export function buildUrl(op: Operation, values: Record<string, string>): string | null {
  let path = op.path
  for (const p of op.params.filter((x) => x.in === 'path')) {
    const value = values[p.name]
    if (!value) return p.req ? null : path.includes(`{${p.name}}`) ? null : path
    path = path.replace(`{${p.name}}`, encodeURIComponent(value))
  }
  // A path template with anything left in it was not filled, and guessing the
  // remainder is how you end up requesting /users/%7Bid%7D.
  if (/\{[^}]+\}/.test(path)) return null

  const query = new URLSearchParams()
  for (const p of op.params.filter((x) => x.in === 'query')) {
    const value = values[p.name]
    if (value) query.set(p.name, value)
    else if (p.req) return null
  }
  const qs = query.toString()
  return `${op.base}${path.startsWith('/') ? path : `/${path}`}${qs ? `?${qs}` : ''}`
}

/**
 * Ask the model for the parameter values, and nothing else.
 *
 * Grammar-constrained to exactly the parameters this operation declares, so it
 * cannot invent a field, cannot answer in prose, and cannot decide to call
 * something else. An operation with no parameters skips the model entirely —
 * there is nothing to decide, and a round trip to ask for an empty object is
 * pure latency.
 */
export type Filled = {
  values: Record<string, string>
  /** Parameters the model admits it supplied rather than read from the question. */
  guessed: string[]
}

export async function fillParams(op: Operation, question: string): Promise<Filled> {
  const wanted = op.params.filter((p) => p.req || p.in === 'path')
  if (!wanted.length) return { values: {}, guessed: [] }

  // Each parameter is asked for as a value *and* a declaration of where the
  // value came from. Making provenance part of the grammar is the point: the
  // model cannot return a value without also committing to whether the question
  // actually contained it, and that answer is a boolean rather than a judgement
  // call, which is the sort of thing a small model gets right.
  const properties: Record<string, unknown> = {}
  for (const p of op.params) {
    properties[p.name] = {
      type: 'object',
      properties: {
        value: { type: 'string', description: p.what || p.name },
        guessed: {
          type: 'boolean',
          description: 'true if the question did not state this and you supplied it yourself',
        },
      },
      required: ['value', 'guessed'],
    }
  }

  const schema = {
    type: 'object',
    properties,
    required: wanted.map((p) => p.name),
  }

  // The instruction this replaced said: "If the question does not give a value,
  // use the most ordinary default for it." That one line manufactured the
  // right-API-wrong-entity failure — asked for the population of Bend, it
  // filled in a country code and returned Bend, Belgium. A default is a guess
  // wearing a helpful expression, and the caller needs to know which it got.
  const system = [
    'Fill in the values for an API request from the question.',
    'Use only what the question says. Never invent an identifier, a key or a date.',
    'If the question does not state a value, still supply your best one, but set',
    'guessed to true for it. Set guessed to false only when the value is stated',
    'in the question or follows directly from it. Values only — no explanation.',
  ].join(' ')

  const user = [
    `Endpoint: ${op.title} — ${op.what || op.path}`,
    `Question: ${question}`,
  ].join('\n')

  try {
    const filled = await granite.fill<Record<string, { value?: unknown; guessed?: unknown }>>(
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      schema,
      { maxTokens: 220 },
    )
    const values: Record<string, string> = {}
    const guessed: string[] = []
    for (const [k, v] of Object.entries(filled)) {
      const raw = v && typeof v === 'object' ? v.value : v
      if (raw === null || raw === undefined || !String(raw).trim()) continue
      values[k] = String(raw).trim()
      if (v && typeof v === 'object' && v.guessed === true) guessed.push(k)
    }
    return { values, guessed }
  } catch (err) {
    console.warn('operations: could not fill parameters', err)
    return { values: {}, guessed: [] }
  }
}

export type Called = { url: string; body: unknown } | null

/**
 * Fill, build, call. The whole bridge, in the order the pieces were designed.
 *
 * Everything goes through the net bridge, so the host applies its own rules
 * about what may be reached — the operations index says where a request *would*
 * go, and the bridge still decides whether it may.
 *
 * The first gate lives here: an operation whose *required* parameters the model
 * had to invent is not answering this question, it is answering a question
 * shaped like it. Refusing costs a call that would have returned something
 * confident and wrong.
 */
export async function callOperation(
  op: Operation,
  question: string,
  /**
   * `refuseGuessed: false` reproduces the behaviour this gate replaced. It
   * exists so the taint suite can measure the ungated pipeline at the same
   * retrieval bar and report what the gates actually buy — a before-and-after
   * that is run rather than remembered. Nothing in the app passes it.
   */
  opts: { refuseGuessed?: boolean } = {},
): Promise<Called> {
  const { values, guessed } = await fillParams(op, question)

  const required = new Set(op.params.filter((p) => p.req).map((p) => p.name))
  const invented = opts.refuseGuessed === false ? [] : guessed.filter((name) => required.has(name))
  if (invented.length) {
    console.warn(`operations: refusing ${op.title} — guessed required ${invented.join(', ')}`)
    return null
  }

  const url = buildUrl(op, values)
  if (!url) return null

  const res = await net(url, { accept: 'application/json' })
  if (!res.ok || !res.body) return null
  try {
    return { url, body: JSON.parse(res.body) }
  } catch {
    // Not JSON. A documentation page answering a call is the usual cause, and
    // handing prose to something expecting a record helps nobody.
    return null
  }
}

/**
 * A shape of the response, small enough to reason about.
 *
 * Not the response. An API answer can be a megabyte of nested records and the
 * model has neither the context for it nor any reason to see it — what it needs
 * is the vocabulary: which keys exist, roughly what sort of thing each holds.
 * Values are included but clipped, because "temperature: 11.3" tells you what
 * the key means in a way "temperature: number" does not.
 */
export function shapeOf(value: unknown, depth = 0, seen = 0): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) {
    if (!value.length) return '[]'
    // One element stands for the list. Ten identical records teach nothing the
    // first did not.
    return `[${shapeOf(value[0], depth + 1, seen)}${value.length > 1 ? `, …${value.length}` : ''}]`
  }
  if (typeof value === 'object') {
    if (depth >= 3) return '{…}'
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 12)
    return `{${entries.map(([k, v]) => `${k}: ${shapeOf(v, depth + 1, seen)}`).join(', ')}}`
  }
  const text = String(value)
  return typeof value === 'string' ? JSON.stringify(text.slice(0, 40)) : text
}

/**
 * Turn a response into the one thing worth putting on screen.
 *
 * This is the generic reducer, and it exists because the alternative does not:
 * qi's ten sources each have a hand-written one, and there is no version of
 * hand-writing three thousand more. The model is given the shape and the
 * question and asked for two strings — what this is, and what it says.
 *
 * It is the weakest link in the chain and worth naming as such. A hand-written
 * reducer knows that `main.temp` is the temperature; this infers it. Where the
 * ten sources are right by construction, this is right by inference, and the
 * value it produces is shown as a quotation from a named API rather than as
 * something qi knows.
 */
export type Read = { label: string; value: string; path: string }

export async function factFrom(
  op: Operation,
  called: NonNullable<Called>,
  question: string,
): Promise<Read | null> {
  // `path` is not decoration. Asking which field the value came from turns an
  // unfalsifiable claim ("this is the answer") into a checkable one ("this is
  // what main.temp said"), and both gates downstream are only possible because
  // the model had to commit to it. No maxLength anywhere here: the grammar
  // compiler turns it into a hard character stop that severs the last word.
  const schema = {
    type: 'object',
    properties: {
      label: { type: 'string' },
      value: { type: 'string' },
      path: {
        type: 'string',
        description: 'the dotted key this value was read from, e.g. main.temp',
      },
    },
    required: ['label', 'value', 'path'],
  }

  const system = [
    'You are reading one API response and reporting the single answer in it.',
    'label: two or three words naming what the value is.',
    'value: the answer itself, copied exactly from the response — a number with',
    'its unit, a name, a short phrase. Never a sentence, never an explanation.',
    'path: the dotted key the value was read from, exactly as it appears.',
    'Copy only what is present. If the response does not answer the question,',
    'set value to an empty string.',
  ].join(' ')

  const user = [
    `Question: ${question}`,
    `From: ${op.title}`,
    `Response: ${shapeOf(called.body).slice(0, 1400)}`,
  ].join('\n')

  try {
    const out = await granite.fill<{ label?: string; value?: string; path?: string }>(
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      schema,
      { maxTokens: 160 },
    )
    const value = (out.value ?? '').trim()
    if (!value) return null
    return {
      label: (out.label ?? op.title).trim().slice(0, 80),
      value: value.slice(0, 200),
      path: (out.path ?? '').trim().slice(0, 120),
    }
  } catch (err) {
    console.warn('operations: could not read the response', err)
    return null
  }
}

/* ── the verification gate ──────────────────────────────────────────────────
 *
 * `factFrom` infers. That is the whole problem with it: when the inference is
 * wrong it is wrong *silently and confidently*, and the result renders with a
 * real hostname and a real source link, indistinguishable from a right answer.
 * A user cannot tell them apart and neither can the model that writes the
 * sentence around it.
 *
 * So the output is checked rather than trusted, and — this is the part that
 * matters — almost none of the checking is another model call. A second model
 * asked "is this right?" fails in the same direction as the first, because it
 * is the same weights reading the same context. Code does not.
 */

/** Every leaf value in a parsed body, as strings. Pure; exported for tests. */
export function leaves(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 8 || out.length > 4000) return out
  if (value === null || value === undefined) return out
  if (Array.isArray(value)) {
    for (const v of value) leaves(v, out, depth + 1)
    return out
  }
  if (typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) leaves(v, out, depth + 1)
    return out
  }
  out.push(String(value))
  return out
}

/**
 * One value, reduced to a form two spellings of the same thing share.
 *
 * Thousands separators go because 1,234,567 and 1234567 are one number. A
 * trailing unit goes because "11.3" and "11.3 °C" are one reading. Case and
 * spacing go because they are never the difference between right and wrong.
 */
function normal(s: string): string {
  return s
    .toLowerCase()
    .replace(/[ \s]+/g, ' ')
    .replace(/(\d),(?=\d{3}\b)/g, '$1')
    .replace(/[°"'`]/g, '')
    .trim()
}

/** The same, with a trailing unit or currency token removed. */
function bare(s: string): string {
  return normal(s)
    .replace(/^[$€£¥]\s*/, '')
    .replace(
      /\s*(c|f|k|celsius|fahrenheit|kelvin|km|m|mi|miles|ft|kg|g|lb|lbs|%|percent|usd|eur|gbp|people|inhabitants|km\/h|mph|m\/s)\.?$/i,
      '',
    )
    .trim()
}

/** The leading number in a string, or NaN. */
function num(s: string): number {
  const m = /-?\d+(?:\.\d+)?/.exec(bare(s).replace(/\s/g, ''))
  return m ? Number(m[0]) : NaN
}

/**
 * Did the value the model reported actually occur in the response?
 *
 * Whole leaves only — never a substring search. Substring matching would accept
 * "11" against a leaf of "11.3" and accept almost any two-digit number against
 * a body containing an id, which is precisely the class of near-miss this is
 * built to catch. A paraphrase, a rounded figure and an invented number all
 * fail this, and they fail it in pure code with no second opinion required.
 */
export function leafOccurs(body: unknown, value: string): boolean {
  const v = value.trim()
  if (!v) return false
  const all = leaves(body)
  if (!all.length) return false

  const vNorm = normal(v)
  const vBare = bare(v)
  const vNum = num(v)
  /** Is the claim a bare quantity, rather than prose that mentions one? */
  const vQuantity = /^-?[\d,]+(?:\.\d+)?$/.test(vBare)

  for (const leaf of all) {
    const lNorm = normal(leaf)
    if (lNorm === vNorm || bare(leaf) === vBare) return true
    // A numeric leaf and a numeric claim compare as numbers, so 11.30 matches
    // 11.3 — but only when both really are numbers end to end, never when the
    // digits merely appear inside a longer string.
    //
    // `vQuantity` is what stops a paraphrase walking through this door. Without
    // it, "it is 11.3 degrees in Oslo right now" extracts 11.3, matches the
    // temperature leaf and is accepted as a copied value — a whole invented
    // sentence, waved through because it happened to quote one real number.
    if (vQuantity && Number.isFinite(vNum)) {
      const lNum = num(leaf)
      if (Number.isFinite(lNum) && lNum === vNum && /^[^a-z]*\d/.test(lNorm)) return true
    }
  }
  return false
}

/** Path words, for embedding: `main.temp_c` → "main temp c". */
export const pathWords = (path: string): string =>
  path
    .replace(/[[\]]/g, '.')
    .split('.')
    .filter((seg) => seg && !/^\d+$/.test(seg))
    .map((seg) => seg.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' '))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * How much the field's name has to do with the question.
 *
 * `main.temp` against "weather in Oslo" scores well because the words really do
 * share meaning. `data.0.id` against anything scores like noise, which is the
 * signal: a model that has picked an arbitrary field to report names an
 * arbitrary field when asked where it looked.
 */
export async function pathRelevance(path: string, question: string): Promise<number> {
  const words = pathWords(path)
  if (!words) return 0
  const [p, q] = await Promise.all([embed(words), embed(question)])
  return cosine(p, q)
}

/** Questions whose answer is a number. A name is not an acceptable reply. */
const QUANTITY_FORM =
  /\b(how (?:many|much|far|old|tall|long|big|hot|cold|deep|fast|heavy)|population|price|cost|temperature|distance|height|weight|length|area|speed|rate|count|number of|worth)\b/i

export const wantsQuantity = (question: string): boolean => QUANTITY_FORM.test(question)

/** Is there a number in here at all? */
export const hasNumber = (value: string): boolean => /\d/.test(value)

/**
 * The bars every API answer has to clear.
 *
 * Defaults only. They are replaced at boot by `calibrateBars`, for the same
 * reason the router's threshold is: a number that describes one embedding model
 * describes no other, and a hardcoded bar silently becomes either the noise
 * floor or unreachable the moment the model is swapped.
 */
export type Bars = { op: number; path: number; agree: number }
export const BARS: Bars = { op: 0.5, path: 0.25, agree: 0.6 }

/**
 * Field names that answer nothing, whatever was asked.
 *
 * The null sample for path scoring, exactly as small talk is the null sample
 * for routing. A real path has to be *more* related to the question than these
 * are — and these are the paths a confused reader reaches for.
 */
const NOISE_PATHS = [
  'data.0.id', 'meta.page', 'status.code', 'links.self', 'response.headers',
  'result.0.uuid', 'items.0.index', 'pagination.offset', 'config.version',
]

/**
 * Pairs that must never count as agreement. What the bar has to beat.
 *
 * Note what these are *not*: unrelated strings. Calibrating against "12 degrees
 * celsius" versus "the population of France" measures how far apart two random
 * sentences sit, which is enormously far, and yields a bar so low that every
 * near-miss clears it — measured at 0.12 here, which would have called almost
 * any two answers agreeing.
 *
 * The thing actually being guarded against is the near miss: the right kind of
 * answer to the wrong entity, two readings of the same quantity that differ,
 * the same city in another country. Those are the pairs a wrong API call
 * produces against a right web passage, so those are what set the bar.
 */
const DISAGREEING: [string, string][] = [
  ['11.3 °C', '27 °C'],
  ['Bend, Oregon', 'Bend, Belgium'],
  ['102,059 people', '1,200 people'],
  ['founded in 1782', 'founded in 1904'],
  ['$64,120', '$3,410'],
  ['437 kilometres', '38 kilometres'],
]

/**
 * Measure the bars against this model, at boot.
 *
 * Each one encodes a claim rather than a number: an operation must be more
 * related to the question than to small talk; a path must be more related than
 * an id field is; two answers must agree more than two unrelated strings do.
 * Those claims survive a model swap. The figures do not.
 */
export async function calibrateBars(smallTalk: string[], questions: string[]): Promise<Bars> {
  // The operation bar: what does the index score for a sentence no API answers?
  const idx = await loadOperations()
  if (idx) {
    const noise = await Promise.all(smallTalk.map((t) => embed(t)))
    let worst = 0
    for (const v of noise) {
      for (const vec of idx.vecs) {
        const s = cosine(v, vec)
        if (s > worst) worst = s
      }
    }
    BARS.op = worst + 0.03
  }

  // The path bar: what does a meaningless field name score against a real
  // question? Anything a genuine path scores has to be above that.
  const [qs, noise] = await Promise.all([
    Promise.all(questions.map((q) => embed(q))),
    Promise.all(NOISE_PATHS.map((p) => embed(pathWords(p)))),
  ])
  let worstPath = 0
  for (const q of qs) {
    for (const n of noise) {
      const s = cosine(q, n)
      if (s > worstPath) worstPath = s
    }
  }
  BARS.path = worstPath + 0.02

  // The agreement bar: how alike do two deliberately unrelated answers look?
  const pairs = await Promise.all(
    DISAGREEING.map(async ([a, b]) => {
      const [va, vb] = await Promise.all([embed(a), embed(b)])
      return cosine(va, vb)
    }),
  )
  BARS.agree = Math.max(...pairs) + 0.05

  return BARS
}

/** Why an answer was kept or dropped — the vocabulary the report prints. */
export type Verdict =
  | { ok: true; why: 'verified'; path: number }
  | { ok: false; why: 'no_op' | 'below_op_bar' | 'guessed_param' | 'no_call' | 'no_read' | 'leaf_missing' | 'path_unrelated' | 'not_a_quantity'; path?: number }

/**
 * Everything after the call: read the response, then earn the right to show it.
 *
 * The order is deliberate — the cheapest and most decisive check runs first.
 * `leafOccurs` is pure code over a parsed body and it eliminates the entire
 * paraphrase-and-invention class before an embedding is computed.
 */
export async function verify(
  called: NonNullable<Called>,
  read: Read,
  question: string,
): Promise<Verdict> {
  if (!leafOccurs(called.body, read.value)) return { ok: false, why: 'leaf_missing' }
  if (wantsQuantity(question) && !hasNumber(read.value)) return { ok: false, why: 'not_a_quantity' }

  const path = await pathRelevance(read.path, question)
  if (path < BARS.path) return { ok: false, why: 'path_unrelated', path }

  return { ok: true, why: 'verified', path }
}
