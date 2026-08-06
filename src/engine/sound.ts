/**
 * The sound of the interface, in the key the conversation is in.
 *
 * This was twelve recordings. They were generated rather than licensed, chosen
 * by measurement rather than by ear, and they were still twelve fixed objects:
 * every one had a pitch baked into it, none of those pitches knew about each
 * other, and a keystroke tick landing under a callout chime produced whatever
 * interval the two happened to have been born with. Usually a bad one.
 *
 * So nothing is recorded now. Every sound is a degree of the current scale,
 * synthesised at the moment it plays, which changes what the sound system is:
 *
 *   it cannot clash with itself, because there is no interval available to it
 *   that is not in the scale — with exactly one exception, `miss`, which is
 *   the only dissonance in the app and therefore the only one that means
 *   something;
 *
 *   it drifts with the conversation, because the key comes from the same four
 *   numbers the palette comes from. The room going grave lowers the tonic and
 *   flattens the third. Nobody has to wire sound to meaning; it is already
 *   wired, upstream, to the same reading;
 *
 *   and it weighs nothing. Twelve WAVs were 204 KB of assets to fetch, decode
 *   and keep decoded. An oscillator and an envelope are neither.
 *
 * Synthesis is superdough — Strudel's engine — rather than raw WebAudio nodes,
 * because the music bed in `music.ts` needs a pattern engine anyway and having
 * the clicks and the music come out of the same synth is the only way they
 * genuinely sit in one mix rather than merely agreeing about pitch.
 *
 * Human events fire the instant they happen. Machine events may be quantised
 * to the bed's clock — see `music.ts` — because a click that waits for the
 * beat reads as lag when *you* caused it, and as composition when the app did.
 */
import { initAudio } from '@strudel/webaudio'
// getAudioContext comes from superdough, not from @strudel/webaudio. They are
// the same context, but superdough compares every deadline against *its* clock,
// and reading the time from the other module is how you end up scheduling
// against a reference that is a few samples off and getting everything
// rejected as being in the past.
import { getAudioContext, registerSynthSounds, superdough } from 'superdough'
import { degree, hz, keyFor, MISS, type Key } from './key'
import { NEUTRAL, type Vibe } from './theme'

export type Role =
  | 'type'
  | 'send'
  | 'land'
  | 'mark'
  | 'open'
  | 'close'
  | 'mode'
  | 'unmode'
  | 'step'
  | 'miss'
  | 'token'

let ready = false
let starting: Promise<void> | null = null
let key: Key = keyFor(NEUTRAL)

/**
 * A key that outranks the conversation's.
 *
 * Normally the key drifts with the vibe — that is the whole design. But while a
 * set is playing, the set is the room: a bassline is holding a tonic, and
 * letting a sad question lower it underneath would be heard as a fault rather
 * than as responsiveness. So a set pins, `tune` politely does nothing while
 * pinned, and stopping restores the drift from wherever the conversation has
 * got to by then.
 */
let pinned: Key | null = null

const STORE_KEY = 'qi.sound'
let muted = false
try {
  muted = localStorage.getItem(STORE_KEY) === 'off'
} catch {
  // Private mode, or storage disabled. Sound on is the right default.
}

/**
 * A clock that does not stall.
 *
 * `AudioContext.currentTime` is the value every deadline here is measured
 * against, and it is not smooth. Sampled every 100 ms against the wall clock it
 * stalled in 42 of 60 ticks — falling as much as 464 ms behind and then lurching
 * 128 ms forward to catch up. Whether that is the render thread starving or
 * WebKit only refreshing the value when the main thread is idle does not matter
 * downstream: superdough rejects any deadline at or behind its clock, so a
 * 40 ms lead computed during a stall is already in the past by the time it is
 * read, and the sound arrives whenever the clock next lurches. Which is exactly
 * the symptom — a keystroke tick a second or two late, intermittently, then
 * fine again.
 *
 * So the reported time is treated as a floor rather than as the truth. The last
 * value seen is remembered with the wall time it was seen at, and the estimate
 * advances with the wall clock in between. It is monotonic, it never stalls,
 * and it snaps back to the real clock the moment the real clock moves ahead of
 * it — so it cannot drift away from the audio hardware over a long session.
 */
let seenAudio = 0
let seenWall = 0

export function audioNow(ctx: AudioContext): number {
  const wall = performance.now() / 1000
  const reported = ctx.currentTime
  if (reported > seenAudio) {
    seenAudio = reported
    seenWall = wall
  }
  return Math.max(reported, seenAudio + (wall - seenWall))
}

/** Per-role last-played time, for the throttle. */
const lastAt = new Map<Role, number>()

/**
 * How often a role may fire, in milliseconds.
 *
 * Typing is the one that matters. A fast typist crosses 12 characters a second
 * and every one of them calls this; without a floor the notes overlap into a
 * chord nobody asked for, which is the exact failure that makes people turn
 * interface sound off and never turn it back on.
 */
const THROTTLE: Partial<Record<Role, number>> = { type: 34, mark: 60, step: 90, token: 62 }

/**
 * Where each event sits in the scale.
 *
 * Read down the column and it is a piece of writing about the app: sending is
 * a departure, so it rises a fifth. An answer landing is a resolution, so it
 * is the tonic triad. Opening and closing are the same two notes in opposite
 * order, which is what makes them audibly a pair. Failure is the one thing
 * outside the key.
 */
const VOICE: Record<Role, (k: Key, strength: number) => Note[]> = {
  // A quiet walk in the bottom of the scale. Not a rising run — an ascending
  // scale under typing turns every sentence into the same melody, and the ear
  // starts predicting it by the third word.
  type: (k) => [{ midi: degree(k, typeStep()), gain: 0.09, len: 0.05, attack: 0.001, decay: 0.04 }],

  // Departure: tonic to the fifth.
  send: (k) => [
    { midi: degree(k, 0), gain: 0.2, len: 0.16, attack: 0.002, decay: 0.14 },
    { midi: degree(k, 4), gain: 0.17, len: 0.3, at: 0.075, attack: 0.002, decay: 0.26 },
  ],

  // Resolution: the tonic triad, swelling rather than struck. The slow attack
  // is why it reads as arrival and not as another click.
  land: (k) => [
    { midi: degree(k, 0), gain: 0.16, len: 1.1, attack: 0.22, decay: 0.9, room: 0.35 },
    { midi: degree(k, 2), gain: 0.12, len: 1.0, at: 0.05, attack: 0.26, decay: 0.8, room: 0.35 },
    { midi: degree(k, 4), gain: 0.1, len: 0.95, at: 0.1, attack: 0.3, decay: 0.75, room: 0.35 },
  ],

  // Bright and small, an octave up — a mark is a detail, not an event.
  mark: (k) => [{ midi: degree(k, 4) + 12, gain: 0.13, len: 0.14, attack: 0.001, decay: 0.12, room: 0.2 }],

  open: (k) => [
    { midi: degree(k, 0), gain: 0.1, len: 0.1, attack: 0.004, decay: 0.09 },
    { midi: degree(k, 4), gain: 0.12, len: 0.24, at: 0.06, attack: 0.006, decay: 0.2, room: 0.25 },
  ],
  // The same two notes backwards, which is what a matched pair actually is.
  close: (k) => [
    { midi: degree(k, 4), gain: 0.1, len: 0.1, attack: 0.004, decay: 0.09 },
    { midi: degree(k, 0), gain: 0.11, len: 0.2, at: 0.055, attack: 0.005, decay: 0.17 },
  ],

  // A latch closing and opening: a third up, a third down. Tighter than the
  // others because it is a mechanism, not a gesture.
  mode: (k) => [
    { midi: degree(k, 0), gain: 0.14, len: 0.07, attack: 0.001, decay: 0.06 },
    { midi: degree(k, 2), gain: 0.13, len: 0.12, at: 0.052, attack: 0.001, decay: 0.1 },
  ],
  unmode: (k) => [
    { midi: degree(k, 2), gain: 0.13, len: 0.07, attack: 0.001, decay: 0.06 },
    { midi: degree(k, 0), gain: 0.12, len: 0.12, at: 0.052, attack: 0.001, decay: 0.1 },
  ],

  // Low and dull. A step is the app muttering to itself.
  step: (k) => [{ midi: degree(k, 1) - 12, gain: 0.08, len: 0.09, attack: 0.002, decay: 0.08 }],

  // The only note in the app that is not in the key.
  miss: (k) => [{ midi: MISS(k), gain: 0.15, len: 0.5, attack: 0.006, decay: 0.45, cutoff: 700 }],

  // A grain of text arriving — the tap under each token.
  //
  // Two earlier versions were wrong in opposite directions. The first was a
  // pitched sine two octaves up: audible, but a note every 60 ms is a melody
  // whether you wanted one or not, and it competed with the words. The second
  // over-corrected into a 14 ms noise burst through a Q-18 band, which was
  // inaudible — and inaudible for a reason worth stating, because the node
  // count said it was playing: a very short burst through a very narrow filter
  // passes almost no energy. Counting nodes proves scheduling, never loudness.
  //
  // This is the middle. Long enough and wide enough to carry real energy, still
  // short enough to be a tap rather than a tone, and the band still sits on a
  // scale degree so a run of them stays inside the key.
  token: (k) => [
    {
      midi: degree(k, 1 + Math.floor(Math.random() * 4)) + 12,
      gain: 0.13,
      len: 0.03,
      attack: 0.0005,
      decay: 0.03,
      noise: true,
      band: 3.2,
      pan: 0.2 + Math.random() * 0.6,
    },
  ],
}

type Note = {
  midi: number
  gain: number
  /** Seconds the voice is held. */
  len: number
  /** Seconds from now. */
  at?: number
  attack?: number
  decay?: number
  room?: number
  cutoff?: number
  pan?: number
  /** Noise through a band tuned to `midi`, rather than a pitched oscillator. */
  noise?: boolean
  /** Band Q for a noise voice. Low is wide and loud; high is narrow and thin. */
  band?: number
  /** Override the key's waveform — the pad voice is always soft. */
  wave?: string
}

/**
 * A random walk over the bottom five degrees.
 *
 * Bounded so typing stays in one register, and reflected at the edges rather
 * than clamped — a clamp makes it stick to the boundary and repeat a note,
 * which is the one thing the walk exists to avoid.
 */
let walk = 0
function typeStep(): number {
  walk += Math.random() < 0.5 ? -1 : 1
  if (walk < 0) walk = 1
  if (walk > 4) walk = 3
  return walk
}

/** Fetch nothing, decode nothing — but keep the gesture contract identical. */
let armed = false

export function prepareSound(): void {
  if (armed) return
  armed = true

  const start = () => {
    unlockSound()
    // Stop listening only once audio is genuinely running.
    //
    // The first version removed the listeners immediately, which meant a
    // gesture that arrived before the engine could start consumed the single
    // chance to start it — and the app then stayed silent forever, with no
    // error anywhere, because every later call found `starting` already set
    // to a promise that had failed. Staying subscribed until `ready` costs one
    // no-op call per gesture and removes that whole class of failure.
    if (!ready) return
    for (const t of ['pointerdown', 'keydown'] as const) window.removeEventListener(t, start)
  }

  for (const t of ['pointerdown', 'keydown'] as const) {
    window.addEventListener(t, start, { passive: true })
  }
}

/**
 * Start the audio clock. Must be called from a real user gesture.
 *
 * Every browser refuses to start an AudioContext otherwise, and one created
 * outside a gesture is born suspended and stays that way — which presents as
 * sound that silently never works rather than as an error.
 */
export function unlockSound(): void {
  if (ready) return
  // Cleared on failure, so a later gesture can genuinely retry rather than
  // finding a settled rejected promise and giving up silently.
  starting ??= initAudio()
    .catch((err) => {
      console.warn('sound: audio unavailable, will retry on next gesture', err)
      starting = null
      throw err
    })
    .then(() => {
      // Registers the waveform voices — triangle, square, the noises. Without
      // it superdough has an empty sound map and every note is a miss.
      registerSynthSounds()
      ready = true
    })
    // Already reported above; this only keeps the rejection from surfacing as
    // an unhandled promise.
    .catch(() => {})
}

export const isMuted = (): boolean => muted

export function setMuted(next: boolean): void {
  muted = next
  try {
    localStorage.setItem(STORE_KEY, next ? 'off' : 'on')
  } catch {
    // Not being able to remember the choice is not a reason to ignore it.
  }
}

/**
 * Put the interface in the key this conversation is in.
 *
 * Called wherever the palette is applied, from the same vibe, so a turn that
 * shifts the colour shifts the tuning in the same instant.
 */
export function tune(vibe: Vibe): void {
  // Recorded either way, so unpinning lands on the conversation's current key
  // rather than on whichever one was current when the set started.
  key = keyFor(vibe)
}

/** Override the conversation's key. Used by a running set. */
export function pinKey(next: Key): void {
  pinned = next
}

/** Hand the key back to the conversation. */
export function unpinKey(): void {
  pinned = null
}

export const isPinned = (): boolean => pinned !== null

export const currentKey = (): Key => pinned ?? key

/**
 * The model is writing, or it has stopped.
 *
 * Kept as a hook even though it currently does nothing but bound the run: the
 * call sites are the honest places to say "writing started" and "writing
 * ended", and having them already wired is what makes anything that wants that
 * span — a bed, a build, a meter — a change in one file.
 *
 * There was a riser here. It was cut: a build under every answer promises an
 * arrival, and an app that promises one on every reply is exhausting.
 */
let writingSince = 0

export function writing(on: boolean): void {
  if (!on) {
    writingSince = 0
    return
  }
  if (!ready || muted || writingSince) return
  writingSince = performance.now()
}

/**
 * Play an arbitrary scale degree.
 *
 * The named roles above are the interface's fixed vocabulary — ten events that
 * always sound the same way. This is the open end of the instrument, for the
 * one caller that needs to compose rather than to signal: `perform.ts`, which
 * reads the model's own output as a score.
 *
 * Degrees, not frequencies, deliberately. A caller that could ask for 622 Hz
 * could ask for something outside the key, and then the guarantee that nothing
 * in this app can play a wrong note would be a convention rather than a fact.
 */
export function tone(
  deg: number,
  opts: {
    gain?: number
    len?: number
    at?: number
    noise?: boolean
    band?: number
    room?: number
    pan?: number
    /**
     * A pad rather than a pluck.
     *
     * The interface's own sounds are struck — they mark an instant, so they
     * start instantly. Prose does not arrive in instants, and playing it with
     * the same voice produced a stream of separate tacks that read as a
     * jumble however well the pitches were chosen. A pad has a slow enough
     * attack that consecutive notes overlap into a line instead of arriving
     * as a sequence of events, and enough tail to sit behind the reading
     * rather than in front of it.
     */
    pad?: boolean
  } = {},
): void {
  if (muted || !ready) return
  const ctx = getAudioContext()
  if (!ctx || ctx.state !== 'running') return
  const len = opts.len ?? (opts.pad ? 1.6 : 0.24)
  emit(
    {
      midi: degree(currentKey(), deg),
      gain: opts.gain ?? 0.12,
      len,
      at: opts.at,
      attack: opts.noise ? 0.0005 : opts.pad ? 0.14 : 0.003,
      // A pad decays across its whole length rather than most of it, so the
      // tail is still moving when the next note starts and the two join.
      decay: len * (opts.pad ? 1 : 0.9),
      noise: opts.noise,
      band: opts.band,
      // Reverb is not decoration here — it is what fuses separate notes into
      // one voice. Without it a pad is just a slow pluck.
      room: opts.room ?? (opts.pad ? 0.6 : undefined),
      pan: opts.pan,
      // Always a triangle for pads, never the key's square: a square with a
      // slow attack is a buzz, and warmth is the entire point of this voice.
      wave: opts.pad ? 'triangle' : undefined,
    },
    audioNow(ctx) + 0.04,
    1,
  )
}

/** Several degrees at once, spread slightly so it strums rather than blocks. */
export function chord(
  degs: number[],
  opts: { gain?: number; len?: number; room?: number; pad?: boolean } = {},
): void {
  degs.forEach((d, i) =>
    tone(d, {
      gain: (opts.gain ?? 0.11) * (1 - i * 0.12),
      len: opts.len ?? 0.7,
      // Spread, so it strums rather than blocks. Wider for pads, whose slow
      // attacks would otherwise all arrive together and read as one thick note.
      at: i * (opts.pad ? 0.075 : 0.022),
      room: opts.room ?? 0.3,
      pad: opts.pad,
    }),
  )
}

/**
 * Play the sound for an event.
 *
 * Safe to call before audio exists and while muted — it returns quietly.
 * Callers are UI event handlers and should never have to know the state of the
 * audio system.
 */
export function sound(role: Role, strength = 1): void {
  if (muted || !ready) return

  const now = performance.now()
  const gap = THROTTLE[role]
  if (gap && now - (lastAt.get(role) ?? -1e9) < gap) return
  lastAt.set(role, now)

  const ctx = getAudioContext()
  if (!ctx || ctx.state !== 'running') return
  // Enough lead for superdough to accept the deadline — it rejects anything at
  // or behind its own clock, and 5 ms was inside the margin, so every note came
  // back "cannot schedule sounds in the past". 40 ms is still under the ~50 ms
  // where a response stops feeling immediate, so nothing reads as lag.
  const base = audioNow(ctx) + 0.04

  for (const n of VOICE[role](currentKey(), strength)) emit(n, base, strength)
}

/** One voice, scheduled. The single place a note becomes sound. */
function emit(n: Note, base: number, strength: number): void {
  // A little detune on every voice. Two identical oscillators at an identical
  // frequency is the sound of a computer; a few cents apart is the sound of an
  // instrument.
  const cents = (Math.random() - 0.5) * 7
  const freq = hz(n.midi) * 2 ** (cents / 1200)
  superdough(
    {
      s: n.noise ? 'white' : n.wave ?? currentKey().wave,
      // A band turns noise into a pitch you feel rather than hear. Q is the
      // dial between a tap and a tone, and it is also a loudness control:
      // narrow bands pass very little of a short burst.
      ...(n.noise ? { bandf: freq, bandq: n.band ?? 4 } : { freq }),
      gain: n.gain * strength,
      attack: n.attack ?? 0.002,
      decay: n.decay ?? n.len,
      sustain: 0,
      release: 0.03,
      cutoff: n.cutoff ?? currentKey().cutoff,
      ...(n.pan !== undefined ? { pan: n.pan } : {}),
      ...(n.room ? { room: n.room, size: 0.6 } : {}),
    },
    base + (n.at ?? 0),
    n.len,
  )
}
