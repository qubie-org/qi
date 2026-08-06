/**
 * Outcome: the one thing telemetry cannot observe by watching.
 *
 * Spans record what qi *did* — which model was called, which verb the agent
 * chose, how long it took, whether the tool found anything. What no span can
 * see is whether the reply was any good, because that is decided minutes later
 * by a person who either edits it, ignores it, or asks again.
 *
 * Five signals, and the distinction between them is the whole value:
 *
 *   kept        the reply stood. Weak positive — most replies are never touched.
 *   edited      the person rewrote it. Strong pair: their text is the target.
 *   abandoned   they left mid-answer. Negative, and the most honest one.
 *   retried     they asked the same thing again. Negative on the first reply.
 *   unsupported the hallucination adapter found a claim the documents did not
 *               support. Negative, and unlike the others it needs no human.
 *
 * That last one matters more than it looks: it is a negative label produced
 * on-device, at no cost to the person using it, by weights that are already
 * resident. It is the only one that scales.
 *
 * Each signal goes two places. A row in SQLite, because the app wants to know
 * what happened to its own replies. And a span, because the trace is what a
 * later version will train on — the corpus and the observability data are the
 * same data, and there is no second pipeline to keep honest.
 *
 * Nothing here trains anything. That is deliberately v2. What is not deferred
 * is collecting the signal correctly from the first turn, because a corpus
 * cannot be backfilled from conversations nobody recorded.
 */
import type { Store } from '../store/db'
import { note, QI } from './telemetry'

const SCHEMA = `
create table if not exists signal (
  id     integer primary key,
  turn   integer not null,
  kind   text    not null,
  detail text    not null default '',
  ts     integer not null
);
create index if not exists signal_turn on signal(turn);
`

export type SignalKind = 'kept' | 'edited' | 'abandoned' | 'retried' | 'unsupported'

let installed = false

/** Additive, and idempotent. The store owns its own tables; this owns one more. */
export function open(store: Store): void {
  if (installed) return
  store.exec(SCHEMA)
  installed = true
}

/**
 * Record what became of a reply.
 *
 * `detail` is the replacement text for an edit, the unsupported sentence for a
 * hallucination verdict, and empty otherwise. It is the training target when
 * there is one, which is why it is stored verbatim rather than summarised.
 */
export function mark(store: Store, turn: number, kind: SignalKind, detail = ''): void {
  open(store)
  store.exec('insert into signal (turn, kind, detail, ts) values (?, ?, ?, ?)', [
    turn,
    kind,
    detail,
    Date.now(),
  ])
  note('signal', {
    [QI.SIGNAL]: kind,
    'qi.turn': turn,
    // Truncated on the way out: a span is not the place to put a paragraph, and
    // the full text is in the row above if anything ever needs it.
    ...(detail ? { 'qi.signal.detail': detail.slice(0, 500) } : {}),
  })
}

/** What the corpus looks like so far — the number that decides when v2 is worth it. */
export function tally(store: Store): Record<SignalKind, number> {
  open(store)
  const rows = store.query<{ kind: SignalKind; n: number }>(
    'select kind, count(*) as n from signal group by kind',
  )
  const out = { kept: 0, edited: 0, abandoned: 0, retried: 0, unsupported: 0 }
  for (const r of rows) out[r.kind] = Number(r.n)
  return out
}
