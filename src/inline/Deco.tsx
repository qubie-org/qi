import type { JSX } from 'react'
import type { DecoKind } from './types'

/* Overlays stretch to whatever span they wrap, so they are authored on a
   nominal 100-wide canvas and told not to preserve their aspect ratio. */
const wrap = {
  preserveAspectRatio: 'none',
  fill: 'none',
  stroke: 'currentColor',
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const

/** img3 — the ellipse drawn round a word by hand, complete with overshoot. */
const circle = (
  <svg {...wrap} viewBox="0 0 100 40" stroke="var(--c1, var(--accent))" strokeWidth="1.6" vectorEffect="non-scaling-stroke">
    <path
      className="draw"
      d="M95.5 17C97 28 76 37.5 50 37.5C24 37.5 3 30 3 19.5C3 9 24 2 50 2C71 2 90 7 95 15.5"
      vectorEffect="non-scaling-stroke"
    />
  </svg>
)

/** img3 — the blue scribble that lives under a word. */
const scribble = (
  <svg {...wrap} viewBox="0 0 100 12" stroke="var(--c2, var(--accent))" strokeWidth="1.4" vectorEffect="non-scaling-stroke">
    <path
      className="draw"
      d="M2 8q6-6 12 0t12 0t12 0t12 0t12 0t12 0t12 0"
      vectorEffect="non-scaling-stroke"
    />
  </svg>
)

/** img3 / img4 — a swash pulled under the word in one stroke. */
const underline = (
  <svg {...wrap} viewBox="0 0 100 10" stroke="var(--c3, var(--accent-2))" strokeWidth="2.4" vectorEffect="non-scaling-stroke">
    <path className="draw" d="M2 6C26 2 70 2 98 5" vectorEffect="non-scaling-stroke" />
  </svg>
)

const box = (
  <svg {...wrap} viewBox="0 0 100 40" stroke="var(--c1, var(--accent))" strokeWidth="1.4" vectorEffect="non-scaling-stroke">
    <rect className="draw" x="2" y="2" width="96" height="36" rx="3" vectorEffect="non-scaling-stroke" />
  </svg>
)

/**
 * Decorations still drawn as overlays.
 *
 * `underline` and `scribble` are deliberately absent: they are now painted by
 * the line box itself (a background gradient and native wavy text-decoration),
 * because an absolutely-positioned SVG over an inline element drifts off
 * register and draws through the line above it.
 *
 * `circle` and `box` have the same flaw and are out of the placement rotation
 * for that reason; they remain here only for explicit `[[span|circle]]` markup,
 * where the author has chosen to accept it on a short span.
 */
export const DECO_SVG: Partial<Record<DecoKind, JSX.Element>> = {
  circle,
  box,
}
