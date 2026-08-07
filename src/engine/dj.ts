/**
 * A set, playing underneath.
 *
 * Everything else the app makes noise about is an event — a keystroke, an
 * answer landing, a mark pressed. Each is a moment, and moments are what the
 * `sound.ts` voices are shaped for. A set is the opposite: it is continuous, it
 * has a tempo, and it is still going while a hundred of those moments happen on
 * top of it.
 *
 * That is exactly why Strudel is here rather than a hand-rolled sequencer. The
 * interface sounds and the set come out of the same synth engine — superdough —
 * so they genuinely share a mix rather than merely agreeing about pitch, and
 * the pattern language does the part that is tedious to write by hand and
 * boring to get wrong: cycles, subdivision, polyrhythm, and the scheduling that
 * keeps them in phase.
 *
 * The important design decision is which direction the key flows.
 *
 * Normally the key drifts from the conversation — `keyFor(vibe)` reads the same
 * four numbers the palette reads, so a grave conversation lowers the tonic. But
 * while a set is playing, the set *is* the room, and having the tonic move
 * under a running bassline because someone asked a sad question would be
 * audible as a mistake rather than as responsiveness. So starting a set pins
 * the key, and every interface sound re-tunes to it for as long as it plays.
 * Stopping unpins, and the drift resumes from wherever the conversation is now.
 *
 * The set is generated, not stored. There is no library of patterns here and
 * there should not be: a fixed set would be the same eight bars every time, and
 * the thing that makes this worth having is that the room sounds different on
 * Tuesday.
 */
import { getAudioContext, initAudio, samples } from '@strudel/webaudio'
import * as strudelCore from '@strudel/core'
import * as strudelAudio from '@strudel/webaudio'
import { soundMap } from 'superdough'
import { note, repl, s, sine, silence, stack, setStringParser } from '@strudel/core'
import { mini } from '@strudel/mini'
import { webaudioOutput } from '@strudel/webaudio'
import { degree, MODES, type Key } from './key'
import { audioNow, currentKey, pinKey, unpinKey } from './sound'
import { keepSet, rateFor, ROLES, strudelFile, type Layer, type Placement } from './arrange'
import { emptyCrate, inCrate, soundNamed, type Sound } from './crate'
import { untilPlayable, vocabulary, type Attempt } from './verify'
import type { Write } from '../packs/strudel'

/**
 * Register mini-notation as the parser for bare strings.
 *
 * Without this, `note('c3 e3 g3')` is one note literally named "c3 e3 g3" —
 * measured, not assumed. With it, the same string is three notes across a
 * cycle, which is the entire ergonomic argument for using Strudel at all.
 */
let parserReady = false
function ensureParser(): void {
  if (parserReady) return
  setStringParser(mini)
  parserReady = true
}

/**
 * Real drums, if the network will give us any.
 *
 * The synthesised kit is honest but thin — noise through a band is recognisably
 * a snare and recognisably not a good one. Dirt-Samples is the set every
 * TidalCycles and Strudel example is written against, 219 banks of it, and it
 * turns out to be reachable from inside a cross-origin-isolated page after all.
 *
 * The route matters and was measured rather than assumed. Under COEP
 * `require-corp` the obvious hosts behave differently: `strudel.cc` fails
 * outright, `raw.githubusercontent.com` returns the bytes but sends no
 * `Cross-Origin-Resource-Policy` header, and **jsdelivr serves the same
 * repository with `cross-origin-resource-policy: cross-origin`** — which is
 * exactly what the isolation rule wants. So the manifest and the base URL are
 * both pinned to jsdelivr, and no proxy is needed.
 *
 * Failure is fine. If this never resolves — offline, blocked, rate-limited —
 * `ready` stays false and the kit falls back to synthesis. A set that plays
 * with worse drums is a much better outcome than one that does not play.
 */
const KIT = 'https://cdn.jsdelivr.net/gh/tidalcycles/dirt-samples@master'

let kitReady = false
let kitLoading: Promise<void> | null = null

export const haveSamples = (): boolean => kitReady

function loadKit(): Promise<void> {
  kitLoading ??= (async () => {
    const res = await fetch(`${KIT}/strudel.json`)
    if (!res.ok) throw new Error(`sample manifest ${res.status}`)
    const manifest = await res.json()
    // The manifest names raw.githubusercontent.com as its base. Overridden so
    // every sample comes from the host that sends CORP, rather than relying on
    // the one that happens to work.
    delete manifest._base
    await samples(manifest, `${KIT}/`)
    kitReady = true
  })().catch((err) => {
    console.warn('dj: no sample kit, using synthesis', err)
    kitLoading = null
  })
  return kitLoading
}

export type Mood = {
  id: string
  /** Words that reach it, matched loosely against whatever was typed. */
  reaches: string[]
  /** Cycles per second. Strudel's tempo unit — 0.5 cps is 120 bpm in 4/4. */
  cps: number
  /** Which mode of the current tonic, by name. */
  mode: string
  /**
   * The kit, as three rhythms of `x` and `~` in mini-notation.
   *
   * Roles, not voices. The rhythm says *when* a kick happens; what a kick
   * sounds like is decided at build time by whether the sample bank loaded.
   * Writing `bd ~ ~ bd` here would have hard-coded the answer into every mood
   * and meant maintaining two copies of each pattern.
   */
  kick: string
  snare: string
  hat: string
  /** Degrees of the scale the bass walks. */
  bass: number[]
  /** Degrees the pad holds. */
  pad: number[]
  /** How open the filter sits. */
  cutoff: number
}

/**
 * Four moods, not forty.
 *
 * Each is a genuinely different room rather than a preset with one parameter
 * changed — different tempo, different mode, different rhythm, different
 * register. A long list of near-identical moods would make the argument to
 * `$dj` meaningless, because whichever you typed you would get roughly the
 * same thing and stop believing the word mattered.
 */
export const MOODS: Mood[] = [
  {
    id: 'deep',
    reaches: ['deep', 'house', 'night', 'late', 'dark', 'club'],
    cps: 0.5,
    mode: 'aeolian',
    kick: 'x ~ ~ x',
    snare: '~ ~ x ~',
    hat: 'x*8',
    bass: [0, 0, 3, 2],
    pad: [0, 2, 4],
    cutoff: 900,
  },
  {
    id: 'ambient',
    reaches: ['ambient', 'calm', 'quiet', 'soft', 'slow', 'focus', 'study', 'work'],
    cps: 0.28,
    mode: 'pentatonic',
    kick: '~',
    snare: '~',
    hat: '~',
    bass: [0, 4],
    pad: [0, 2, 4, 6],
    cutoff: 1400,
  },
  {
    id: 'bright',
    reaches: ['bright', 'happy', 'up', 'upbeat', 'morning', 'sun', 'pop'],
    cps: 0.58,
    mode: 'lydian',
    kick: 'x ~ x ~',
    snare: '~ x ~ x',
    hat: 'x*4',
    bass: [0, 2, 4, 2],
    pad: [0, 2, 4],
    cutoff: 2600,
  },
  {
    id: 'drive',
    reaches: ['drive', 'fast', 'hard', 'techno', 'energy', 'gym', 'run'],
    cps: 0.66,
    mode: 'dorian',
    kick: 'x*4',
    snare: '~ x ~ x',
    hat: 'x*16',
    bass: [0, 0, 0, 5],
    pad: [0, 4],
    cutoff: 1800,
  },
]

/** Whichever mood the words point at; `deep` when they point nowhere. */
export function moodFor(argument: string): Mood {
  const words = argument.toLowerCase().split(/\W+/).filter(Boolean)
  let best = MOODS[0]
  let bestHits = 0
  for (const mood of MOODS) {
    const hits = words.filter((w) => mood.reaches.some((r) => r.startsWith(w) || w.startsWith(r))).length
    if (hits > bestHits) {
      best = mood
      bestHits = hits
    }
  }
  return best
}

type Playing = {
  mood: Mood
  key: Key
  scheduler: { start(): void; stop(): void; setPattern(p: unknown, autostart?: boolean): void }
  /** The generated Strudel source for whatever is currently playing. */
  source: string
}

let playing: Playing | null = null

export const nowPlaying = (): { mood: string; key: string } | null =>
  playing ? { mood: playing.mood.id, key: `${playing.key.mode.name} on ${playing.key.root}` } : null

/**
 * The set as text, or nothing.
 *
 * Exposed because a set that uses found recordings has to be able to show its
 * own credits, and the file is where they live. See `arrange.ts` for why the
 * text exists at all and why nothing ever evaluates it.
 */
export const setSource = (): string => playing?.source ?? ''

/** `s("x").gain(1).room(2)` — the text half of a layer, built beside the pattern. */
const call = (base: string, calls: [string, string | number][]): string =>
  base + calls.map(([m, v]) => `.${m}(${v})`).join('')

/**
 * One found recording, placed.
 *
 * `every` is expressed as a mask rather than as `.every()`, because Strudel's
 * `every` applies a *function* every N cycles and what is wanted here is for
 * the sample to sound on one cycle in N and be silent on the others. The mask
 * is written out longhand — `<1 0 0 0>` — so the generated file says plainly
 * what it does instead of relying on the reader knowing which of the two it is.
 */
function sampleLayer(p: Placement, sound: Sound, mood: Mood, key: Key): Layer {
  const role = ROLES[p.role]
  const { speed } = rateFor(sound, mood, key)

  const mask = p.every <= 1 ? '' : `<1${' 0'.repeat(p.every - 1)}>`
  const calls: [string, string | number][] = []
  if (p.begin > 0) calls.push(['begin', p.begin.toFixed(3)])
  if (speed !== 1) calls.push(['speed', speed])
  calls.push(['gain', role.gain])
  if (role.cutoff) calls.push(['cutoff', role.cutoff])
  if (role.room) calls.push(['room', role.room])
  if (mask) calls.push(['mask', `"${mask}"`])

  let pattern = s(p.sound) as any
  if (p.begin > 0) pattern = pattern.begin(p.begin)
  if (speed !== 1) pattern = pattern.speed(speed)
  pattern = pattern.gain(role.gain)
  if (role.cutoff) pattern = pattern.cutoff(role.cutoff)
  if (role.room) pattern = pattern.room(role.room)
  if (mask) pattern = pattern.mask(mask)

  return { pattern, source: call(`s("${p.sound}")`, calls) }
}

/**
 * The synthesised half, as patterns and as text.
 *
 * The drum voices depend on whether the sample bank loaded, which is why
 * `voices` is a parameter rather than being read from `kitReady` inside: the
 * generated source has to say `sbd` when `sbd` is what played, or the file is a
 * faithful description of a set nobody heard.
 */
function coreLayers(
  mood: Mood,
  key: Key,
  voices: { kick: string; snare: string; hat: string },
  real: boolean,
): Layer[] {
  const notes = (degrees: number[], octave: number) =>
    degrees.map((d) => degree(key, d) + octave * 12).join(' ')

  const out: Layer[] = []
  const rhythm = (pattern: string, voice: string) => pattern.replace(/x/g, voice)

  if (mood.kick !== '~') {
    const src = rhythm(mood.kick, voices.kick)
    out.push({
      pattern: (s(src) as any).gain(real ? 0.5 : 0.34).decay(0.16),
      source: `s("${src}").gain(${real ? 0.5 : 0.34}).decay(0.16)`,
    })
  }
  if (mood.snare !== '~') {
    const src = rhythm(mood.snare, voices.snare)
    out.push(
      real
        ? { pattern: (s(src) as any).gain(0.34), source: `s("${src}").gain(0.34)` }
        : {
            pattern: (s(src) as any).bandf(1800).bandq(2.2).decay(0.11).gain(0.16),
            source: `s("${src}").bandf(1800).bandq(2.2).decay(0.11).gain(0.16)`,
          },
    )
  }
  if (mood.hat !== '~') {
    const src = rhythm(mood.hat, voices.hat)
    out.push(
      real
        ? { pattern: (s(src) as any).gain(0.18).mask('<1 1 0 1>'), source: `s("${src}").gain(0.18).mask("<1 1 0 1>")` }
        : {
            pattern: (s(src) as any).hcutoff(7000).decay(0.028).gain(0.075).mask('<1 1 0 1>'),
            source: `s("${src}").hcutoff(7000).decay(0.028).gain(0.075).mask("<1 1 0 1>")`,
          },
    )
  }

  const bass = notes(mood.bass, -1)
  out.push({
    pattern: (note(bass) as any)
      .s('sawtooth')
      .cutoff(mood.cutoff * 0.5)
      .gain(0.16)
      .attack(0.01)
      .release(0.18),
    source: `note("${bass}").s("sawtooth").cutoff(${mood.cutoff * 0.5}).gain(0.16).attack(0.01).release(0.18)`,
  })

  const pad = notes(mood.pad, 0)
  const lo = Math.round(mood.cutoff * 0.55)
  const hi = Math.round(mood.cutoff * 1.35)
  out.push({
    pattern: (note(pad) as any)
      .s('triangle')
      .slow(4)
      .gain(0.075)
      .attack(1.2)
      .release(2.5)
      .room(0.6)
      .cutoff(sine.range(lo, hi).slow(32)),
    source:
      `note("${pad}").s("triangle").slow(4).gain(0.075).attack(1.2).release(2.5).room(0.6)` +
      `\n    .cutoff(sine.range(${lo}, ${hi}).slow(32))`,
  })

  return out
}

/** Stack whatever layers exist. `silence` rather than an empty stack, which throws. */
const stackOf = (layers: Layer[]): unknown =>
  layers.length ? stack(...layers.map((l) => l.pattern)) : silence


/**
 * Build the pattern, and the text that describes it.
 *
 * Notes are MIDI numbers, not names and not frequencies.
 *
 * Frequencies were the first attempt and they are silently wrong: `note()`
 * reads a bare number as a MIDI note, so `note("130.81")` — middle C in hertz —
 * is MIDI 130, four octaves above the top of a piano, and every voice came out
 * at 24000 Hz. Which is the Nyquist frequency at this sample rate, i.e. exactly
 * inaudible, so the set "played" perfectly and made no sound. Measured by
 * sampling `OscillatorNode.frequency` on a running set; nothing else would have
 * caught it.
 *
 * MIDI is also the honest unit here: `degree()` already returns one, so this
 * passes it straight through instead of converting to hertz for Strudel to
 * convert back.
 *
 * The layer construction itself moved to `arrange.ts`. Not for tidiness: every
 * layer now has to exist twice — once as a pattern that plays and once as a
 * line of Strudel in the generated file — and two writers in two files is how
 * the file ends up describing a set nobody is listening to. Each layer is built
 * as a pair, in one place, and this function only stacks them.
 */
function build(mood: Mood, key: Key, placed: Placement[]): { pattern: unknown; source: string } {
  ensureParser()

  // The same rhythms, played by whatever voices exist.
  //
  // With the sample kit loaded these are Dirt-Samples names, which is what
  // every Strudel example in the world is written against. Without it they are
  // superdough's own voices: a synth bass drum, and white noise shaped two
  // different ways — recognisably a kit, and recognisably a cheaper one.
  const voices = kitReady
    ? { kick: 'bd', snare: 'sd', hat: 'hh' }
    : { kick: 'sbd', snare: 'white', hat: 'white' }

  /**
   * Arrangement, which is where "sounds better" actually comes from.
   *
   * Everything above decides what one bar contains. Nothing above decides what
   * happens in the second minute, and that was the real weakness: a set that
   * loops one perfect bar forever stops being music after about ninety seconds,
   * however good the bar is. The ear gives up on anything that has stopped
   * telling it something new.
   *
   * None of this needs a model. Strudel already has the vocabulary for change
   * over time, and change over time is deterministic — a filter opening across
   * half a minute, hats sitting out every third phrase, a kick that thins once
   * in a while. Those are arrangement decisions in the ordinary sense and there
   * is nothing for a language model to decide about them.
   *
   * The periods are deliberately coprime-ish — 4, 8, 24, 32 cycles — so the
   * layers drift in and out of alignment instead of all changing on the same
   * bar, which is what makes a loop sound like an arrangement rather than like
   * a switch being flipped. A found sample joins that scheme through its own
   * `every`, which is the one arrangement decision the model does get to make.
   */
  const layers: Layer[] = [...coreLayers(mood, key, voices, kitReady)]
  const sounds = []
  for (const p of placed) {
    // A placement naming a sound that is not in the crate is dropped rather
    // than repaired. There is no nearest sensible recording.
    const sound = soundNamed(p.sound)
    if (!sound) continue
    sounds.push(sound)
    layers.push(sampleLayer(p, sound, mood, key))
  }

  return { pattern: stackOf(layers), source: strudelFile(mood, key, layers, sounds) }
}

/**
 * Start a set. Idempotent in effect: starting while playing replaces the set
 * rather than layering a second one over the first.
 */
/** The key a mood implies, over whatever tonic the conversation already has. */
export function keyForMood(mood: Mood): Key {
  const base = currentKey()
  return {
    ...base,
    mode: MODES.find((m) => m.name === mood.mode) ?? base.mode,
    cutoff: mood.cutoff,
  }
}

/**
 * Start a set. Idempotent in effect: starting while playing replaces the set
 * rather than layering a second one over the first.
 */
/**
 * What to ask the model for.
 *
 * The mood carries what the words were understood to mean — tempo, mode, and
 * the words that reached it — and the crate carries what was found to play. A
 * model asked only for "deep" writes the median deep set; told the tempo and
 * that there are two found recordings in the room, it writes something that
 * fits them.
 */
function describeFor(mood: Mood, placed: Placement[]): string {
  const bpm = Math.round(mood.cps * 120)
  const found = placed.length
    ? `, using ${placed.length} sampled recording${placed.length === 1 ? '' : 's'}`
    : ''
  return `a ${mood.id} set in ${mood.mode} at ${bpm} bpm${found}`
}

/**
 * What a generated pattern may name, and what will actually make a sound.
 *
 * Both are read at the moment of use rather than cached. Strudel registers its
 * synths eagerly but a sample bank only once its download lands, so the same
 * pattern is playable or silent depending on when the question is asked —
 * measured, the registry holds 19 names before `loadKit` and 237 after. A
 * check against the early number rejects every drum the model writes.
 */
const strudelVocabulary = () =>
  vocabulary(
    strudelCore as unknown as Record<string, unknown>,
    strudelAudio as unknown as Record<string, unknown>,
  )

const registeredSounds = () => new Set(Object.keys(soundMap.get()))

export async function startSet(
  mood: Mood,
  placed: Placement[] = [],
  write?: Write,
): Promise<{ mood: string; key: string; source: string; page: string; wrote: Attempt | null }> {
  await initAudio()
  ensureParser()

  // Waited for, not fired and forgotten: a set that starts on synths and swaps
  // to samples four seconds in is a glitch, not an upgrade. If it fails, it
  // fails fast and the synth kit plays.
  await loadKit()

  // `halt`, not `stopSet`: stopping empties the crate, and the crate is what
  // the caller has just spent ten seconds filling. Replacing a set must not
  // throw away the recordings the replacement is made of.
  if (playing) halt()

  // The tonic stays where the conversation had it and only the mode changes, so
  // starting a set does not transpose the room out from under whatever was just
  // said.
  const key = keyForMood(mood)

  const ctx = getAudioContext()
  const { scheduler } = repl({
    defaultOutput: webaudioOutput,
    // The same monotonic estimate the interface sounds use, for the same
    // reason: given the raw clock this scheduler logged hundreds of "skip
    // query: too late" while trying to keep a bar in phase against a value
    // that stalls and lurches.
    //
    // That message will come back, in bursts, and the second time it is not
    // this. Strudel's clock advances `phase` by 0.05s per callback and drives
    // the callback from a 100ms `setInterval`; macOS throttles timers in a
    // window that is not frontmost, so an occluded window wakes up owing
    // twenty ticks per second it was away and skips every one of them as
    // already past. Measured: frontmost, peak RMS 0.1999 and no skips at all;
    // occluded, 0.010 — silence — and a flood of them sharing one timestamp,
    // which is the tell. Nothing here is wrong when that happens, and there is
    // nothing to fix in the clock. Verify audio with the window in front.
    getTime: () => audioNow(ctx),
  })

  /**
   * Ask the model for a pattern, and fall back to arranging one.
   *
   * After `loadKit`, deliberately: the check reads the sound registry, and
   * before the kit lands that registry has no drums in it, so every pattern the
   * model writes would be rejected for naming `bd`.
   *
   * A failure here is not an error. `build` cannot produce anything unplayable,
   * because a struct under a grammar cannot express anything unplayable — so
   * the set always starts, and `wrote` is what says whether it was composed or
   * arranged. That is the honest version of this feature: the interesting path
   * is allowed to fail as often as it likes.
   */
  let wrote: Attempt | null = null
  let pattern: unknown
  let source: string

  if (write) {
    wrote = await untilPlayable(
      (seed) => write(describeFor(mood, placed), seed),
      strudelVocabulary(),
      registeredSounds(),
      // Two, not four. A generation costs about 37 seconds on the wasm backend,
      // and nobody waits two and a half minutes for a backing track. `repair`
      // is what makes two enough — it rescues the common failure rather than
      // spending another 37 seconds regenerating four good layers to fix one
      // invented word.
      2,
    )
    if (!wrote.ok) console.warn('dj: nothing playable in', wrote.tries, 'tries —', wrote.reasons.join(' · '))
  }

  if (wrote?.ok) {
    pattern = wrote.pattern
    source = wrote.code
  } else {
    const built = build(mood, key, placed)
    pattern = built.pattern
    source = built.source
  }

  scheduler.setPattern((pattern as { cps: (n: number) => unknown }).cps(mood.cps), true)
  playing = { mood, key, scheduler, source }

  // Everything the interface plays from here re-tunes to the set.
  pinKey(key)

  // The file is written whether or not anybody asks for it. A set with found
  // recordings in it has credits that have to survive the set, and writing them
  // down only when requested means they are missing exactly when somebody
  // wanted them.
  const page = keepSet(mood, source, inCrate())

  return { mood: mood.id, key: `${key.mode.name} on ${key.root}`, source, page, wrote }
}

/** Silence the scheduler and give the key back. Keeps the crate. */
function halt(): void {
  if (!playing) return
  try {
    playing.scheduler.stop()
  } catch {
    // Already stopped, or the context went away underneath it.
  }
  playing = null
  unpinKey()
}

/** Stop, and hand the key back to the conversation. */
export function stopSet(): void {
  halt()
  // The crate goes with the set. Object URLs held past the set that used them
  // are a few megabytes of decoded audio nobody can reach, and the next set
  // will want different sounds anyway.
  emptyCrate()
}

export const isPlaying = (): boolean => playing !== null
