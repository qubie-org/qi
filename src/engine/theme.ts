/**
 * Vibe → design tokens.
 *
 * The room is white. Colour and contrast are spent only on type, so this maps
 * the conversation's drift onto: the accent hues the words and glyphs take,
 * two barely-there gradient tints, and how heavy / tight / lively the agent's
 * voice is. Everything lands as CSS custom properties and CSS does the
 * interpolating — see the @property blocks in styles.css.
 */

export type Vibe = {
  /** cold, technical ↔ warm, human */
  warmth: number
  /** still ↔ urgent */
  energy: number
  /** playful ↔ serious */
  gravity: number
  /** plain ↔ strange */
  wonder: number
}

export const NEUTRAL: Vibe = { warmth: 0, energy: 0, gravity: 0, wonder: 0 }

const clamp = (x: number, lo = -1, hi = 1) => Math.min(hi, Math.max(lo, x))
const mix = (a: number, b: number, t: number) => a + (b - a) * (t * 0.5 + 0.5)

/**
 * Four fixed anchors, not an arc.
 *
 * Interpolating hue continuously — blue round through magenta to amber — meant
 * every middling conversation came out pink, because pink is the middle of
 * that path. Google's palette is not a gradient: it is four saturated,
 * unmistakable hues that never blend into each other. img1 is literally those
 * four as a run of shapes.
 *
 * Vibe now chooses *which* anchor leads and in what order the rest follow,
 * rather than sliding between them. Measured from #4285F4 / #EA4335 / #FBBC04
 * / #34A853 in OKLCH.
 */
const ANCHORS = [
  { name: 'blue', l: 0.63, c: 0.18, h: 260 },
  { name: 'red', l: 0.626, c: 0.206, h: 29 },
  { name: 'gold', l: 0.78, c: 0.17, h: 84 },
  { name: 'green', l: 0.648, c: 0.16, h: 148.5 },
] as const

export function tokensFor(v: Vibe): Record<string, string> {
  const warmth = clamp(v.warmth)
  const energy = clamp(v.energy)
  const gravity = clamp(v.gravity)
  const wonder = clamp(v.wonder)

  // The palette does NOT rotate with the conversation. Which colour a word
  // takes is decided by what that word means (see palette.ts); rotating the
  // whole set underneath that would make "ocean" blue in one turn and gold in
  // the next, which is colour varying without signifying — the thing worth
  // avoiding. Vibe still shapes saturation, weight and motion.
  const boost = mix(0.94, 1.22, energy) + mix(0, 0.06, wonder)
  const lift = -mix(0, 0.06, gravity)

  const ok = (a: (typeof ANCHORS)[number], dl = 0) =>
    `oklch(${((a.l + lift + dl) * 100).toFixed(1)}% ${(a.c * boost).toFixed(3)} ${a.h})`

  const [blue, red, gold, green] = ANCHORS


  return {
    // Named, stable, and in tone order: --t1 blue, --t2 red, --t3 gold,
    // --t4 green. A word asks for the tone its meaning implies and always gets
    // the same colour for it.
    '--t1': ok(blue),
    '--t2': ok(red),
    '--t3': ok(gold),
    '--t4': ok(green),
    '--c1': ok(blue),
    '--c2': ok(red),
    '--c3': ok(gold),
    '--c4': ok(green),
    // Fallbacks for anything not asking for a specific tone.
    '--accent': ok(blue),
    '--accent-2': ok(gold),

    // The room is white and stays white. Tinting the walls competes with the
    // type for the same signal and reads as a wash rather than as meaning;
    // variation belongs in the words, where it can point at something.
    '--bg-a': 'oklch(99.4% 0.0012 260)',
    '--bg-b': 'oklch(98.2% 0.002 260)',

    // Voice.
    // A serif carries its weight in the letterforms, so the range that used to
    // run 560–880 now runs where a display serif actually looks composed. The
    // top of the old range was a headline shouting; nothing needs that.
    '--agent-weight': String(Math.round(mix(380, 580, energy * 0.6 + gravity * 0.4))),
    '--agent-tracking': `${mix(-0.004, -0.022, energy * 0.5 + gravity * 0.5).toFixed(4)}em`,
    '--agent-size': `${mix(2.4, 3.2, energy * 0.7 - gravity * 0.3).toFixed(2)}rem`,
    '--motion': mix(0.72, 1.5, energy).toFixed(3),
  }
}

let current: Vibe = { ...NEUTRAL }

export function applyVibe(v: Vibe, el: HTMLElement = document.documentElement) {
  current = v
  const tokens = tokensFor(v)
  for (const [k, val] of Object.entries(tokens)) el.style.setProperty(k, val)
}

export const currentVibe = () => current

/** Ease toward a target so a single sentence never yanks the whole room. */
export function blend(from: Vibe, to: Vibe, t = 0.34): Vibe {
  return {
    warmth: from.warmth + (to.warmth - from.warmth) * t,
    energy: from.energy + (to.energy - from.energy) * t,
    gravity: from.gravity + (to.gravity - from.gravity) * t,
    wonder: from.wonder + (to.wonder - from.wonder) * t,
  }
}
