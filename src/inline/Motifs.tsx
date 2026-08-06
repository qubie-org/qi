import type { JSX } from 'react'
import type { MotifKind } from './types'

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const

/**
 * Every motif is authored on a 24-unit-tall canvas and sized in `em`, so it
 * scales with whatever type it is sitting inside and never needs a fixed px.
 */
export const MOTIF_SVG: Record<MotifKind, (k: string) => JSX.Element> = {

  // img1 — the shapes run
  shapes: (k) => (
    <svg key={k} className="i-motif" viewBox="0 0 96 24" aria-hidden>
      <circle cx="11" cy="12" r="11" fill="var(--c1, #e8483c)" />
      <rect x="26" y="0" width="9" height="24" fill="var(--c2, #3f7ef5)" />
      <path d="M52 1L63 12L52 23L41 12Z" fill="var(--c3, #23a05c)" />
      <rect x="68" y="0" width="28" height="24" rx="12" fill="var(--c4, #f5b52b)" />
    </svg>
  ),

  // img3 — the long arrow that carries you to the next thing
  arrow: (k) => (
    <svg key={k} className="i-motif i-motif--wide" viewBox="0 0 100 16" aria-hidden>
      <path d="M2 8H94" {...stroke} strokeWidth={1.6} />
      <path d="M84 2L95 8L84 14" {...stroke} strokeWidth={1.6} />
    </svg>
  ),

  // img4 — the hand-drawn curve
  curve: (k) => (
    <svg key={k} className="i-motif" viewBox="0 0 30 26" aria-hidden>
      <path d="M2 2c0 14 8 20 24 20" {...stroke} strokeWidth={1.5} />
      <path d="M19 17l7 5-7 4" {...stroke} strokeWidth={1.5} />
    </svg>
  ),

  // A bullet, so it must ride at x-height. On the baseline at .22em it just
  // reads as a full stop.
  dot: (k) => (
    <svg
      key={k}
      className="i-motif"
      viewBox="0 0 12 12"
      aria-hidden
      style={{ height: '.3em', verticalAlign: '.16em' }}
    >
      <circle cx="6" cy="6" r="6" fill="var(--c1, var(--accent))" />
    </svg>
  ),

}

export function Motif({ kind }: { kind: MotifKind }) {
  return MOTIF_SVG[kind](kind)
}
