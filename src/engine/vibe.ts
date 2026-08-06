/**
 * What the conversation feels like, as four numbers.
 *
 * Each axis is a direction in embedding space defined by two poles. Projecting
 * the turn onto that direction gives a signed reading, and readings are folded
 * into a running state with decay so the room drifts rather than flips.
 */
import { cosine, embed, known, warm } from '../model/vectors'
import { blend, NEUTRAL, type Vibe } from './theme'

const AXES: Record<keyof Vibe, [string, string]> = {
  warmth: [
    'technical precise system data machine protocol exact specification',
    'warm human feeling personal tender intimate memory family',
  ],
  energy: [
    'calm quiet slow still gentle patient rest peaceful',
    'urgent fast intense loud sudden rush emergency crisis',
  ],
  gravity: [
    'playful fun silly joke light amusing casual',
    'serious grave important solemn critical consequence weight',
  ],
  wonder: [
    'ordinary plain normal routine familiar mundane usual',
    'strange mysterious wonder cosmic infinite dream impossible',
  ],
}

export type Axes = Record<keyof Vibe, Float32Array>

/** The poles, embedded once at boot — a fixed set of strings, like the bank. */
export async function buildAxes(): Promise<Axes> {
  const out = {} as Axes
  for (const [name, [lo, hi]] of Object.entries(AXES)) {
    const [a, b] = await Promise.all([embed(lo), embed(hi)])
    const d = new Float32Array(a.length)
    let sq = 0
    for (let i = 0; i < a.length; i++) {
      d[i] = b[i] - a[i]
      sq += d[i] * d[i]
    }
    const n = Math.sqrt(sq) || 1
    for (let i = 0; i < d.length; i++) d[i] /= n
    out[name as keyof Vibe] = d
  }
  return out
}

/**
 * Readings are small (a sentence is never a pure pole), so they are scaled to
 * fill the usable range before being clamped.
 */
const GAIN = 4.2

/**
 * Null when the sentence has not been embedded yet. The caller keeps whatever
 * vibe the room already had rather than lurching to neutral for one frame —
 * a theme that flickers on every new sentence is worse than one that arrives
 * a beat late.
 */
export function read(text: string, axes: Axes): Vibe | null {
  const v = known(text)
  if (!v) {
    warm([text])
    return null
  }
  const proj = (a: Float32Array) => Math.max(-1, Math.min(1, cosine(v, a) * GAIN))
  return {
    warmth: proj(axes.warmth),
    energy: proj(axes.energy),
    gravity: proj(axes.gravity),
    wonder: proj(axes.wonder),
  }
}

/** Running vibe: each turn nudges the room, it never reassigns it. */
export class Drift {
  private state: Vibe = { ...NEUTRAL }
  constructor(private readonly rate = 0.34) {}

  push(text: string, axes: Axes): Vibe {
    const next = read(text, axes)
    if (next) this.state = blend(this.state, next, this.rate)
    return this.state
  }

  get current(): Vibe {
    return this.state
  }
}
