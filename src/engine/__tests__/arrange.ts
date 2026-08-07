/**
 * The part of the set the model decides, and the file it turns into.
 *
 * Everything here runs under bun, which is only possible because `arrange.ts`
 * deliberately does not import `@strudel/core` — that package imports
 * `SalatRepl` from `@kabelsalat/web`, which throws outside a browser, so a
 * single `s()` in this dependency chain would make the whole module untestable.
 * The pattern building lives in `dj.ts` for exactly that reason and is verified
 * in the running app instead.
 *
 * Two things are being checked, and only the second is obvious.
 *
 * The first is the clamping. A grammar guarantees the shape of what the model
 * says and guarantees nothing about the values, which is the same lesson
 * `compose.ts` already records — so every field a model can emit is given a
 * value no sane model would emit, and the result has to still be playable.
 *
 * The second is that the generated file is *true*. It is the only artefact that
 * survives the set, it carries the licence obligations, and a credit block that
 * has quietly stopped matching what played is worse than no credit block at
 * all — it is a false statement about someone else's work.
 */
import { bpmOf, keepSet, placements, rateFor, strudelFile, type Layer } from '../arrange'
import type { Sound } from '../crate'
import type { Mood } from '../dj'
import type { Analysis } from '../analyse'
import { MODES } from '../key'
import { get } from '../../pages/space'

const MOOD: Mood = {
  id: 'deep',
  reaches: [],
  cps: 0.5, // 120 bpm
  mode: 'aeolian',
  kick: 'x ~ ~ x',
  snare: '~ ~ x ~',
  hat: 'x*8',
  bass: [0, 0, 3, 2],
  pad: [0, 2, 4],
  cutoff: 900,
}

const KEY = { root: 62, mode: MODES[0], wave: 'triangle', cutoff: 900, cps: 0.5 }

const analysis = (over: Partial<Analysis> = {}): Analysis => ({
  seconds: 12,
  sampleRate: 48000,
  bpm: null,
  confidence: 0,
  alternative: null,
  loudestAt: 0,
  sections: [],
  loudness: 0.1,
  pitch: null,
  pitchName: null,
  pitchConfidence: 0,
  ...over,
})

const sound = (name: string, over: Partial<Sound> = {}): Sound => ({
  id: `id-${name}`,
  name,
  title: 'Tribe Drum Loop',
  creator: 'PearceWilsonKing',
  license: 'cc0',
  licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
  url: 'https://cdn.freesound.org/previews/342/342465_3906011-hq.mp3',
  blobUrl: 'blob:test',
  landing: 'https://freesound.org/people/PearceWilsonKing/sounds/342465',
  provider: 'freesound',
  attribution: '"Tribe Drum Loop" by PearceWilsonKing is marked with CC0 1.0.',
  seconds: 8.3,
  clipped: false,
  analysis: analysis(),
  ...over,
})

const ok = (claim: boolean, why: string) => {
  console.log(`  ${claim ? 'ok  ' : 'FAIL'}  ${why}`)
  if (!claim) throw new Error(why)
}

console.log('── what the model is allowed to say\n')

const offered = [sound('crate0'), sound('crate1')]

ok(placements(null, offered).length === 0, 'a non-array is no placements')
ok(placements([{ sound: 'nope', role: 'lead', every: 1, begin: 0 }], offered).length === 0,
  'a sound that is not in the crate is dropped, not repaired')

const wild = placements(
  [
    { sound: 'crate0', role: 'lead', every: 999, begin: 5 },
    { sound: 'crate0', role: 'bed', every: 2, begin: 0 },
    { sound: 'crate1', role: 'wobble', every: -3, begin: -1 },
    { sound: 'crate1', role: 'stab', every: 1, begin: 0 },
  ],
  offered,
)
ok(wild.length === 2, `at most two samples (got ${wild.length})`)
ok(wild[0].every === 16, `every 999 clamps to 16 (got ${wild[0].every})`)
ok(wild[0].begin === 0.9, `begin 5 clamps to 0.9 (got ${wild[0].begin})`)
ok(wild[1].role === 'texture', `an invented role falls back to texture (got ${wild[1].role})`)
ok(wild[1].every === 1, `every -3 clamps to 1 (got ${wild[1].every})`)
ok(wild[1].begin === 0, `begin -1 clamps to 0 (got ${wild[1].begin})`)
ok(new Set(wild.map((p) => p.sound)).size === 2, 'the same recording is not placed twice')

const missing = placements([{ sound: 'crate0' }], offered)
ok(missing.length === 1 && missing[0].every >= 1 && missing[0].begin === 0,
  'a placement with nothing but a name still comes out playable')

console.log('\n── playback rate\n')

ok(Math.round(bpmOf(MOOD)) === 120, `0.5 cps is 120 bpm (got ${bpmOf(MOOD)})`)

const rhythmic = rateFor(sound('crate0', { analysis: analysis({ bpm: 174, confidence: 0.8 }) }), MOOD, KEY)
// 120/174 = 0.6897, which is the exact case an earlier 0.69 lower bound sent
// to double time. It has to come out under 1.
ok(Math.abs(rhythmic.speed - 120 / 174) < 0.001,
  `174 lands on 120, not on 240 (got ${rhythmic.speed}, ${rhythmic.why})`)

const slowLoop = rateFor(sound('crate0', { analysis: analysis({ bpm: 60, confidence: 0.9 }) }), MOOD, KEY)
ok(slowLoop.speed === 1, `60 under 120 plays at 1, in half time (got ${slowLoop.speed})`)

for (const bpm of [58, 71, 84, 90, 101, 117, 128, 133, 145, 160, 174, 199]) {
  const r = rateFor(sound('crate0', { analysis: analysis({ bpm, confidence: 0.7 }) }), MOOD, KEY)
  ok(r.speed >= 1 / 1.5 - 1e-6 && r.speed < 1.5, `${bpm} bpm folds inside one octave (got ${r.speed})`)
}

// A tempo nobody believes must not be acted on. This is the whole reason the
// confidence exists rather than being a field somebody might read.
const unsure = rateFor(sound('crate0', { analysis: analysis({ bpm: 174, confidence: 0.2 }) }), MOOD, KEY)
ok(unsure.speed === 1, `an unconfident tempo is not matched (got ${unsure.speed}, ${unsure.why})`)

// KEY.root 62 is D, pitch class 2. A sample around C (0) is two semitones down.
const pitched = rateFor(
  sound('crate0', { analysis: analysis({ pitch: 0, pitchName: 'C', pitchConfidence: 0.8 }) }),
  MOOD,
  KEY,
)
ok(Math.abs(pitched.speed - 2 ** (2 / 12)) < 0.001, `C into a set on D goes up two semitones (got ${pitched.speed})`)

// Eleven semitones up is one down. The long way round is always the wrong way.
const far = rateFor(
  sound('crate0', { analysis: analysis({ pitch: 3, pitchName: 'D#', pitchConfidence: 0.9 }) }),
  MOOD,
  KEY,
)
ok(far.speed < 1 && far.speed > 0.9, `D# into D goes down a semitone, not up eleven (got ${far.speed})`)

const neither = rateFor(sound('crate0'), MOOD, KEY)
ok(neither.speed === 1 && neither.why === 'as recorded', 'knowing nothing means playing it as recorded')

console.log('\n── the file\n')

const layers: Layer[] = [
  { pattern: null, source: 's("sbd ~ ~ sbd").gain(0.34).decay(0.16)' },
  { pattern: null, source: 'note("50 50 53 52").s("sawtooth")' },
  { pattern: null, source: 's("crate0").gain(0.5).room(0.15)' },
]
const used = [sound('crate0', { analysis: analysis({ bpm: 92.5, confidence: 0.61 }), clipped: true })]
const file = strudelFile(MOOD, KEY, layers, used)
console.log(file.split('\n').map((l) => `    ${l}`).join('\n'))

for (const l of layers) ok(file.includes(l.source), `the file contains ${l.source.slice(0, 28)}…`)
ok(file.includes('setcps(0.5)'), 'the file sets the tempo')
ok(file.includes('PearceWilsonKing'), 'the creator is named')
ok(file.includes('CC0'), 'the licence is named')
ok(file.includes(used[0].landing), 'the original is linked')
ok(file.includes(used[0].url), 'the audio URL is there, so the file runs elsewhere')
ok(file.includes('93 bpm') && file.includes('0.61'), 'the measured tempo is stated with its confidence')
ok(file.includes('clipped'), 'a clipped sample says it was clipped')

// A set with nothing found in it must not grow an empty credits block.
const plain = strudelFile(MOOD, KEY, layers.slice(0, 2), [])
ok(!plain.includes('Openverse'), 'a fully synthesised set has no credits section')

console.log('\n── keeping it\n')
const id = keepSet(MOOD, file, used)
const page = get(id)
ok(!!page, 'the set became a page')
ok(page!.body.includes('PearceWilsonKing'), 'and the page carries the credits')
ok(get(keepSet(MOOD, plain, [])) !== undefined && id === 'the-set', 'starting again replaces it rather than piling up')

console.log('\narrange: ok')
