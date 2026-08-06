/**
 * Decks, and one of them full screen.
 *
 * The same two-view shape as `@note` — an index, and one thing open — because
 * they are the same kind of place and a second navigation idiom for the second
 * app would be a second thing to learn for no gain.
 *
 * What is different is what "open" means. A note opens into an editor; a deck
 * opens into reveal, which takes over the surface, binds the arrow keys, and
 * runs its own layout. That is a much larger thing to hand the page, so it is
 * torn down explicitly on the way out — see `useEffect` below, where the
 * cleanup is the load-bearing half.
 *
 * ── reveal is bundled, not fetched ──────────────────────────────────────────
 *
 * The app is cross-origin isolated (COEP `require-corp`), so a script tag
 * pointing at a CDN does not load at all — it fails the resource policy check
 * rather than merely being slow. `reveal.js` is therefore a dependency and is
 * imported like any other module, which is also what makes a deck work with no
 * network at all. Only `reveal.css` comes from the package; everything visible
 * is `theme.ts`, for the reasons written there.
 *
 * The stylesheet is `reveal.js/reveal.css`, not `reveal.js/dist/reveal.css`.
 * The package declares an `exports` map, so the path on disk is not importable
 * — only the names the map lists are, and it publishes the css under a shorter
 * name than the file actually has.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import Reveal from 'reveal.js'
import 'reveal.js/reveal.css'

import type { Surface } from '../index'
import { allDecks, deleteDeck, putDeck, titleOf, type Deck } from '../../store/notes'
import { sound } from '../../engine/sound'
import { deckHtml } from './render'
import { isTheme, THEMES, themeCss, type ThemeName } from './theme'

type View = { at: 'index' } | { at: 'deck'; id: string }

/** One slide's worth of reveal, mounted and torn down with the component. */
function Stage({ deck }: { deck: Deck }) {
  const host = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = host.current
    if (!el) return

    const slides = el.querySelector('.slides')
    if (slides) slides.innerHTML = deckHtml(deck.body)

    // `embedded` keeps reveal inside this element instead of assuming it owns
    // the document — without it, reveal binds to the body and the breadcrumb
    // above the deck stops receiving keys.
    const r = new Reveal(el, {
      embedded: true,
      hash: false,
      controls: true,
      progress: true,
      slideNumber: false,
      transition: 'slide',
      // reveal measures the viewport once at init; inside a surface that is
      // mounted after layout has settled, that measurement is the wrong one
      // unless it is told to watch.
      width: 1280,
      height: 720,
      margin: 0.06,
    })
    void r.initialize()

    // The cleanup is why this is a component rather than an effect in the
    // parent. reveal registers key handlers, a resize observer and a hash
    // listener on the window; leaving one instance behind means the *next*
    // deck opened has two of everything, and arrow keys move both.
    return () => {
      try {
        r.destroy()
      } catch {
        // destroy() throws if initialize() never finished — a deck closed
        // within a frame of opening. There is nothing to clean up in that case
        // and nothing useful to say about it.
      }
    }
  }, [deck.id, deck.body])

  return (
    <div className="reveal" ref={host}>
      <div className="slides" />
    </div>
  )
}

export const surface: Surface = function DeckApp({ argument, onExit }) {
  const [decks, setDecks] = useState<Deck[]>([])
  const [view, setView] = useState<View>({ at: 'index' })
  const [loaded, setLoaded] = useState(false)

  const refresh = useCallback(async () => {
    const all = await allDecks()
    setDecks(all)
    setLoaded(true)
    return all
  }, [])

  useEffect(() => {
    void refresh().then((all) => {
      // An argument names a deck — `/present` passes the id of the one it just
      // wrote, so finishing a deck opens it rather than announcing it.
      if (!argument) return
      const want = argument.trim()
      const hit = all.find((d) => d.id === want) ?? all.find((d) => titleOf(d).toLowerCase().includes(want.toLowerCase()))
      if (hit) setView({ at: 'deck', id: hit.id })
    })
  }, [refresh, argument])

  const current = view.at === 'deck' ? decks.find((d) => d.id === view.id) : undefined

  const back = useCallback(() => {
    sound('unmode')
    setView({ at: 'index' })
    void refresh()
  }, [refresh])

  // Escape leaves the deck before it leaves the app, so the key does the least
  // surprising thing at each depth rather than always exiting to the river.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (view.at === 'deck') {
        e.stopPropagation()
        back()
      }
    }
    addEventListener('keydown', onKey, true)
    return () => removeEventListener('keydown', onKey, true)
  }, [view.at, back])

  const setTheme = useCallback(
    async (theme: ThemeName) => {
      if (!current) return
      sound('mark')
      await putDeck({ ...current, theme })
      await refresh()
    },
    [current, refresh],
  )

  if (current) {
    const theme: ThemeName = isTheme(current.theme) ? current.theme : 'quiet'
    return (
      <div className="deck-surface">
        <style>{themeCss(theme)}</style>
        <Stage deck={current} />
        <div className="deck-chrome">
          <button type="button" onClick={back}>
            ← decks
          </button>
          <div className="deck-themes">
            {THEMES.map((t) => (
              <button
                key={t}
                type="button"
                aria-pressed={t === theme}
                className={t === theme ? 'on' : ''}
                onClick={() => void setTheme(t)}
              >
                {t}
              </button>
            ))}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="deck-index">
      <header>
        <button type="button" onClick={onExit}>
          ← back
        </button>
        <h1>decks</h1>
      </header>

      {!loaded ? null : decks.length === 0 ? (
        <p className="deck-empty">
          Nothing yet. <code>/present</code> writes one from a question — it researches first, so every
          slide carries the source it came from.
        </p>
      ) : (
        <ul className="deck-list">
          {decks.map((d) => (
            <li key={d.id}>
              <button
                type="button"
                onClick={() => {
                  sound('open')
                  setView({ at: 'deck', id: d.id })
                }}
              >
                <span className="deck-title">{titleOf(d)}</span>
                <span className="deck-meta">
                  {d.body.split(/\n---[ \t]*\n/).filter((s) => s.trim()).length} slides · {d.theme}
                </span>
              </button>
              <button
                type="button"
                className="deck-drop"
                aria-label={`delete ${titleOf(d)}`}
                onClick={async () => {
                  await deleteDeck(d.id)
                  await refresh()
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
