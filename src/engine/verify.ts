/**
 * Letting a model write real Strudel, and refusing to play what does not work.
 *
 * `compose.ts` takes the other route: the model fills a struct under a grammar
 * that makes anything unplayable unexpressible. That is safe and it is also the
 * ceiling — a struct with `kick`, `snare`, `hat`, `bass` and `pad` in it can
 * only ever describe the four-part arrangement it was shaped around. Asked for
 * something that is not that shape, the best it can do is the nearest preset,
 * which is why every set came out sounding like a preset.
 *
 * A 135M model finetuned on Strudel writes the thing itself. Measured against
 * the same five prompts, with sampling rather than greedy decode, it produced
 * `voicing()`, `chord("<Dm7 Cmaj7 Gmaj7>")`, `.every(3, x => x.rev())`,
 * `.delayfeedback()`, `bank("RolandTR808")` — vocabulary the struct has no
 * field for. It also gave "a limping seven-beat thing" a genuinely seven-step
 * kick, which is the conditioning the struct route never managed.
 *
 * And it invented `s("gm_tide")`, `s("gm_slow_tide")`, and drove `s("drums")`
 * with `note()`. So it cannot be trusted either.
 *
 * ── Verify rather than constrain ────────────────────────────────────────────
 *
 * This is the same shape as the research process. There, the model may say
 * anything and a claim survives only if its quote is literally in the page. The
 * check is mechanical, it has no model in it, and everything upstream of it is
 * a suggestion. Here the equivalent is: the pattern must name only sounds that
 * exist, evaluate against a fixed vocabulary, and produce events.
 *
 * Three gates, cheapest first.
 */
/** What a check decided, and enough detail to say why in a log line. */
export type Verdict =
  | { ok: true; pattern: unknown; haps: number; remapped: string[] }
  | { ok: false; stage: 'unknown-sound' | 'no-eval' | 'silent'; detail: string }

/**
 * Sample names the model reaches for by default, and a synth that stands in.
 *
 * Not a nicety. The model writes `s("bd")`, `s("hh")` and `s("cp")` in almost
 * every generation, because that is what Strudel examples are written with —
 * and those are *sample* names from Dirt-Samples, 219 banks fetched over the
 * network. Measured on this machine with the network refusing that download,
 * the registry held 19 sounds and none of them were drums, so every generation
 * would have been silent while reporting itself as playing.
 *
 * The preset path already survives this by synthesising its own kit. A
 * generated pattern gets the same courtesy rather than being failed for naming
 * the thing every example names.
 */
const STANDS_IN: Record<string, string> = {
  bd: 'sine',
  kick: 'sine',
  sd: 'white',
  sn: 'white',
  snare: 'white',
  rim: 'square',
  cp: 'pink',
  clap: 'pink',
  hh: 'white',
  oh: 'white',
  hat: 'white',
}

/**
 * Sound names a pattern mentions, from `s("…")` and `sound("…")`.
 *
 * `bank` is deliberately not read. It names a *set* of samples to look names up
 * in — `bank("RolandTR808")` says where `bd` should come from, not what to
 * play — so checking it against the sound registry asks the wrong question and
 * gets the wrong answer: the model writes real bank names like `RolandTR808`
 * and `RolandTR909`, none of which are registered sounds, and treating them as
 * inventions had `repair` rewriting them to `bank("triangle")`. A bank that
 * does not exist is a lookup that falls through, which Strudel already handles.
 */
export function soundsNamed(code: string): string[] {
  const found = new Set<string>()
  for (const m of code.matchAll(/\b(?:s|sound)\(\s*["']([^"']+)["']/g)) {
    // A mini-notation string is many names plus its own punctuation. Splitting
    // on that punctuation is what turns `"bd ~ ~ bd*2"` into `bd`.
    for (const token of m[1].split(/[\s<>[\]!*/,.@?]+/)) {
      const name = token.replace(/:\d+$/, '').trim()
      if (name && name !== '~' && !/^\d/.test(name)) found.add(name)
    }
  }
  return [...found]
}

/**
 * Swap sample names for synths when the sample banks are not loaded.
 *
 * Only when they are absent. With Dirt-Samples present, `bd` is a far better
 * kick than a sine burst and there is no reason to prefer the stand-in.
 */
export function standIn(code: string, registered: Set<string>): { code: string; remapped: string[] } {
  const remapped: string[] = []
  let out = code
  for (const [sample, synth] of Object.entries(STANDS_IN)) {
    if (registered.has(sample) || !registered.has(synth)) continue
    // Only inside a sound string, and only as a whole word — `bd` must not
    // rewrite the `bd` inside `birdsong`, and `sd` must not touch `.speed(`.
    const before = out
    out = out.replace(/\b(s|sound)\(\s*(["'])([^"']+)\2/g, (all, fn, q, body) => {
      const swapped = body.replace(new RegExp(`(^|[\\s<>\\[\\]!*/,])${sample}(?=$|[\\s<>\\[\\]!*/,:])`, 'g'), `$1${synth}`)
      return swapped === body ? all : `${fn}(${q}${swapped}${q}`
    })
    if (out !== before) remapped.push(`${sample}→${synth}`)
  }
  return { code: out, remapped }
}

/**
 * Substitute a sound the model invented for one that exists.
 *
 * The measured inventions were `gm_tide`, `gm_slow_tide`, `gm_electric_bass_finger`,
 * `gtr` and `drums`. Every one of them is a *plausible* name — the model has
 * clearly seen General MIDI instrument lists — and every one of them is silence.
 *
 * Rejecting the whole pattern for one bad name throws away four good layers to
 * punish a fifth, and the retry that follows costs another five seconds to
 * regenerate the parts that were already fine. So the name is swapped and the
 * substitution is reported, which is both cheaper and more honest than a
 * generation that silently omits a voice.
 *
 * The choice of stand-in is by shape, not by meaning: a name with `bass` or a
 * low-register hint in it goes to a sawtooth, percussive-sounding names go to
 * noise, everything else to a triangle. This is not trying to be right about
 * timbre — it is trying to keep the arrangement intact. `verify` still refuses
 * anything that will not produce events.
 */
export function repair(code: string, registered: Set<string>): { code: string; remapped: string[] } {
  const remapped: string[] = []
  const pick = (name: string): string | null => {
    const wants = (...c: string[]) => c.find((n) => registered.has(n)) ?? null
    if (/bass|sub|low|contra/i.test(name)) return wants('sawtooth', 'triangle', 'sine')
    if (/drum|perc|snare|clap|hat|cymbal|tom|rim|kit/i.test(name)) return wants('white', 'pink', 'square')
    if (/pad|string|choir|organ|air/i.test(name)) return wants('triangle', 'sine', 'sawtooth')
    return wants('triangle', 'sawtooth', 'square', 'sine')
  }

  const out = code.replace(/\b(s|sound)\(\s*(["'])([^"']+)\2/g, (all, fn, q, body: string) => {
    let changed = false
    const swapped = body
      .split(/(\s+)/)
      .map((token) => {
        const bare = token.trim()
        if (!bare || bare === '~' || /^[<>[\]!*/,.@?]+$/.test(bare)) return token
        const name = bare.replace(/[:*!/@].*$/, '')
        if (!name || registered.has(name)) return token
        const to = pick(name)
        if (!to) return token
        changed = true
        remapped.push(`${name}→${to}`)
        return token.replace(name, to)
      })
      .join('')
    return changed ? `${fn}(${q}${swapped}${q}` : all
  })

  return { code: out, remapped }
}

/**
 * The names a generated pattern is allowed to mention.
 *
 * Everything Strudel exports, and nothing else. This is the one place the
 * approach is genuinely bounded, and it is bounded in the right dimension: the
 * *vocabulary* is fixed, the *composition* is free. A struct fixes the
 * composition too, which is what made every set sound the same.
 *
 * The banned list matters more than it looks. `new Function` builds a function
 * in global scope, so a body that says `fetch` reaches the real one; binding
 * these names as parameters shadows them with `undefined`. The model is local
 * and 135M and is not trying to do anything, but "the pattern language cannot
 * reach the network" should be a property of the code rather than a hope about
 * the weights.
 */
const BANNED = [
  'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'Worker', 'importScripts',
  'Function', 'localStorage', 'sessionStorage', 'indexedDB',
  'document', 'window', 'globalThis', 'self', 'top', 'parent', 'navigator',
]

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/**
 * Words that cannot be a function parameter under `"use strict"`.
 *
 * Strudel exports 999 names and it only takes one of these among them for
 * `new Function` to throw `Invalid parameters or function name in strict mode`
 * — which it did, on every pattern, and reads exactly like the generated code
 * being at fault rather than the binding around it. Filtered rather than
 * special-cased: losing a binding named `interface` costs a pattern nothing.
 *
 * `eval` is the one that cannot be handled here at all. It is illegal as a
 * parameter *and* illegal to `var`-shadow in strict mode, so it stays reachable
 * and is stated rather than papered over. What the gates guarantee is that the
 * result is a Strudel pattern producing events; they are not a sandbox, and the
 * model that writes into them is a local 135M finetune with no network of its
 * own. Reducers that genuinely need isolation still go through Wasmer.
 */
const RESERVED = new Set([
  'eval', 'arguments', 'implements', 'interface', 'let', 'package',
  'private', 'protected', 'public', 'static', 'yield',
])

export type Vocabulary = { names: string[]; values: unknown[] }

/** Bind a Strudel namespace (or several) into something `verify` can use. */
export function vocabulary(...namespaces: Record<string, unknown>[]): Vocabulary {
  const scope: Record<string, unknown> = {}
  for (const ns of namespaces) {
    for (const [k, v] of Object.entries(ns)) if (IDENTIFIER.test(k) && !RESERVED.has(k)) scope[k] = v
  }
  for (const b of BANNED) if (!RESERVED.has(b)) scope[b] = undefined
  return { names: Object.keys(scope), values: Object.values(scope) }
}

/**
 * Run the three gates.
 *
 * `registered` is the sound map as it is *now*, not as it was at startup:
 * Strudel registers synths eagerly and sample banks only once their network
 * fetch lands, so the same pattern is playable or silent depending on when it
 * is asked. Reading the registry late is the difference between a check that
 * means something and one that passes everything.
 */
export function verify(code: string, vocab: Vocabulary, registered: Set<string>): Verdict {
  const trimmed = code.trim().replace(/^```(?:javascript|js)?\s*|\s*```$/g, '').trim()
  if (!trimmed) return { ok: false, stage: 'no-eval', detail: 'empty' }

  const first = standIn(trimmed, registered)
  const { code: mapped, remapped } = repair(first.code, registered)
  remapped.unshift(...first.remapped)

  const unknown = soundsNamed(mapped).filter((n) => !registered.has(n))
  if (unknown.length) return { ok: false, stage: 'unknown-sound', detail: unknown.join(' ') }

  let pattern: unknown
  try {
    // eslint-disable-next-line no-new-func
    const build = new Function(...vocab.names, `"use strict"; return (${mapped})`)
    pattern = build(...vocab.values)
  } catch (err) {
    return { ok: false, stage: 'no-eval', detail: String((err as Error)?.message ?? err).slice(0, 90) }
  }

  // A pattern that evaluates and queries to nothing is the failure that looks
  // most like success: the scheduler runs, the transport advances, and the room
  // is silent. `queryArc` over two cycles is the cheapest way to catch it.
  try {
    const haps = (pattern as { queryArc(a: number, b: number): unknown[] }).queryArc(0, 2)
    if (!Array.isArray(haps) || !haps.length) return { ok: false, stage: 'silent', detail: 'no events in two cycles' }
    return { ok: true, pattern, haps: haps.length, remapped }
  } catch (err) {
    return { ok: false, stage: 'silent', detail: String((err as Error)?.message ?? err).slice(0, 90) }
  }
}

/** What a whole attempt-until-playable run decided. */
export type Attempt =
  | { ok: true; code: string; pattern: unknown; haps: number; remapped: string[]; tries: number }
  | { ok: false; tries: number; reasons: string[] }

/**
 * Keep asking until something plays.
 *
 * One generation is not a good enough bet to build a feature on. Measured over
 * nine real generations against a registry holding only the 19 synth voices —
 * the worst case, with the sample banks unreachable — four were playable as
 * written. Every rejection was correct: three named sounds that do not exist,
 * one called `voicing()`, which is not a function Strudel exports.
 *
 * `repair` converts most of the first kind, since an invented name is a bad
 * *word* rather than a bad *arrangement*. What is left is genuinely malformed
 * and the only answer is to ask again — a different seed, so the sampler takes
 * a different path rather than reproducing the same mistake deterministically.
 *
 * Four attempts, and the arithmetic is why: at a conservative half surviving
 * per attempt that is fifteen in sixteen, and the failure that remains falls
 * back to `compose.ts`, which cannot fail because it cannot say anything
 * unplayable. So the set always starts. What varies is whether it was written
 * or arranged, and the fact says which.
 *
 * The reasons are collected rather than discarded. A run that took three tries
 * and reports `unknown-sound gm_pad · silent · ok` is describing the model's
 * failure modes to whoever reads the log, which is the only way the prompt or
 * the stand-in table ever gets better.
 */
export async function untilPlayable(
  write: (seed: number) => Promise<string>,
  vocab: Vocabulary,
  registered: Set<string>,
  tries = 4,
): Promise<Attempt> {
  const reasons: string[] = []
  for (let i = 0; i < tries; i++) {
    // The seed is the attempt number, so a set is reproducible from the two
    // things a report can carry: what was asked for, and which try it was.
    let code: string
    try {
      code = await write(i + 1)
    } catch (err) {
      reasons.push(`write failed: ${String((err as Error)?.message ?? err).slice(0, 60)}`)
      continue
    }
    const v = verify(code, vocab, registered)
    if (v.ok) {
      return { ok: true, code, pattern: v.pattern, haps: v.haps, remapped: v.remapped, tries: i + 1 }
    }
    reasons.push(`${v.stage}${v.detail ? ` ${v.detail}` : ''}`)
  }
  return { ok: false, tries, reasons }
}
