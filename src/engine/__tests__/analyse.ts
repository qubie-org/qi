/**
 * Does the tempo estimator know what tempo something is?
 *
 * This runs under bun rather than in the app, and that is a deliberate
 * exception to the rule that audio work is verified in the running page. The
 * rule exists because the wasm sandbox, superdough and the audio clock cannot
 * be loaded outside the app. None of those are involved here: `analyse()` is a
 * pure function over a Float32Array, so an AudioBuffer with the four properties
 * it reads is a complete and honest stand-in, and running it here means the
 * accuracy claim is checked on every `bun run test` instead of on the days
 * somebody remembers to open the app.
 *
 * The material is synthesised rather than downloaded for the same reason a unit
 * test does not call an API: a click track has a tempo *by construction*, so an
 * error here is the estimator's and not the corpus's. What it deliberately does
 * not prove is behaviour on real recordings — that is measured separately,
 * against Openverse hits whose own titles state their BPM, and reported with
 * the feature rather than asserted here.
 *
 * Two numbers are asserted, and the second is the interesting one:
 *
 *   exact       within 2% of the true tempo.
 *   octave      within 2% of the true tempo, or of half or double it.
 *
 * Half and double are the standing ambiguity in tempo estimation — every
 * published system is scored twice for this reason — and for a set they are
 * nearly harmless, because a 128 BPM loop dropped into a 64 BPM set still lands
 * on the bar. So the bar for `octave` is total and the bar for `exact` is not.
 */
import { analyse } from '../analyse'

const SR = 44100

/**
 * A click track, written straight into a buffer.
 *
 * Kick on the beat, hat on the offbeat, snare on the third beat of the bar —
 * enough structure that the autocorrelation has real competition at half a
 * beat, two beats and four beats, which is the whole point. A bare pulse train
 * would be estimated perfectly by anything and would prove nothing.
 */
function click(bpm: number, seconds: number): Float32Array {
  const x = new Float32Array(Math.round(SR * seconds))
  const beat = 60 / bpm

  const add = (at: number, gain: number, make: (i: number, n: number) => number, len: number) => {
    const start = Math.round(at * SR)
    const n = Math.round(len * SR)
    for (let i = 0; i < n && start + i < x.length; i++) x[start + i] += gain * make(i, n)
  }

  // A pseudo-random source with a fixed seed: noise the test can repeat.
  let seed = 12345
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return (seed / 0x7fffffff) * 2 - 1
  }

  for (let b = 0; b * beat < seconds - 0.2; b++) {
    const t = b * beat
    // Kick: 60 Hz, fast decay.
    add(t, 0.9, (i) => Math.sin((2 * Math.PI * 60 * i) / SR) * Math.exp(-i / (SR * 0.05)), 0.15)
    // Hat on the offbeat, quieter — the accent pattern the estimator has to keep.
    add(t + beat / 2, 0.18, (i) => rand() * Math.exp(-i / (SR * 0.004)), 0.03)
    // Hat on the beat too, so the grid is even and only the accents differ.
    add(t, 0.3, (i) => rand() * Math.exp(-i / (SR * 0.004)), 0.03)
    // Snare on beat three of each bar: a four-beat period to compete with.
    if (b % 4 === 2) add(t, 0.5, (i) => rand() * Math.exp(-i / (SR * 0.03)), 0.15)
  }
  return x
}

/** Everything `analyse` reads off an AudioBuffer, and nothing else. */
const asBuffer = (x: Float32Array) =>
  ({
    length: x.length,
    sampleRate: SR,
    numberOfChannels: 1,
    duration: x.length / SR,
    getChannelData: () => x,
  }) as unknown as AudioBuffer

const TEMPI = [74, 88, 100, 110, 120, 128, 140, 155, 174]

console.log('── tempo, against click tracks of known BPM\n')
console.log('  true    est     err%   conf   alt     verdict')

let exact = 0
let octave = 0
for (const bpm of TEMPI) {
  const a = analyse(asBuffer(click(bpm, 16)))
  const est = a.bpm ?? 0
  const err = Math.abs(est - bpm) / bpm
  const near = (r: number) => Math.abs(est - bpm * r) / bpm / r < 0.02
  const isExact = err < 0.02
  const isOctave = isExact || near(0.5) || near(2)
  if (isExact) exact++
  if (isOctave) octave++
  console.log(
    `  ${String(bpm).padStart(4)}  ${est.toFixed(1).padStart(6)}  ${(err * 100).toFixed(1).padStart(5)}  ` +
      `${a.confidence.toFixed(2)}  ${String(a.alternative ?? '—').padStart(6)}   ` +
      `${isExact ? 'exact' : isOctave ? 'octave' : 'WRONG'}`,
  )
}
console.log(`\n  exact ${exact}/${TEMPI.length}   within an octave ${octave}/${TEMPI.length}`)

if (octave < TEMPI.length) throw new Error(`tempo: ${TEMPI.length - octave} estimate(s) not even within an octave`)
if (exact < TEMPI.length - 2) throw new Error(`tempo: only ${exact}/${TEMPI.length} exact`)

/**
 * Silence and noise must not produce a tempo.
 *
 * The failure this guards is the one the whole confidence field exists for: an
 * estimator that always answers will answer 120 for a rainstorm, the set will
 * be built on it, and nothing anywhere will have said the number was invented.
 */
console.log('\n── refusals\n')
let seed = 7
const rand = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return (seed / 0x7fffffff) * 2 - 1
}
const noise = new Float32Array(SR * 10)
for (let i = 0; i < noise.length; i++) noise[i] = rand() * 0.3
const onNoise = analyse(asBuffer(noise))
console.log(`  white noise      bpm ${onNoise.bpm ?? '—'}  conf ${onNoise.confidence.toFixed(2)}`)
if (onNoise.confidence > 0.4) throw new Error('tempo: confident about white noise')

const quiet = analyse(asBuffer(new Float32Array(SR * 10)))
console.log(`  silence          bpm ${quiet.bpm ?? '—'}  conf ${quiet.confidence.toFixed(2)}`)
if (quiet.confidence > 0.4) throw new Error('tempo: confident about silence')

// A pure 220 Hz tone: no onsets at all, but a very clear pitch. The two halves
// of the analysis must not borrow each other's confidence.
const tone = new Float32Array(SR * 8)
for (let i = 0; i < tone.length; i++) tone[i] = 0.4 * Math.sin((2 * Math.PI * 220 * i) / SR)
const onTone = analyse(asBuffer(tone))
console.log(
  `  220 Hz tone      bpm ${onTone.bpm ?? '—'}  conf ${onTone.confidence.toFixed(2)}  ` +
    `pitch ${onTone.pitchName ?? '—'} (${onTone.pitchConfidence.toFixed(2)})`,
)
if (onTone.pitchName !== 'A') throw new Error(`pitch: 220 Hz read as ${onTone.pitchName}`)

/**
 * Noise has no key either, and this is the case that matters.
 *
 * The click track is *not* a good negative here and it is worth writing down
 * why, because the first version of this test asserted on it and the assertion
 * was wrong rather than the code: its kick is a 60 Hz sine, so it genuinely has
 * a fundamental, and refusing to name one would have been the bug. Real
 * percussion is broadband, which is what white noise stands in for.
 */
console.log(`  white noise      pitch ${onNoise.pitchName ?? '—'} (${onNoise.pitchConfidence.toFixed(2)})`)
if (onNoise.pitchName) throw new Error(`pitch: white noise read as ${onNoise.pitchName}`)

console.log('\n── shape\n')

/** Quiet, then loud, then fading: something the section labels can bite on. */
const arc = click(120, 32)
for (let i = 0; i < arc.length; i++) {
  const t = i / SR
  const gain = t < 8 ? 0.25 : t < 22 ? 1 : Math.max(0.1, 1 - (t - 22) / 10)
  arc[i] *= gain
}
const shaped = analyse(asBuffer(arc))
console.log(`  sections: ${shaped.sections.map((s) => `${s.role} ${s.from}–${s.to}s`).join(', ') || 'none'}`)
console.log(`  loudest at ${shaped.loudestAt}s`)
if (shaped.sections.length < 2) throw new Error('shape: a signal with an obvious arc produced one flat section')
if (shaped.sections[0].role !== 'intro') throw new Error(`shape: quiet opening read as ${shaped.sections[0].role}`)
if (!shaped.sections.some((s) => s.role === 'drop')) throw new Error('shape: no loud section found')

console.log('\nanalyse: ok')
