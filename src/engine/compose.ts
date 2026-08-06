/**
 * The model writing a set.
 *
 * The four presets are four rooms, and four is not many. Asked for "something
 * like rain on a window at 3am" the picker matches nothing and plays `deep`,
 * which is a reasonable guess and obviously not what was asked for.
 *
 * The tempting move is to let the model write Strudel. It is a small language,
 * there are thousands of examples in its documentation, and a 3B model will
 * cheerfully produce something that looks exactly like one of them. It will
 * also, several times an hour, produce something that does not parse, or that
 * parses into silence, or that calls a function that does not exist — and the
 * failure arrives as an exception in an audio callback, which is the worst
 * place in the system to find out.
 *
 * So the model does not write code. It fills in the same struct the four
 * presets are written as, under a grammar that makes anything else
 * unexpressible: a mode from a fixed list, three rhythms, two lists of scale
 * degrees, a tempo, a filter. Everything it can say is playable by
 * construction, and everything it cannot say is a thing that would have broken.
 *
 * What is left is genuinely composition. Rhythm, tempo, register, mode, how
 * open the filter sits and whether the bass walks or sits still — that is most
 * of what makes one set different from another, and none of it needed the
 * model to be able to write a function call.
 *
 * Then it is checked anyway. A grammar guarantees the shape and says nothing
 * about the values: nothing stops a model returning 400 cycles per second, a
 * bass line of nine notes below hearing, or a rhythm string of `x` characters
 * with no cycle in it. Every field is clamped, and the rhythms have to parse
 * before anything is played.
 */
import { granite } from '../model/granite'
import { MODES } from './key'
import { MOODS, moodFor, type Mood } from './dj'

/**
 * What the model may say.
 *
 * Deliberately close to `Mood`, because the presets are the worked examples —
 * they are what the prompt shows, so the schema it fills should be the shape it
 * was shown. Note there is no `maxLength` anywhere: llama.cpp compiles the
 * schema to a grammar and enforces length as a hard character stop, which
 * severs the last token mid-word. Clamping happens after.
 */
const SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    mode: { type: 'string', enum: MODES.map((m) => m.name) },
    cps: { type: 'number' },
    kick: { type: 'string' },
    snare: { type: 'string' },
    hat: { type: 'string' },
    // Bounded, and this is load-bearing rather than tidy. An unbounded array
    // in a GBNF grammar is an invitation the model accepts: asked for a bass
    // line it returned sixteen zeros, and the tokens spent on them ran the
    // generation past its budget so the JSON truncated mid-string and failed to
    // parse at all. `maxItems` is safe in a way `maxLength` is not — it bounds
    // a count, not a string, so nothing gets severed mid-word.
    bass: { type: 'array', items: { type: 'integer' }, minItems: 2, maxItems: 8 },
    pad: { type: 'array', items: { type: 'integer' }, minItems: 2, maxItems: 5 },
    cutoff: { type: 'number' },
  },
  required: ['id', 'mode', 'cps', 'kick', 'snare', 'hat', 'bass', 'pad', 'cutoff'],
}

/**
 * A rhythm is `x` and `~`, and the handful of mini-notation characters that
 * arrange them. Anything else — a note name, a sample name, a function call —
 * is the model reaching for Strudel proper, and is rejected rather than
 * repaired, because a half-understood pattern is worse than a preset.
 */
const RHYTHM = /^[x~\s*<>[\]!/]+$/

const clamp = (n: number, lo: number, hi: number, fallback: number): number =>
  Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback

const rhythm = (value: unknown, fallback: string): string => {
  const s = typeof value === 'string' ? value.trim() : ''
  if (!s || !RHYTHM.test(s) || s.length > 60) return fallback
  // A rhythm of nothing but rests is silence with extra steps; a mood that
  // wanted no kick says so with '~', which this also produces.
  return /x/.test(s) ? s : '~'
}

const degrees = (value: unknown, fallback: number[]): number[] => {
  if (!Array.isArray(value) || !value.length) return fallback
  const out = value
    .filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
    // Two octaves either side of the tonic. Further than that and the bass
    // leaves the range a small speaker can reproduce at all.
    .map((n) => Math.round(clamp(n, -7, 14, 0)))
    .slice(0, 8)
  return out.length ? out : fallback
}

/**
 * Fold whatever came back onto something playable.
 *
 * Every field falls back to the nearest preset rather than to a fixed default,
 * so a partially-sensible answer keeps its sensible parts: a model that gets
 * the rhythm right and the tempo absurd yields its rhythm over the preset's
 * tempo, instead of throwing the whole thing away.
 */
export function shape(raw: Record<string, unknown>, near: Mood): Mood {
  return {
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim().slice(0, 24) : near.id,
    reaches: [],
    // 0.2–0.9 cps is 48–216 bpm in four. Outside that it is either a drone or
    // a fire alarm.
    cps: clamp(Number(raw.cps), 0.2, 0.9, near.cps),
    mode: MODES.some((m) => m.name === raw.mode) ? String(raw.mode) : near.mode,
    kick: rhythm(raw.kick, near.kick),
    snare: rhythm(raw.snare, near.snare),
    hat: rhythm(raw.hat, near.hat),
    bass: degrees(raw.bass, near.bass),
    pad: degrees(raw.pad, near.pad),
    cutoff: clamp(Number(raw.cutoff), 300, 6000, near.cutoff),
  }
}

const SYSTEM = [
  'You arrange a short looping set of music. You are given a description of a',
  'room or a feeling and you answer with the arrangement, as fields.',
  '',
  'kick, snare and hat are one bar of rhythm. Write `x` where the drum hits and',
  '`~` where it rests, separated by spaces. `x*8` means eight evenly across the',
  'bar. `~` alone means that drum does not play at all.',
  '',
  'bass and pad are scale degrees, as whole numbers. 0 is the root, 2 is the',
  'third, 4 is the fifth. Negative goes below the root. bass is a line, so it',
  'moves; pad is a chord held under it, so give it three or four degrees that',
  'sound together.',
  '',
  'cps is cycles per second: 0.28 is very slow, 0.5 is a steady four to the',
  'floor, 0.7 is fast. cutoff is how bright it is, in hertz, from 300 dark to',
  '6000 open.',
  '',
  'Choose the mode for the feeling: aeolian and dorian are minor and heavy,',
  'pentatonic is open and neutral, ionian is plain major, lydian is bright and',
  'strange.',
  '',
  'Give the arrangement a short lowercase id — one or two words for what it is.',
].join('\n')

/** The presets, as worked examples the model can pattern-match against. */
const EXAMPLES = MOODS.map(
  (m) =>
    `${m.id}: mode ${m.mode}, cps ${m.cps}, kick "${m.kick}", snare "${m.snare}", hat "${m.hat}", bass [${m.bass}], pad [${m.pad}], cutoff ${m.cutoff}`,
).join('\n')

/**
 * Compose a set for a description.
 *
 * Returns the nearest preset if the model is unreachable or says something
 * unusable, so this never fails — the worst outcome is the behaviour that
 * existed before it.
 */
export async function compose(description: string): Promise<{ mood: Mood; written: boolean }> {
  const near = moodFor(description)
  if (!granite.ready || !description.trim()) return { mood: near, written: false }

  try {
    const raw = await granite.fill<Record<string, unknown>>(
      [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `Existing arrangements, for reference:\n${EXAMPLES}\n\nArrange: ${description}` },
      ],
      SCHEMA,
      // Enough headroom to close the object; a truncated JSON is a total loss.
      { maxTokens: 420 },
    )
    return { mood: shape(raw, near), written: true }
  } catch (err) {
    console.warn('dj: could not compose, using the nearest preset', err)
    return { mood: near, written: false }
  }
}
