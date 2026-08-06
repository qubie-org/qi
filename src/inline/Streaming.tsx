/**
 * Words arriving one at a time.
 *
 * The naive version re-renders the whole string on every token, so every word
 * re-animates on every frame and the line strobes. The fix is stable keys: each
 * word is keyed by its position, so React mounts only the words that are
 * actually new and CSS animates them exactly once on mount.
 *
 * Deliberately not the full `River`. Marks, glyphs and emoji are placed by
 * `place()` once the reply has settled — running placement per token would make
 * decorations appear, move and vanish as the sentence grows, which reads as
 * malfunction rather than as thinking.
 */
export function Streaming({ text }: { text: string }) {
  // Split on whitespace but keep it, so spacing survives without a wrapper.
  const parts = text.split(/(\s+)/).filter((p) => p !== '')

  return (
    <p className="river river--live">
      {parts.map((part, i) =>
        /^\s+$/.test(part) ? (
          <span key={i}>{part}</span>
        ) : (
          <span key={i} className="i-word">
            {part}
          </span>
        ),
      )}
      <span className="i-caret" aria-hidden />
    </p>
  )
}
