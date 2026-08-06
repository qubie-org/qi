/**
 * The floor: a colour field with a body.
 *
 * The bottom of the page is where the conversation is happening, so it is the
 * one place in a white room that should feel like it is alive. It was a black
 * vignette, which is a shadow — the wrong idea entirely. It is now the four
 * tones the rest of the app colours words with, pooled along the bottom edge
 * and climbing at the corners, and it *moves*.
 *
 * Not a keyframe animation. A keyframe loop is the same three seconds forever
 * and reads as decoration within about ten of them. This is a pair of damped
 * springs that get pushed when you type and then settle — so the motion is
 * caused by something, has weight, and never repeats exactly.
 *
 *   lift   how bright the field is. Each keystroke adds energy; it decays.
 *   sway   which way it leans. Alternate keystrokes push opposite ways, so a
 *          run of typing rocks the field rather than shoving it one way.
 *
 * Both are integrated by the same spring — acceleration toward a target,
 * proportional to distance, minus damping proportional to velocity. It is four
 * lines of arithmetic and behaves like a real object, which is the whole point:
 * things with mass are legible in a way that eased curves are not.
 *
 * The loop sleeps. When both springs are within a hair of rest and have no
 * velocity left, the frame callback stops rescheduling itself, so an idle page
 * costs nothing at all.
 */

type Spring = {
  value: number
  velocity: number
  target: number
  /** Stiffness: how hard it pulls toward the target. */
  k: number
  /** Damping: how quickly the wobble dies. Below ~2*sqrt(k) it oscillates. */
  c: number
}

const spring = (k: number, c: number): Spring => ({ value: 0, velocity: 0, target: 0, k, c })

/** Bright and quick — a keystroke should register immediately. */
const lift = spring(120, 14)
/** Looser and slower, so the lean lags the brightness and the field feels heavy. */
const sway = spring(38, 7.5)

let running = false
let last = 0
let pushes = 0

/** Nothing here is worth a frame once it is this close to still. */
const REST = 0.0008

function step(now: number) {
  // Seconds, clamped: a backgrounded tab resumes with a huge delta and an
  // unclamped integrator answers that by launching the field off screen.
  const dt = Math.min(0.032, (now - last) / 1000 || 0.016)
  last = now

  let moving = false
  for (const s of [lift, sway]) {
    const accel = (s.target - s.value) * s.k - s.velocity * s.c
    s.velocity += accel * dt
    s.value += s.velocity * dt
    if (Math.abs(s.velocity) > REST || Math.abs(s.target - s.value) > REST) moving = true
  }

  // Energy bleeds away on its own, so a burst of typing decays into stillness
  // rather than holding the field up until the next keystroke.
  lift.target *= Math.exp(-1.9 * dt)
  sway.target *= Math.exp(-1.4 * dt)

  const root = document.documentElement.style
  root.setProperty('--floor-lift', lift.value.toFixed(4))
  root.setProperty('--floor-sway', sway.value.toFixed(4))

  if (moving || Math.abs(lift.target) > REST) {
    requestAnimationFrame(step)
  } else {
    running = false
    root.setProperty('--floor-lift', '0')
    root.setProperty('--floor-sway', '0')
  }
}

function wake() {
  if (running) return
  running = true
  last = performance.now()
  requestAnimationFrame(step)
}

/**
 * A keystroke. Adds brightness and a push, alternating direction so that typing
 * rocks the field instead of sliding it into a corner.
 *
 * Capped rather than accumulated without limit: holding a key down should not
 * be able to drive the field to white.
 */
export function nudge(strength = 1): void {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
  pushes += 1
  lift.target = Math.min(1, lift.target + 0.34 * strength)
  sway.target = Math.max(-1, Math.min(1, sway.target + (pushes % 2 ? 0.3 : -0.3) * strength))
  wake()
}

/**
 * A bigger event — a question sent, an answer arriving. Same spring, more of it,
 * so the field surges and settles instead of stepping to a new brightness.
 */
export function surge(strength = 1): void {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
  lift.target = Math.min(1.6, lift.target + 1.1 * strength)
  sway.velocity += (Math.random() < 0.5 ? -1 : 1) * 1.6 * strength
  wake()
}
