/**
 * The Strudel writer, against the real weights.
 *
 * Skipped when the pack is not installed, because it is the only test here that
 * needs 137 MB on disk and takes seconds per generation rather than
 * milliseconds. Run it with `bun src/packs/__tests__/writer.ts` after
 * `bun run pull strudel`.
 *
 * It exists because everything it covers is the kind of thing that fails
 * silently and plausibly. A prompt built without the ChatML markers still
 * generates — it just generates prose completion instead of an answer. A
 * decoder that drops the byte map still returns a string — it is just mojibake.
 * A sampler stuck at temperature zero still varies its output across prompts —
 * barely, which is the trap that made this model look like a template the first
 * time it was measured. None of those throw.
 */
import { existsSync, readFileSync } from 'node:fs'
import { repair, soundsNamed } from '../../engine/verify'
import { strudelWriter } from '../writer'

const DIR = 'packs/strudel'
if (!existsSync(`${DIR}/model_quantized.onnx`)) {
  console.log('writer: pack not installed — skipped')
  process.exit(0)
}

let failed = 0
const ok = (name: string, cond: boolean, detail = '') => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
  if (!cond) failed++
}

const tok = JSON.parse(readFileSync(`${DIR}/tokenizer.json`, 'utf8'))
const write = await strudelWriter(`${DIR}/model_quantized.onnx`, tok)

const t0 = Date.now()
const first = await write('a deep late-night set in aeolian at 60 bpm', 1)
const took = (Date.now() - t0) / 1000

console.log(`\n  ── seed 1 (${took.toFixed(1)}s)\n${first.split('\n').map((l) => '     ' + l).join('\n')}\n`)

ok('it writes something', first.length > 20, `${first.length} chars`)
ok('and it is Strudel, not prose', /\b(stack|s|note|n)\s*\(/.test(first), first.slice(0, 40))
ok(
  'with no chat markers leaking into the code',
  !first.includes('<|im_') && !first.includes('im_end'),
)
ok('and no mojibake from the byte map', !/�/.test(first))
// Measured, not aspirational. onnxruntime-web's wasm backend runs this graph
// at roughly 370ms per decode step — the same weights under the native node
// binding take 5-6s for a whole generation, so the gap is the backend, not the
// model. Threads do not close it: 1, 4 and 8 all landed within 6s of each
// other. The ceiling is set where a second attempt is still tolerable, and
// `untilPlayable` is given a budget of two rather than four because of it.
ok('in a workable time', took < 75, `${took.toFixed(1)}s`)

// The failure this catches is the one that cost the most: at temperature zero
// every prompt returns nearly the same thing, and it reads as a model that
// memorised one template rather than a decoder collapsing onto its mode.
const second = await write('a deep late-night set in aeolian at 60 bpm', 2)
ok('a different seed gives a different set', first !== second, second.slice(0, 44))

const other = await write('frantic drum and bass with a rolling bassline at 174 bpm', 1)
ok('and a different prompt does too', other !== first, other.slice(0, 44))

// Not an assertion about taste — just that the words reach the output at all.
// A prompt-format bug shows up here as a model ignoring everything it was told.
const sparse = await write('almost silent, one low note every few bars, no drums', 3)
console.log(`\n  ── "almost silent"\n${sparse.split('\n').map((l) => '     ' + l).join('\n')}\n`)

// What the gates will have to deal with, measured rather than assumed.
const synths = new Set(['sine', 'square', 'triangle', 'sawtooth', 'white', 'pink'])
const all = [first, second, other, sparse]
const named = [...new Set(all.flatMap(soundsNamed))]
const unknown = named.filter((n) => !synths.has(n))
console.log(`  sounds named across four sets: ${named.join(' ') || '(none)'}`)
console.log(`  not in the synth kit:          ${unknown.join(' ') || '(none)'}`)

const rescued = unknown.filter((n) => !soundsNamed(repair(`s("${n}")`, synths)[0] ?? '').includes(n))
ok(
  'every name it invents can be stood in for',
  unknown.every((n) => repair(`s("${n}")`, synths).remapped.length === 1),
  `${unknown.length} unknown, ${rescued.length} rescued`,
)

console.log(failed ? `\nwriter: ${failed} failed` : '\nwriter: the model writes Strudel')
if (failed) process.exit(1)
