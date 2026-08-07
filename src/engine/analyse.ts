/**
 * Listening to a sound well enough to place it.
 *
 * The set generator in `dj.ts` has always been able to *invent* music, because
 * everything it plays is synthesised and every number it needs is one it chose.
 * A found recording is the opposite: it arrives with a tempo, a loudness shape
 * and possibly a key that were all decided by someone else, years ago, and none
 * of that is written down anywhere. Openverse will tell you the licence and the
 * creator and the duration in milliseconds. It will not tell you the BPM.
 *
 * So this is the smallest amount of listening that lets code decide where a
 * sample goes. Three questions, in descending order of how much the arrangement
 * depends on them:
 *
 *   tempo     the load-bearing one. Get it wrong and every later decision —
 *             the set's cps, whether the loop is stretched, where the bar
 *             lines fall — is wrong with it.
 *   shape     where the energy is, coarsely. Enough to say "the useful part
 *             starts at 8 seconds", which is what stops a sample being
 *             dropped in on its four-second fade-in.
 *   pitch     nice to have. Reported only when it is actually confident,
 *             because a drum loop has no key and saying it has one is worse
 *             than saying nothing.
 *
 * This is deliberately not an MIR stack. There is no FFT, no onset classifier,
 * no beat tracker with a dynamic-programming backend. Everything below is a
 * loop over a Float32Array, and the whole pass over thirty seconds of audio
 * costs a few tens of milliseconds — which matters because it runs on the main
 * thread of a page that is also drawing an interface.
 *
 * ── What was measured, and what it killed ──────────────────────────────────
 *
 * The first estimator used the standard textbook onset function: the positive
 * first difference of the *log* RMS envelope. Against synthesised click tracks
 * with a kick on the beat and a hat on the offbeat it was exactly right at 88,
 * 100 and 120 BPM and exactly wrong above that:
 *
 *     true 128 → 85.4      true 140 → 93.5      true 174 → 116.2
 *
 * Every one of those is two-thirds of the truth — the estimator locked onto a
 * period of a bar and a half. Dumping the raw autocorrelation for the 128 case
 * showed why: the peak at 1.5 beats (1.77) was larger than the peak at 1 beat
 * (1.42). That is not a tuning problem, it is the log talking. A log envelope
 * compresses dynamics so hard that a quiet hat rising out of near-silence
 * produces a *bigger* jump than a loud kick rising out of the hat's tail — so
 * the onset train stops being "strong, weak, strong, weak" and becomes a plain
 * even grid at half-beats, at which point every multiple of half a beat
 * correlates about equally and the winner is decided by noise.
 *
 * Two changes follow from that one measurement, and both are here:
 *
 *   the envelope is compressed with a square root rather than a logarithm, so
 *   a kick stays louder than a hat and the accent pattern survives;
 *
 *   and the tempo is not chosen by the tallest autocorrelation peak but by a
 *   harmonic sum — a lag scores as itself plus its own multiples. A true beat
 *   period has its 2×, 3× and 4× all correlating, because those are bar-ish
 *   distances in the same grid. A period of one and a half beats has 3× and 6×
 *   correlating and 4.5× not, so it loses even when its own single peak is
 *   taller. This is the cheap half of what Ellis's 2007 beat tracker does, and
 *   it is the half that fixes octave and half-octave errors.
 *
 * The log-normal tempo prior centred on 120 BPM is from the same paper. It is
 * not a fudge: given a recording that genuinely correlates at both 85 and 170,
 * something has to break the tie, and "people mostly make music near 120" is a
 * better tiebreaker than "pick the lower lag".
 */

/**
 * Frame geometry.
 *
 * 5 ms hop is 200 envelope frames a second, which puts the lag resolution at
 * 120 BPM at about 1.2 BPM — fine enough that the parabolic interpolation
 * below is doing the last bit rather than all of it. A 20 ms window (four hops)
 * is long enough to average out a waveform's own cycles at bass frequencies and
 * short enough that a kick and the hat 60 ms later are separate frames.
 */
const HOP_S = 0.005
const WIN_HOPS = 4

/** The tempo range anything danceable lives in. Outside it, halves and doubles. */
const BPM_LO = 60
const BPM_HI = 200

/**
 * How much audio is enough.
 *
 * Autocorrelation over thirty seconds sees a tempo perfectly well; over five
 * minutes it sees the same tempo and costs ten times as much. The cap is on
 * *decoded* audio rather than on the download, because the download is capped
 * separately and for a different reason (see `crate.ts`).
 */
const MAX_ANALYSE_S = 40

export type Section = {
  /** Seconds from the start of the file. */
  from: number
  to: number
  /** Coarse role, from relative loudness and position. */
  role: 'intro' | 'build' | 'drop' | 'body' | 'tail'
  /** RMS relative to the loudest bar, 0–1. */
  level: number
}

export type Analysis = {
  /** Seconds of audio actually examined. */
  seconds: number
  sampleRate: number
  /** Beats per minute, or null when nothing periodic was found at all. */
  bpm: number | null
  /**
   * 0–1. Below ~0.35 the number should be shown as a guess or not shown.
   *
   * This is a real measurement, not a vibe: the winning score divided by the
   * mean score across the whole searched tempo range, squashed. A recording
   * with one strong periodicity scores far above its own average; a field
   * recording of rain scores barely above it.
   */
  confidence: number
  /**
   * The runner-up tempo, when there is a genuine second candidate.
   *
   * Kept because half and double time are the honest ambiguity in this problem
   * and hiding them is how a confident wrong answer gets made. If the caller
   * needs 90 BPM and this says 174/87, that is usable information.
   */
  alternative: number | null
  /** Seconds into the file where the loudest bar starts. */
  loudestAt: number
  sections: Section[]
  /** Overall RMS, 0–1, for gain-matching against the synthesised kit. */
  loudness: number
  /**
   * Dominant pitch class as a MIDI number in 0–11 (0 = C), or null.
   *
   * Null is the common and correct answer for percussion. See `chroma` below
   * for why this refuses rather than guesses.
   */
  pitch: number | null
  pitchName: string | null
  pitchConfidence: number
}

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

/** Both channels folded down. Stereo width tells us nothing about tempo. */
function mono(buf: AudioBuffer, maxSeconds: number): Float32Array {
  const n = Math.min(buf.length, Math.floor(maxSeconds * buf.sampleRate))
  const out = new Float32Array(n)
  const channels = Math.min(2, buf.numberOfChannels)
  for (let c = 0; c < channels; c++) {
    const data = buf.getChannelData(c)
    for (let i = 0; i < n; i++) out[i] += data[i] / channels
  }
  return out
}

/** RMS per frame. The one thing everything below is computed from. */
function envelope(x: Float32Array, sampleRate: number): { e: Float32Array; rate: number } {
  const hop = Math.max(1, Math.round(sampleRate * HOP_S))
  const win = hop * WIN_HOPS
  const n = Math.max(0, Math.floor((x.length - win) / hop))
  const e = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let sum = 0
    const at = i * hop
    for (let j = 0; j < win; j++) {
      const v = x[at + j]
      sum += v * v
    }
    e[i] = Math.sqrt(sum / win)
  }
  return { e, rate: sampleRate / hop }
}

/**
 * Onset strength: how much louder this frame is than the last one.
 *
 * The square root is the compression, and the reason it is a square root and
 * not a logarithm is the whole measurement recorded at the top of this file.
 * The local mean subtraction is what stops a long fade-in reading as one very
 * slow beat, and the rectification afterwards is what keeps the
 * autocorrelation honest — with negative values in the signal, two quiet
 * stretches multiply to a positive score and silence starts winning.
 */
function onsets(e: Float32Array, rate: number): Float32Array {
  const raw = new Float32Array(e.length)
  for (let i = 1; i < e.length; i++) {
    const d = Math.sqrt(e[i]) - Math.sqrt(e[i - 1])
    raw[i] = d > 0 ? d : 0
  }
  // 200 ms of history: long enough to be a baseline, short enough that a real
  // accent still stands above it.
  const w = Math.max(4, Math.round(rate * 0.2))
  const out = new Float32Array(raw.length)
  let run = 0
  for (let i = 0; i < raw.length; i++) {
    run += raw[i]
    if (i >= w) run -= raw[i - w]
    const d = raw[i] - run / Math.min(i + 1, w)
    out[i] = d > 0 ? d : 0
  }
  return out
}

/**
 * Unbiased-ish autocorrelation of the onset strength, out to four bars.
 *
 * Divided by the overlap count rather than by the full length, so a long lag is
 * not penalised simply for having fewer terms to sum. Computed out past the
 * search range because the harmonic sum reaches above it.
 */
function autocorrelate(o: Float32Array, maxLag: number): Float64Array {
  const a = new Float64Array(maxLag + 1)
  const n = o.length
  for (let lag = 1; lag <= maxLag && lag < n; lag++) {
    let sum = 0
    for (let i = lag; i < n; i++) sum += o[i] * o[i - lag]
    a[lag] = sum / (n - lag)
  }
  return a
}

/** Ellis 2007's log-normal weighting: a preference for tempi near 120 BPM. */
const prior = (bpm: number) => Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2)

type Tempo = { bpm: number; confidence: number; alternative: number | null }

function tempo(o: Float32Array, rate: number): Tempo {
  const loLag = Math.max(2, Math.floor((60 / BPM_HI) * rate))
  const hiLag = Math.ceil((60 / BPM_LO) * rate)
  // Four multiples of the slowest candidate, so the harmonic sum never reads
  // past the end of the array and silently scores a lag as if its multiples
  // did not correlate.
  const a = autocorrelate(o, hiLag * 4 + 2)

  const score = new Float64Array(hiLag + 1)
  let best = loLag
  let bestValue = -Infinity
  let total = 0
  let counted = 0
  for (let lag = loLag; lag <= hiLag; lag++) {
    // A lag scores as itself plus its own multiples, each worth less than the
    // last. This is the line that fixes 128 → 85.4.
    let harmonic = 0
    for (let k = 1; k <= 4; k++) harmonic += a[lag * k] / k
    const value = harmonic * prior((60 * rate) / lag)
    score[lag] = value
    total += value
    counted++
    if (value > bestValue) {
      bestValue = value
      best = lag
    }
  }
  if (!counted || bestValue <= 0) return { bpm: 0, confidence: 0, alternative: null }

  /**
   * The octave, decided from evidence rather than from the prior.
   *
   * The harmonic sum removes the ugly errors — thirds of a tempo, bars and a
   * half — and leaves the one genuine ambiguity behind: is this 64 or 128?
   * Both correlate, because every multiple of the beat is also a multiple of
   * two beats, so no amount of weighting the sum will separate them.
   *
   * What does separate them is the *plain* autocorrelation halfway between:
   * if there are strong onsets at half the winning lag, the winning lag is two
   * beats and not one. Measured on click tracks with a kick on the beat and a
   * hat on the offbeat, `a[L/2] / a[L]` came out
   *
   *     picked correctly    88 → 0.556    100 → 0.571
   *     picked half-tempo  128 → 0.778    140 → 0.748
   *
   * with white noise at 0.242 and a pure tone at 0.000. The gap between 0.571
   * and 0.748 is wide and on the right side of everything, so the cut is 0.66.
   *
   * The slow direction needs its own test and a different one, because two
   * beats *always* correlate at least as well as one and a ratio near 1 is
   * therefore normal. Only when the double lag correlates *better* — measured
   * 1.69 for the one tempo that was picked at double speed, against 0.80–0.87
   * for every tempo picked correctly — is the slower reading the real one.
   */
  const half = Math.round(best / 2)
  const double = best * 2
  if (half >= loLag && a[best] > 0 && a[half] / a[best] >= 0.66) best = half
  else if (double <= hiLag && a[best] > 0 && a[double] / a[best] >= 1.15) best = double

  // Sub-frame lag by fitting a parabola through the winner and its neighbours.
  // Worth about a BPM at 120, which is the difference between a loop that
  // stays in phase for a minute and one that does not.
  const left = score[best - 1] ?? 0
  const mid = score[best]
  const right = score[best + 1] ?? 0
  const denom = left - 2 * mid + right
  const shift = denom ? (0.5 * (left - right)) / denom : 0
  const lag = best + (Math.abs(shift) < 1 ? shift : 0)
  const bpm = (60 * rate) / lag

  /**
   * The runner-up, found by ignoring everything near the winner.
   *
   * "Near" is a quarter of the winning lag, which is wide enough to exclude the
   * winner's own shoulder and narrow enough to leave half and double time
   * visible — those being the two answers a tempo estimator is actually
   * choosing between.
   */
  let second = 0
  let secondValue = -Infinity
  const guard = Math.max(2, Math.round(best * 0.25))
  for (let l = loLag; l <= hiLag; l++) {
    if (Math.abs(l - best) <= guard) continue
    if (score[l] > secondValue) {
      secondValue = score[l]
      second = l
    }
  }

  /**
   * Confidence, scaled against what was actually measured.
   *
   * The quantity is the winning score over the mean score across the whole
   * searched tempo range — how far the answer stands above the field. The first
   * version divided `(ratio - 1)` by 8, which reported 1.00 for everything
   * including material that had no tempo at all, because the raw ratios are
   * nothing like 1–8:
   *
   *     click tracks   22 – 44
   *     white noise     4.1
   *     a pure tone     3.5
   *
   * So the floor is 3, not 1 — below that there is no periodicity worth the
   * name — and the span is 15, which puts a click track at the ceiling and
   * leaves the middle of the range for real recordings, which are messier than
   * a click track and should not be reported as certain.
   */
  const mean = total / counted
  const ratio = score[best] / (mean || 1e-12)
  const confidence = Math.max(0, Math.min(1, (ratio - 3) / 15))

  return {
    bpm,
    confidence,
    alternative: second && secondValue > bestValue * 0.6 ? (60 * rate) / second : null,
  }
}

/**
 * Where the energy is, in bars.
 *
 * Bars rather than seconds because the labels are only useful to something that
 * is going to place the sample on a grid, and a boundary that is not on a bar
 * line cannot be used without moving it. When there is no usable tempo the bar
 * falls back to two seconds, which is roughly a bar at 120 and keeps the shape
 * readable rather than refusing to describe it.
 */
function shape(e: Float32Array, rate: number, bpm: number): { sections: Section[]; loudestAt: number } {
  const barSeconds = bpm > 0 ? (60 / bpm) * 4 : 2
  const perBar = Math.max(1, Math.round(barSeconds * rate))
  const bars = Math.floor(e.length / perBar)
  if (bars < 2) return { sections: [], loudestAt: 0 }

  const level = new Float64Array(bars)
  let peak = 0
  for (let b = 0; b < bars; b++) {
    let sum = 0
    for (let i = 0; i < perBar; i++) {
      const v = e[b * perBar + i]
      sum += v * v
    }
    level[b] = Math.sqrt(sum / perBar)
    if (level[b] > peak) peak = level[b]
  }
  if (!peak) return { sections: [], loudestAt: 0 }

  let loudest = 0
  for (let b = 0; b < bars; b++) {
    level[b] /= peak
    if (level[b] > level[loudest]) loudest = b
  }

  const roleOf = (b: number): Section['role'] => {
    const l = level[b]
    const rising = b > 0 && l - level[b - 1] > 0.08
    if (l >= 0.85) return 'drop'
    if (b < bars * 0.25 && l < 0.6) return 'intro'
    if (b > bars * 0.75 && l < 0.7) return 'tail'
    if (rising) return 'build'
    return 'body'
  }

  // Adjacent bars with the same role are one span. A per-bar list of forty
  // entries is not a description of a piece of music, it is the envelope again.
  const sections: Section[] = []
  for (let b = 0; b < bars; b++) {
    const role = roleOf(b)
    const from = (b * perBar) / rate
    const to = ((b + 1) * perBar) / rate
    const last = sections[sections.length - 1]
    if (last && last.role === role) {
      last.to = to
      last.level = Math.max(last.level, level[b])
    } else {
      sections.push({ from: +from.toFixed(2), to: +to.toFixed(2), role, level: +level[b].toFixed(2) })
    }
  }
  for (const s of sections) {
    s.from = +s.from.toFixed(2)
    s.to = +s.to.toFixed(2)
  }
  return { sections, loudestAt: +((loudest * perBar) / rate).toFixed(2) }
}

/**
 * A twelve-bin chroma, by Goertzel rather than by FFT.
 *
 * The honest reason there is no FFT here: this file has no FFT, adding one is a
 * few hundred lines of someone else's code, and a chroma only needs the
 * magnitude at 48 known frequencies — four octaves of twelve pitch classes.
 * Goertzel gives exactly that for two multiplies per sample per bin, which
 * over eight windows of 4096 samples is under two million operations. An FFT
 * would compute 2048 bins we would then throw 2000 of away.
 *
 * The windows are spread across the file rather than taken from the front,
 * because the front of a recording is very often a fade or a count-in.
 *
 * What this cannot do is tell major from minor, and it does not try. Reporting
 * a tonic pitch class is a claim this measurement supports; reporting a key is
 * not, and the app's own key already comes from the conversation anyway — what
 * a sample needs to say is which note it sits on, so it can be transposed to
 * agree.
 */
function chroma(x: Float32Array, sampleRate: number): { pitch: number | null; confidence: number } {
  const N = 4096
  const windows = 8
  if (x.length < N * 2) return { pitch: null, confidence: 0 }

  const bins = new Float64Array(12)
  const stride = Math.floor((x.length - N) / windows)

  for (let w = 0; w < windows; w++) {
    const at = w * stride
    for (let pc = 0; pc < 12; pc++) {
      for (let octave = 2; octave <= 5; octave++) {
        // MIDI 12 = C0, so pitch class `pc` in `octave` is 12*(octave+1) + pc.
        const midi = 12 * (octave + 1) + pc
        const freq = 440 * 2 ** ((midi - 69) / 12)
        if (freq > sampleRate / 2) continue
        const k = (2 * Math.PI * freq) / sampleRate
        const coeff = 2 * Math.cos(k)
        let s0 = 0
        let s1 = 0
        let s2 = 0
        for (let i = 0; i < N; i++) {
          // Hann, so a partial that sits between two of our frequencies does
          // not smear across every bin in the octave.
          const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1))
          s0 = x[at + i] * win + coeff * s1 - s2
          s2 = s1
          s1 = s0
        }
        bins[pc] += Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2))
      }
    }
  }

  let top = 0
  let sum = 0
  for (let i = 0; i < 12; i++) {
    sum += bins[i]
    if (bins[i] > bins[top]) top = i
  }
  if (!sum) return { pitch: null, confidence: 0 }

  const mean = sum / 12
  // How far the winner stands above a flat chroma. A flat chroma is what noise
  // and unpitched percussion produce, and it scores 0 here by construction.
  const confidence = Math.max(0, Math.min(1, (bins[top] / mean - 1) / 1.5))
  // 0.35 was picked by looking at what percussion scores rather than by taste:
  // below it, the "dominant" pitch is whichever bin the cymbals happened to
  // land in. Refusing is the correct answer for a drum loop.
  return confidence >= 0.35 ? { pitch: top, confidence } : { pitch: null, confidence }
}

/**
 * Everything above, on one decoded buffer.
 *
 * Total, and total on purpose: a sample that cannot be analysed is still a
 * sample, so this returns zeroed confidences rather than throwing. Every
 * consumer already has to handle "no tempo found", because that is the right
 * answer for a bell.
 */
export function analyse(buf: AudioBuffer): Analysis {
  const x = mono(buf, MAX_ANALYSE_S)
  const seconds = x.length / buf.sampleRate
  const { e, rate } = envelope(x, buf.sampleRate)

  let loudness = 0
  for (let i = 0; i < e.length; i++) loudness += e[i] * e[i]
  loudness = e.length ? Math.sqrt(loudness / e.length) : 0

  const empty: Analysis = {
    seconds: +seconds.toFixed(2),
    sampleRate: buf.sampleRate,
    bpm: null,
    confidence: 0,
    alternative: null,
    loudestAt: 0,
    sections: [],
    loudness: +loudness.toFixed(4),
    pitch: null,
    pitchName: null,
    pitchConfidence: 0,
  }
  // Under about three seconds there is no room for two beats at 60 BPM, so any
  // tempo that came back would be an artefact of the window rather than a
  // property of the sound.
  if (e.length < rate * 3) return empty

  const t = tempo(onsets(e, rate), rate)
  const bpm = t.bpm > 0 ? +t.bpm.toFixed(1) : null
  const { sections, loudestAt } = shape(e, rate, t.bpm)
  const { pitch, confidence: pitchConfidence } = chroma(x, buf.sampleRate)

  return {
    ...empty,
    bpm,
    confidence: +t.confidence.toFixed(2),
    alternative: t.alternative ? +t.alternative.toFixed(1) : null,
    loudestAt,
    sections,
    pitch,
    pitchName: pitch === null ? null : NAMES[pitch],
    pitchConfidence: +pitchConfidence.toFixed(2),
  }
}

/**
 * How to say a tempo out loud.
 *
 * A wrong BPM stated flatly is worse than an unsure one, because everything
 * downstream — the set's own tempo, whether the sample is stretched, where the
 * bars land — is built on it. So the confidence is not an extra field somebody
 * might read; it is folded into the sentence, and below the bar the number does
 * not get said at all.
 */
export function saidTempo(a: Analysis): string {
  if (a.bpm === null || a.confidence < 0.2) return 'no steady tempo'
  if (a.confidence < 0.4) return `maybe ${Math.round(a.bpm)} bpm`
  const alt = a.alternative ? ` (or ${Math.round(a.alternative)})` : ''
  return `${Math.round(a.bpm)} bpm${alt}`
}
