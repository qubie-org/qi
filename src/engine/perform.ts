/**
 * The answer, played.
 *
 * The clicks under a stream tell you that text is arriving. They do not tell
 * you anything *about* it — the same rain falls whether the model is listing
 * three numbers or arriving at something. So the stream is read here as a
 * score instead, and the thing that makes that possible is that the text
 * already has structure worth hearing:
 *
 *   a word          moves the melody one step
 *   a clause break  turns it back down — commas are where a sentence breathes
 *   a full stop     resolves it to a chord, and starts the next phrase lower
 *   an emoji        rings out two octaves up, because an emoji is already the
 *                   loudest thing on the line visually and this is the same
 *                   decision made in the other medium
 *   a capitalised   lifts a fifth — proper nouns are what `place.ts` already
 *   word            treats as the marks worth pressing, so they are also the
 *                   notes worth hearing
 *
 * The melody is a contour, not a tune. It walks up while a sentence is still
 * going and falls back at every break, so a long clause climbs and a short one
 * barely moves, and the shape you hear is the shape of the sentence. Nothing
 * is transposed, chosen or randomised outside the key — `tone` only accepts
 * scale degrees, so a wrong note is not expressible.
 *
 * Everything is rate-limited independently. A fast model emits tokens far
 * faster than music can be made of them, and the failure mode of a performer
 * with no floor is not "busy" but "unlistenable".
 */
import { chord, sound, tone } from './sound'

/** Extended pictographic: emoji, including the ones built from sequences. */
const EMOJI = /\p{Extended_Pictographic}/u
const SENTENCE_END = /[.!?]/
const CLAUSE = /[,;:—–]/
const WORD_BREAK = /[\s\n]/

/** Where the melody currently sits, in scale degrees. */
let step = 0
/** Words since the last full stop — the phrase's length so far. */
let inPhrase = 0
/** How many sentences this answer has produced, for the slow descent. */
let phrases = 0
/** Text seen so far, so a delta can be taken from the cumulative stream. */
let seen = ''

const lastAt: Record<string, number> = {}
function allow(what: string, gap: number): boolean {
  const now = performance.now()
  if (now - (lastAt[what] ?? -1e9) < gap) return false
  lastAt[what] = now
  return true
}

/** Begin a new answer. */
export function performReset(): void {
  step = 0
  inPhrase = 0
  phrases = 0
  seen = ''
}

/**
 * Take the stream so far and play whatever is new in it.
 *
 * The agent reports cumulative text rather than deltas, so the delta is taken
 * here. Guarded both ways: if the text ever shrinks or is replaced wholesale —
 * a retry, a rewritten answer — the performer resets rather than trying to
 * play the difference between two unrelated strings.
 */
export function performStream(soFar: string): void {
  if (!soFar.startsWith(seen)) {
    seen = soFar
    return
  }
  const delta = soFar.slice(seen.length)
  seen = soFar
  if (!delta) return

  // A word is only complete once something ends it, so the word just finished
  // is the one before the break — which is why capitalisation is read from the
  // tail of `seen` rather than from the delta.
  for (const ch of delta) {
    if (EMOJI.test(ch)) {
      // Left to ring, and the one event here allowed to be conspicuous —
      // because on the page it already is.
      //
      // A fixed high register rather than `step + n`: the melody can already
      // be nine degrees up, and adding to it put one emoji at MIDI 98 — three
      // octaves above the tonic, which is a whistle, not a bell. Fixed also
      // means every emoji in an answer rings in the same place, so it reads as
      // one recurring voice.
      if (allow('emoji', 140)) tone(9 + Math.floor(Math.random() * 3), { gain: 0.1, len: 2.2, room: 0.7, pad: true })
      continue
    }

    if (SENTENCE_END.test(ch)) {
      if (!allow('cadence', 320)) continue
      // Resolve. The triad is the same one `land` uses, so a sentence ending
      // and an answer ending are audibly the same gesture at two scales.
      const root = Math.max(0, -phrases)
      chord([root, root + 2, root + 4], { gain: 0.075, len: 2.6, room: 0.7, pad: true })
      phrases += 1
      inPhrase = 0
      // Each sentence starts a little lower than the last, so a long answer
      // settles instead of climbing forever.
      step = Math.max(-2, -Math.floor(phrases / 2))
      continue
    }

    if (CLAUSE.test(ch)) {
      // A breath: down a step, quietly. This is what stops a long sentence
      // from being a straight ascending run.
      if (!allow('clause', 200)) continue
      step = Math.max(-3, step - 2)
      tone(step, { gain: 0.055, len: 1.5, pad: true })
      continue
    }

    if (WORD_BREAK.test(ch)) {
      inPhrase += 1
      if (!allow('word', 300)) continue

      // Capitalised words lift; ordinary ones step. Read from the finished
      // word, which is whatever sits behind this break.
      const word = seen.slice(0, seen.length - 1).split(/[\s\n]/).pop() ?? ''
      const proper = word.length > 2 && /^[A-Z]/.test(word)

      if (proper) {
        tone(step + 4, { gain: 0.08, len: 2.0, pad: true })
      } else if (inPhrase % 4 === 0) {
        // One word in four, with a 300 ms floor on top. Every other word was
        // still roughly six notes a second, which is a run, not a line — and a
        // run is what "jumbled" means. Pads are long; they need space between
        // entries or they stack into a cluster chord.
        step = Math.min(9, step + 1)
        tone(step, { gain: 0.06, len: 1.7, pad: true })
      }
      continue
    }
  }

  // The tap stays underneath everything, quieter than it was when it was the
  // only thing here — it is now texture rather than content.
  sound('token')
}
