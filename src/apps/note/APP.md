---
id: note
name: note
needs:
gives: a place to write
makes: research
tone: 1
---

Writing that stays.

`needs` is empty, so `@note` opens the moment it is chosen rather than first
asking a question. That is the difference between an app and the other two
namespaces: a command and a skill both take an argument because both do
something *to* it, but an app is a place, and putting a text field between a
person and a place they asked for is a doorman. The app has its own search
field one keystroke in; it does not need the composer's.

An argument is still honoured when one arrives — `@note` written inside a
sentence and pressed passes the empty string, but nothing stops a future caller
passing a query, and it lands in the search field with the results already
narrowed.

## What it keeps

Notes are markdown text with a stable id, and they live in IndexedDB rather
than in the SQLite store the conversation uses. That is not a preference. In
this shell WebKit exposes OPFS writing only inside a worker, so the SQLite store
cannot install its persistent VFS on the main thread and is a memory database
that empties on reload. `src/store/notes.ts` has the measurements.

## Saving

Explicit. ⌘S, or the word `save`. Nothing else writes a note.

Typing writes a *draft* instead, on a short timer, into a separate store. So
leaving is never destructive and never a decision: the breadcrumb takes you back
to the conversation with the draft intact, and reopening the note restores
exactly what was on screen. Throwing work away is its own gesture — `revert` —
and it says how old the saved version it is returning to is.

The reason for the split is that "autosave" and "cancel" contradict each other
if they touch the same record. Here they cannot: save decides, the draft
remembers, and the two never write to the same place.

## Writing

What is on screen is the note, not its source. A heading is bigger, a list item
has a bullet, a quote has a rule beside it — and the `#`, the `-` and the `>`
exist only in the file that gets saved. Typing a marker is a gesture: `# ` at
the start of a block makes it a heading and the two characters vanish. So does
`**bold**`, `*slanted*` and `` `code` ``, the moment the closing marker lands.

Tab cycles the current block — paragraph, heading, list, quote, code, and round
again. The gutter names what the caret is inside, which is the only thing about
a block that is otherwise invisible.

There is no editor dependency. The surface is a `contentEditable`, the browser
does the editing so undo and input methods keep working, and `edit.ts` only
normalises what it leaves behind. What gets saved is still ordinary markdown a
person could have typed by hand.

Known limits: changing a block's kind is an attribute change and is not on the
undo stack — press Tab round again rather than ⌘Z. Nested emphasis beyond
strong, em and code is read correctly but is not something the editor produces.
