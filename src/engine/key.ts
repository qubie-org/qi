/**
 * The key the interface is in.
 *
 * qi already reads every turn as four numbers — warmth, energy, gravity,
 * wonder — and drifts the palette along them, so a conversation about
 * something grave gets a different room than one about something silly. The
 * page has had that since the beginning. The sound did not: it was twelve
 * fixed recordings that played the same way whatever was being discussed.
 *
 * This is the missing half. The same four numbers pick a tonic, a mode, a
 * timbre and a tempo, and every sound the interface makes is a degree of that
 * scale. Two things follow, and the second is the reason to do it at all:
 *
 *   nothing can clash, because there is no interval in the interface that is
 *   not in the scale — except one, which is the point of `MISS`;
 *
 *   and the sound drifts with the conversation exactly as the colour does,
 *   from the same reading, so they are two expressions of one state rather
 *   than two decorative systems that happen to share a page.
 *
 * The modes are ordered by brightness, which is the axis the ear actually
 * hears — lydian's raised fourth reads as *further out* than ionian, aeolian's
 * flat sixth as heavier. Mapping "strange" to a raised fourth and "serious" to
 * a flat third is not a metaphor; it is what those intervals have meant in
 * this tuning system for four hundred years.
 */
import type { Vibe } from './theme'

export type Mode = {
  name: string
  /** Semitones above the tonic. */
  steps: number[]
}

/** Ordered dark to bright. Pentatonic sits in the middle: it omits the two
 *  degrees that decide major-ness, so it is the one that commits to nothing. */
export const MODES: Mode[] = [
  { name: 'aeolian', steps: [0, 2, 3, 5, 7, 8, 10] },
  { name: 'dorian', steps: [0, 2, 3, 5, 7, 9, 10] },
  { name: 'pentatonic', steps: [0, 2, 4, 7, 9] },
  { name: 'ionian', steps: [0, 2, 4, 5, 7, 9, 11] },
  { name: 'lydian', steps: [0, 2, 4, 6, 7, 9, 11] },
]

export type Key = {
  /** MIDI note of the tonic. */
  root: number
  mode: Mode
  /** superdough voice for pitched sounds. */
  wave: string
  /** Low-pass in Hz — the single strongest timbral control there is. */
  cutoff: number
  /** Cycles per second, for anything that runs on a clock. */
  cps: number
}

/** D above middle C. High enough to cut through a room, low enough not to ping. */
const TONIC = 62

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x))

/**
 * Read the room, and say what key it is in.
 *
 * Deliberately total and deliberately cheap: it is called on every drift and
 * must never fail, allocate anything interesting, or need the audio system to
 * exist. A key is a description, not a device.
 */
export function keyFor(vibe: Vibe): Key {
  const { warmth, energy, gravity, wonder } = vibe

  // Brightness runs from grave to strange. Gravity darkens, wonder brightens,
  // and warmth leans very slightly bright because a warm minor is still minor
  // but a warm major is unmistakable.
  const bright = clamp(-gravity * 1.15 + wonder * 0.9 + warmth * 0.25, -1, 1)
  const mode = MODES[Math.round(((bright + 1) / 2) * (MODES.length - 1))]

  // Serious speech sits lower. Whole tones rather than semitones, so a drift
  // between two readings is a transposition and never a chromatic slide.
  const root = TONIC + Math.round(clamp(-gravity, -1, 1) * 2.5) * 2

  // Technical is thin and hard; human is round. One waveform each, and the
  // filter doing most of the work — cutoff is far more audible than the choice
  // between two waveforms that are both fairly plain to begin with.
  const wave = warmth < -0.25 ? 'square' : 'triangle'
  const cutoff = 900 + clamp(warmth + 1, 0, 2) * 1500 + clamp(energy, 0, 1) * 900

  // Still conversations breathe; urgent ones do not.
  const cps = 0.36 + clamp(energy, -1, 1) * 0.14

  return { root, mode, wave, cutoff, cps }
}

/**
 * The MIDI note for a scale degree.
 *
 * Degrees run past the end of the scale and wrap into the next octave, so
 * `degree(7)` on a five-note scale is the third degree an octave up rather
 * than an error. That is what makes it safe for callers to ask for a triad as
 * `0, 2, 4` without knowing how many notes the current mode has.
 */
export function degree(key: Key, n: number): number {
  const len = key.mode.steps.length
  const octave = Math.floor(n / len)
  const within = ((n % len) + len) % len
  return key.root + key.mode.steps[within] + octave * 12
}

/** Hz for a MIDI note. A4 = 440. */
export const hz = (midi: number): number => 440 * 2 ** ((midi - 69) / 12)

/**
 * The one interval that is not in the scale.
 *
 * Everything the interface does is consonant, which means consonance carries
 * no information — it is just the sound of the app working. A failure has to
 * be audibly outside that, so `miss` is a flat second below the tonic: the
 * sharpest dissonance in the system, and unmistakably not a scale tone
 * whatever mode is currently selected, because no mode here has one.
 */
export const MISS = (key: Key): number => key.root - 11
