/**
 * The first app: a place the page becomes, rather than something it says.
 *
 * Three decisions are load-bearing here and each of them was a fork in the
 * road.
 *
 * **What you see is the note, not its source.** This was a textarea first, and
 * a textarea can only ever show you your own markup: you typed `# Parts` and
 * you sat looking at `# Parts`. That is a file being edited rather than a note
 * being written, and no amount of typography fixes it. The surface is a
 * `contentEditable` whose blocks draw themselves — a heading *is* bigger, a
 * list item *has* a bullet that CSS drew — and the `#`, the `-` and the `>`
 * exist only in what `doc.ts` writes to the store. Still no editor dependency:
 * Lexical is ~30 KB before a plugin and brings a document model that would make
 * markdown an import format, and the page is cross-origin isolated with COEP
 * `require-corp`, so the CDN path such a library usually takes is blocked
 * outright. What replaces it is `edit.ts` — the browser does the editing, this
 * only normalises afterwards.
 *
 * **Save is explicit; nothing else writes a note.** Typing writes a *draft*, to
 * a different object store, on a short timer. This is the only arrangement in
 * which "save" and "cancel" both keep their ordinary meanings: the saved note
 * is the last thing someone chose to keep, so save is a decision rather than a
 * formality, and leaving is never destructive because the draft is still there
 * when you come back. Discarding is a third gesture with its own button, and it
 * says what it is reverting to. Autosaving straight into the note would have
 * made save a no-op and cancel a lie.
 *
 * **One breadcrumb, drawn by the shell.** The app publishes where inside itself
 * you are and the shell renders the whole trail. The first version had the app
 * draw its own back-link under the shell's, which is two back-arrows for one
 * position, disagreeing about where back is.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { setCrumbs, type Surface } from '../index'
import { sound } from '../../engine/sound'
import { embed, ready as vectorsReady } from '../../model/vectors'
import {
  allDrafts,
  allNotes,
  deleteNote,
  dropDraft,
  newNote,
  putDraft,
  putNote,
  titleOf,
  type Draft,
  type Note,
} from '../../store/notes'
import { GLYPH, LABEL, nextKind, type BlockKind } from './blocks'
import { parseDoc, writeDoc } from './doc'
import {
  afterReturn,
  backspaceAtStart,
  caretBlock,
  kindAt,
  normalize,
  pasteMarkdown,
  readDoc,
  reflowInline,
  renderInto,
  runInputRules,
} from './edit'
import { embeddableText, literal, nearest, type Hit } from './search'

/** How long typing has to stop before the draft is written. */
const DRAFT_DELAY = 400

/** Which of the two places in the app you are standing. */
type View = { at: 'index' } | { at: 'note'; id: string }

export const surface: Surface = function NoteApp({ argument, onExit }) {
  const [notes, setNotes] = useState<Note[]>([])
  const [drafts, setDrafts] = useState<Map<string, Draft>>(new Map())
  const [view, setView] = useState<View>({ at: 'index' })
  const [loaded, setLoaded] = useState(false)

  const refresh = useCallback(async () => {
    const [n, d] = await Promise.all([allNotes(), allDrafts()])
    setNotes(n)
    setDrafts(new Map(d.map((x) => [x.id, x])))
    setLoaded(true)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const open = useCallback((id: string) => {
    sound('open')
    setView({ at: 'note', id })
  }, [])

  const back = useCallback(() => {
    sound('unmode')
    setView({ at: 'index' })
    void refresh()
  }, [refresh])

  const current = view.at === 'note' ? notes.find((n) => n.id === view.id) : undefined

  /**
   * Publish where we are, so the shell's breadcrumb is the only one.
   *
   * The app used to draw its own `‹ all notes` under the shell's trail, which
   * put two back-arrows on screen that pointed at different places. One trail,
   * drawn once, by whoever owns that corner.
   */
  useEffect(() => {
    setCrumbs(
      current
        ? [{ label: 'note', go: back }, { label: titleOf(current) }]
        : [{ label: 'note' }],
    )
  }, [current, back])

  return (
    <div className="app app--note">
      {view.at === 'index' || !current ? (
        <Index
          notes={notes}
          drafts={drafts}
          loaded={loaded}
          initialQuery={argument}
          onOpen={open}
          onCreate={async (seed) => {
            // Written straight away rather than held in memory until the first
            // save. A note you can open, leave and come back to has to exist,
            // and an id that is only real once you save it is an id every draft
            // and every index row would have to special-case.
            const note = await putNote(newNote(seed))
            await refresh()
            open(note.id)
          }}
        />
      ) : (
        <Editor
          key={current.id}
          note={current}
          draft={drafts.get(current.id)}
          onBack={back}
          onExit={onExit}
          onChanged={refresh}
        />
      )}
    </div>
  )
}

// ── the index ───────────────────────────────────────────────────────────────

/**
 * Everything written, and the way in.
 *
 * The field is search only. It was tempting to make Enter create a note from
 * whatever had been typed — one field doing both jobs — but then every search
 * that finds nothing is one keystroke away from silently making a note called
 * "tax retrun", and the gesture that finds things and the gesture that makes
 * them should not be the same key. Creating is a button, and it names what it
 * is about to make so there is no doubt.
 */
function Index({
  notes,
  drafts,
  loaded,
  initialQuery,
  onOpen,
  onCreate,
}: {
  notes: Note[]
  drafts: Map<string, Draft>
  loaded: boolean
  initialQuery: string
  onOpen: (id: string) => void
  onCreate: (seed: string) => void
}) {
  const [query, setQuery] = useState(initialQuery)
  const [close, setClose] = useState<Hit[]>([])

  // Literal search is synchronous and runs on every keystroke — a scan over a
  // few hundred short strings, with no debounce to get stale and no promise to
  // race. See `search.ts` for why this is the spine rather than the fallback.
  const hits = useMemo(() => literal(notes, query), [notes, query])

  /**
   * Meaning, only where words failed.
   *
   * Guarded three ways: there must be no literal hit at all, the query must be
   * long enough to be a query, and an embedder must actually be bound. The
   * effect is cancelled by the flag rather than by racing, so a fast typist
   * cannot have an older query's neighbours land on top of a newer one's.
   */
  useEffect(() => {
    const q = query.trim()
    if (hits.length || q.length < 3 || !vectorsReady()) {
      setClose([])
      return
    }
    let alive = true
    const timer = setTimeout(() => {
      void embed(q).then((vec) => {
        if (alive) setClose(nearest(notes, vec))
      })
    }, 180)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [query, hits.length, notes])

  return (
    <>
      <div className="note-head">
        <input
          className="note-find"
          autoFocus
          value={query}
          placeholder="find a note"
          onChange={(e) => setQuery(e.target.value)}
          aria-label="find a note"
        />
        <button type="button" className="note-new" onClick={() => onCreate(query.trim())}>
          {query.trim() ? `new note “${query.trim()}”` : 'new note'}
        </button>
      </div>

      {!loaded ? null : notes.length === 0 ? (
        <p className="note-empty">nothing written yet.</p>
      ) : (
        <>
          <ul className="note-list">
            {hits.map((h) => (
              <Row key={h.note.id} hit={h} unsaved={drafts.has(h.note.id)} onOpen={onOpen} />
            ))}
          </ul>

          {!hits.length && (
            <p className="note-empty">
              {query.trim() ? `nothing matches “${query.trim()}”.` : 'nothing here.'}
            </p>
          )}

          {/* A different heading because it is a different claim. These are not
              matches; they are the nearest things by meaning, offered only
              because the words found nothing. */}
          {!hits.length && close.length > 0 && (
            <>
              <p className="note-aside">closest by meaning</p>
              <ul className="note-list">
                {close.map((h) => (
                  <Row key={h.note.id} hit={h} unsaved={drafts.has(h.note.id)} onOpen={onOpen} />
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </>
  )
}

function Row({
  hit,
  unsaved,
  onOpen,
}: {
  hit: Hit
  unsaved: boolean
  onOpen: (id: string) => void
}) {
  return (
    <li>
      <button type="button" className="note-row" onClick={() => onOpen(hit.note.id)}>
        <span className="note-row-title">
          {hit.title}
          {unsaved && (
            <span className="note-dot" title="unsaved changes" aria-label="unsaved changes" />
          )}
        </span>
        <span className="note-row-snip">{marked(hit)}</span>
      </button>
    </li>
  )
}

/** The matched characters, marked in place, so a hit can be checked by eye. */
function marked(hit: Hit) {
  if (!hit.mark) return hit.snippet
  const [a, b] = hit.mark
  return (
    <>
      {hit.snippet.slice(0, a)}
      <mark>{hit.snippet.slice(a, b)}</mark>
      {hit.snippet.slice(b)}
    </>
  )
}

// ── the editor ──────────────────────────────────────────────────────────────

function Editor({
  note,
  draft,
  onBack,
  onExit,
  onChanged,
}: {
  note: Note
  draft: Draft | undefined
  onBack: () => void
  onExit: () => void
  onChanged: () => Promise<void>
}) {
  // The draft wins on open. It is by definition newer than the note — it only
  // exists because someone typed after the last save — so restoring the saved
  // text instead would silently undo the work the draft was written to keep.
  const [body, setBody] = useState(draft?.body ?? note.body)
  const [saved, setSaved] = useState(note.body)
  const [savedAt, setSavedAt] = useState(note.updated)
  const [confirming, setConfirming] = useState(false)
  const doc = useRef<HTMLDivElement>(null)
  const dirty = body !== saved

  const gutter = useGutter(doc, body)

  /**
   * Fill the surface once, from markdown.
   *
   * Once — not on every render. React must never own these children: it would
   * diff the document on every keystroke and put the caret back wherever the
   * previous render had left it. The DOM is the document from here on, and
   * `body` is a serialisation of it kept for comparison, not a source for it.
   * `key={note.id}` upstream is what makes "once" mean "once per note".
   */
  useLayoutEffect(() => {
    const root = doc.current
    if (!root) return
    renderInto(root, parseDoc(draft?.body ?? note.body))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Re-read the document after anything that could have changed it. */
  const sync = useCallback(() => {
    const root = doc.current
    if (!root) return
    normalize(root)
    setBody(writeDoc(readDoc(root)))
  }, [])

  /**
   * Finish a block when the caret leaves it.
   *
   * `inlineRule` catches a marker at the instant it closes, which covers typing
   * forwards and nothing else. Moving away from a block — by click, by arrow
   * key, by anything — is the other moment at which its text is final, so it is
   * re-read then. Without this, going back to wrap a word in asterisks leaves
   * the asterisks on screen, which is the exact thing this editor promises not
   * to do.
   */
  const inBlock = useRef<HTMLElement | null>(null)
  useEffect(() => {
    const onMove = () => {
      const root = doc.current
      if (!root) return
      const now = caretBlock(root)
      const before = inBlock.current
      inBlock.current = now
      if (before && before !== now && root.contains(before) && reflowInline(before)) sync()
    }
    document.addEventListener('selectionchange', onMove)
    return () => document.removeEventListener('selectionchange', onMove)
  }, [sync])

  // The draft, on a timer. Deliberately not on every keystroke: a write per
  // character is a transaction per character, and nothing is protected by the
  // difference between losing 0 ms of typing and losing 400 ms of it.
  useEffect(() => {
    if (!dirty) return
    const t = setTimeout(() => void putDraft(note.id, body), DRAFT_DELAY)
    return () => clearTimeout(t)
  }, [body, dirty, note.id])

  const save = useCallback(async () => {
    const root = doc.current
    // Finish whatever block the caret is in first, so what gets written is what
    // is on screen rather than one keystroke behind it.
    if (root) {
      const here = caretBlock(root)
      if (here) reflowInline(here)
    }
    const text = root ? writeDoc(readDoc(root)) : body
    // The vector is computed here rather than on every keystroke because this
    // is the only moment the text is claimed to be worth finding again. With no
    // embed pack bound this resolves to a stand-in, so it is left off entirely
    // rather than stored as a meaningless neighbour — see `search.ts`.
    const vec = vectorsReady() ? await embed(embeddableText({ title: note.title, body: text })) : undefined
    const out = await putNote({ ...note, body: text, vec })
    await dropDraft(note.id)
    setBody(text)
    setSaved(text)
    setSavedAt(out.updated)
    sound('mark')
    await onChanged()
  }, [body, note, onChanged])

  /**
   * Throw the work away, on purpose and with warning.
   *
   * Two presses, because this is the one button in the app that can lose
   * something, and it names the version it is going back to so the choice is
   * informed rather than brave.
   */
  const revert = useCallback(async () => {
    const root = doc.current
    if (root) renderInto(root, parseDoc(saved))
    setBody(saved)
    await dropDraft(note.id)
    setConfirming(false)
    sound('unmode')
    await onChanged()
  }, [saved, note.id, onChanged])

  const remove = useCallback(async () => {
    await deleteNote(note.id)
    sound('miss')
    onBack()
  }, [note.id, onBack])

  return (
    <>
      {/* No back-link here. The breadcrumb the shell draws is the only one —
          see `setCrumbs` above. This row is state and actions, nothing else. */}
      <div className="note-bar">
        <span className="note-state">
          {dirty ? 'unsaved' : `saved ${ago(savedAt)}`}
        </span>
        <div className="note-acts">
          {dirty && (
            <button
              type="button"
              className={`note-act${confirming ? ' note-act--warn' : ''}`}
              onClick={() => (confirming ? void revert() : setConfirming(true))}
              onBlur={() => setConfirming(false)}
            >
              {confirming ? `discard — back to ${ago(savedAt)}?` : 'revert'}
            </button>
          )}
          <button type="button" className="note-act note-act--go" disabled={!dirty} onClick={() => void save()}>
            save
          </button>
          <button type="button" className="note-act note-act--quiet" onClick={() => void remove()}>
            delete
          </button>
        </div>
      </div>

      <div className="note-page">
        {/* The gutter. One glyph, at the block the caret is in — a legend for
            what Tab is about to change, not a map of the whole document. */}
        <span
          className="note-gutter"
          style={{ top: `${gutter.top}px` }}
          title={LABEL[gutter.kind]}
          aria-hidden
        >
          {GLYPH[gutter.kind]}
        </span>

        {/* The document. `contentEditable` with the browser left in charge of
            editing — see `edit.ts` for why intercepting keys would cost more
            than it buys. React never owns these children; the effect above
            fills them once and the DOM is the document from then on. */}
        <div
          ref={doc}
          className="note-doc note-type"
          contentEditable
          suppressContentEditableWarning
          spellCheck
          role="textbox"
          aria-multiline
          aria-label="note body"
          data-empty={!body.trim() || undefined}
          onInput={() => {
            // Rules first: they may rewrite what was just typed, and `sync`
            // has to serialise the result rather than the keystroke.
            if (doc.current) runInputRules(doc.current)
            sync()
          }}
          onPaste={(e) => {
            // Always as markdown, never as HTML — the clipboard is the one
            // place foreign markup can get in.
            e.preventDefault()
            const text = e.clipboardData.getData('text/plain')
            if (doc.current && text) pasteMarkdown(doc.current, text)
            sync()
          }}
          onKeyDown={(e) => {
            const root = doc.current
            if (!root) return

            if (e.key === 'Tab') {
              e.preventDefault()
              const el = caretBlock(root)
              if (!el) return
              const kind = nextKind(kindAt(root))
              el.dataset.kind = kind
              sound('type', 0.7)
              sync()
              return
            }

            if (e.key === 'Enter' && !e.shiftKey) {
              // The browser splits the block; the kind of the new one is a
              // decision, so it is corrected once the split has happened.
              const was = kindAt(root)
              setTimeout(() => {
                afterReturn(root, was)
                sync()
              }, 0)
              return
            }

            if (e.key === 'Backspace' && backspaceAtStart(root)) {
              e.preventDefault()
              sync()
              return
            }

            // ⌘S is the key everyone already presses. Prevented first, or the
            // shell's own save dialogue takes it.
            if (e.key.toLowerCase() === 's' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              if (dirty) void save()
              return
            }

            // Escape leaves without deciding. The draft has it.
            if (e.key === 'Escape') {
              e.preventDefault()
              onBack()
            }
          }}
        />
      </div>

      <p className="note-foot">
        <kbd>tab</kbd> changes the block · <kbd>⌘S</kbd> saves · <kbd>esc</kbd> goes back ·{' '}
        <button type="button" className="note-linkish" onClick={onExit}>
          back to the conversation
        </button>
      </p>
    </>
  )
}

/**
 * Where the gutter glyph goes, and what it says.
 *
 * This got much smaller when the document stopped being a textarea. A textarea
 * has no elements in it, so the caret's *visual* line had to be reconstructed
 * by rendering a mirror copy of the text and measuring where a marker landed —
 * about forty lines, all of them a workaround for not being able to ask. Now
 * the block under the caret is an element: it knows its own kind and its own
 * position, and both questions are one property each.
 *
 * `selectionchange` is what makes it follow the caret rather than the text:
 * arrow keys and clicks move the caret without firing `input`, and a gutter
 * that only updated on typing would name the wrong block for as long as you
 * were reading rather than writing.
 */
function useGutter(doc: React.RefObject<HTMLDivElement | null>, body: string) {
  const [at, setAt] = useState<{ top: number; kind: BlockKind }>({ top: 0, kind: 'paragraph' })

  const read = useCallback(() => {
    const root = doc.current
    if (!root) return
    const el = caretBlock(root)
    if (!el) return
    setAt({ top: el.offsetTop + el.offsetHeight / 2, kind: kindAt(root) })
  }, [doc])

  useEffect(() => {
    document.addEventListener('selectionchange', read)
    return () => document.removeEventListener('selectionchange', read)
  }, [read])

  // Typing reflows the blocks below the caret without moving the selection, so
  // the position is re-read whenever the document changes as well.
  useLayoutEffect(read, [body, read])

  return at
}

/** Rough, and deliberately so — a note does not need a clock, only a sense. */
function ago(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (s < 45) return 'just now'
  if (s < 5400) return `${Math.round(s / 60)}m ago`
  if (s < 172800) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}
