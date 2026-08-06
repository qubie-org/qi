/**
 * The steps, as a row of badges.
 *
 * When the agent takes several moves to answer, the reader is otherwise
 * watching a page do nothing for eight seconds and then produce a sentence with
 * no account of where it came from. The badges are that account: one per tool
 * call, left to right in the order they happened, each naming what it was.
 *
 * They are deliberately small — `.62em`, the same step-down as lists and other
 * sub-content — because they are not the answer. The answer is the big text
 * underneath, and a step row that competes with it has misunderstood which is
 * which.
 *
 * The captions are written by the summariser, not by the code. `look` with the
 * argument "reykjavik weather" becomes "Weather Data Retrieval" because an 800M
 * model read the result and named it; the fallback when that model is missing
 * is the verb and its argument, which is honest but duller.
 *
 * Each badge takes its glyph and its colour from potion, through exactly the
 * path a word in the reply takes — the step's subject is embedded and matched
 * against the same motif bank and the same four anchors. A step about the ocean
 * carries the blue the sentence about the ocean will carry. The visual system
 * does not get a second, parallel set of rules for chrome.
 */
import { useEffect, useRef } from 'react'
import { animate, stagger } from 'animejs'
import type { StepEvent } from './loop'
import { explain, type Bank } from '../engine/place'
import { sound } from '../engine/sound'
import type { MotifKind } from '../inline/types'

export type Badge = StepEvent & { motif: MotifKind | null; tone: number }

/**
 * Colour by verb, glyph by meaning.
 *
 * The four verbs get the four anchors, fixed. This is the one place a colour is
 * assigned by category rather than by meaning, and it earns the exception by
 * being a legend: after two turns the reader knows blue is a lookup without
 * being told, which is what colour is for. Rotating these per conversation
 * would destroy the only thing that makes them readable.
 *
 * The glyph is not fixed. It comes from embedding the step's subject against
 * the same motif bank the reply's words are scored on, so a step about a
 * journey draws an arrow and a step about a place draws a dot — decided the
 * same way, by the same model, as everything else on the page.
 *
 * Async because `explain` is: a step's subject is usually a phrase nobody has
 * typed before, so it is nearly always a cache miss, and a badge can afford to
 * wait for its glyph in a way that a paint cannot.
 */
/**
 * Tone per verb, so a run of steps reads as a palette rather than a stripe.
 * Pack verbs are not listed and fall through to 0 — a colour they share with
 * `look`, which is the right family for anything that fetches.
 */
const TONE: Record<string, number> = { look: 0, do: 1, open: 2, recall: 3 }

export async function badgeFor(e: StepEvent, bank: Bank): Promise<Badge> {
  const hits = e.subject ? await explain(e.subject, bank) : []
  const best = hits[0]
  return {
    ...e,
    motif: best && best.score >= bank.threshold ? best.kind : null,
    tone: TONE[e.kind] ?? 0,
  }
}

/** The glyph for a step, drawn the same way the inline motifs are. */
function Glyph({ kind, tone }: { kind: MotifKind | null; tone: number }) {
  const stroke = `var(--t${tone + 1})`
  if (!kind) return null
  return (
    <svg className="badge-glyph" viewBox="0 0 12 12" aria-hidden>
      {kind === 'dot' && <circle cx="6" cy="6" r="3.2" fill={stroke} />}
      {kind === 'shapes' && <rect x="2.6" y="2.6" width="6.8" height="6.8" rx="1.4" fill={stroke} />}
      {kind === 'arrow' && (
        <path d="M2 6h7M6.4 3.2 9.4 6l-3 2.8" fill="none" stroke={stroke} strokeWidth="1.6" strokeLinecap="round" />
      )}
      {kind === 'curve' && (
        <path d="M2 8c2-5 6-5 8 0" fill="none" stroke={stroke} strokeWidth="1.6" strokeLinecap="round" />
      )}
    </svg>
  )
}

export function Steps({ badges, status }: { badges: Badge[]; status: string | null }) {
  const row = useRef<HTMLDivElement>(null)
  const seen = useRef(0)

  // Only badges that have not been animated yet: re-running the entrance on
  // every render would restart the row each time a step resolves.
  useEffect(() => {
    const el = row.current
    if (!el) return
    const items = Array.from(el.querySelectorAll<HTMLElement>('.badge')).slice(seen.current)
    if (!items.length) return
    seen.current += items.length
    // One tick per badge that actually just arrived, staggered with it.
    items.forEach((_, i) => window.setTimeout(() => sound('step'), i * 45))
    animate(items, {
      opacity: [0, 1],
      translateY: [6, 0],
      scale: [0.94, 1],
      duration: 260,
      delay: stagger(45),
      ease: 'outCubic',
    })
  }, [badges.length])

  if (!badges.length && !status) return null

  return (
    <div className="steps" ref={row}>
      <div className="steps-row">
        {badges.map((b) => (
          <span key={b.id} className={`badge badge-${b.state}`} title={b.note?.subTitle || b.subject}>
            <Glyph kind={b.motif} tone={b.tone} />
            <span className="badge-text">{b.note?.title ?? b.subject ?? b.kind}</span>
          </span>
        ))}
      </div>
      {/* First person, present tense, written by the summariser from what
          actually happened — "I'm checking the fetched weather details" rather
          than a spinner. This is the line that makes a multi-step turn read as
          a continuation instead of a hang. */}
      {status && <div className="steps-status">{status}</div>}
    </div>
  )
}
