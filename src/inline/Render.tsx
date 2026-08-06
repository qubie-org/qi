import { createContext, Fragment, useContext, useEffect, useRef, useState, type JSX } from 'react'
import { animate, stagger, svg as animeSvg } from 'animejs'
import { DECO_SVG } from './Deco'
import { Motif } from './Motifs'
import type { Node } from './types'
import { Callout, type Aside } from './Annotation'
import { Preview, useHoverPreview, type Previewed } from './Preview'
import { sound } from '../engine/sound'
import { find, SIGILS } from '../pages/sigils'

/**
 * How a picture asks for its callout to be opened.
 *
 * A context rather than a prop because `node` is a plain recursive function,
 * not a component tree — threading a handler through every branch of it to
 * reach one leaf would be the tail wagging the dog.
 */
type AsideHandler = (el: HTMLElement, aside: Aside) => void
const AsideContext = createContext<AsideHandler | null>(null)

/**
 * Hovering a picture enlarges it. Same reasoning as the aside context: `node`
 * is a recursive function rather than a component tree, so the one leaf that
 * needs a handler reaches for it rather than having it threaded down.
 */
type HoverHandler = { enter: (el: HTMLElement, image: Previewed) => void; leave: () => void }
const HoverContext = createContext<HoverHandler | null>(null)

function Chip({ n }: { n: Extract<Node, { t: 'chip' }> }) {
  const onAside = useContext(AsideContext)
  const hover = useContext(HoverContext)
  return (
    <img
      className={`i-chip i-chip--${n.shape ?? 'inline'}`}
      // The picture's own proportions, never the stylesheet's guess.
      style={n.w && n.h ? { aspectRatio: `${n.w} / ${n.h}` } : undefined}
      src={n.src}
      alt={n.alt}
      loading="lazy"
      decoding="async"
      // Cross-origin isolation is on for Wasmer, and COEP blocks every
      // third-party image that does not opt in. Requesting it in CORS mode
      // satisfies that for any host sending Access-Control-Allow-Origin,
      // which the image sources here do.
      crossOrigin="anonymous"
      referrerPolicy="no-referrer"
      onClick={(e) => {
        sound(n.aside && onAside ? 'open' : 'mark')
        return n.aside && onAside ? onAside(e.currentTarget as HTMLElement, n.aside) : navigateTo(n.alt)
      }}
      onMouseEnter={(e) =>
        hover?.enter(e.currentTarget as HTMLElement, { src: n.src, alt: n.alt, w: n.w, h: n.h })
      }
      onMouseLeave={() => hover?.leave()}
    />
  )
}
import { addressOf, SCHEME } from '../pages/space'

/**
 * Internal navigation is announced as a DOM event rather than threaded through
 * props: `node()` is a plain recursive function, and passing a callback down
 * every branch of it to reach one link type is worse than one listener.
 */
export const NAVIGATE = 'qi:navigate'
/** A term was pressed: say more about this. */
export const EXPAND = 'qi:expand'
/** A skill was pressed in the text, rather than picked in the composer. */
export const INVOKE = 'qi:invoke'

const expandOn = (topic: string) => dispatchEvent(new CustomEvent(EXPAND, { detail: topic }))
const invoke = (verb: string) => dispatchEvent(new CustomEvent(INVOKE, { detail: verb }))
export const navigateTo = (id: string) =>
  dispatchEvent(new CustomEvent(NAVIGATE, { detail: id }))

/**
 * AST → DOM. The one rule this file exists to enforce: it never emits a
 * block-level box. Everything is a span, an svg, or an img sitting in the
 * text flow, so the whole turn stays a single river of type.
 */
function node(n: Node, i: number): JSX.Element {
  const k = String(i)
  switch (n.t) {
    case 'text':
      return <Fragment key={k}>{n.v}</Fragment>

    case 'brk':
      return <br key={k} />

    case 'item':
      // Inline-level, full width: gives each item its own line and lets a
      // wrapped second line hang under the text rather than under the marker.
      return <span key={k} className="i-item">{kids(n.kids)}</span>

    case 'slot':
      // Resolved slots render whatever they became. An unresolved one shows
      // its intent rather than vanishing — a dropped step is worse than a
      // visible one.
      return (
        <span key={k} className={n.kids.length ? 'i-slot' : 'i-slot i-slot--open'}>
          {n.kids.length ? kids(n.kids) : n.intent}
        </span>
      )

    case 'em':
      return <span key={k} className="i-em">{kids(n.kids)}</span>

    case 'term':
      // A press asks for more about it. Nothing else — it does not navigate,
      // because there is usually nowhere yet to navigate to; the answer is
      // written when it is asked for.
      return (
        <button
          key={k}
          type="button"
          className="i-term"
          title={`more about ${n.topic}`}
          onClick={() => {
            sound('mark')
            expandOn(n.topic)
          }}
        >
          {kids(n.kids)}
        </button>
      )

    /**
     * `/command`, `$skill`, `@app`.
     *
     * One case for all three: the affordance is identical — a small chip you
     * can press — and only the sigil drawn and the namespace dispatched into
     * differ. Three cases here would be three places for the sigils to drift
     * apart from `pages/sigils.ts`, which is the file that is supposed to be
     * the only answer to what a leading character means.
     *
     * An unknown id still renders. The model can write `/weather` at any time,
     * and a chip that is plainly a chip and does nothing when pressed is more
     * honest than silently printing it as prose — it says the app knows what
     * kind of thing that is and does not have one.
     */
    case 'invoke': {
      const known = find(n.id)
      return (
        <button
          key={k}
          type="button"
          className={`i-invoke i-invoke--${SIGILS[n.sigil].kind}${known ? '' : ' i-invoke--unknown'}`}
          title={known ? `${SIGILS[n.sigil].kind}: ${known.name}` : `no ${SIGILS[n.sigil].kind} called ${n.id}`}
          disabled={!known}
          onClick={() => {
            sound(n.sigil === '/' ? 'mode' : 'mark')
            invoke(`${n.sigil}${n.id}`)
          }}
        >
          <span className="i-sigil">{n.sigil}</span>
          {known?.name ?? n.id}
        </button>
      )
    }

    case 'strong':
      return <span key={k} className="i-strong">{kids(n.kids)}</span>

    case 'strike':
      return <span key={k} className="i-strike">{kids(n.kids)}</span>

    case 'code':
      return <span key={k} className="i-code">{n.v}</span>

    case 'hl':
      return <span key={k} className="i-hl">{kids(n.kids)}</span>

    case 'link': {
      // `qi:` addresses stay inside the page; everything else is the web.
      const internal = n.href.startsWith(SCHEME)
      return internal ? (
        <a
          key={k}
          className="i-link i-link--internal"
          href={n.href}
          onClick={(e) => {
            e.preventDefault()
            // addressOf decodes; slicing the scheme by hand left `do%2Fweather`
            // and every action link missed.
            navigateTo(addressOf(n.href) ?? '')
          }}
        >
          {kids(n.kids)}
        </a>
      ) : (
        <a key={k} className="i-link" href={n.href} target="_blank" rel="noreferrer noopener">
          {kids(n.kids)}
        </a>
      )
    }

    case 'motif':
      return <Motif key={k} kind={n.kind} />

    case 'emoji':
      // Sized to the type it sits in and labelled for screen readers, which
      // otherwise announce the raw codepoint name.
      return (
        <span key={k} className="i-emoji" role="img" aria-label={n.label || n.glyph}>
          {n.glyph}
        </span>
      )

    case 'chip':
      // img5 — a picture riding the baseline. Never a block image. Clicking one
      // opens a callout about it when it has anything to say, and otherwise
      // opens the page it belongs to, so an image is never a dead end.
      //
      // Composition follows the picture's real shape rather than forcing every
      // image into one slot: a panorama earns a band, a portrait floats and the
      // text sets around it, a square sits in the line.
      return <Chip key={k} n={n} />

    case 'src':
      // Attribution, not narration: small, quiet, riding above the baseline.
      return n.href ? (
        <a key={k} className="i-src" href={n.href} target="_blank" rel="noreferrer noopener">
          {n.label}
        </a>
      ) : (
        <span key={k} className="i-src">{n.label}</span>
      )

    case 'sub': {
      // img4 — the character is replaced by the glyph, spacing preserved.
      const text = n.kids.map((c) => (c.t === 'text' ? c.v : '')).join('')
      const at = text.toLowerCase().indexOf(n.ch.toLowerCase())
      if (at < 0) return <span key={k}>{kids(n.kids)}</span>
      return (
        <span key={k} className="i-sub">
          {text.slice(0, at)}
          <Motif kind={n.kind} />
          {text.slice(at + 1)}
        </span>
      )
    }

    case 'deco': {
      const overlay = DECO_SVG[n.deco]
      // Tone picks which word-colour from the theme's narrow zone, so several
      // coloured words in a sentence differ without leaving the family.
      const tone = n.tone === undefined ? undefined : `var(--t${(n.tone % 4) + 1})`
      return (
        <span
          key={k}
          className={`i-deco i-deco--${n.deco} i-${n.deco}`}
          style={tone ? ({ '--tone': tone } as React.CSSProperties) : undefined}
        >
          {overlay}
          {kids(n.kids)}
        </span>
      )
    }
  }
}

const kids = (ns: Node[]) => ns.map(node)

export function River({ nodes, animated = true }: { nodes: Node[]; animated?: boolean }) {
  const ref = useRef<HTMLParagraphElement>(null)
  // One open at a time. Two callouts with two leaders crossing each other is
  // exactly the crowding the rest of the page works to avoid.
  const [open, setOpen] = useState<{ el: HTMLElement; aside: Aside } | null>(null)
  const preview = useHoverPreview()

  useEffect(() => {
    if (!ref.current || !animated) return
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const root = ref.current
    const energy = Number(getComputedStyle(root).getPropertyValue('--motion')) || 1

    // Strokes draw themselves on, the way someone would mark up a page.
    const drawn = root.querySelectorAll<SVGPathElement>('.draw')
    if (drawn.length) {
      animate(animeSvg.createDrawable(drawn), {
        draw: ['0 0', '0 1'],
        duration: 700 / energy,
        delay: stagger(90, { start: 260 }),
        ease: 'inOut(2)',
      })
    }

    // The highlight sweeps left to right rather than appearing all at once.
    const swept = root.querySelectorAll<HTMLElement>('.i-hl')
    if (swept.length) {
      animate(swept, {
        backgroundSize: ['0% .34em', '100% .34em'],
        duration: 520 / energy,
        delay: stagger(80, { start: 200 }),
        ease: 'out(3)',
      })
    }

    // Underlines are backgrounds now, so they draw on by growing their width —
    // the same gesture the old stroke animation gave, without the overlay.
    const ruled = root.querySelectorAll<HTMLElement>('.i-deco--underline')
    if (ruled.length) {
      animate(ruled, {
        backgroundSize: ['0% .1em', '100% .1em'],
        duration: 600 / energy,
        delay: stagger(90, { start: 240 }),
        ease: 'inOut(2)',
      })
    }

    // Glyphs and chips pop in after the words have landed.
    const marks = root.querySelectorAll<HTMLElement>('.i-motif, .i-chip, .i-emoji')
    if (marks.length) {
      animate(marks, {
        opacity: [0, 1],
        scale: [0.72, 1],
        duration: 420 / energy,
        delay: stagger(60, { start: 140 }),
        ease: 'out(3)',
      })
    }
  }, [nodes, animated])

  return (
    <AsideContext.Provider
      value={(el, aside) => {
        // A click means the callout, so the preview gets out of the way rather
        // than sitting on top of the thing that just opened.
        preview.hide()
        setOpen((o) => (o?.el === el ? null : { el, aside }))
      }}
    >
      <HoverContext.Provider value={{ enter: preview.enter, leave: preview.leave }}>
        <p className="river" ref={ref}>
          {nodes.map(node)}
        </p>
        {open && <Callout anchor={open.el} aside={open.aside} onClose={() => setOpen(null)} />}
        {preview.shown && <Preview anchor={preview.shown.el} image={preview.shown.image} />}
      </HoverContext.Provider>
    </AsideContext.Provider>
  )
}
