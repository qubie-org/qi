/**
 * Where notes live, and why it is not the store next door.
 *
 * `db.ts` is the obvious home — it is already open, it is already relational,
 * and it already has a `note` table. It is also, in the shell this app actually
 * ships in, a memory database that forgets everything on reload. That is not a
 * guess. In the real WKWebView:
 *
 *   navigator.storage.getDirectory()          works
 *   FileSystemFileHandle.prototype            ["constructor", "getFile"]
 *   fh.createWritable                         undefined
 *   fh.createSyncAccessHandle                 undefined   (main thread)
 *   fh.createSyncAccessHandle                 function    (inside a Worker)
 *
 * WebKit exposes OPFS *writing* only to workers, so sqlite-wasm's SAH-pool VFS
 * cannot install on the main thread and `openStore()` falls through to its
 * `:memory:` branch every single time — which is the `store: no OPFS, memory
 * only` line in the console. A conversation losing itself on reload is a
 * tolerable bug. A notes app losing notes is not a bug, it is the absence of
 * the product, so notes do not go anywhere near that store until it moves
 * behind a worker.
 *
 * IndexedDB was measured rather than assumed: a marker written here, `/reload`,
 * and the identical string read back. It is also the only candidate that is
 * simultaneously durable, asynchronous and structured. localStorage survives
 * too, but it is synchronous — every debounced draft write would block the main
 * thread mid-keystroke — it stores strings, so the whole set would be
 * re-serialised on each save, and WebKit caps it around 5 MB regardless of the
 * 20 GB quota the origin actually has.
 *
 * Two object stores, not one:
 *
 *   note    what has been saved. Written only by an explicit save.
 *   draft   what has been typed and not yet saved. Written on a timer.
 *
 * Keeping them apart is what lets "save" and "cancel" both mean something
 * definite. If autosave wrote into `note`, saving would be a no-op and
 * cancelling would have nothing to cancel; because it writes to `draft`, the
 * saved note is exactly what someone last chose to keep, and the draft is the
 * work in progress that survives a crash without pretending to be a decision.
 * See `apps/note/app.tsx` for the half of that argument that has a UI.
 *
 * Vectors ride along on the note record. IndexedDB stores a Float32Array
 * directly through the structured clone algorithm, so unlike the SQLite store —
 * which has to pack them into blobs by hand — there is nothing to convert and
 * nothing to get wrong about byte offsets.
 */

const DB_NAME = 'qi-notes'
const DB_VERSION = 2
const NOTES = 'note'
const DRAFTS = 'draft'
const DECKS = 'deck'

export type Note = {
  id: string
  /**
   * The explicit title, when someone insisted on one. `null` — which is the
   * normal case — means the title is the first line of the body.
   *
   * Stored as an override rather than as a denormalised copy so there is one
   * source of truth. A stored title that is *usually* a copy of the first line
   * is a stored title that will eventually disagree with the first line, and
   * then no reader knows which one is the name of the note. `titleOf` resolves
   * it; nothing else may.
   */
  title: string | null
  body: string
  created: number
  updated: number
  /**
   * The note's meaning, if an embedder was available when it was saved.
   * Optional on purpose: with no embed pack installed the app still works, it
   * simply has no answer for a query that shares no words with anything.
   */
  vec?: Float32Array
}

/** Typed but unsaved. `at` is when the typing stopped, not when it started. */
export type Draft = { id: string; body: string; at: number }

/**
 * A deck.
 *
 * The body is markdown, not HTML, and that is the whole design. reveal.js reads
 * markdown natively with `---` between slides, so the stored artifact is the
 * thing a person could have typed and the HTML is a *rendering* of it —
 * generated on open, thrown away on close, never the source of truth.
 *
 * Storing the HTML instead would have meant a deck nobody can edit without a
 * parser, a diff nobody can read, and a model asked to emit angle brackets
 * under a grammar. Markdown keeps the same split every working part of this
 * codebase has: the model writes prose into small holes, code assembles the
 * document.
 *
 * Shaped like `Note` on purpose — same id discipline, same title-is-the-first
 * -line rule, so `titleOf` works on both — with `theme` as the one addition,
 * because a deck has a look and a note does not.
 */
export type Deck = {
  id: string
  title: string | null
  /** Markdown. `---` on its own line starts a new slide. */
  body: string
  /** Which built-in theme renders it. */
  theme: string
  created: number
  updated: number
  /** What it was made from, when it came out of `/present`. */
  source?: string
}

/**
 * The name of a note.
 *
 * The first line, trimmed of whatever markup made it a heading, because the
 * thing a person writes at the top of a note is already its title and asking
 * them to type it twice in a separate field is the "form" this app is trying
 * not to be.
 */
export function titleOf(note: { title: string | null; body: string }): string {
  if (note.title?.trim()) return note.title.trim()
  const first = note.body.split('\n').find((l) => l.trim()) ?? ''
  const bare = first
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/^\s{0,3}[-*+]\s+/, '')
    .replace(/^\s{0,3}>\s?/, '')
    .trim()
  return bare || 'untitled'
}

/**
 * A fresh note.
 *
 * The id is minted here and never changes, so a note that is renamed, retitled
 * and rewritten is still the same note to every draft, index and search result
 * that ever referred to it. `crypto.randomUUID` rather than a counter because
 * a counter needs to read the store to know what it is, and an id you cannot
 * mint offline is an id that fails at the one moment you need it.
 */
export function newNote(body = ''): Note {
  const now = Date.now()
  return { id: crypto.randomUUID(), title: null, body, created: now, updated: now }
}

/** A fresh deck. Same id discipline as a note, for the same reasons. */
export function newDeck(body = '', theme = 'quiet'): Deck {
  const now = Date.now()
  return { id: crypto.randomUUID(), title: null, body, theme, created: now, updated: now }
}

// ── the connection ──────────────────────────────────────────────────────────

let opening: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(NOTES)) {
        // `updated` is indexed because the one ordering the index view always
        // wants is most-recently-touched first, and sorting a few hundred
        // records in JS to get it would be doing by hand what the store is for.
        db.createObjectStore(NOTES, { keyPath: 'id' }).createIndex('updated', 'updated')
      }
      if (!db.objectStoreNames.contains(DRAFTS)) {
        db.createObjectStore(DRAFTS, { keyPath: 'id' })
      }
      // Added at version 2. The guard is what makes the whole handler
      // re-runnable: a browser at version 1 gets only this block, a fresh
      // install gets all three, and neither case needs to know which.
      if (!db.objectStoreNames.contains(DECKS)) {
        db.createObjectStore(DECKS, { keyPath: 'id' }).createIndex('updated', 'updated')
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
    // A blocked upgrade means another tab is holding the old version. Nothing
    // useful can be done about it here, so it fails loudly rather than hanging.
    req.onblocked = () => reject(new Error('notes: database blocked by another window'))
  }).catch((err) => {
    // A failed open must not be cached as a permanently rejected promise, or
    // one transient failure at boot disables notes for the life of the page.
    opening = null
    throw err
  })
  return opening
}

/**
 * One transaction, promisified.
 *
 * IndexedDB's event API is unusable inline — every call site would grow four
 * handlers — and the wrapper is small enough that a library would be more
 * bytes than the thing it wraps. Resolution waits on `oncomplete` rather than
 * on the request's `onsuccess`: a request can succeed inside a transaction that
 * subsequently aborts, and reporting a write as done when it was rolled back is
 * exactly the failure this file exists to prevent.
 */
function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  body: (s: IDBObjectStore) => IDBRequest,
): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode)
        const req = body(t.objectStore(store))
        let out: T
        req.onsuccess = () => {
          out = req.result as T
        }
        t.oncomplete = () => resolve(out)
        t.onerror = () => reject(t.error)
        t.onabort = () => reject(t.error ?? new Error('notes: transaction aborted'))
      }),
  )
}

// ── notes ───────────────────────────────────────────────────────────────────

/** Every note, most recently touched first. */
export async function allNotes(): Promise<Note[]> {
  const all = await tx<Note[]>(NOTES, 'readonly', (s) => s.getAll())
  return (all ?? []).sort((a, b) => b.updated - a.updated)
}

export function getNote(id: string): Promise<Note | undefined> {
  return tx<Note | undefined>(NOTES, 'readonly', (s) => s.get(id))
}

/**
 * Save. The only thing that writes a note, and it stamps `updated` itself so
 * no caller can save without advancing it — an unchanged timestamp would put a
 * just-edited note back in the middle of the index.
 */
export async function putNote(note: Note): Promise<Note> {
  const saved = { ...note, updated: Date.now() }
  await tx<IDBValidKey>(NOTES, 'readwrite', (s) => s.put(saved))
  return saved
}

export async function deleteNote(id: string): Promise<void> {
  await tx<undefined>(NOTES, 'readwrite', (s) => s.delete(id))
  await dropDraft(id)
}

// ── drafts ──────────────────────────────────────────────────────────────────

export async function putDraft(id: string, body: string): Promise<void> {
  await tx<IDBValidKey>(DRAFTS, 'readwrite', (s) => s.put({ id, body, at: Date.now() } satisfies Draft))
}

export function getDraft(id: string): Promise<Draft | undefined> {
  return tx<Draft | undefined>(DRAFTS, 'readonly', (s) => s.get(id))
}

export async function dropDraft(id: string): Promise<void> {
  await tx<undefined>(DRAFTS, 'readwrite', (s) => s.delete(id))
}

/** Every draft, so the index can mark which notes have unsaved work in them. */
export async function allDrafts(): Promise<Draft[]> {
  return (await tx<Draft[]>(DRAFTS, 'readonly', (s) => s.getAll())) ?? []
}

// ── decks ───────────────────────────────────────────────────────────────────
//
// Deliberately in this file rather than a `decks.ts` of its own. `open()` and
// `tx()` are private here, and a second module would either duplicate the
// connection — two upgrade handlers racing over one database, which is how a
// version bump turns into a corrupt store — or export them, which makes the
// transaction wrapper public API for the sake of one caller.

/** Every deck, most recently touched first. */
export async function allDecks(): Promise<Deck[]> {
  const all = await tx<Deck[]>(DECKS, 'readonly', (s) => s.getAll())
  return (all ?? []).sort((a, b) => b.updated - a.updated)
}

export function getDeck(id: string): Promise<Deck | undefined> {
  return tx<Deck | undefined>(DECKS, 'readonly', (s) => s.get(id))
}

export async function putDeck(deck: Deck): Promise<Deck> {
  const saved = { ...deck, updated: Date.now() }
  await tx(DECKS, 'readwrite', (s) => s.put(saved))
  return saved
}

export async function deleteDeck(id: string): Promise<void> {
  await tx(DECKS, 'readwrite', (s) => s.delete(id))
}
