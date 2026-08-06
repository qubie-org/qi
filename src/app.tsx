import { useCallback, useEffect, useRef, useState } from 'react'
import { NAVIGATE, River } from './inline/Render'
import { countWords, placeChip, shapeFor } from './inline/compose'
import { Streaming } from './inline/Streaming'
import { parse } from './inline/parse'
import type { Node } from './inline/types'
import { embed, loadTable, type Table } from './engine/embed'
import { buildBank, place, type Bank } from './engine/place'
import { buildAxes, Drift, type Axes } from './engine/vibe'
import { emojiBank, loadEmoji } from './engine/emoji'
import { applyVibe, type Vibe } from './engine/theme'
import { trackScrollTheme, type Snapshot } from './engine/scrollTheme'
import { Needle } from './engine/needle'
import { Agent, type AgentEvent } from './agent/loop'
import { Digest } from './agent/digest'
import { badgeFor, Steps, type Badge } from './agent/Steps'
import { openStore, type Store } from './store/db'
import { bootSandbox, buildRouter, factNodes, statesQuantity, type Fact, type Router } from './ground'
import { pageFromFact } from './pages/build'
import { runAction, registerSkills, parseAction } from './pages/actions'
import { autolink } from './pages/autolink'
import { address, resolve } from './pages/space'
import { reduce } from './ground/sandbox'

/**
 * Each turn carries the vibe it was written under, so scroll can restore it,
 * and the steps it took, so a multi-move answer keeps its account of itself
 * after the live row has gone.
 */
type Turn = { role: 'user' | 'agent'; nodes: Node[]; text: string; vibe: Vibe; steps?: Badge[] }
type Engine = { table: Table; bank: Bank; axes: Axes; drift: Drift; router: Router; store: Store }

const hasCode = (ns: Node[]): boolean =>
  ns.some((n) => n.t === 'code' || ('kids' in n && hasCode(n.kids)))

/** Loaded at most once, and only if a conversation ever turns to code. */
let codeTablePromise: Promise<Table> | null = null
async function ensureCodeTable(): Promise<Table | undefined> {
  codeTablePromise ??= loadTable('/models/potion-code')
  try {
    return await codeTablePromise
  } catch (err) {
    console.warn('potion-code unavailable', err)
    codeTablePromise = null
    return undefined
  }
}

export default function App() {
  const [turns, setTurns] = useState<Turn[]>([])
  const [status, setStatus] = useState('waking')
  const [busy, setBusy] = useState(false)
  /** Reply text as it arrives, before the marks are placed on it. */
  const [live, setLive] = useState<string | null>(null)
  /** Steps of the turn in flight, and what the agent says it is doing. */
  const [steps, setSteps] = useState<Badge[]>([])
  const [status_, setStatus_] = useState<string | null>(null)
  const engine = useRef<Engine | null>(null)
  const digest = useRef(new Digest())
  const agent = useRef(new Agent(digest.current))
  const needle = useRef(new Needle())
  const bottom = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let alive = true
    ;(async () => {
      // The semantic layer first — on its own it is enough to run the visuals.
      const [table, store] = await Promise.all([loadTable('/models/potion'), openStore()])
      if (!alive) return
      engine.current = {
        table,
        bank: buildBank(table),
        axes: buildAxes(table),
        drift: new Drift(),
        router: buildRouter(table),
        store,
      }
      // ~14ms to embed 1,386 labels; the model is never told they exist.
      void loadEmoji(table)
      registerSkills()
      setStatus('loading voice')

      // Both servers, together. The summariser is not optional to the agent
      // loop working, but it is optional to it working *well* — without it the
      // badges fall back to verb-and-argument and tool results reach the agent
      // uncompressed, so a missing 800M model degrades rather than breaks.
      const [voice] = await Promise.allSettled([agent.current.load(), digest.current.load()])
      if (voice.status === 'rejected') console.error('agent failed', voice.reason)

      // Router and sandbox come up together; neither blocks the other.
      if (alive) setStatus('loading tools')
      await Promise.allSettled([needle.current.load(), bootSandbox()])
      if (alive) setStatus(agent.current.ready ? 'ready' : 'visuals only')

      if (import.meta.env.DEV) {
        // Handles for poking the pipeline from the console.
        Object.assign(window, {
          toki: { engine: engine.current, needle: needle.current, agent: agent.current, digest: digest.current, store, reduce, bootSandbox },
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

      // A `do/` address runs rather than opens. The kind decides what following
      // a link means — the one idea from TinyOS worth taking wholesale.
      if (parseAction(addr)) {
        const result = await runAction(addr, {
          table: e.table,
          router: e.router,
          needle: needle.current as never,
        })
        if (result.kind === 'fact') {
          const page = pageFromFact(result.fact, result.query)
          const body = page.image ? `![${page.title}](${page.image}) ${page.body}` : page.body
          setTurns((t) => [
            ...t,
            {
              role: 'agent',
              text: `${page.title}\n${page.body}`,
              vibe,
              nodes: place(parse(`[[${page.title}|loud]]\n${body}`), e.table, e.bank, { seed: t.length }),
            },
          ])
        } else if (result.kind === 'miss') {
          setTurns((t) => [
            ...t,
            { role: 'agent', text: result.reason, vibe,
              nodes: parse(`${result.reason}. [see what there is](${address('skills')})`) },
          ])
        }
        return
      }

      const hit = resolve(addr, e.table)
      if (!hit) {
        setTurns((t) => [
          ...t,
          { role: 'agent', text: `nothing at ${addr}`, vibe,
            nodes: parse(`nothing at ${addr}. [see what there is](${address('skills')})`) },
        ])
        return
      }
      const { page } = hit
      const body = page.image ? `![${page.title}](${page.image}) ${page.body}` : page.body
      setTurns((t) => [
        ...t,
        {
          role: 'agent',
          text: `${page.title}\n${page.body}`,
          vibe,
          nodes: place(parse(`[[${page.title}|loud]]\n${body}`), e.table, e.bank, {
            seed: t.length,
            emoji: emojiBank(),
          }),
        },
      ])
    }
    addEventListener(NAVIGATE, onNavigate)
    return () => removeEventListener(NAVIGATE, onNavigate)
  }, [])

  useEffect(() => {
    if (!stick.current) return
    // Instant while tokens stream in; smooth animations would queue up and
    // fight each other several times a second.
    bottom.current?.scrollIntoView({ behavior: live === null ? 'smooth' : 'auto', block: 'end' })
  }, [turns, live])

  const send = useCallback(
    async (text: string) => {
      const e = engine.current
      if (!e || busy) return
      setBusy(true)
      setSteps([])
      setStatus_(null)

      // The room drifts toward what was just said, before the reply lands.
      const userVibe = e.drift.push(text, e.table, e.axes)
      applyVibe(userVibe)
      e.store.addTurn('user', text, embed(e.table, text))
      setTurns((t) => [
        ...t,
        {
          role: 'user',
          text,
          vibe: userVibe,
          nodes: place(parse(text), e.table, e.bank, { maxMotifs: 1, decorate: false, emoji: emojiBank() }),
        },
      ])

      // The agent decides what to do. Grounding is no longer run in front of
      // the model on a routing guess — it is one of four things the model can
      // choose to do, and it can choose to do it twice, or not at all, or to
      // recall something it already found instead.
      let reply = ''
      let facts: Fact[] = []
      const taken: Badge[] = []
      try {
        if (agent.current.ready) {
          const out = await agent.current.run(
            text,
            { table: e.table, router: e.router, store: e.store, needle: needle.current as never },
            (ev: AgentEvent) => {
              if (ev.t === 'token') return setLive(ev.text)
              if (ev.t === 'status') return setStatus_(ev.text)
              // A step is replaced in place when it resolves, so the badge that
              // appeared as "looking up" becomes the name the summariser gave it
              // without the row reflowing.
              const badge = badgeFor(ev, e.table, e.bank)
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
        setLive(null)
        setStatus_(null)
      }

      // The first fact found is the one cited; later steps refined it.
      const fact = facts[0] ?? null
      // If the model is unreachable a fact it managed to fetch still answers.
      if (!reply) reply = fact ? fact.value : 'no local model server is running.'

      const replyVibe = e.drift.push(reply, e.table, e.axes)
      applyVibe(replyVibe)
      e.store.addTurn('agent', reply, embed(e.table, reply))

      // The topic line is rewritten from the turns themselves, in the
      // background. It is what the *next* turn is given instead of a
      // transcript, so it must not be on the critical path of this one.
      void (async () => {
        const topic = await digest.current.topic(e.store.recentTurns(6))
        if (topic) e.store.putNote('topic', topic, null, embed(e.table, topic))
      })()

      // potion-code is 17 MB and most conversations never need it, so it is
      // fetched the first time a reply actually contains code.
      const parsed = parse(reply)
      const code = hasCode(parsed) ? await ensureCodeTable() : undefined

      setTurns((t) => {
        // Built without mutation: this updater can run more than once.
        // Linked after placement so a mark and a link never fight for the same
        // word, and only ever to pages that actually exist.
        const placed = autolink(place(parsed, e.table, e.bank, { seed: t.length, codeTable: code }))
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
              },
              e.table,
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

  return (
    <>
      <div className="bg" />
      <div className="status">{busy ? 'thinking' : status}</div>

      <div className="stage">
        {turns.length === 0 && !live && (
          <div className="turn turn-agent">
            <River nodes={parse('say something. the page will follow.')} />
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
            {live !== null && <Streaming text={live} />}
          </div>
        )}
        <div ref={bottom} />
      </div>

      <Composer onSend={send} disabled={busy} />
    </>
  )
}

function Composer({ onSend, disabled }: { onSend: (t: string) => void; disabled: boolean }) {
  const [value, setValue] = useState('')
  const input = useRef<HTMLInputElement>(null)

  // The input is never `disabled` — disabling a focused field blurs it, and
  // the caret would be lost on every send. Sends are guarded on submit instead.
  useEffect(() => {
    if (!disabled) input.current?.focus()
  }, [disabled])

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault()
        const v = value.trim()
        if (!v || disabled) return
        setValue('')
        onSend(v)
        input.current?.focus()
      }}
    >
      <input
        ref={input}
        autoFocus
        value={value}
        placeholder={disabled ? 'thinking' : 'say something'}
        onChange={(e) => setValue(e.target.value)}
      />
    </form>
  )
}
