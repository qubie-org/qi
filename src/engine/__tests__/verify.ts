/**
 * The gates that decide whether a generated pattern is allowed to play.
 *
 * Everything here is a pure function over a string and a set of sound names, so
 * none of it needs Strudel, a model, or an audio context — which is the reason
 * the split in `verify.ts` is shaped the way it is. The one gate that genuinely
 * needs Strudel (does it evaluate, does it produce events) is exercised with a
 * stand-in vocabulary that behaves like a pattern without being one.
 *
 * The cases are not invented. Every string below came out of the model.
 */
import { repair, soundsNamed, standIn, untilPlayable, verify, vocabulary } from '../verify'

let failed = 0
const ok = (name: string, cond: boolean, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
  if (!cond) failed++
}
const eq = (name: string, got: unknown, want: unknown) =>
  ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}`)

// ── what a pattern names ─────────────────────────────────────────────────────

eq('a bare name', soundsNamed('s("bd")'), ['bd'])
eq(
  'mini-notation is many names',
  soundsNamed('s("bd ~ ~ bd*2")').sort(),
  ['bd'],
)
eq(
  'rests and numbers are not sounds',
  soundsNamed('s("~ ~ 3 hh")').sort(),
  ['hh'],
)
eq(
  'every sound call is read',
  soundsNamed('stack(s("bd"), sound("hh*8"), s("gm_tide"))').sort(),
  ['bd', 'gm_tide', 'hh'],
)
ok(
  'note() is not a sound call',
  soundsNamed('note("c3 e3").lpf(500)').length === 0,
)

// ── standing in for samples that are not loaded ──────────────────────────────

const synths = new Set(['sine', 'square', 'triangle', 'sawtooth', 'white', 'pink'])

{
  const { code, remapped } = standIn('s("bd ~ cp ~")', synths)
  ok('a drum kit becomes synths when the banks are absent', code.includes('sine') && code.includes('pink'), code)
  ok('and says which', remapped.length === 2, remapped.join(' '))
}
{
  // With the banks present there is nothing to stand in for — `bd` is a better
  // kick than a sine burst and swapping it would be a downgrade.
  const withSamples = new Set([...synths, 'bd', 'cp'])
  const { code, remapped } = standIn('s("bd ~ cp ~")', withSamples)
  eq('nothing is swapped when the real samples exist', remapped, [])
  ok('and the code is untouched', code === 's("bd ~ cp ~")')
}
{
  // The failure this guards: a substring rewrite that reaches into a word or a
  // method name. `sd` inside `.speed(` was the one that would have bitten.
  const { code } = standIn('s("birdsong").speed(2)', synths)
  ok('a name inside another word is left alone', code.includes('birdsong'), code)
  ok('and a method that contains it is too', code.includes('.speed(2)'), code)
}

// ── repairing an invented name ───────────────────────────────────────────────

{
  const { code, remapped } = repair('s("gm_tide")', synths)
  ok('an invented name is replaced rather than rejected', !code.includes('gm_tide'), code)
  ok('and the substitution is reported', remapped.length === 1, remapped.join(' '))
}
{
  const { code } = repair('s("gm_electric_bass_finger")', synths)
  ok('a bass-shaped name gets a sawtooth', code.includes('sawtooth'), code)
}
{
  const { code } = repair('s("drums")', synths)
  ok('a percussion-shaped name gets noise', code.includes('white'), code)
}
{
  const { code, remapped } = repair('s("sine ~ square")', synths)
  eq('a pattern that names only real sounds is untouched', remapped, [])
  ok('and keeps its text', code === 's("sine ~ square")')
}

// ── the vocabulary ───────────────────────────────────────────────────────────

{
  // `eval` and friends cannot be function parameters under "use strict" — one
  // of them among Strudel's 999 exports threw on every pattern, and read as the
  // generated code being at fault rather than the binding around it.
  const v = vocabulary({ stack: 1, note: 2, eval: 3, interface: 4, yield: 5, 'not-an-ident': 6 })
  ok('reserved words are filtered out', !v.names.includes('eval') && !v.names.includes('yield'), v.names.join(' '))
  ok('so are non-identifiers', !v.names.includes('not-an-ident'))
  ok('real names survive', v.names.includes('stack') && v.names.includes('note'))
  ok('and the network is shadowed', v.names.includes('fetch') && v.values[v.names.indexOf('fetch')] === undefined)
}

// ── the three gates ──────────────────────────────────────────────────────────

/** Enough of a Pattern to be checked without pulling Strudel into a test. */
const fakePattern = (haps: number) => ({ queryArc: () => Array(haps).fill({}) })
const strudelish = vocabulary({
  stack: (...xs: unknown[]) => xs[0],
  s: () => fakePattern(4),
  note: () => fakePattern(2),
  silence: fakePattern(0),
})

{
  // An invented name is repaired, not refused — the arrangement around it was
  // fine and regenerating it would cost another five seconds to fix one word.
  const v = verify('s("gm_tide")', strudelish, new Set(['sine']))
  ok('an invented name is rescued when something can stand in for it', v.ok, JSON.stringify(v))
  ok('and the rescue is on the record', v.ok && v.remapped.includes('gm_tide→sine'))
}
{
  // With nothing to stand in for it, there is no rescue and the gate holds.
  // This is the case that keeps `repair` from turning the check into a rubber
  // stamp: it can only ever substitute a sound that is genuinely registered.
  const v = verify('s("gm_tide")', strudelish, new Set())
  ok('and is still refused when nothing exists to swap in', !v.ok && v.stage === 'unknown-sound', JSON.stringify(v))
}
{
  const v = verify('s("bd")', strudelish, synths)
  ok('a pattern whose samples were stood in for is allowed', v.ok, JSON.stringify(v))
  ok('and reports the substitution', v.ok && v.remapped.length === 1)
}
{
  const v = verify('nope(', strudelish, synths)
  ok('a pattern that will not parse is refused', !v.ok && v.stage === 'no-eval', JSON.stringify(v))
}
{
  const v = verify('voicing()', strudelish, synths)
  ok('a call to something Strudel does not export is refused', !v.ok && v.stage === 'no-eval')
}
{
  const v = verify('silence', strudelish, synths)
  ok('a pattern that produces no events is refused', !v.ok && v.stage === 'silent', JSON.stringify(v))
}
ok('an empty generation is refused', verify('   ', strudelish, synths).ok === false)
{
  const v = verify('```javascript\ns("sine")\n```', strudelish, synths)
  ok('a fenced code block is unwrapped', v.ok, JSON.stringify(v))
}

// ── keeping at it until something plays ──────────────────────────────────────

await (async () => {
  let calls = 0
  const write = async (seed: number) => {
    calls++
    // Two duds, then something playable — the real shape of a run.
    return seed < 3 ? 'nope(' : 's("sine")'
  }
  const a = await untilPlayable(write, strudelish, synths, 4)
  ok('it keeps asking until a pattern plays', a.ok, JSON.stringify(a))
  ok('and stops as soon as one does', a.tries === 3 && calls === 3, `tries ${a.tries}`)
})()

await (async () => {
  const a = await untilPlayable(async () => 'nope(', strudelish, synths, 3)
  ok('it gives up after the budget', !a.ok && a.tries === 3)
  ok('and says what went wrong each time', !a.ok && a.reasons.length === 3, JSON.stringify(a))
})()

await (async () => {
  // A generator that throws must not take the whole run with it — the fallback
  // to compose.ts is what makes the set always start.
  const a = await untilPlayable(
    async (seed) => {
      if (seed === 1) throw new Error('session gone')
      return 's("sine")'
    },
    strudelish,
    synths,
    3,
  )
  ok('a generator that throws is one lost attempt, not a crash', a.ok && a.tries === 2, JSON.stringify(a))
})()

await (async () => {
  let seen: number[] = []
  await untilPlayable(async (seed) => { seen.push(seed); return 'nope(' }, strudelish, synths, 3)
  eq('each attempt gets its own seed, so the sampler takes a new path', seen, [1, 2, 3])
})()

console.log(failed ? `\nverify: ${failed} failed` : '\nverify: all gates hold')
if (failed) process.exit(1)
