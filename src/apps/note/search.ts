/**
 * Finding a note, and the case for not being clever about it.
 *
 * qi has an embedder to hand and it would be easy to make this the showcase for
 * it. That would be the wrong call, and the reason is worth writing down
 * because the temptation recurs.
 *
 * Cosine similarity always returns something. Ask a handful of notes about
 * "tax" and the nearest one comes back ranked first whether or not any of them
 * has anything to do with tax — the ranking is total, so an empty result set is
 * not something it can express. At three notes that is not search, it is a
 * shuffle with a confident face. Substring matching has the property that
 * matters more than recall at this scale: when it finds nothing, nothing is
 * what it says, and when it finds something it can point at the characters that
 * matched, which is what lets a result carry a highlighted snippet instead of a
 * score nobody can check.
 *
 * It is also synchronous. Literal search runs on every keystroke with no
 * debounce, no await and no stale-response race, because it is a scan over a
 * few hundred short strings — microseconds. `embed` costs ~8 ms per distinct
 * string and has to be awaited, so putting it on the typing path buys a
 * spinner and a class of bug where the results belong to a query you have
 * already finished editing.
 *
 * So meaning is a *fallback*, and it only earns its place where the literal
 * answer genuinely has none: the query found zero notes by its words. Then, and
 * only then, the app embeds the query and offers the nearest notes above a
 * floor — shown under a different heading, because "nothing matched those words,
 * these are the closest by meaning" is a different claim from "here are your
 * matches" and must not be allowed to look like one. Above the floor there is
 * usually nothing, and saying so is the correct answer.
 *
 * The floor is 0.35. `model/vectors.ts` recentres every vector against the
 * middle of the language, and its own measurements after recentring put
 * unrelated pairs at a median of -0.011 and a 95th percentile of 0.150, with
 * genuinely related pairs at 0.49–0.78. 0.35 sits well above the noise and well
 * below the signal; it is not tuned, it is read off the numbers that file
 * already establishes.
 *
 * Nothing here imports the embedder. `nearest` takes a vector and does the dot
 * product itself, so this whole file is pure, testable under bun without a DOM,
 * and cannot drag the model stack into a unit test.
 */
import { titleOf, type Note } from '../../store/notes'

export type Hit = {
  note: Note
  title: string
  /** A window of the body around the match, for the index to show. */
  snippet: string
  /** Character range of the match *within the snippet*, so it can be marked. */
  mark: [number, number] | null
  score: number
}

const SNIPPET = 96

/**
 * Everything after the line the title came from.
 *
 * A row already shows the title, so a snippet that opens with it says the same
 * thing twice and spends the only line available for distinguishing this note
 * on a word already directly above. Only applied when there is no match to
 * centre on — when there is, where the match actually falls matters more than
 * tidiness, and cutting the first line could cut the thing being shown.
 */
function afterTitle(body: string): string {
  const lines = body.split('\n')
  const first = lines.findIndex((l) => l.trim())
  return first === -1 ? '' : lines.slice(first + 1).join('\n')
}

/**
 * A window of body text around a match.
 *
 * Cut on word boundaries where there are any within reach, because a snippet
 * that starts mid-word reads as a rendering fault rather than as an excerpt.
 * Newlines collapse: the index is a list, and a snippet that brings its own
 * line breaks would make each row a different height.
 */
function excerpt(body: string, at: number, length: number): { snippet: string; mark: [number, number] | null } {
  if (at < 0) {
    const rest = afterTitle(body).replace(/\s+/g, ' ').trim()
    return { snippet: rest.length > SNIPPET ? `${rest.slice(0, SNIPPET)}…` : rest, mark: null }
  }
  const flat = body.replace(/\s+/g, ' ').trim()

  // The match moved when whitespace collapsed, so it is located again in the
  // flattened text rather than having its old offset carried over — that offset
  // was correct for a string that no longer exists.
  const needle = body.slice(at, at + length).replace(/\s+/g, ' ').trim()
  const found = flat.toLowerCase().indexOf(needle.toLowerCase())
  if (found < 0) return { snippet: flat.slice(0, SNIPPET), mark: null }

  let start = Math.max(0, found - Math.floor((SNIPPET - needle.length) / 2))
  if (start > 0) {
    const space = flat.indexOf(' ', start)
    if (space >= 0 && space < start + 12) start = space + 1
  }
  const cut = flat.slice(start, start + SNIPPET)
  const lead = start > 0 ? '…' : ''
  const tail = start + SNIPPET < flat.length ? '…' : ''
  return {
    snippet: `${lead}${cut}${tail}`,
    mark: [lead.length + (found - start), lead.length + (found - start) + needle.length],
  }
}

/**
 * Literal search. Case-insensitive substring, and that is the whole algorithm.
 *
 * Ranking has three tiers and no tuning: a title that starts with the query,
 * then a title that contains it, then a body that contains it. Within a tier,
 * most recently touched first — which is the ordering the index already uses,
 * so a search that matches everything degrades gracefully into the plain list
 * rather than reshuffling it into an unfamiliar order.
 */
export function literal(notes: Note[], query: string): Hit[] {
  const q = query.trim().toLowerCase()
  if (!q) {
    return notes.map((note) => ({
      note,
      title: titleOf(note),
      ...excerpt(note.body, -1, 0),
      score: 0,
    }))
  }

  const out: Hit[] = []
  for (const note of notes) {
    const title = titleOf(note)
    const inTitle = title.toLowerCase().indexOf(q)
    const inBody = note.body.toLowerCase().indexOf(q)
    if (inTitle < 0 && inBody < 0) continue

    // A title hit still shows a body excerpt when there is one, because the
    // title is already on the row and repeating it as the snippet wastes the
    // only line available for saying which note this is.
    const at = inBody >= 0 ? inBody : -1
    out.push({
      note,
      title,
      ...excerpt(note.body, at, q.length),
      score: inTitle === 0 ? 3 : inTitle > 0 ? 2 : 1,
    })
  }

  return out.sort((a, b) => b.score - a.score || b.note.updated - a.note.updated)
}

/**
 * The fallback. Nearest notes to a query vector, above the noise floor.
 *
 * Vectors are unit length coming out of `embed`, so the dot product is the
 * cosine and there is nothing to normalise. Notes saved before an embedder was
 * available have no vector and are skipped rather than scored as zero — an
 * absent opinion is not the opinion that something is unrelated.
 */
export const FLOOR = 0.35

export function nearest(notes: Note[], query: Float32Array, k = 5, floor = FLOOR): Hit[] {
  const out: Hit[] = []
  for (const note of notes) {
    if (!note.vec) continue
    let d = 0
    const n = Math.min(note.vec.length, query.length)
    for (let i = 0; i < n; i++) d += note.vec[i] * query[i]
    if (d < floor) continue
    out.push({ note, title: titleOf(note), ...excerpt(note.body, -1, 0), score: d })
  }
  return out.sort((a, b) => b.score - a.score).slice(0, k)
}

/**
 * What a note is embedded *as*.
 *
 * Title plus the opening of the body. The whole body would be worse, not
 * better: the encoder truncates anyway, and averaging a thousand words of
 * meeting notes produces a vector that sits in the dead centre of the language
 * and is therefore close to every query and useful for none.
 */
export const embeddableText = (note: { title: string | null; body: string }): string =>
  `${titleOf(note)} ${note.body.slice(0, 400)}`.trim()
