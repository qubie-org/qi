/**
 * The room remembers where you are in the conversation.
 *
 * Every turn snapshots the vibe it was written under. As you scroll, the active
 * theme is a weighted blend of the turns actually on screen — so scrolling back
 * to something said ten turns ago restores the colour, weight and motion the
 * page had at the time, and scrolling forward brings the present back.
 *
 * The theme is therefore a property of *position in the feed*, not global
 * state. Nothing is stored per pixel; the blend is recomputed from the turns
 * themselves, so it survives resize, reflow and re-render for free.
 */
import { applyVibe, NEUTRAL, type Vibe } from './theme'

/** How sharply attention falls off from the focus line. Larger = softer mix. */
const FALLOFF = 0.55
/** Where the eye is assumed to be, as a fraction of viewport height. */
const FOCUS = 0.42
/** Below this, a turn contributes nothing and is skipped entirely. */
const MIN_WEIGHT = 0.02

export type Snapshot = { el: HTMLElement; vibe: Vibe }

const AXES = ['warmth', 'energy', 'gravity', 'wonder'] as const

/**
 * Blend the vibes of whatever is on screen, weighted by nearness to the focus
 * line. Returns null when nothing is visible, so the caller can leave the
 * current theme alone rather than snapping to neutral.
 */
export function blendVisible(snaps: Snapshot[], viewportH = window.innerHeight): Vibe | null {
  const focus = viewportH * FOCUS
  let total = 0
  const acc: Vibe = { ...NEUTRAL }

  for (const { el, vibe } of snaps) {
    const r = el.getBoundingClientRect()
    if (r.bottom < 0 || r.top > viewportH) continue // off screen entirely

    // Distance from the focus line to the nearest edge of the turn, so a tall
    // turn spanning the line counts as fully in focus rather than as its centre.
    const above = focus - r.bottom
    const below = r.top - focus
    const gap = Math.max(0, above, below)
    const weight = Math.exp(-((gap / (viewportH * FALLOFF)) ** 2))
    if (weight < MIN_WEIGHT) continue

    for (const axis of AXES) acc[axis] += vibe[axis] * weight
    total += weight
  }

  if (!total) return null
  for (const axis of AXES) acc[axis] /= total
  return acc
}

/**
 * Watch scroll and keep the theme in step with the feed.
 *
 * Reads are batched into a single rAF so a fast scroll costs one layout pass
 * per frame rather than one per event, and the observer is passive so it never
 * blocks the scroll itself.
 */
export function trackScrollTheme(getSnapshots: () => Snapshot[]): () => void {
  let queued = false
  let last: Vibe | null = null

  const settle = () => {
    queued = false
    const next = blendVisible(getSnapshots())
    if (!next) return
    // Skip work when nothing meaningful moved — this runs every frame.
    if (last && AXES.every((a) => Math.abs(next[a] - last![a]) < 0.004)) return
    last = next
    applyVibe(next)
  }

  const onScroll = () => {
    if (queued) return
    queued = true
    requestAnimationFrame(settle)
  }

  addEventListener('scroll', onScroll, { passive: true })
  addEventListener('resize', onScroll, { passive: true })
  onScroll()

  return () => {
    removeEventListener('scroll', onScroll)
    removeEventListener('resize', onScroll)
  }
}
