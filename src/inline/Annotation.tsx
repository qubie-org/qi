/**
 * The aside: click a thing, and a note about it grows out of it on the next row.
 *
 * The pattern has a name in editorial design even if it has none in UI kits —
 * a *callout* joined to what it describes by a *leader*. Books put these in the
 * margin; a page this narrow has no margin, so it goes underneath and the
 * leader does the work the margin used to.
 *
 * Two decisions make it feel like part of the page rather than a widget:
 *
 *   it is a row, not a layer. No popover, no tooltip, nothing floating over
 *   the text. The note takes its own line and the turn grows to fit, so
 *   nothing is ever covered up and the reading order stays the reading order.
 *
 *   the leader is drawn, not implied. A line from the picture's corner to the
 *   note's first word says *this belongs to that* in a way proximity alone
 *   cannot, and it is the thing that stops a second note being ambiguous.
 *
 * The geometry is measured rather than guessed, because a floated image can sit
 * anywhere on the line and the note can wrap to any height. Both rects are read
 * relative to the turn, once per layout, and again whenever the turn resizes.
 */
import { useLayoutEffect, useRef, useState } from 'react'
import { sound } from '../engine/sound'

export type Aside = {
  /** What it is. Set in the note's own voice, not the answer's. */
  title: string
  /** A line or two. Attribution, provenance, dimensions — the small print. */
  body: string
  /** Where the thing actually lives, if anywhere. */
  href?: string
  /** Tone index, so the leader and the rule agree with the word they came from. */
  tone?: number
}

type Geometry = { path: string; top: number; left: number }

export function Callout({
  anchor,
  aside,
  onClose,
}: {
  anchor: HTMLElement
  aside: Aside
  onClose: () => void
}) {
  const noteRef = useRef<HTMLDivElement>(null)
  const [geo, setGeo] = useState<Geometry | null>(null)

  useLayoutEffect(() => {
    const note = noteRef.current
    // The turn is the positioning context; everything is measured against it so
    // that scrolling and page offset never enter into it.
    const frame = note?.offsetParent as HTMLElement | null
    if (!note || !frame) return

    const measure = () => {
      const f = frame.getBoundingClientRect()
      const a = anchor.getBoundingClientRect()
      const n = note.getBoundingClientRect()

      // From the bottom of the thing, to the top-left of the note. Both points
      // are on the same side of the turn as the anchor, so a picture floated
      // left gets a leader that leans left and one floated right leans right.
      const x1 = a.left - f.left + a.width / 2
      const y1 = a.bottom - f.top
      const x2 = n.left - f.left + 14
      const y2 = n.top - f.top

      // A single curve rather than an elbow: the control points pull the line
      // out and down, so it reads as drawn by hand rather than as a connector
      // in a diagram.
      const dip = Math.max(14, (y2 - y1) * 0.55)
      setGeo({
        path: `M ${x1} ${y1} C ${x1} ${y1 + dip}, ${x2} ${y2 - dip}, ${x2} ${y2}`,
        top: 0,
        left: 0,
      })
    }

    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(frame)
    ro.observe(note)
    return () => ro.disconnect()
  }, [anchor, aside])

  return (
    <>
      {geo && (
        <svg className="annot-leader" aria-hidden>
          <path className="annot-leader-line" d={geo.path} pathLength={1} />
        </svg>
      )}
      <div
        ref={noteRef}
        className="annot"
        style={aside.tone !== undefined ? ({ '--tone': `var(--t${(aside.tone % 4) + 1})` } as React.CSSProperties) : undefined}
      >
        <div className="annot-title">{aside.title}</div>
        <div className="annot-body">{aside.body}</div>
        <div className="annot-actions">
          {aside.href && (
            <a className="annot-open" href={aside.href} target="_blank" rel="noreferrer noopener">
              open
            </a>
          )}
          <button
            className="annot-close"
            onClick={() => {
              sound('close')
              onClose()
            }}
            type="button"
          >
            close
          </button>
        </div>
      </div>
    </>
  )
}
