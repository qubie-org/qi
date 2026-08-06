/**
 * Reading half-written markup.
 *
 * A settled turn goes through `parse()`, which sees the whole reply and can be
 * sure what every marker meant. A stream cannot: at the moment `**Ice` has
 * arrived, nobody knows whether those asterisks open a bold span or are two
 * literal characters, and the only way to find out is to wait.
 *
 * The old streaming view did not wait — it printed the raw text, so every
 * answer briefly showed its own source. Asterisks, brackets and backticks
 * appeared, sat there, and were replaced by formatting when the stream ended.
 * That is the app showing its working, and it undoes the one thing the river is
 * for, which is that text arrives already looking like itself.
 *
 * So this splits the stream in two at the last point where the markup is
 * unambiguous:
 *
 *   settled   everything up to the last closed marker, which can be styled
 *             now and will never be re-interpreted
 *   pending   the tail after it, which is printed as plain text with any
 *             opening marker withheld
 *
 * Withheld, not hidden: the characters of an unclosed marker are dropped from
 * the output entirely, and the words after it are shown unstyled. So `**Ice`
 * renders as "Ice", and one token later, when the closer lands, the same word
 * becomes bold in place. Nothing appears that later has to be taken away — the
 * text only ever gains formatting, which is the same rule the streaming marks
 * already follow.
 */

export type Span = {
  text: string
  kind: 'plain' | 'strong' | 'em' | 'code'
  /** True while this span's markup is still open, so it renders unstyled. */
  pending?: boolean
}

/**
 * Markers, longest first.
 *
 * Order matters: `**` has to be tested before `*`, or every bold opener is read
 * as an italic one and the second asterisk starts a new span.
 */
const MARKERS: { open: string; kind: Span['kind'] }[] = [
  { open: '**', kind: 'strong' },
  { open: '__', kind: 'strong' },
  { open: '`', kind: 'code' },
  { open: '*', kind: 'em' },
  { open: '_', kind: 'em' },
]

/** `[text](url)` and `![alt](src)` — the link body is what a reader wants. */
const LINK = /!?\[([^\]]*)\]\(([^)]*)\)/

/**
 * Turn the text so far into spans that are safe to render.
 *
 * Cheap by construction — one pass, no allocation per character — because this
 * runs on every token of every answer.
 */
export function liveSpans(text: string): Span[] {
  const out: Span[] = []
  let rest = text

  const push = (t: string, kind: Span['kind'], pending?: boolean) => {
    if (!t) return
    const last = out[out.length - 1]
    // Merge touching plain spans so React sees a stable, short list rather than
    // one span per token.
    if (last && last.kind === kind && !last.pending && !pending) last.text += t
    else out.push(pending ? { text: t, kind, pending } : { text: t, kind })
  }

  while (rest) {
    // A complete link anywhere ahead is resolved before markers, so the URL
    // never reaches the page even briefly.
    const link = LINK.exec(rest)
    const marker = firstMarker(rest)

    if (link && (!marker || link.index < marker.at)) {
      push(rest.slice(0, link.index), 'plain')
      // Images contribute nothing readable mid-stream; their alt text is a
      // description of something not on screen yet, so it is dropped.
      if (!link[0].startsWith('!')) push(link[1], 'plain')
      rest = rest.slice(link.index + link[0].length)
      continue
    }

    // An unterminated link is resolved before any marker, not after.
    //
    // A URL is full of characters that mean formatting in prose — this leaked
    // when an underscore inside a half-typed `example.com/a_b` was read as an
    // italic opener, which made everything before it a plain span and put the
    // raw URL on screen. Inside an unclosed link there is no markup, only a
    // URL, so the link has to win wherever it starts first.
    const bracket = rest.indexOf('[')
    const dangling = bracket >= 0 && !rest.slice(bracket).includes(')')
    if (dangling && (!marker || marker.at > bracket)) {
      const cut = bracket > 0 && rest[bracket - 1] === '!' ? bracket - 1 : bracket
      push(rest.slice(0, cut), 'plain')
      // Cut back to the body, not just past the bracket: with `[the map](h`
      // on screen, dropping only the `[` still leaves `the map](h`.
      const tail = rest.slice(bracket + 1)
      const bodyEnd = tail.indexOf(']')
      push(hold(bodyEnd === -1 ? tail : tail.slice(0, bodyEnd)), 'plain', true)
      break
    }

    if (!marker) {
      push(rest, 'plain')
      break
    }

    push(rest.slice(0, marker.at), 'plain')
    const after = rest.slice(marker.at + marker.open.length)
    const close = after.indexOf(marker.open)

    if (close === -1) {
      // Still open. Drop the marker, show what follows as plain, and let the
      // next token decide what it was.
      push(hold(after), 'plain', true)
      break
    }

    push(after.slice(0, close), marker.kind)
    rest = after.slice(close + marker.open.length)
  }

  return out
}

/**
 * Trim a marker that is itself half-arrived.
 *
 * A closing `**` reaches the page one asterisk at a time, so there is always a
 * moment where the text ends in a single `*` that is not punctuation and not
 * yet a closer. Printing it is exactly the leak this file exists to prevent —
 * caught by feeding a sentence in prefix by prefix and finding a stray asterisk
 * at character 41 of 129.
 */
const hold = (t: string): string => t.replace(/[*_`[\]!]+$/, '')

function firstMarker(s: string): { at: number; open: string; kind: Span['kind'] } | null {
  let best: { at: number; open: string; kind: Span['kind'] } | null = null
  for (const m of MARKERS) {
    const at = s.indexOf(m.open)
    if (at === -1) continue
    // Earliest wins; on a tie the longer marker wins, which is what keeps `**`
    // from being read as `*`.
    if (!best || at < best.at || (at === best.at && m.open.length > best.open.length)) {
      best = { at, open: m.open, kind: m.kind }
    }
  }
  return best
}
