import type { Sigil } from '../pages/sigils'

/** Every glyph qi can drop into the middle of a sentence. */
export const MOTIFS = [
  // No squiggles. A wavy underline means 'spelling error' in every editor
  // anyone has used, so drawing one under a correct word reads as a fault;
  // the sine glyphs had the same problem, looking like a broken rule.
  // What is left is unambiguous: a run of shapes, two arrows, a bullet.
  'shapes',     // img1 — circle / bar / diamond / pill run
  'arrow',      // img3 — long straight arrow
  'curve',      // img4 — curved hand-drawn arrow
  'dot',        // list separator, thematic break
] as const
export type MotifKind = (typeof MOTIFS)[number]
export const isMotif = (s: string): s is MotifKind => (MOTIFS as readonly string[]).includes(s)

/** Ways a run of words can be marked up without becoming a box. */
export const DECOS = [
  'circle',     // img3 — hand-drawn ellipse around it
  'underline',  // img3/img4 — swash underline
  'box',        // thin rectangle
  'color',      // img2 — the word itself takes an accent hue
  'loud',       // what a heading downgrades into: bigger, still inline
  'strike',
  'marker',     // a list's 1. / a. / iv. — ordering kept, box discarded
] as const
export type DecoKind = (typeof DECOS)[number]
export const isDeco = (s: string): s is DecoKind => (DECOS as readonly string[]).includes(s)

export type Node =
  | { t: 'text'; v: string }
  | { t: 'em'; kids: Node[] }
  /**
   * A thing worth pulling on: a proper noun, or a concept the reply leaned on.
   *
   * The marks used to be decoration — a glyph beside a word because the word
   * resembled an arrow. This is the opposite: a mark means the word *does*
   * something, and the only thing it does is ask for more about itself.
   */
  | { t: 'term'; topic: string; kids: Node[] }
  /**
   * An invocation written into the text: `/coin price`, `$something`, `@app`.
   *
   * One node for all three sigils rather than three nearly identical ones,
   * because everything downstream — hit target, colour, press handler — is the
   * same shape and only the verb differs. `sigil` is what the renderer draws
   * and what the press dispatches on, so the three namespaces stay
   * distinguishable without three parallel code paths that can fall out of
   * step. See `pages/sigils.ts` for what each one means.
   */
  | { t: 'invoke'; sigil: Sigil; id: string }
  | { t: 'strong'; kids: Node[] }
  | { t: 'code'; v: string }
  | { t: 'strike'; kids: Node[] }
  | { t: 'hl'; kids: Node[] }
  | { t: 'link'; href: string; kids: Node[] }
  | { t: 'motif'; kind: MotifKind; slot?: number }
  /**
   * An emoji placed automatically by the render layer. The model never writes
   * one and never sees one — same contract as a motif.
   */
  | { t: 'emoji'; glyph: string; label: string }
  | { t: 'deco'; deco: DecoKind; slot?: number; tone?: number; kids: Node[] }
  /** img4: one character inside the word is replaced by a motif. */
  | { t: 'sub'; ch: string; kind: MotifKind; kids: Node[] }
  /** img5: an image riding the baseline. Never a block <img>. */
  | {
      t: 'chip'
      src: string
      alt: string
      /** Real pixel size when the source reports it, so composition can key
       *  off the actual shape instead of assuming one. */
      w?: number
      h?: number
      /** Treatment chosen from shape AND surrounding text — see compose.ts. */
      shape?: 'band' | 'wide' | 'tall' | 'inline'
      /** The small print, shown as a callout when the picture is clicked. */
      aside?: { title: string; body: string; href?: string; tone?: number }
    }
  /** Where a grounded value came from. Set small — it attributes, it doesn't speak. */
  | { t: 'src'; label: string; href?: string }
  /**
   * An open slot: plain-English intent the model wrote, resolved late against
   * the tool / widget / motif banks. The model never learns tool syntax or
   * glyph names — it only learns to want something here.
   */
  | { t: 'slot'; intent: string; kids: Node[] }
  /**
   * One list item: its marker plus everything up to the next break. Grouped so
   * a wrapped line can hang under its own text instead of running back to the
   * margin. Inline-level — still not a block.
   */
  | { t: 'item'; kids: Node[] }
  /** A breath in the river. Not a <p>. */
  | { t: 'brk' }

/** Flatten to plain words — what the embedding layer reads. */
export function plain(nodes: Node[]): string {
  let s = ''
  for (const n of nodes) {
    switch (n.t) {
      case 'text': s += n.v; break
      case 'code': s += n.v; break
      case 'brk': s += ' '; break
      case 'motif': break
      case 'emoji': break
      case 'src': break
      case 'chip': s += n.alt; break
      // An unresolved slot still reads as its intent.
      case 'slot': s += n.kids.length ? plain(n.kids) : n.intent; break
      default: s += plain((n as { kids: Node[] }).kids)
    }
  }
  return s
}
