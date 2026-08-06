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
import { note, repl, s, sine, silence, stack, setStringParser } from '@strudel/core'
import { mini } from '@strudel/mini'
import { webaudioOutput } from '@strudel/webaudio'
import { degree, MODES, type Key } from './key'
import { audioNow, currentKey, pinKey, unpinKey } from './sound'

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
}

let playing: Playing | null = null

export const nowPlaying = (): { mood: string; key: string } | null =>
  playing ? { mood: playing.mood.id, key: `${playing.key.mode.name} on ${playing.key.root}` } : null

/**
 * Build the pattern.
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
 */
function build(mood: Mood, key: Key) {
  ensureParser()

  const notes = (degrees: number[], octave: number) =>
    degrees.map((d) => degree(key, d) + octave * 12).join(' ')

  // The same rhythms, played by whatever voices exist.
  //
  // With the sample kit loaded these are Dirt-Samples names, which is what
  // every Strudel example in the world is written against. Without it they are
  // superdough's own voices: a synth bass drum, and white noise shaped two
  // different ways — recognisably a kit, and recognisably a cheaper one.
  const voices = kitReady
    ? { kick: 'bd', snare: 'sd', hat: 'hh' }
    : { kick: 'sbd', snare: 'white', hat: 'white' }

  const layer = (rhythm: string, voice: string) =>
    rhythm === '~' ? null : s(rhythm.replace(/x/g, voice))

  const kick = layer(mood.kick, voices.kick)?.gain(kitReady ? 0.5 : 0.34).decay(0.16) ?? silence

  // The filters only apply to the noise version. A recorded snare already has
  // its own body, and putting a 1.8 kHz band across it makes it sound like it
  // is being played through a telephone.
  const snareRaw = layer(mood.snare, voices.snare)
  const snare = snareRaw
    ? kitReady
      ? snareRaw.gain(0.34)
      : snareRaw.bandf(1800).bandq(2.2).decay(0.11).gain(0.16)
    : silence

  const hatRaw = layer(mood.hat, voices.hat)
  const hat = hatRaw
    ? kitReady
      ? hatRaw.gain(0.18)
      : hatRaw.hcutoff(7000).decay(0.028).gain(0.075)
    : silence

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
   * a switch being flipped.
   */
  const arranged = stack(
    // A kick that occasionally drops half its hits. Once every eight cycles,
    // which is often enough to notice and rare enough not to be a pattern.
    kick.every(8, (x: unknown) => (x as { degradeBy: (n: number) => unknown }).degradeBy(0.5)),
    snare,
    // Hats sit out one phrase in four. The single cheapest way to make a loop
    // breathe: taking a layer away is more audible than adding one.
    hat.mask('<1 1 0 1>'),
  )

  const drums = arranged

  const bass = note(notes(mood.bass, -1))
    .s('sawtooth')
    .cutoff(mood.cutoff * 0.5)
    .gain(0.16)
    .attack(0.01)
    .release(0.18)

  // The pad holds a chord across the whole cycle and is the layer the interface
  // sounds sit inside — quiet, slow, and wide open in time.
  const pad = note(notes(mood.pad, 0))
    .s('triangle')
    .slow(4)
    .cutoff(mood.cutoff)
    .gain(0.075)
    .attack(1.2)
    .release(2.5)
    .room(0.6)

  // The filter opens and closes over half a minute. Slow enough that you never
  // catch it moving, fast enough that the set is somewhere different by the
  // time you look up.
  const swept = pad.cutoff(sine.range(mood.cutoff * 0.55, mood.cutoff * 1.35).slow(32))

  return stack(drums, bass, swept)
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
export async function startSet(mood: Mood): Promise<{ mood: string; key: string }> {
  await initAudio()
  ensureParser()

  // Waited for, not fired and forgotten: a set that starts on synths and swaps
  // to samples four seconds in is a glitch, not an upgrade. If it fails, it
  // fails fast and the synth kit plays.
  await loadKit()

  if (playing) stopSet()

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
    getTime: () => audioNow(ctx),
  })

  scheduler.setPattern(build(mood, key).cps(mood.cps), true)
  playing = { mood, key, scheduler }

  // Everything the interface plays from here re-tunes to the set.
  pinKey(key)

  return { mood: mood.id, key: `${key.mode.name} on ${key.root}` }
}

/** Stop, and hand the key back to the conversation. */
export function stopSet(): void {
  if (!playing) return
  try {
    playing.scheduler.stop()
  } catch {
    // Already stopped, or the context went away underneath it.
  }
  playing = null
  unpinKey()
}

export const isPlaying = (): boolean => playing !== null
