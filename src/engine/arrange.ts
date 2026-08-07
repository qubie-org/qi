/**
 * Turning a decision into a set, and into a file you can read.
 *
 * `compose.ts` already establishes the division this file extends. The model
 * does not write Strudel; it fills a struct, under a grammar that makes
 * anything unplayable unexpressible, and code turns the struct into music. That
 * held while everything was synthesised. Adding found recordings makes it
 * matter more, not less — a model asked to place a sample will happily write
 * `s("crate0").chop(8).jux(rev).striate(4)`, three of which might exist.
 *
 * So the model's whole vocabulary for a sample is four fields: which one, what
 * job it is doing, how often it comes round, and how far into the file to start.
 * Everything after that is measurement and arithmetic.
 *
 * ── Why the source text exists at all ──────────────────────────────────────
 *
 * A set used to be entirely ephemeral: an audio graph, a scheduler, and nothing
 * you could look at. That was acceptable while every sound was generated from
 * four numbers, because the four numbers *were* the set. It stops being
 * acceptable the moment real recordings are involved, for a reason that is
 * legal before it is aesthetic — a set assembled from CC-licensed audio has to
 * be able to name every source, and "the app knew at the time" is not naming.
 *
 * So the struct is rendered twice: once into patterns that play, and once into
 * Strudel source with the credits at the top. The two are produced together, as
 * `Layer` pairs — `{ pattern, source }` — rather than by two separate writers
 * that would drift apart within a month. Neither half of a pair is allowed to
 * exist without the other.
 *
 * The pairs themselves are built in `dj.ts` and not here, and that split is
 * forced rather than chosen: `@strudel/core` imports `SalatRepl` from
 * `@kabelsalat/web`, which cannot be loaded outside a browser at all, so any
 * module that touches `s()` or `note()` is untestable under bun. Everything in
 * this file — what the model may say, how it is clamped, what rate a sample
 * plays at, what the file looks like — is arithmetic and strings, and keeping
 * it free of the pattern library is what lets `__tests__/arrange.ts` check any
 * of it. `dj.ts` builds the pairs; this file decides what goes in them and
 * writes them out.
 *
 * Nothing evaluates the text. It is not a round trip, it is a record. Evaluating
 * generated Strudel inside an audio callback is precisely the failure mode this
 * whole design was built to avoid, and it does not become safe because the
 * generator happens to be ours.
 */
import type { Key } from './key'
import type { Mood } from './dj'
// Type-only, and that is load-bearing rather than tidy: `crate.ts` imports
// superdough, superdough imports @kabelsalat/web, and that module cannot be
// loaded outside a browser at all — `SalatRepl` is not found and the import
// throws. A type import is erased, so everything in this file that does not
// touch the audio engine stays testable under bun. `sampleLayer` therefore
// takes a `Sound` rather than looking one up by name.
import type { Sound } from './crate'
import { put } from '../pages/space'

/**
 * What the model may say about a sample.
 *
 * `role` rather than a set of numbers. "This is the lead" is a musical
 * judgement a model can make from a one-line description; "this should be at
 * 0.42 gain through a 900 Hz low-pass" is not, and asking for it produces
 * confident nonsense that has to be clamped back into the range it should have
 * been chosen from in the first place. Each role below carries its own gain,
 * filtering and space, decided here once.
 */
export type Placement = {
  /** The crate name — `crate0`. Anything else is dropped. */
  sound: string
  role: 'lead' | 'bed' | 'stab' | 'texture'
  /** Comes round once every N cycles. 1 is every bar; 8 is once a phrase. */
  every: number
  /** How far into the recording to start, 0–1. */
  begin: number
}

/** The grammar the model fills. One object per sample, and never many. */
export const PLACEMENT_SCHEMA = {
  type: 'array',
  minItems: 0,
  // Two, not eight. A set with eight found samples in it is not an arrangement,
  // it is a collision — and each one costs a download measured in seconds.
  maxItems: 2,
  items: {
    type: 'object',
    properties: {
      sound: { type: 'string' },
      role: { type: 'string', enum: ['lead', 'bed', 'stab', 'texture'] },
      every: { type: 'integer' },
      begin: { type: 'number' },
    },
    required: ['sound', 'role', 'every', 'begin'],
  },
}

/**
 * How each role sits in the mix.
 *
 * These are the numbers the model is not asked for. `gain` is deliberately low
 * across the board: the found recording is joining a set that already has a
 * kick, a bass and a pad in it, and a sample mastered to modern loudness will
 * be 20 dB above everything the synthesiser makes if it is let in at unity.
 */
export const ROLES = {
  /** The thing the set is about. Loud, unfiltered, comes round often. */
  lead: { gain: 0.5, room: 0.15, cutoff: 0, loop: false },
  /** Underneath everything, long and quiet. */
  bed: { gain: 0.3, room: 0.5, cutoff: 2200, loop: true },
  /** A hit. Short, present, occasional. */
  stab: { gain: 0.45, room: 0.25, cutoff: 0, loop: false },
  /** Barely there on purpose — air, not content. */
  texture: { gain: 0.18, room: 0.7, cutoff: 3500, loop: true },
} as const

const clamp = (n: number, lo: number, hi: number, fallback: number) =>
  Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback

/**
 * Fold whatever the model said onto something playable.
 *
 * The same discipline `compose.ts` applies to a mood: a grammar guarantees the
 * shape and says nothing about the values, so every field is checked. The one
 * that cannot be clamped is `sound` — a name that is not in the crate refers to
 * a recording that does not exist, and there is no nearest sensible value for
 * that, so the placement is dropped.
 */
export function placements(raw: unknown, offered: Sound[]): Placement[] {
  if (!Array.isArray(raw)) return []
  const names = new Set(offered.map((o) => o.name))
  const out: Placement[] = []
  // The cap is on what is *accepted*, not on what is read. Slicing the input to
  // two first meant a repeated name or a malformed entry spent a slot, so a
  // model that named the same recording twice got one sample instead of two.
  for (const item of raw) {
    if (out.length >= 2) break
    if (!item || typeof item !== 'object') continue
    const p = item as Record<string, unknown>
    const sound = String(p.sound ?? '')
    if (!names.has(sound) || out.some((o) => o.sound === sound)) continue
    const role = (['lead', 'bed', 'stab', 'texture'] as const).includes(p.role as never)
      ? (p.role as Placement['role'])
      : 'texture'
    out.push({
      sound,
      role,
      // 1–16 cycles. Above 16 the sample is heard once and never returns, which
      // reads as a glitch rather than as an arrangement.
      every: Math.round(clamp(Number(p.every), 1, 16, role === 'bed' ? 4 : 2)),
      // Never past 0.9 — a sample that starts in its last tenth is a click.
      begin: clamp(Number(p.begin), 0, 0.9, 0),
    })
  }
  return out
}

/** The set's own tempo in BPM. Strudel counts cycles; four beats to a cycle. */
export const bpmOf = (mood: Mood): number => mood.cps * 60 * 4

/**
 * What playback rate to use, and why.
 *
 * `speed` is the only pitch and tempo control a sampler has, and it does both
 * at once — which means it cannot serve two masters and the choice has to be
 * made deliberately rather than by whichever branch happens to run last.
 *
 *   Rhythmic material — a confident tempo — is speed-matched to the set. A
 *   drum loop that is not in time with the kick is not a texture, it is a
 *   mistake, and the pitch shift that comes with the stretch is inaudible on
 *   percussion. The rate is folded into a single octave so the stretch is never
 *   extreme: a 174 BPM break under a 120 BPM set plays at 0.69× and lands on
 *   120, rather than at 1.38× and landing on 240.
 *
 *   The window is [1/1.5, 1.5) and its edges were chosen by being wrong first.
 *   With a lower bound of 0.69 the exact case above — 120/174 = 0.6897 — fell
 *   a thousandth *outside* it, doubled, and the break came back at double time.
 *   An interval boundary that a common tempo pair lands within 0.2% of is a
 *   boundary in the wrong place; a musical fifth of headroom either side is not.
 *
 *   Pitched material — a confident chroma and no tempo — is transposed to the
 *   key instead, by the shortest distance, so a sample recorded in F sits in
 *   the set's D rather than a tritone away from it.
 *
 *   Anything confident about neither is played at 1. Guessing costs more than
 *   it returns.
 *
 * `note()` is not used for this and the reason is written down in `dj.ts`:
 * bare numbers there are MIDI, samples have no MIDI to be relative to unless
 * the bank declares one, and the last time a frequency was passed to something
 * expecting a note the whole set played silently at 24 kHz. `speed` is a plain
 * ratio and cannot be misread.
 */
export function rateFor(sound: Sound, mood: Mood, key: Key): { speed: number; why: string } {
  const a = sound.analysis
  if (a.bpm && a.confidence >= 0.4) {
    const target = bpmOf(mood)
    let ratio = target / a.bpm
    while (ratio >= 1.5) ratio /= 2
    while (ratio < 1 / 1.5) ratio *= 2
    return { speed: +ratio.toFixed(4), why: `${Math.round(a.bpm)}→${Math.round(target)} bpm` }
  }
  if (a.pitch !== null && a.pitchConfidence >= 0.5) {
    // Shortest way round the circle: a fifth up is a fourth down, and a fourth
    // down leaves the sample sounding like itself.
    let steps = (((key.root % 12) - a.pitch + 6) % 12) - 6
    if (steps < -6) steps += 12
    return { speed: +(2 ** (steps / 12)).toFixed(4), why: `${a.pitchName}→key` }
  }
  return { speed: 1, why: 'as recorded' }
}

/** A pattern and the line of Strudel that would have made it. Never one alone. */
export type Layer = { pattern: unknown; source: string }

/**
 * The file.
 *
 * Runnable Strudel, credits first. The credits are first rather than last
 * because this text is the thing that gets copied somewhere else, and an
 * attribution at the bottom of a file is an attribution that gets cut off.
 */
export function strudelFile(mood: Mood, key: Key, layers: Layer[], sounds: Sound[]): string {
  const head = [
    `// ${mood.id} — ${key.mode.name} on ${key.root}, ${Math.round(bpmOf(mood))} bpm`,
    '//',
  ]
  if (sounds.length) {
    head.push('// Samples, via Openverse:')
    for (const snd of sounds) {
      head.push(`//   ${snd.name}  ${snd.attribution}`)
      head.push(`//           ${snd.landing || snd.url}`)
      const a = snd.analysis
      head.push(
        `//           ${Math.round(snd.seconds)}s` +
          (a.bpm ? `, ${Math.round(a.bpm)} bpm (confidence ${a.confidence.toFixed(2)})` : ', no steady tempo') +
          (a.pitchName ? `, around ${a.pitchName}` : '') +
          (snd.clipped ? ', clipped to the first 600 KB' : ''),
      )
    }
    head.push('//')
    head.push('// Sample names are local. To run this elsewhere, point them at the URLs above:')
    head.push(
      `// samples({ ${sounds.map((snd) => `${snd.name}: ["${snd.url}"]`).join(', ')} }, '')`,
    )
    head.push('//')
  }

  return [
    ...head,
    `setcps(${mood.cps})`,
    '',
    'stack(',
    ...layers.map((l) => `  ${l.source},`),
    ')',
    '',
  ].join('\n')
}

/**
 * Keep the file where the rest of the app keeps things.
 *
 * A page, not a download and not a blob in local storage, because the page
 * space is the address book this app already has — `qi:the-set` can be opened,
 * linked to from a reply, and replaced in place when the next set starts. One
 * id, deliberately: a history of every set anybody ever played is a feature
 * nobody asked for and forty dead pages within an afternoon.
 */
export function keepSet(mood: Mood, source: string, sounds: Sound[]): string {
  put({
    id: 'the-set',
    kind: 'page',
    title: `the set — ${mood.id}`,
    body: [
      '```',
      source.trimEnd(),
      '```',
      ...(sounds.length ? ['', ...sounds.map((snd) => `- ${snd.attribution}`)] : []),
    ].join('\n'),
    aliases: ['the set', 'set', 'strudel', mood.id],
    src: sounds.length ? 'openverse' : 'qi',
  })
  return 'the-set'
}
