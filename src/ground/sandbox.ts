/**
 * The sandbox.
 *
 * Reducers turn a stranger's API response into the handful of bytes qi is
 * willing to put on screen. That is untrusted code running over untrusted
 * data, so it runs in QuickJS inside Wasmer: no network, no DOM, no
 * filesystem, no timers — stdin in, stdout out, and a byte cap on the way
 * back.
 *
 * It fails *closed*. If the sandbox will not boot, grounding is skipped
 * rather than quietly evaluated on the main thread.
 */
import { init, Wasmer } from '@wasmer/sdk'
import wasmUrl from '@wasmer/sdk/wasm?url'
import * as v from 'valibot'

/**
 * The contract for anything leaving the sandbox, declared once.
 *
 * Reducers are code written against third-party responses that change shape
 * without warning, so their output is validated rather than trusted. Declaring
 * the schema also means the `Fact` type is *derived* from the validator — the
 * two cannot drift apart the way a hand-written guard and a hand-written type
 * always eventually do.
 */

/**
 * A quantity, kept as data rather than as a rendered string.
 *
 * "432 km up, 27540 km/h" cannot be checked, converted, compared or aged. This
 * can: `path` and `raw` say exactly which field of which response it came
 * from, so the claim can be re-fetched and verified against the source, and
 * `asOf` makes staleness visible instead of implied.
 *
 * Formatting is the renderer's job, never the reducer's.
 */
export const QuantitySchema = v.object({
  /** The number itself, unformatted. */
  n: v.number(),
  /** A unit token: a CLDR unit ('celsius', 'kilometer-per-hour') or ISO 4217. */
  unit: v.optional(v.string()),
  /** Significant digits the source actually provided — not what looks tidy. */
  precision: v.optional(v.number()),
  /** ISO timestamp for when this was true. Live data without it is a guess. */
  asOf: v.optional(v.string()),
  /** Dotted path into the response body, so the exact field can be re-checked. */
  path: v.string(),
  /** The untransformed value, for verification against the live source. */
  raw: v.unknown(),
})

export const FactSchema = v.object({
  /** What the number/string is, in two or three words. */
  label: v.string(),
  value: v.string(),
  unit: v.optional(v.string()),
  /**
   * Present whenever the fact is quantitative. When set, the renderer formats
   * from this and ignores `value`, which remains only as a fallback for
   * genuinely textual facts.
   */
  quantities: v.optional(v.array(QuantitySchema)),
  /** An image that will ride the baseline as a chip. */
  chip: v.optional(v.string()),
  /** Its real pixel size, when the source reports it — drives composition. */
  chipW: v.optional(v.number()),
  chipH: v.optional(v.number()),
  /** Attribution, always rendered. */
  src: v.string(),
  srcUrl: v.optional(v.string()),
  /**
   * A second, independent source that said the same thing.
   *
   * Set only when the API path and the web path were run against the same
   * question and their answers agreed. It is not rendered — it exists so that
   * "two unrelated places agree on this" is recorded at the moment it is known,
   * rather than being a fact about the code that nobody can inspect afterwards.
   */
  corroboration: v.optional(v.string()),
  /**
   * The *only* thing the language model is shown. Truncated rather than
   * rejected: an over-long hint is a sloppy reducer, not a reason to lose an
   * otherwise good fact.
   */
  hint: v.pipe(
    v.string(),
    v.transform((s) => (s.length > MAX_HINT_CHARS ? s.slice(0, MAX_HINT_CHARS).trimEnd() : s)),
  ),
  /**
   * When a source returns several plausible answers, the reducer hands back a
   * shortlist instead of guessing. The host reranks it against the query —
   * taking [0] is the API's idea of relevance, not ours.
   */
  candidates: v.optional(
    v.pipe(
      v.array(
        v.object({
          label: v.string(),
          value: v.string(),
          chip: v.optional(v.string()),
          chipW: v.optional(v.number()),
          chipH: v.optional(v.number()),
        }),
      ),
      v.transform((list) => list.slice(0, MAX_CANDIDATES)),
    ),
  ),
})

export type Quantity = v.InferOutput<typeof QuantitySchema>
export type Fact = v.InferOutput<typeof FactSchema>

const PKG = 'saghul/quickjs'
/**
 * Ceiling on what may leave the sandbox. Generous enough for a reranking
 * shortlist, still ~60x smaller than the 243 KB responses this exists to stop.
 *
 * It was 512 B, which silently killed every wiki shortlist — the wrong
 * invariant on the wrong field. What actually must stay small is `hint`, the
 * only thing the model is ever shown, and that is bounded separately below.
 */
export const MAX_FACT_BYTES = 4096
/** The model's entire view of a fact. Kept to roughly a dozen tokens. */
export const MAX_HINT_CHARS = 120
const MAX_CANDIDATES = 5
const TIMEOUT_MS = 4000

let booting: Promise<Wasmer | null> | null = null
let consecutiveFailures = 0

/**
 * How many failures in a row before the instance is assumed dead.
 *
 * One is a bad reducer or a bad payload and says nothing about the sandbox.
 * Three in a row is the sandbox, and there is no other way to tell: a Wasmer
 * instance that has stopped running commands does not announce it, it simply
 * stops returning.
 */
const DEAD_AFTER = 3

/**
 * Throw the instance away so the next call builds a new one.
 *
 * The cache is why this is needed. `booting` is memoised, correctly — building
 * the sandbox is expensive and should happen once — but a memoised handle to
 * something dead is a memoised failure, and that is exactly what happened: the
 * instance stopped running commands, every reducer began returning nothing, and
 * every grounded source in the app went quiet for the rest of the session. The
 * only symptom was emptiness, which is indistinguishable from the web having no
 * answers, and it sent an hour into debugging an image feature that was fine.
 *
 * Nothing here can repair a wasm instance. What it can do is stop trusting one.
 */
export function retireSandbox(why: string): void {
  console.warn(`sandbox: retiring instance — ${why}`)
  booting = null
  consecutiveFailures = 0
}

export function bootSandbox(): Promise<Wasmer | null> {
  booting ??= (async () => {
    try {
      await init({ module: wasmUrl })
      return await Wasmer.fromRegistry(PKG)
    } catch (err) {
      console.warn('sandbox unavailable — grounding disabled', err)
      return null
    }
  })()
  return booting
}

/**
 * saghul/quickjs declares no entrypoint — it publishes named commands
 * (`qjs`, `quickjs`). Packages differ here, so take whichever exists.
 */
function command(pkg: Wasmer) {
  const cmds = pkg.commands as Record<string, { run: (o: unknown) => Promise<any> }> | undefined
  return pkg.entrypoint ?? cmds?.qjs ?? cmds?.quickjs ?? null
}

export const sandboxReady = async () => (await bootSandbox()) !== null

/**
 * Wraps a reducer body so it reads stdin, runs, and prints one JSON object.
 * The reducer sees `data` and nothing else — no globals are threaded in.
 */
function program(reducerBody: string): string {
  // `--std` injects `std` and `os` as globals. `-e` evaluates a *script*, so an
  // `import` statement here is a syntax error and the process exits 1.
  return `
const raw = std.in.readAsString();
try {
  const data = JSON.parse(raw);
  const reduce = (data) => { ${reducerBody} };
  const out = reduce(data);
  std.out.puts(JSON.stringify(out === undefined ? null : out));
} catch (e) {
  std.out.puts(JSON.stringify({ __error: String(e && e.message || e) }));
}
`.trim()
}

/**
 * Run `reducerBody` over `payload`. Returns null on any failure — a source
 * that cannot be reduced is a source qi does not speak from.
 */
export async function reduce(reducerBody: string, payload: unknown): Promise<Fact | null> {
  const qjs = await bootSandbox()
  const cmd = qjs && command(qjs)
  if (!cmd) {
    // Never fail silently here again — this path cost an afternoon.
    console.warn('sandbox: no runnable command on', PKG, qjs ? Object.keys(qjs.commands ?? {}) : '(no package)')
    return null
  }

  let stdout: string
  try {
    const instance = await cmd.run({
      args: ['--std', '-e', program(reducerBody)],
      stdin: JSON.stringify(payload),
    })
    const output = await Promise.race([
      instance.wait(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('sandbox timeout')), TIMEOUT_MS)),
    ])
    if (!output.ok) {
      console.warn(`reducer exited ${output.code}: ${output.stderr || '(no stderr)'}`)
      return null
    }
    // A run that completed proves the instance is alive, whatever the
    // reducer itself made of the payload.
    consecutiveFailures = 0
    stdout = output.stdout
  } catch (err) {
    console.warn('reducer failed', err)
    // A timeout is this sandbox's characteristic death: the command is
    // accepted and never completes. Retire on the first one rather than
    // waiting for three, because every call until then costs the full
    // timeout and returns nothing.
    if (String(err).includes('timeout')) retireSandbox('a reducer timed out')
    else if (++consecutiveFailures >= DEAD_AFTER) retireSandbox(`${DEAD_AFTER} reducers failed in a row`)
    return null
  }

  // The cap is the whole point: nothing large reaches the renderer or the model.
  if (stdout.length > MAX_FACT_BYTES) {
    console.warn(`reducer returned ${stdout.length}B > ${MAX_FACT_BYTES}B cap — dropped`)
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!parsed || (parsed as { __error?: string }).__error) {
    const err = (parsed as { __error?: string } | null)?.__error
    if (err) console.warn('reducer threw:', err)
    return null
  }

  // Validated, not trusted: reducers run against third-party responses that
  // change shape without notice, and a malformed fact should be dropped with a
  // reason rather than rendered as `undefined`.
  const result = v.safeParse(FactSchema, parsed)
  if (!result.success) {
    console.warn('reducer output failed the fact contract:', v.flatten(result.issues))
    return null
  }
  return result.output
}
