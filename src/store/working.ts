/**
 * The working set: everything the model is allowed to know at this moment.
 *
 * This is the guard rail on context. A transcript answers "what has happened",
 * which is the wrong question — the model needs "what is true, what am I doing,
 * and how far in am I". Those three things are almost always under 400
 * characters, however long the conversation has run, so that is the budget.
 *
 * It is rebuilt before every step rather than appended to. Rebuilding means a
 * fact that stopped being relevant simply stops being retrieved, which is the
 * one thing an append-only context can never do.
 *
 * The section order is deliberate. Small models weight the beginning and the
 * end of a prompt far more than the middle, so the two things most likely to be
 * needed — what we are talking about, and what just happened — sit at the
 * edges, and the retrieved detail sits between them.
 */
import type { Store } from './db'

/** Whole-set ceiling. Past this the model starts hedging instead of answering. */
const BUDGET = 420
const FACTS = 4

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`)

export type WorkingSet = {
  /** The block handed to the model, or '' when there is nothing worth saying. */
  text: string
  /** Which facts were retrieved, so the caller can cite or link them. */
  keys: string[]
}

/**
 * Render the working set for a query.
 *
 * `query` is the potion embedding of what the user just said — the same vector
 * the theme and motif engines are given. Memory is therefore retrieved against
 * exactly the notion of "what this is about" that the page is already styling
 * itself around, so what the model recalls and what the reader sees drift
 * together rather than apart.
 */
export function workingSet(store: Store, query: Float32Array): WorkingSet {
  const lines: string[] = []
  const keys: string[] = []

  const topic = store.note('topic')
  if (topic) lines.push(`about: ${clip(topic, 150)}`)

  const hits = store.recall(query, FACTS)
  const facts = hits.filter((h) => h.kind === 'fact')
  const notes = hits.filter((h) => h.kind === 'note' && h.text !== topic)

  if (facts.length) {
    lines.push('known:')
    for (const f of facts) {
      lines.push(`  ${clip(f.text, 90)}`)
      if (f.key) keys.push(f.key)
    }
  }
  // A recalled note is an earlier conclusion. Worth one line, never more —
  // summaries of summaries are how a context quietly fills with its own echo.
  if (notes.length) lines.push(`earlier: ${clip(notes[0].text, 110)}`)

  const steps = store.stepsFor()
  if (steps.length) {
    // Only what has already resolved. A step still running has no result to
    // reason about, and naming it invites the model to pretend it has one.
    const done = steps.filter((s) => s.state === 'done')
    if (done.length) {
      lines.push(`done: ${clip(done.map((s) => `${s.kind} ${s.arg}`.trim()).join(' · '), 120)}`)
      // The most recent result in full, because it is what the next decision
      // actually turns on. Everything before it has been compressed to a verb.
      const last = done[done.length - 1]
      if (last.digest) lines.push(`latest: ${clip(last.digest, 160)}`)
    }
  }

  let text = lines.join('\n')
  // Trim from the middle out: drop retrieved detail before dropping the topic
  // line or the latest result, since those are the two that carry continuity.
  while (text.length > BUDGET && lines.length > 2) {
    const cut = lines.findIndex((l) => l.startsWith('  ') || l.startsWith('earlier:'))
    if (cut < 0) break
    lines.splice(cut, 1)
    text = lines.join('\n')
  }

  return { text: clip(text, BUDGET), keys }
}
