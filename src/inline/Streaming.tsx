/**
 * Words arriving one at a time, decorating themselves as they land.
 *
 * The naive version re-renders the whole string on every token, so every word
 * re-animates on every frame and the line strobes. The fix is stable keys: each
 * word is keyed by its position, so React mounts only the words that are
 * actually new and CSS animates them exactly once on mount.
 *
 * This used to render plain text and leave every glyph, mark and colour to
 * `place()` once the reply had settled, on the grounds that placement per token
 * would make decorations appear, move and vanish as the sentence grew — which
 * reads as malfunction rather than as thinking. That objection was right about
 * the symptom and wrong about the cause. Decorations flickered because
 * placement is a *global* decision: a density budget and a ranking over the
 * whole sentence, both of which change with every word that arrives.
 *
 * So the streaming view does not run placement. It asks a different question,
 * one word at a time — does this word, by itself, earn a mark? — and then never
 * takes the answer back. `decided` only ever gains entries. A word that has
 * been given a glyph keeps it for the rest of the stream, so nothing moves and
 * nothing vanishes; the design accumulates instead of being redrawn.
 *
 * Two details make it settle honestly rather than jump at the end:
 *
 *  - A word whose vector is still cold gets nothing this pass and asks for it.
 *    One token later the vector is warm and the word decorates itself. The
 *    first sentence of a conversation therefore decorates a beat behind, and
 *    every one after it is immediate.
 *  - The pacing budget grows with the text, so a long reply accumulates more
 *    marks than a short one without any word losing what it already had.
 */
import { useRef } from 'react'
import { markFor, STOP, type Bank, type WordMark } from '../engine/place'
import type { EmojiBank } from '../engine/emoji'
import { liveSpans } from './live'

/** Roughly one mark per this many content words, same feel as `place`. */
const PER_WORDS = 6

export function Streaming({
  text,
  bank,
  emoji,
}: {
  text: string
  bank?: Bank
  emoji?: EmojiBank | null
}) {
  // Keyed by word index, which is stable for the life of one stream: tokens are
  // appended, never rewritten, so index 3 is the same word it was.
  const decided = useRef(new Map<number, WordMark>())
  const spent = useRef(0)

  // Markup is resolved before anything is split, so no asterisk, backtick or
  // URL ever reaches the page — see `live.ts`. Each word carries the style of
  // the span it came from.
  const spans = liveSpans(text)
  const parts: { t: string; kind: string; pending?: boolean }[] = []
  for (const span of spans) {
    for (const piece of span.text.split(/(\s+)/)) {
      if (piece !== '') parts.push({ t: piece, kind: span.kind, pending: span.pending })
    }
  }

  if (bank) {
    let seen = 0
    parts.forEach(({ t: part }, i) => {
      if (/^\s+$/.test(part)) return
      seen++
      if (decided.current.has(i)) return
      // The last word is still being typed — deciding on a prefix would give
      // "oce" a mark that "ocean" would not have earned, and the rule is that a
      // decision is never taken back.
      if (i >= parts.length - 1) return
      if (spent.current >= Math.max(1, Math.round(seen / PER_WORDS))) return

      const clean = part.toLowerCase().replace(/[^a-z'-]/g, '')
      if (clean.length < 4 || STOP.has(clean)) return

      const mark = markFor(clean, bank, emoji ?? null)
      if (!mark) return
      decided.current.set(i, mark)
      if (mark.emoji) spent.current++
    })
  }

  return (
    <p className="river river--live">
      {parts.map(({ t: part, kind }, i) => {
        if (/^\s+$/.test(part)) return <span key={i}>{part}</span>
        const mark = decided.current.get(i)
        // The same markup `Render` produces for a settled turn, so a word does
        // not change shape when the stream ends and the real tree replaces it.
        const styled = kind === 'strong' ? 'i-strong' : kind === 'em' ? 'i-em' : kind === 'code' ? 'i-code' : ''
        return (
          <span key={i} className={`i-word${styled ? ` ${styled}` : ''}`}>
            {part}
            {mark?.emoji && (
              <span className="i-emoji" role="img" aria-label={mark.emoji.label}>
                {mark.emoji.glyph}
              </span>
            )}
          </span>
        )
      })}
      <span className="i-caret" aria-hidden />
    </p>
  )
}
