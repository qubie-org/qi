/**
 * The picture, big enough to actually see.
 *
 * Images in the river are sized to the type they sit in — a square one rides
 * the baseline at about the height of a capital letter, which is right for the
 * composition and useless for looking at. The float treatments are larger and
 * still small. Something has to bridge the gap between "a picture belongs in
 * this sentence" and "I would like to see the picture".
 *
 * Hover does it, because it costs nothing and commits to nothing. Click already
 * means something here — it opens the callout with the credit and the licence —
 * so enlarging on click would either take that gesture or make people choose
 * between two things they want at the same time.
 *
 * Three details keep it from becoming a nuisance:
 *
 *   a delay before it appears, so crossing a picture on the way somewhere else
 *   does not fire it;
 *
 *   a delay before it goes, so the pointer can travel between the picture and
 *   the card without it vanishing underneath;
 *
 *   and it is positioned, not merely offset. The card is measured against the
 *   window and flips to whichever side has room, because a preview that opens
 *   off-screen is worse than none.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export type Previewed = {
  src: string
  alt: string
  w?: number
  h?: number
}

/** Long enough to mean it; short enough not to feel like a wait. */
export const ENTER_DELAY = 140
export const LEAVE_DELAY = 90

const MAX_W = 420
const MAX_H = 340
const GAP = 12

type Placed = { left: number; top: number; width: number; height: number; from: string }

export function Preview({ anchor, image }: { anchor: HTMLElement; image: Previewed }) {
  const ref = useRef<HTMLDivElement>(null)
  const [placed, setPlaced] = useState<Placed | null>(null)

  useLayoutEffect(() => {
    const frame = ref.current?.offsetParent as HTMLElement | null
    if (!frame) return

    const measure = () => {
      const f = frame.getBoundingClientRect()
      const a = anchor.getBoundingClientRect()

      // The picture's own proportions decide the card's, so nothing is cropped
      // or stretched — the whole point is to see it as it is.
      const ratio = image.w && image.h ? image.w / image.h : 1
      let width = Math.min(MAX_W, window.innerWidth - 2 * GAP)
      let height = width / ratio
      if (height > MAX_H) {
        height = MAX_H
        width = height * ratio
      }

      // Above if there is room, below if not. Measured against the window
      // rather than the turn, because the turn scrolls and the window does not.
      const above = a.top - GAP - height >= GAP
      const top = above ? a.top - GAP - height : a.bottom + GAP
      // Centred on the picture, then pushed back inside the window.
      const wanted = a.left + a.width / 2 - width / 2
      const left = Math.max(GAP, Math.min(wanted, window.innerWidth - width - GAP))

      setPlaced({
        left: left - f.left,
        top: top - f.top,
        width,
        height,
        // Growing from the edge nearest the picture is what makes it read as
        // coming *out of* the picture rather than appearing beside it.
        from: above ? 'bottom center' : 'top center',
      })
    }

    measure()
    window.addEventListener('scroll', measure, { passive: true })
    window.addEventListener('resize', measure)
    return () => {
      window.removeEventListener('scroll', measure)
      window.removeEventListener('resize', measure)
    }
  }, [anchor, image])

  if (!placed) {
    // One frame with nothing painted, so the card never appears at 0,0 first.
    return <div ref={ref} className="preview preview--measuring" aria-hidden />
  }

  return (
    <div
      ref={ref}
      className="preview"
      aria-hidden
      style={{
        left: placed.left,
        top: placed.top,
        width: placed.width,
        height: placed.height,
        transformOrigin: placed.from,
      }}
    >
      <img className="preview-image" src={image.src} alt={image.alt} crossOrigin="anonymous" referrerPolicy="no-referrer" />
    </div>
  )
}

/**
 * Hover with hysteresis.
 *
 * Two timers rather than one: entering waits, leaving waits, and either cancels
 * the other. Without the leaving delay the card flickers whenever the pointer
 * crosses the gap between the picture and the card; without the entering one it
 * fires at every picture the pointer passes over on its way down the page.
 */
export function useHoverPreview() {
  const [shown, setShown] = useState<{ el: HTMLElement; image: Previewed } | null>(null)
  const timer = useRef<number | null>(null)

  const clear = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }

  useEffect(() => clear, [])

  return {
    shown,
    enter(el: HTMLElement, image: Previewed) {
      clear()
      // Nothing to enlarge if the picture is already being shown large — a
      // panorama across the measure gains nothing from a card in front of it.
      if (el.getBoundingClientRect().width >= MAX_W * 0.9) return
      timer.current = window.setTimeout(() => setShown({ el, image }), ENTER_DELAY)
    },
    leave() {
      clear()
      timer.current = window.setTimeout(() => setShown(null), LEAVE_DELAY)
    },
    hide() {
      clear()
      setShown(null)
    },
  }
}
