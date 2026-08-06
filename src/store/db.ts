/**
 * What qi remembers.
 *
 * The talker's context was being *accumulated*: a transcript that grew every
 * turn, plus a fact dump re-injected as a system message each time. That grows
 * without bound and, worse, buries the two or three lines that actually matter
 * under everything that once mattered. A 4B model does not fail at long
 * context so much as it fails at deciding what in the context is load-bearing —
 * so the fix is not a bigger window, it is a smaller and better-chosen one.
 *
 * Everything said, found and done is written here instead. Each step of a turn
 * then *rebuilds* a working set from it — a topic line, a few retrieved facts,
 * the open task, the steps so far — so what reaches the model is O(1) in the
 * length of the conversation rather than O(n). See `working.ts` for the
 * rendering; this file is only the memory.
 *
 * Retrieval is by embedding rather than recency, and the embeddings are the
 * ones potion already computes for motifs and colour. Nothing new is loaded to
 * make memory work; the same 7.85 MB table that decides a word is important
 * also decides a fact is relevant.
 *
 * SQLite rather than IndexedDB because the queries here are relational — steps
 * belong to tasks, notes scope to tasks, facts are addressable by key — and
 * because the page is already cross-origin isolated for Wasmer, which is what
 * the OPFS backend needs.
 */
import sqlite3InitModule, { type Database, type Sqlite3Static } from '@sqlite.org/sqlite-wasm'

export type Role = 'user' | 'agent'
export type StepState = 'running' | 'done' | 'failed'

export type StoredFact = {
  key: string
  label: string
  value: string
  unit?: string
  src?: string
  url?: string
  asOf?: string
}

export type Step = {
  id: number
  task: number
  seq: number
  kind: string
  arg: string
  digest: string
  state: StepState
  ms: number
}

export type Recalled = { kind: 'fact' | 'note' | 'turn'; text: string; score: number; key?: string }

const SCHEMA = `
create table if not exists turn (
  id    integer primary key,
  role  text    not null,
  text  text    not null,
  ts    integer not null,
  task  integer,
  vec   blob
);
create table if not exists fact (
  id    integer primary key,
  key   text    not null unique,
  label text    not null,
  value text    not null,
  unit  text,
  src   text,
  url   text,
  asof  text,
  ts    integer not null,
  vec   blob
);
create table if not exists task (
  id     integer primary key,
  title  text    not null,
  state  text    not null default 'open',
  opened integer not null,
  closed integer
);
create table if not exists step (
  id     integer primary key,
  task   integer not null,
  seq    integer not null,
  kind   text    not null,
  arg    text    not null default '',
  digest text    not null default '',
  state  text    not null default 'running',
  ms     integer not null default 0
);
create table if not exists note (
  id    integer primary key,
  scope text    not null,
  ref   integer,
  text  text    not null,
  ts    integer not null,
  vec   blob
);
create index if not exists step_task on step(task, seq);
create index if not exists note_scope on note(scope, ref);
`

/** Float32Array in, bytes out — SQLite has no vector type and needs none. */
const toBlob = (v: Float32Array) => new Uint8Array(v.buffer.slice(0) as ArrayBuffer)
const fromBlob = (b: Uint8Array | null) =>
  b ? new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)) : null

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) s += a[i] * b[i]
  return s
}

export class Store {
  private db: Database
  /** The task a turn is currently working under, if any. */
  task: number | null = null

  constructor(db: Database) {
    this.db = db
    this.db.exec(SCHEMA)
  }

  // sqlite-wasm's exec() overloads are written for literal argument objects and
  // do not survive being wrapped in a generic helper, so the call is made
  // through a loosened view of the handle. The shape passed is the documented
  // one; only the type-level narrowing is being stepped around.
  private get raw() {
    return this.db as unknown as {
      exec(o: Record<string, unknown>): unknown
      selectValue(sql: string, bind?: unknown[]): unknown
    }
  }

  private rows<T = Record<string, unknown>>(sql: string, bind: unknown[] = []): T[] {
    return (this.raw.exec({ sql, bind, rowMode: 'object', returnValue: 'resultRows' }) ?? []) as T[]
  }

  private run(sql: string, bind: unknown[] = []): number {
    this.raw.exec({ sql, bind })
    return Number(this.raw.selectValue('select last_insert_rowid()'))
  }

  /**
   * The escape hatch, for tables this class does not own.
   *
   * Everything above is a named operation because the conversation's shape is
   * this file's business. The harvest lane's is not — it adds its own table and
   * its own queries alongside, and giving it these two methods is cheaper than
   * growing this class every time something wants to remember something new.
   */
  query<T = Record<string, unknown>>(sql: string, bind: unknown[] = []): T[] {
    return this.rows<T>(sql, bind)
  }

  exec(sql: string, bind: unknown[] = []): number {
    return this.run(sql, bind)
  }

  // ── what was said ───────────────────────────────────────────────────────

  addTurn(role: Role, text: string, vec?: Float32Array): number {
    return this.run('insert into turn (role, text, ts, task, vec) values (?,?,?,?,?)', [
      role,
      text,
      Date.now(),
      this.task,
      vec ? toBlob(vec) : null,
    ])
  }

  /**
   * The last few turns, verbatim.
   *
   * Verbatim matters: what the model was shown of its own last reply used to be
   * the *displayed* text, which is trimmed to whole sentences under a word
   * limit. Feeding that back taught it that its previous answer stopped where
   * the trimmer stopped it, which is a good way to make a model lose the thread.
   */
  recentTurns(n = 4): { role: Role; text: string }[] {
    return this.rows<{ role: Role; text: string }>(
      'select role, text from turn order by id desc limit ?',
      [n],
    ).reverse()
  }

  // ── what was found ──────────────────────────────────────────────────────

  /** Facts are keyed, so asking the same thing twice updates rather than piles up. */
  putFact(f: StoredFact, vec?: Float32Array): void {
    this.run(
      `insert into fact (key, label, value, unit, src, url, asof, ts, vec) values (?,?,?,?,?,?,?,?,?)
       on conflict(key) do update set value=excluded.value, asof=excluded.asof, ts=excluded.ts`,
      [f.key, f.label, f.value, f.unit ?? null, f.src ?? null, f.url ?? null, f.asOf ?? null, Date.now(), vec ? toBlob(vec) : null],
    )
  }

  factByKey(key: string): StoredFact | null {
    const r = this.rows<StoredFact & { asof: string }>('select * from fact where key = ?', [key])[0]
    return r ? { ...r, asOf: r.asof } : null
  }

  // ── what was done ───────────────────────────────────────────────────────

  openTask(title: string): number {
    const id = this.run('insert into task (title, state, opened) values (?, ?, ?)', [title, 'open', Date.now()])
    this.task = id
    return id
  }

  closeTask(id = this.task, state: 'done' | 'failed' = 'done'): void {
    if (id == null) return
    this.run('update task set state = ?, closed = ? where id = ?', [state, Date.now(), id])
    if (this.task === id) this.task = null
  }

  addStep(kind: string, arg: string, task = this.task): number {
    if (task == null) return -1
    const seq = Number(this.raw.selectValue('select coalesce(max(seq), 0) + 1 from step where task = ?', [task]))
    return this.run('insert into step (task, seq, kind, arg) values (?,?,?,?)', [task, seq, kind, arg])
  }

  finishStep(id: number, digest: string, ms: number, state: StepState = 'done'): void {
    if (id < 0) return
    this.run('update step set digest = ?, ms = ?, state = ? where id = ?', [digest, ms, state, id])
  }

  stepsFor(task = this.task): Step[] {
    if (task == null) return []
    return this.rows<Step>('select * from step where task = ? order by seq', [task])
  }

  // ── what it amounts to ──────────────────────────────────────────────────

  /**
   * A note is a summary. There is exactly one per scope+ref, rewritten in
   * place, because a conversation has one topic at a time and keeping the old
   * ones would recreate the transcript this whole file exists to avoid.
   */
  putNote(scope: 'topic' | 'task', text: string, ref: number | null = null, vec?: Float32Array): void {
    this.run('delete from note where scope = ? and ifnull(ref, -1) = ifnull(?, -1)', [scope, ref])
    this.run('insert into note (scope, ref, text, ts, vec) values (?,?,?,?,?)', [
      scope,
      ref,
      text,
      Date.now(),
      vec ? toBlob(vec) : null,
    ])
  }

  note(scope: 'topic' | 'task', ref: number | null = null): string | null {
    const r = this.rows<{ text: string }>(
      'select text from note where scope = ? and ifnull(ref, -1) = ifnull(?, -1) limit 1',
      [scope, ref],
    )[0]
    return r?.text ?? null
  }

  // ── getting it back ─────────────────────────────────────────────────────

  /**
   * Nearest facts and notes to a query vector.
   *
   * Brute force on purpose. potion vectors are 256-dim and a conversation
   * accumulates hundreds of rows, not millions, so the whole scan is well under
   * a millisecond — an index would cost more to maintain than it saves, and
   * would be one more thing that can be subtly wrong.
   *
   * Vectors are unit-normalised by `embed`, so the dot product is the cosine.
   */
  recall(query: Float32Array, k = 4, floor = 0.28): Recalled[] {
    const out: Recalled[] = []

    for (const r of this.rows<{ key: string; label: string; value: string; unit: string | null; vec: Uint8Array | null }>(
      'select key, label, value, unit, vec from fact',
    )) {
      const v = fromBlob(r.vec)
      if (!v) continue
      out.push({
        kind: 'fact',
        key: r.key,
        text: `${r.label}: ${r.value}${r.unit ? ` ${r.unit}` : ''}`,
        score: dot(query, v),
      })
    }

    for (const r of this.rows<{ text: string; vec: Uint8Array | null }>('select text, vec from note')) {
      const v = fromBlob(r.vec)
      if (v) out.push({ kind: 'note', text: r.text, score: dot(query, v) })
    }

    return out
      .filter((r) => r.score >= floor)
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
  }
}

let booting: Promise<Store> | null = null

/**
 * Open the store, preferring OPFS so a conversation survives a reload.
 *
 * The SAH-pool VFS is used rather than the plain OPFS one because it is the
 * variant that works on the main thread; the other needs a dedicated worker.
 * If persistence is unavailable — private windows, older browsers — memory is
 * a complete fallback, since nothing here is the source of truth for anything
 * outside the page.
 */
export function openStore(): Promise<Store> {
  booting ??= (async () => {
    // The published types declare the initialiser as taking nothing, but it
    // accepts the Emscripten module config and this is the only way to stop it
    // logging its banner to the console on every load.
    const init = sqlite3InitModule as (cfg?: Record<string, unknown>) => Promise<Sqlite3Static>
    const sqlite3 = await init({ print: () => {}, printErr: console.warn })
    try {
      const pool = await sqlite3.installOpfsSAHPoolVfs({ name: 'qi' })
      return new Store(new pool.OpfsSAHPoolDb('/qi.sqlite3'))
    } catch (err) {
      console.warn('store: no OPFS, memory only', err)
      return new Store(new sqlite3.oo1.DB(':memory:'))
    }
  })()
  return booting
}
