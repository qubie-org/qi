/**
 * `@` — what you already have.
 *
 * The other namespace resolves a name to something someone declared. This one
 * cannot, and that is the whole reason it is not a registry: "everything you
 * have ever written" is not a list to pick from, it is a query, and modelling
 * it as a third array of registered entries would have meant pretending
 * otherwise.
 *
 * So there is no `FINDS` to fill. The picker asks this, it reads the store, and
 * what comes back is shaped like an entry only so the same picker can draw it.
 *
 * ── Titles, not contents ────────────────────────────────────────────────────
 *
 * A match is on the title and on the opening of the body, not on everything
 * written. That is a deliberate limit rather than a missing feature: `@` is for
 * reaching a thing you know exists, and full-text search over every note would
 * return the ten places you mentioned a word when what you wanted was the one
 * note about it. Searching properly — meaning, not letters — is what `#` was
 * going to be and what the note app's own `nearest` already does with an
 * embedding, one keystroke inside the place where the results are useful.
 *
 * Nothing here is async beyond the two store reads, and both are indexed. A
 * picker that lags behind typing is worse than one that shows less.
 */
import { allDecks, allNotes, titleOf } from '../store/notes'
import type { Find } from './sigils'

/** Where a found thing lives, and what to press to get there. */
type Home = {
  /** The app that owns it, by id. */
  app: string
  /** The word shown under the title. */
  kind: string
  tone: number
}

const NOTE: Home = { app: 'note', kind: 'note', tone: 1 }
const DECK: Home = { app: 'deck', kind: 'deck', tone: 2 }

/**
 * How well a query matches a title.
 *
 * Three tiers rather than a score, because with a handful of results the
 * ordering people notice is "the one I typed the start of" ahead of "the one
 * that contains it somewhere". Anything subtler than that is invisible in a
 * list of five.
 */
function rank(title: string, body: string, query: string): number {
  const t = title.toLowerCase()
  const q = query.toLowerCase()
  if (!q) return 1
  if (t.startsWith(q)) return 3
  if (t.includes(q)) return 2
  if (body.slice(0, 400).toLowerCase().includes(q)) return 1
  return 0
}

/** How many results the picker shows. More than this is a list, not a hint. */
const MOST = 8

/**
 * Everything matching, best first.
 *
 * `open` is bound here rather than resolved by the caller, so a found thing
 * knows how to reach itself. It goes through `enter` on the owning app — the
 * same path `/note` and `/deck` take — which means opening a note from `@` and
 * opening it from its own explorer are one code path and cannot drift.
 */
export async function findAcross(query: string, enter: (app: string, id: string) => void): Promise<Find[]> {
  const [notes, decks] = await Promise.all([allNotes(), allDecks()])

  const rows = [
    ...notes.map((n) => ({ id: n.id, title: titleOf(n), body: n.body, home: NOTE, updated: n.updated })),
    ...decks.map((d) => ({ id: d.id, title: titleOf(d), body: d.body, home: DECK, updated: d.updated })),
  ]

  return rows
    .map((r) => ({ ...r, score: rank(r.title, r.body, query.trim()) }))
    .filter((r) => r.score > 0)
    // Score first, then most recently touched — which is the right tiebreak for
    // a store where the thing you want is usually the thing you just made.
    .sort((a, b) => b.score - a.score || b.updated - a.updated)
    .slice(0, MOST)
    .map((r) => ({
      sigil: '@' as const,
      id: r.id,
      name: r.title,
      needs: '',
      gives: r.home.kind,
      tone: r.home.tone,
      open: () => enter(r.home.app, r.id),
    }))
}
