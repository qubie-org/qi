import { Fragment, useEffect, useRef, type JSX } from 'react'
import { animate, stagger, svg as animeSvg } from 'animejs'
import { DECO_SVG } from './Deco'
import { Motif } from './Motifs'
import type { Node } from './types'
import { addressOf, SCHEME } from '../pages/space'

/**
 * Internal navigation is announced as a DOM event rather than threaded through
 * props: `node()` is a plain recursive function, and passing a callback down
 * every branch of it to reach one link type is worse than one listener.
 */
export const NAVIGATE = 'toki:navigate'
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

    case 'strong':
      return <span key={k} className="i-strong">{kids(n.kids)}</span>

    case 'strike':
      return <span key={k} className="i-strike">{kids(n.kids)}</span>

    case 'code':
      return <span key={k} className="i-code">{n.v}</span>

    case 'hl':
      return <span key={k} className="i-hl">{kids(n.kids)}</span>

    case 'link': {
      // `toki:` addresses stay inside the page; everything else is the web.
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
      // opens the page it belongs to, so an image is an address like anything
      // else rather than a dead end.
      //
      // Composition follows the picture's real shape rather than forcing every
      // image into one slot: a panorama earns a band, a portrait floats and the
      // text sets around it, a square sits in the line.
      return (
        <img
          key={k}
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
          onClick={() => navigateTo(n.alt)}
        />
      )

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
    <p className="river" ref={ref}>
      {nodes.map(node)}
    </p>
  )
}
