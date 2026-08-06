---
id: deck
name: deck
needs:
gives: slides that carry their sources
makes: present
tone: 2
---

Decks, and one of them full screen.

`needs` is empty, so `@deck` opens the moment it is chosen. An argument is
honoured when one arrives and is read as a deck to open — an id, or enough of a
title to identify one. `/present` passes the id of the deck it just wrote, so
finishing a deck opens it rather than announcing it and leaving you to go and
look.

A deck is markdown, with `---` alone on a line between slides. That is reveal's
own convention and it means the stored thing is the thing a person could have
typed; the HTML is generated on open and thrown away on close. A deck written by
`/present` also carries `[title](url)` lines, which are lifted out of the slide
body and rendered as a footer — so a claim on a slide keeps the source it was
checked against, and the deck is verifiable at a glance rather than on trust.

Three themes — quiet, dark, plain — chosen while the deck is open. reveal's own
eleven are not loaded: they are somebody else's typography, and a deck built out
of your own notes should not look like it came from a different program. Only
reveal's layout CSS is used.
