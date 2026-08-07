import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { EXPAND, INVOKE, NAVIGATE, River } from './inline/Render'
import { countWords, placeChip, shapeFor } from './inline/compose'
import { Streaming } from './inline/Streaming'
import { parse } from './inline/parse'
import type { Node } from './inline/types'
import { embed, startVectors, warmSentence } from './model/vectors'
import { buildBank, place, type Bank } from './engine/place'
import { buildAxes, Drift, type Axes } from './engine/vibe'
import { buildToneBank, type ToneBank } from './engine/palette'
import { emojiBank, loadEmoji } from './engine/emoji'
import { applyVibe, NEUTRAL, type Vibe } from './engine/theme'
import { nudge, surge } from './engine/floor'
import { isMuted, setMuted, sound, tune, writing } from './engine/sound'
import { performReset, performStream } from './engine/perform'
import { trackScrollTheme, type Snapshot } from './engine/scrollTheme'
import { Agent, type AgentEvent } from './agent/loop'
import { Digest } from './agent/digest'
import { badgeFor, Steps, type Badge } from './agent/Steps'
import { openStore, type Store } from './store/db'
import { bootSandbox, buildRouter, factNodes, statesQuantity, type Fact, type Router } from './ground'
import { pageFromFact } from './pages/build'
import { COMMANDS, find, immediate, isSigil, match, SIGILS, type App as AppEntry, type Command, type Invocable, type Sigil } from './pages/sigils'
import { findAcross } from './pages/find'
import { CRUMBS, OPEN_APP, type Crumb, type Opening, type Surface } from './apps'
import { loadFolders } from './skills/discover'
import { granite } from './model/granite'
import { packs } from './model/packs'
import { startTelemetry } from './model/telemetry'
import { autolink } from './pages/autolink'
import { address, resolve } from './pages/space'
import { reduce } from './ground/sandbox'

/**
 * Each turn carries the vibe it was written under, so scroll can restore it,
 * and the steps it took, so a multi-move answer keeps its account of itself
 * after the live row has gone.
 */
type Turn = { role: 'user' | 'agent'; nodes: Node[]; text: string; vibe: Vibe; steps?: Badge[] }
type Engine = { bank: Bank; axes: Axes; drift: Drift; router: Router; store: Store; tones: ToneBank }

export default function App() {
  const [turns, setTurns] = useState<Turn[]>([])
  /** The history drawer, and what it is showing. */
  const [history, setHistory] = useState<{ id: number; title: string; updated: number; turns: number }[] | null>(null)
  const [status, setStatus] = useState('waking')
  const [quiet, setQuiet] = useState(isMuted())
  /** Bumped to re-read what is running; the chrome polls nothing. */
  const [, setTick] = useState(0)
  const [busy, setBusy] = useState(false)
  /** Reply text as it arrives, before the marks are placed on it. */
  const [live, setLive] = useState<string | null>(null)
  /** Steps of the turn in flight, and what the agent says it is doing. */
  const [steps, setSteps] = useState<Badge[]>([])
  const [status_, setStatus_] = useState<string | null>(null)
  /**
   * The app holding the page, if one is.
   *
   * A single slot, not a stack: `@` means *become this*, and two apps at once
   * would need a story about which is behind which that nothing in the design
   * asks for. The breadcrumb has exactly one place to go back to because there
   * is exactly one place it can have come from.
   */
  const [held, setHeld] = useState<{ entry: AppEntry; argument: string } | null>(null)
  /** Where inside the app you are, as the app itself reports it. */
  const [crumbs, setCrumbs] = useState<Crumb[]>([])
  const engine = useRef<Engine | null>(null)
  const digest = useRef(new Digest())
  const agent = useRef(new Agent(digest.current))
  const bottom = useRef<HTMLDivElement>(null)
  // The listeners above are registered once; these keep them pointed at the
  // current callbacks rather than at the ones that existed on first render.
  const sendRef = useRef<((t: string) => Promise<void>) | null>(null)
  const commandRef = useRef<((c: Command, arg: string) => Promise<void>) | null>(null)

  useEffect(() => {
    let alive = true
    ;(async () => {
      // The palette exists before anything asks for it. --t1..--t4 were only
      // written when a turn applied a vibe, so on an empty page every
      // `var(--tone)` resolved to nothing and the command picker came out
      // colourless — the one place those tokens are needed before a
      // conversation has started.
      applyVibe(NEUTRAL)
      tune(NEUTRAL)

      // Commands are folders, so the registries are empty until they
      // are read. Done before the first paint because the picker lists them and
      // are loaded.
      loadFolders()

      // Telemetry before anything it would observe. Spans for every model
      // call, every tool the agent chooses and every pack install go out as
      // OTLP — to a collector if one is configured, to telemetry/ if not.
      startTelemetry()

      // Meaning first. Everything visual is downstream of a vector, so the
      // embed pack binds before anything asks for one — and if it is not
      // installed, `startVectors` says so and the fallback keeps the page
      // rendering rather than throwing.
      setStatus('loading meaning')
      const [store, vectors] = await Promise.all([openStore(), startVectors()])
      if (!alive) return
      if (!vectors) console.warn('no embed pack — vectors are stand-ins')

      // These three are fixed sets of strings — motif anchors, vibe poles,
      // source anchors — so they are embedded once, here, and the render path
      // only ever reads the cache afterwards.
      const [bank, axes, router, tones] = await Promise.all([
        buildBank(),
        buildAxes(),
        buildRouter(),
        buildToneBank(),
      ])
      if (!alive) return
      engine.current = { bank, axes, drift: new Drift(), router, store, tones }

      // Vectors precomputed at build time against the same weights; the model
      // is never told the lexicon exists.
      void loadEmoji()
      setStatus('loading voice')

      // The core model, then whatever packs are installed. A pack that fails to
      // bind is logged and skipped — an uninstalled capability is a missing
      // verb, never a broken page.
      const [voice] = await Promise.allSettled([granite.load(), bootSandbox()])
      if (voice.status === 'rejected') console.error('core model unreachable', voice.reason)
      if (alive) setStatus('loading packs')
      await packs.bindInstalled()
      if (alive) setStatus(agent.current.ready ? 'ready' : 'visuals only')

      if (import.meta.env.DEV) {
        // Handles for poking the pipeline from the console.
        Object.assign(window, {
          qi: { engine: engine.current, agent: agent.current, digest: digest.current, granite, packs, store, reduce, bootSandbox },
        })
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  // Follow the conversation, but only while the reader is already at the
  // bottom — scrolling up to re-read something should not get yanked back.
  const stick = useRef(true)
  useEffect(() => {
    const onScroll = () => {
      const se = document.scrollingElement
      if (!se) return
      stick.current = se.scrollHeight - se.scrollTop - se.clientHeight < 140
    }
    addEventListener('scroll', onScroll, { passive: true })
    return () => removeEventListener('scroll', onScroll)
  }, [])

  // The feed owns the theme: scrolling back through it restores the room as it
  // was, and scrolling forward brings the present back.
  const turnsRef = useRef<Turn[]>([])
  turnsRef.current = turns
  useEffect(() => {
    return trackScrollTheme((): Snapshot[] => {
      const out: Snapshot[] = []
      document.querySelectorAll<HTMLElement>('[data-turn]').forEach((el) => {
        const turn = turnsRef.current[Number(el.dataset.turn)]
        if (turn) out.push({ el, vibe: turn.vibe })
      })
      return out
    })
  }, [])

  // Following a link opens a page as its own turn. Pages go through the same
  // parse -> place -> River path a reply does, so they inherit the inline
  // system, emoji, marks and theme without knowing any of it exists.
  useEffect(() => {
    const onNavigate = async (ev: Event) => {
      const e = engine.current
      const addr = (ev as CustomEvent<string>).detail
      if (!e || !addr) return
      const vibe = e.drift.current

      const hit = await resolve(addr)
      if (!hit) {
        sound('miss')
        setTurns((t) => [
          ...t,
          { role: 'agent', text: `nothing at ${addr}`, vibe,
            nodes: parse(`nothing at ${addr}.`) },
        ])
        return
      }
      const { page } = hit
      const body = page.image ? `![${page.title}](${page.image}) ${page.body}` : page.body
      await warmSentence(`${page.title} ${page.body}`)
      setTurns((t) => [
        ...t,
        {
          role: 'agent',
          text: `${page.title}\n${page.body}`,
          vibe,
          nodes: place(parse(`[[${page.title}|loud]]\n${body}`), e.bank, {
            seed: t.length,
            emoji: emojiBank(),
          }),
        },
      ])
    }
    addEventListener(NAVIGATE, onNavigate)
    return () => removeEventListener(NAVIGATE, onNavigate)
  }, [])

  /**
   * Pressing a term asks about it, and pressing a /command runs it.
   *
   * Both are the same gesture the composer already offers, reached from inside
   * the text instead. That is the whole justification for the marks existing:
   * a word is worth marking exactly when pressing it would do something, and
   * the something is always something you could have typed.
   */
  useEffect(() => {
    const onExpand = (ev: Event) => {
      const topic = (ev as CustomEvent<string>).detail
      if (topic) void sendRef.current?.(`tell me more about ${topic}`)
    }
    const onInvoke = (ev: Event) => {
      // The chip sends its sigil along with its id, so the namespace is not
      // re-guessed here from a bare name — two namespaces could hold the same
      // word and the press would pick whichever was searched first.
      const raw = (ev as CustomEvent<string>).detail ?? ''
      const sigil = raw.slice(0, 1)
      const id = raw.slice(1)
      if (!isSigil(sigil) || !id) return
      const entry = SIGILS[sigil].entries.find((e) => e.id === id || e.name === id)
      // Both live under `/` now, so the branch is on what the entry *is*. An
      // app announces itself rather than being opened here, so a press in the
      // text and a choice in the composer go down the same path.
      if (!entry) return
      if ('enter' in entry) entry.enter('')
      else if (entry.sigil === '/') void commandRef.current?.(entry, '')
    }
    addEventListener(EXPAND, onExpand)
    addEventListener(INVOKE, onInvoke)
    return () => {
      removeEventListener(EXPAND, onExpand)
      removeEventListener(INVOKE, onInvoke)
    }
  }, [])

  /**
   * An app asking for the page.
   *
   * The registry entry carries its own surface, so the shell needs to know
   * nothing about what any app is — only that one wants the page and that the
   * way back is the breadcrumb it draws. Everything below the sigil layer stays
   * ignorant of notes, and adding a second app is a folder rather than a change
   * here.
   */
  useEffect(() => {
    const onOpen = (ev: Event) => {
      const { id, argument } = (ev as CustomEvent<Opening>).detail ?? { id: '', argument: '' }
      const entry = SIGILS['/'].entries.find((e) => e.id === id)
      if (!entry || !('surface' in entry)) return
      sound('mode')
      setCrumbs([])
      setHeld({ entry, argument })
    }
    const onCrumbs = (ev: Event) => setCrumbs((ev as CustomEvent<Crumb[]>).detail ?? [])
    addEventListener(OPEN_APP, onOpen)
    addEventListener(CRUMBS, onCrumbs)
    return () => {
      removeEventListener(OPEN_APP, onOpen)
      removeEventListener(CRUMBS, onCrumbs)
    }
  }, [])

  useEffect(() => {
    if (!stick.current) return
    // Instant while tokens stream in; smooth animations would queue up and
    // fight each other several times a second.
    bottom.current?.scrollIntoView({ behavior: live === null ? 'smooth' : 'auto', block: 'end' })
  }, [turns, live])

  /**
   * A command, run directly.
   *
   * This is the whole point of the mode: the source is called with what was
   * typed, the sandbox reduces the response, and the fact is rendered. No
   * model is involved anywhere in it, so it returns in the time one HTTP
   * request takes and cannot invent anything.
   */
  const runCommandTurn = useCallback(async (command: Command, argument: string) => {
    const e = engine.current
    if (!e || busy) return
    setBusy(true)
    try {
      const asked = [command.name, argument].filter(Boolean).join(' ')
      surge(1)
      sound('send')
      await warmSentence(asked)
      const vibe = e.drift.push(asked, e.axes)
      applyVibe(vibe)
      tune(vibe)
      setTurns((t) => [
        ...t,
        {
          role: 'user',
          text: asked,
          vibe,
          nodes: place(parse(asked), e.bank, {
            maxMotifs: 2,
            decorate: false,
            emoji: emojiBank(),
            seed: t.length,
          }),
        },
      ])

      const fact = await command.run(argument)
      if (!fact) {
        sound('miss')
        setTurns((t) => [
          ...t,
          { role: 'agent', text: `${command.name} found nothing`, vibe,
            nodes: parse(`${command.name} found nothing for that.`) },
        ])
        return
      }

      pageFromFact(fact, asked)
      e.store.putFact(
        { key: asked.toLowerCase(), label: fact.label, value: fact.value, unit: fact.unit,
          src: fact.src, url: fact.srcUrl },
        await embed(`${asked} ${fact.label}`),
      )

      const body = fact.chip ? `![${fact.label}](${fact.chip}) ${fact.label}` : fact.label
      await warmSentence(`${fact.label} ${fact.value}`)
      setTurns((t) => [
        ...t,
        {
          role: 'agent',
          text: `${fact.label} ${fact.value}`,
          vibe,
          nodes: [
            ...place(parse(body), e.bank, { seed: t.length, emoji: emojiBank() }),
            // The label ends without punctuation here — it is a name, not a
            // sentence — so the measurement needs a space of its own.
            { t: 'text', v: ' ' },
            ...factNodes(fact),
          ],
        },
      ])
    } finally {
      setBusy(false)
    }
  }, [busy])

  const send = useCallback(
    async (text: string) => {
      const e = engine.current
      if (!e || busy) return
      setBusy(true)
      setSteps([])
      setStatus_(null)

      // The field surges when a question goes, and again when the answer lands.
      // Same spring as typing, more of it — so the two biggest moments in a
      // turn are the two the floor actually reacts to.
      surge(1)
      sound('send')
      performReset()

      // One batch up front: the sentence and every content word in it. After
      // this the whole render path is cache hits, so the turn paints complete
      // rather than acquiring its decorations a frame later.
      await warmSentence(text)

      // The room drifts toward what was just said, before the reply lands.
      const userVibe = e.drift.push(text, e.axes)
      applyVibe(userVibe)
      tune(userVibe)
      e.store.addTurn('user', text, await embed(text))
      setTurns((t) => [
        ...t,
        {
          role: 'user',
          text,
          vibe: userVibe,
          nodes: place(parse(text), e.bank, {
            maxMotifs: 2,
            decorate: false,
            emoji: emojiBank(),
            seed: t.length,
          }),
        },
      ])

      // The agent decides what to do. Grounding is not run in front of the
      // model on a routing guess — it is one of the verbs the model can choose,
      // and it can choose it twice, or not at all, or recall something it
      // already found instead.
      let reply = ''
      let facts: Fact[] = []
      const taken: Badge[] = []
      try {
        if (agent.current.ready) {
          const out = await agent.current.run(
            text,
            { router: e.router, store: e.store },
            async (ev: AgentEvent) => {
              if (ev.t === 'token') {
                // The answer plays itself: words step the melody, clauses
                // breathe, sentences resolve to a chord, emoji ring out. The
                // tap stays underneath as texture.
                writing(true)
                performStream(ev.text)
                return setLive(ev.text)
              }
              if (ev.t === 'status') return setStatus_(ev.text)
              // A step is replaced in place when it resolves, so the badge that
              // appeared as "looking up" becomes the name the summariser gave it
              // without the row reflowing.
              const badge = await badgeFor(ev, e.bank)
              const at = taken.findIndex((b) => b.id === badge.id)
              if (at >= 0) taken[at] = badge
              else taken.push(badge)
              setSteps([...taken])
            },
          )
          reply = out.reply
          facts = out.facts
        }
      } catch (err) {
        console.error('agent failed', err)
      } finally {
        // Whatever happened — answered, failed, threw — the writing has
        // stopped, so any riser comes down and `land` resolves it.
        writing(false)
        setLive(null)
        setStatus_(null)
      }

      // The first fact found is the one cited; later steps refined it.
      // A picture wins the slot.
      //
      // This was `facts[0]`, which is right when a turn produces one fact and
      // silently wrong when it produces several: the image arrived second and
      // never rendered, so a photograph that had been fetched, decoded and
      // measured was dropped one step from the screen. Only one fact can take
      // the sentence, and when one of them is something to look at, it is the
      // one worth showing.
      const fact = facts.find((f) => f.chip) ?? facts[0] ?? null
      // If the model is unreachable a fact it managed to fetch still answers.
      if (!reply) reply = fact ? fact.value : 'no local model server is running.'

      surge(0.85)
      sound('land')
      await warmSentence(reply)
      const replyVibe = e.drift.push(reply, e.axes)
      applyVibe(replyVibe)
      tune(replyVibe)
      e.store.addTurn('agent', reply, await embed(reply))

      // The topic line is rewritten from the turns themselves, in the
      // background. It is what the *next* turn is given instead of a
      // transcript, so it must not be on the critical path of this one.
      void (async () => {
        const topic = await digest.current.topic(e.store.recentTurns(6))
        if (topic) e.store.putNote('topic', topic, null, await embed(topic))
      })()

      const parsed = parse(reply)

      setTurns((t) => {
        // Built without mutation: this updater can run more than once.
        // Linked after placement so a mark and a link never fight for the same
        // word, and only ever to pages that actually exist.
        // The reply gets emoji placed here now, not written by the model. It
        // used to ask for them in the prompt, which on a small model produced
        // replies that were *only* an emoji — and the reason placement ever
        // moved into the model (a static table cannot tell a verb from a noun)
        // stopped applying when the embed pack became a real encoder.
        const placed = autolink(place(parsed, e.bank, { seed: t.length, emoji: emojiBank() }))
        // A picture goes *in* the sentence, beside the word it depicts, at a
        // size the surrounding text can actually support — a float needs
        // something to flow around it or it just stands there.
        const withChip = fact?.chip
          ? placeChip(
              placed,
              {
                t: 'chip',
                src: fact.chip,
                alt: fact.label,
                w: fact.chipW,
                h: fact.chipH,
                shape: shapeFor(fact.chipW, fact.chipH, countWords(placed)),
                // Everything the fact knows that the sentence has no room for.
                // It is not hidden so much as deferred: the answer stays one
                // line, and the provenance is one click under it.
                aside: {
                  title: fact.label,
                  body: [fact.value, fact.chipW && fact.chipH ? `${fact.chipW}×${fact.chipH}` : '', fact.src]
                    .filter(Boolean)
                    .join(' · '),
                  href: fact.srcUrl,
                },
              },
            )
          : placed
        const nodes = [
          ...withChip,
          // The value is typeset directly — it never passes through the model.
          // A textual fact is already the reply above, so only its attribution
          // is appended; measurements get their own line.
          // The measurement block only when the model did not already say the
          // number, otherwise it appears twice. Attribution always.
          ...(fact && fact.quantities?.length && !statesQuantity(reply, fact)
            ? [{ t: 'brk' } as Node, ...factNodes(fact)]
            : fact
              ? [{ t: 'src', label: fact.src, href: fact.srcUrl } as Node]
              : []),
        ]
        return [...t, { role: 'agent', text: reply, vibe: replyVibe, nodes, steps: taken.length ? taken : undefined }]
      })
      setSteps([])
      setBusy(false)
    },
    [busy],
  )

  // Registered listeners keep a ref rather than re-subscribing every render.
  sendRef.current = send

    commandRef.current = runCommandTurn

  return (
    <>
      <div className="bg" />
      {/* The floor. Sits above the thread and below the composer's words, so
          the last lines of a long answer sink into it rather than stopping at
          an edge. */}
      {/* Four lamps rather than one gradient, because they have to move
          independently — a single background can be slid sideways but its
          colours keep their spacing forever, which is the static-rainbow look.
          Separately they cross, overlap and remix. */}
      <div className="floor" aria-hidden>
        <i className="lamp lamp--1" />
        <i className="lamp lamp--2" />
        <i className="lamp lamp--3" />
        <i className="lamp lamp--4" />
      </div>
      <div className="chrome">
        {/* A new conversation, and the ones before it.
            Beside the status rather than in a sidebar: the app has one column
            and adding a second to hold a list would cost more than the list is
            worth. The drawer opens over the river and closes on choosing. */}
        <button
          type="button"
          className="chrome-act"
          title="new thread"
          aria-label="new thread"
          onClick={() => {
            sound('mode')
            engine.current?.store.openThread()
            setTurns([])
            setHistory(null)
          }}
        >
          +
        </button>
        <button
          type="button"
          className="chrome-act"
          title="past threads"
          aria-label="past threads"
          onClick={() => {
            sound(history ? 'unmode' : 'mode')
            // Only open once there is a store to ask. Before that the list
            // came back empty and the drawer said "nothing yet", which is a
            // claim about your history made without reading it.
            if (history) return setHistory(null)
            const store = engine.current?.store
            if (store) setHistory(store.threads())
          }}
        >
          ⏱
        </button>

        {/* Anything still running. A command that keeps going after it returns
            has to be stoppable from outside the sentence that started it —
            otherwise the only way to end it is to remember the exact words,
            which is not an interface. */}
        {COMMANDS.filter((c) => c.running?.() && c.controls?.length).map((c) => (
          <span key={c.id} className="live" title={`${c.name} is running`}>
            <span className="live-name">{c.name}</span>
            {c.controls?.map((ctl) => (
              <button
                key={ctl.action}
                type="button"
                className="live-act"
                title={ctl.title}
                aria-label={ctl.title}
                onClick={() => {
                  c.control?.(ctl.action)
                  sound('unmode')
                  // Nothing here knows what the command did, so the chip is
                  // re-read rather than told: one tick later `running()` is
                  // whatever it now is.
                  setTick((n) => n + 1)
                }}
              >
                {ctl.glyph}
              </button>
            ))}
          </span>
        ))}
        <div className="status">{busy ? 'thinking' : status}</div>
        {/* Sound is on by default, which is only defensible if turning it off
            takes one click and stays off. Three bars that flatten to one —
            a level, not a stock speaker, because the app has no other icons
            and one borrowed glyph would look borrowed. */}
        <button
          type="button"
          className={`quiet${quiet ? ' quiet--off' : ''}`}
          aria-pressed={quiet}
          aria-label={quiet ? 'turn sound on' : 'turn sound off'}
          title={quiet ? 'sound off' : 'sound on'}
          onClick={() => {
            const next = !quiet
            setMuted(next)
            setQuiet(next)
            // Coming back on, say so — silence is not confirmation.
            if (!next) sound('mark')
          }}
        >
          <span className="quiet-bar" />
          <span className="quiet-bar" />
          <span className="quiet-bar" />
        </button>
      </div>

      {/* An app has the page. The breadcrumb is the shell's, not the app's:
          every app gets a way out whether or not it remembered to draw one,
          and it sits clear of the traffic lights the window insets for. */}
      {held && (
        <>
          <nav className="crumbs" aria-label="breadcrumb">
            <button
              type="button"
              className="crumb"
              onClick={() => {
                sound('unmode')
                setHeld(null)
              }}
            >
              conversation
            </button>
            {/* The app's own trail, or just its name until it says otherwise.
                One row, so there is never a second back-arrow disagreeing
                with this one about where "back" is. */}
            {(crumbs.length ? crumbs : [{ label: held.entry.name }]).map((c, i, all) => (
              <Fragment key={`${c.label}-${i}`}>
                <span className="crumb-sep" aria-hidden>›</span>
                {c.go && i < all.length - 1 ? (
                  <button type="button" className="crumb" onClick={c.go}>
                    {c.label}
                  </button>
                ) : (
                  <span className="crumb crumb--here">{c.label}</span>
                )}
              </Fragment>
            ))}
          </nav>
          <Held entry={held.entry} argument={held.argument} onExit={() => setHeld(null)} />
        </>
      )}

      <div className="stage" hidden={!!held}>
        {turns.length === 0 && !live && (
          <div className="turn turn-agent">
            <River nodes={parse('say something. the page will follow.')} />
          </div>
        )}
        {/* Past conversations, over the river rather than beside it.
            Choosing one replays its turns as plain text — the typography and
            colour of a turn are derived from the sentence, so they rebuild
            themselves; what is not rebuilt is the step list, which belonged to
            a run that has finished and would be a fiction to show again. */}
        {history && (
          <div className="threads" role="listbox">
            {history.length === 0 && <div className="threads-empty">nothing yet</div>}
            {history.map((h) => (
              <button
                key={h.id}
                type="button"
                role="option"
                aria-selected={false}
                className="threads-row"
                onMouseDown={(ev) => {
                  ev.preventDefault()
                  const store = engine.current?.store
                  if (!store) return
                  sound('open')
                  store.resume(h.id)
                  setTurns(
                    store.threadTurns(h.id).map((t) => ({
                      role: t.role as 'user' | 'agent',
                      text: t.text,
                      nodes: parse(t.text),
                      vibe: NEUTRAL,
                    })),
                  )
                  setHistory(null)
                }}
              >
                <span className="threads-title">{h.title}</span>
                <span className="threads-meta">{h.turns} turn{h.turns === 1 ? '' : 's'}</span>
              </button>
            ))}
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i} data-turn={i} className={`turn turn-${t.role}`}>
            {/* Kept with the answer, not just shown while it works: how a
                thing was found is part of the answer, and scrolling back to a
                claim should show what it rests on. */}
            {t.steps && <Steps badges={t.steps} status={null} />}
            <River nodes={t.nodes} />
          </div>
        ))}
        {(steps.length > 0 || status_ || live !== null) && (
          <div className="turn turn-agent turn-live">
            <Steps badges={steps} status={status_} />
            {/* Words animate in as they arrive; marks and glyphs wait for the
                settled line, so nothing decorates a sentence still moving. */}
            {live !== null && (
              <Streaming
                text={live}
                bank={engine.current?.bank}
                emoji={emojiBank()}
                  />
            )}
          </div>
        )}
        <div ref={bottom} />
      </div>

      {/* No composer while an app has the page. Not hidden — absent. A field
          that still took Enter behind a surface would be a second interface
          running underneath the one you are looking at. */}
      {!held && (
        <Composer onSend={send} onCommand={runCommandTurn} disabled={busy} />
      )}
    </>
  )
}

/**
 * Draw whatever the app is.
 *
 * The cast is the whole reason this is a component rather than an expression.
 * `App.surface` is typed `unknown` in `pages/sigils.ts` so that the parser, the
 * composer and the renderer — all of which import that file — do not acquire a
 * dependency on React because one of the four namespaces happens to draw
 * itself. The narrowing belongs at the one place that actually renders it, and
 * this is that place.
 */
function Held({
  entry,
  argument,
  onExit,
}: {
  entry: AppEntry
  argument: string
  onExit: () => void
}) {
  const Surface = entry.surface as Surface
  return <Surface argument={argument} onExit={onExit} />
}

/**
 * The composer, which is also every skill's input.
 *
 * Typing `/` opens the picker: a row of toned chips above the field, filtered
 * as you keep typing. Choosing one does not insert text — it puts the composer
 * *into* that skill, so the placeholder becomes the skill's own question and
 * the next thing entered is the argument. A skill that needs no argument runs
 * the moment it is chosen.
 *
 * Escape or deleting back past the start leaves the mode. Nothing is modal
 * beyond the placeholder and the tone, because a composer that traps you is
 * worse than one that occasionally forgets what you meant.
 */
/** What a chosen verb does with what you type after it. */
type Pending =
  | { kind: 'command'; command: Command; label: string; needs: string }
  | { kind: 'search'; app: AppEntry; label: string; needs: string }

/**
 * The three things you can do with a place.
 *
 * Written here rather than declared per app, because they are not a property of
 * a deck or a note — they are the three things anyone ever wants from a
 * collection, and an app that offered a different set would be answering a
 * question nobody asked. `create` appears only when the app names a maker.
 */
const VERBS = (app: AppEntry, maker: Command | undefined) =>
  [
    { id: 'browse', gives: `open ${app.name}s`, needs: '' },
    { id: 'search', gives: `find one`, needs: `which ${app.name}?` },
    ...(maker ? [{ id: 'create', gives: `a new ${app.name}`, needs: maker.needs || `what should it be about?` }] : []),
  ] as const

function Composer({
  onSend,
  onCommand,
  disabled,
}: {
  onSend: (t: string) => void
  onCommand: (command: Command, argument: string) => void
  disabled: boolean
}) {
  const [value, setValue] = useState('')
  /**
   * What the composer is collecting an argument for.
   *
   * A command is the ordinary case. `search` is the other one: an app can be
   * opened *at* something, and the field collects the something — same field,
   * same ghost text, different thing at the end of it, so the shape has to say
   * which rather than being inferred from the entry.
   */
  const [mode, setMode] = useState<Pending | null>(null)
  /**
   * An app whose verb has not been chosen yet.
   *
   * `/deck` alone is ambiguous — show me my decks, find one, or make one — and
   * the old behaviour picked the first reading silently. While this is set the
   * picker lists verbs instead of entries, which is the whole two-step.
   */
  const [verbing, setVerbing] = useState<AppEntry | null>(null)
  const [at, setAt] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const shell = useRef<HTMLFormElement>(null)

  /**
   * The composer tells the page how tall it is.
   *
   * It floats over the thread, so the thread has to end above it — and the
   * height is not a constant anyone can write down: the skill picker opens, a
   * mode label appears, the window narrows and the input wraps to a bigger
   * type size. Reserving a guessed number is how the last line of an answer
   * ends up underneath the input, which is exactly what it was doing.
   */
  useLayoutEffect(() => {
    const el = shell.current
    if (!el) return
    const measure = () =>
      document.documentElement.style.setProperty('--composer-h', `${el.offsetHeight}px`)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // The picker is open exactly while the field begins with a sigil, which means
  // it needs no open/closed state of its own to fall out of sync with the text.
  // Which sigil decides what is searched, so `/` and `@` are two pickers that
  // happen to share one piece of chrome.
  const lead = value.slice(0, 1)
  const picking = !mode && isSigil(lead)
  const sigil = picking ? (lead as Sigil) : null

  /**
   * What has been typed after the sigil, split where it matters.
   *
   * A command's name is one token, so everything past the first space is its
   * argument — which is what makes `/research why is the sky blue` a thing you
   * can type in one go rather than a thing you pick and then type into. Before
   * this, that string matched no command at all (the whole of it was compared
   * against the names), the picker emptied, and Enter did nothing: the field
   * looked like it was working right up until it silently wasn't.
   *
   * `@` is not split, because a find query is free text and "hugging face" is
   * two words about one thing.
   */
  const rest = value.slice(1)
  const cut = sigil === '/' ? rest.indexOf(' ') : -1
  const query = cut >= 0 ? rest.slice(0, cut) : rest
  const carried = cut >= 0 ? rest.slice(cut + 1) : ''

  /**
   * What `@` found, which is not the same kind of thing as what `/` matched.
   *
   * `/` is a registry lookup and is synchronous; `@` is two indexed reads and
   * is not. Keeping them in one `matches` expression would have made the whole
   * picker async for the sake of one namespace, and a `/` picker that arrived a
   * frame after the keystroke would be a worse `/` picker.
   *
   * Stale results are dropped rather than rendered: two keystrokes in flight
   * can settle out of order, and a picker briefly showing the results for the
   * previous query is the kind of bug nobody reports and everybody notices.
   */
  const [found, setFound] = useState<Invocable[]>([])
  useEffect(() => {
    if (sigil !== '@') {
      setFound([])
      return
    }
    let live = true
    void findAcross(query, (app, id) =>
      dispatchEvent(new CustomEvent(OPEN_APP, { detail: { id: app, argument: id } })),
    ).then((rows) => {
      if (live) setFound(rows)
    })
    return () => {
      live = false
    }
  }, [sigil, query])

  /**
   * The verbs, when a place has been chosen and its intention has not.
   *
   * They stand in for `matches` rather than living beside it, so the arrow
   * keys, the highlight, Enter and the drawer itself are one mechanism at both
   * levels. Two lists with two sets of handlers is how the second level ends up
   * subtly not working like the first.
   */
  const verbs = verbing ? VERBS(verbing, COMMANDS.find((c) => c.id === verbing.makes)) : []
  const matches = verbing ? [] : sigil === '@' ? found : sigil ? match(sigil, query) : []
  const rows: { id: string; name: string; hint: string; opens?: boolean }[] = verbing
    ? verbs.map((v) => ({ id: v.id, name: v.id, hint: v.needs || v.gives }))
    : matches.map((m) => ({
        id: m.id,
        name: m.sigil === '/' ? `/${m.id}` : m.name,
        hint: m.needs || m.gives,
        opens: 'surface' in m,
      }))
  const highlighted = rows[Math.min(at, rows.length - 1)]
  const open = picking || !!verbing

  // The input is never `disabled` — disabling a focused field blurs it, and
  // the caret would be lost on every send. Sends are guarded on submit instead.
  useEffect(() => {
    if (!disabled) input.current?.focus()
  }, [disabled])

  /**
   * `argument` is whatever was already typed after the name.
   *
   * A command chosen with its argument in hand runs, rather than latching the
   * composer and asking for what it has just been given — the latch exists to
   * collect something missing, and there is nothing missing.
   */
  const choose = (entry: Invocable, argument = '') => {
    setValue('')
    setAt(0)
    // An app takes the page immediately rather than going through the mode
    // below, because the mode below exists to collect an argument and an app
    // that asked a question before showing itself would be a doorman. It gets
    // whatever was typed after the sigil, which is empty in the ordinary case.
    // An app is a place, and a place is at least three different intentions.
    // Opening it on choice answered one of them by guessing; the verbs ask.
    // An argument typed inline is unambiguous — `/deck rust` means find it —
    // so that skips the step it would only have answered.
    if ('enter' in entry) {
      setMode(null)
      if (argument.trim()) {
        entry.enter(argument.trim())
        return
      }
      sound('mode')
      setVerbing(entry)
      return
    }
    // A found thing opens; there is nothing to collect and nothing to run.
    if (entry.sigil === '@') {
      setMode(null)
      entry.open()
      return
    }
    if (immediate(entry) || argument.trim()) {
      // Nothing to ask for, or nothing left to ask for.
      setMode(null)
      onCommand(entry, argument.trim())
      return
    }
    // The composer becoming a command's input is the one interface change worth
    // a two-part sound: it latches, and a latch says so.
    sound('mode')
    setMode({ kind: 'command', command: entry, label: `/${entry.id}`, needs: entry.needs })
  }

  /** A verb chosen for the app in `verbing`. */
  const takeVerb = (verb: string) => {
    const app = verbing
    if (!app) return
    setVerbing(null)
    setValue('')
    setAt(0)
    if (verb === 'browse') {
      app.enter('')
      return
    }
    sound('mode')
    if (verb === 'search') {
      setMode({ kind: 'search', app, label: `/${app.id} search`, needs: `which ${app.name}?` })
      return
    }
    const maker = COMMANDS.find((c) => c.id === app.makes)
    if (maker && 'run' in maker) {
      setMode({ kind: 'command', command: maker, label: `/${app.id} create`, needs: maker.needs })
    }
  }

  return (
    <form
      ref={shell}
      className={`composer${mode ? ' composer--skill' : ''}${disabled ? ' composer--busy' : ''}`}
      onSubmit={(e) => {
        e.preventDefault()
        if (disabled) return
        if (verbing) {
          if (highlighted) takeVerb(highlighted.id)
          return
        }
        if (picking) {
          if (highlighted) choose(matches[Math.min(at, matches.length - 1)], carried)
          return
        }
        const v = value.trim()
        if (!v) return
        setValue('')
        if (mode) {
          const pending = mode
          setMode(null)
          if (pending.kind === 'command') onCommand(pending.command, v)
          else pending.app.enter(v)
        } else {
          onSend(v)
        }
        input.current?.focus()
      }}
    >
      {open && (
        <div className="picker" role="listbox">
          {/* Which place the verbs belong to. Without it the second level is
              three bare words with nothing saying what they act on. */}
          {verbing && <div className="picker-of">/{verbing.id}</div>}
          {rows.map((r, i) => (
            <button
              key={r.id}
              type="button"
              role="option"
              aria-selected={r === highlighted}
              className={`picker-skill${r === highlighted ? ' picker-skill--on' : ''}`}
              // Mouse down rather than click: click fires after blur, and the
              // blur would have already closed the picker underneath it.
              onMouseDown={(e) => {
                e.preventDefault()
                if (verbing) takeVerb(r.id)
                else choose(matches[i], carried)
              }}
            >
              <span className="picker-name">{r.name}</span>
              {/* What to type next, when there is something to type. `needs` is
                  the question the command asks and `gives` is what comes back;
                  for someone deciding what to do, the question is the useful
                  half and the answer is the consolation prize. */}
              <span className="picker-gives">{r.hint}</span>
              {r.opens && <span className="picker-opens" aria-hidden>↗</span>}
            </button>
          ))}
          {/* An empty namespace says so rather than showing nothing.
              Typing `$` and getting no response at all reads as the key not
              working; saying there are none yet is the difference between a
              broken affordance and an honest one — and both `$` and `@` are
              genuinely empty right now. */}
          {!rows.length && sigil && (
            <div className="picker-empty">no {SIGILS[sigil].kind}s yet</div>
          )}
        </div>
      )}

      <div className="composer-field">
      {/* Written as `/id` rather than as the display name, because it is the
          text that would be in the field if the picker had not swallowed it —
          and the ghost text after it is the rest of the same line. */}
      {mode && <span className="composer-mode">{mode.label}</span>}
      <input
        ref={input}
        autoFocus
        value={value}
        placeholder={disabled ? 'thinking' : mode ? mode.needs : 'say something'}
        onChange={(e) => {
          // Every keystroke pushes the floor and ticks. The spring and the
          // throttle do the rest — held keys cannot buzz.
          const typed = e.target.value.length > value.length
          nudge(typed ? 1 : 0.5)
          sound('type', typed ? 1 : 0.8)
          setValue(e.target.value)
          setAt(0)
        }}
        onKeyDown={(e) => {
          // One Escape branch, not two. A second one further down for the
          // verb step was unreachable behind this, and the verbs stayed open
          // with no way out but the mouse — the kind of bug that only shows up
          // if you actually press the key.
          if (e.key === 'Escape') {
            if (mode || verbing) sound('unmode')
            setMode(null)
            setVerbing(null)
            setValue('')
            return
          }
          // Backspacing out of an empty field leaves the skill, which is the
          // gesture people already use to escape a chip in every other field.
          if (e.key === 'Backspace' && mode && !value) {
            sound('unmode')
            setMode(null)
            return
          }
          // Backspace out of the verbs and back to the list of places, which
          // is where the same key already takes you out of a latched command.
          if (e.key === 'Backspace' && verbing && !value) {
            sound('unmode')
            setVerbing(null)
            setValue('/')
            setAt(0)
            return
          }
          if (!rows.length) return
          if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
            e.preventDefault()
            sound('type', 0.7)
            setAt((i) => (i + 1) % rows.length)
          } else if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
            e.preventDefault()
            sound('type', 0.7)
            setAt((i) => (i - 1 + rows.length) % rows.length)
          }
        }}
      />
      {/* No send button. The key that sends it is the key you are already on,
          so the affordance is a reminder rather than a target — it appears
          when there is something to send and says which key. */}
      <span className={`composer-return${value.trim() ? ' composer-return--on' : ''}`} aria-hidden>
        ⏎
      </span>
      </div>
    </form>
  )
}
