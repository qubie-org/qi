/**
 * Themes, as the app's own CSS rather than reveal's.
 *
 * reveal ships eleven themes and every one of them is somebody else's app:
 * Source Sans, a blue gradient, drop shadows, uppercase headings with letter
 * spacing. Loading one would make a deck opened from this app look like a
 * different program than the app that made it — which is the one thing a
 * presentation built out of your own notes must not do.
 *
 * So `reveal.css` is loaded for layout only — it is what makes slides scale,
 * centre and transition — and everything visible is set here, against the same
 * variables the rest of the app is drawn with. A deck is the river's contents
 * on a bigger screen, not an export to another format.
 *
 * Three, because three is the number of genuinely different rooms a deck is
 * shown in, and a longer list would be a menu rather than a decision:
 *
 *   quiet   paper, serif, generous margins. The default. A deck that is mostly
 *           sentences, read at a table or shared as a link.
 *   dark    for a projector in a room with the lights off, where paper-white
 *           is a wall of glare.
 *   plain   near-monochrome and tighter, for decks that are mostly numbers and
 *           quotations, where anything decorative competes with the content.
 */
export type ThemeName = 'quiet' | 'dark' | 'plain'

export const THEMES: ThemeName[] = ['quiet', 'dark', 'plain']

export const isTheme = (s: string): s is ThemeName => (THEMES as string[]).includes(s)

/**
 * The look, keyed by theme.
 *
 * Written as one string per theme rather than as a stylesheet with three
 * modifier classes, because a deck renders one theme at a time and the other
 * two are dead weight in the document. It also means a theme is a value that
 * can be handed around and stored on the deck, which is what `Deck.theme` is.
 */
const LOOKS: Record<ThemeName, string> = {
  quiet: `
    --deck-bg: #faf9f6;
    --deck-ink: #17181a;
    --deck-soft: #5c5f66;
    --deck-rule: #e0ddd4;
    --deck-accent: #7a5c3e;
    --deck-family: ui-serif, Georgia, 'Iowan Old Style', serif;
    --deck-heading-weight: 500;
  `,
  dark: `
    --deck-bg: #121316;
    --deck-ink: #eceef2;
    --deck-soft: #9aa0aa;
    --deck-rule: #2a2d33;
    --deck-accent: #c9a227;
    --deck-family: ui-serif, Georgia, 'Iowan Old Style', serif;
    --deck-heading-weight: 500;
  `,
  plain: `
    --deck-bg: #ffffff;
    --deck-ink: #0b0b0c;
    --deck-soft: #6b6b6e;
    --deck-rule: #e6e6e8;
    --deck-accent: #0b0b0c;
    --deck-family: ui-sans-serif, -apple-system, 'Helvetica Neue', sans-serif;
    --deck-heading-weight: 600;
  `,
}

/**
 * The stylesheet for one deck.
 *
 * Scoped under `.deck-surface` so it cannot reach the app around it. reveal
 * sets a great many properties on `.reveal` and its descendants, and a
 * stylesheet that answered those globally would restyle the river the moment a
 * deck was opened once.
 */
export const themeCss = (theme: ThemeName): string => `
.deck-surface {
  ${LOOKS[theme]}
  background: var(--deck-bg);
  color: var(--deck-ink);
  position: absolute;
  inset: 0;
}

.deck-surface .reveal {
  font-family: var(--deck-family);
  font-size: 30px;
  color: var(--deck-ink);
}

/* Left-aligned, because a slide of prose centred line by line is a poster.
   reveal centres by default and this is the single most important override. */
.deck-surface .reveal .slides section {
  text-align: left;
  padding: 0 4vw;
}

.deck-surface .reveal h1,
.deck-surface .reveal h2,
.deck-surface .reveal h3 {
  font-family: var(--deck-family);
  font-weight: var(--deck-heading-weight);
  color: var(--deck-ink);
  text-transform: none;
  letter-spacing: -0.01em;
  line-height: 1.15;
  text-wrap: balance;
  margin: 0 0 0.6em;
}

.deck-surface .reveal h1 { font-size: 1.9em; }
.deck-surface .reveal h2 { font-size: 1.45em; }
.deck-surface .reveal h3 { font-size: 1.15em; }

.deck-surface .reveal p { line-height: 1.45; margin: 0 0 0.7em; }

.deck-surface .reveal ul { margin: 0; padding-left: 1.1em; }
.deck-surface .reveal li { margin: 0 0 0.5em; line-height: 1.4; }
.deck-surface .reveal li::marker { color: var(--deck-accent); }

/* A quotation is evidence here, not decoration — every one of them came with a
   source that was checked. It gets the accent rule and nothing else. */
.deck-surface .reveal blockquote {
  margin: 0.8em 0;
  padding: 0 0 0 1em;
  border-left: 2px solid var(--deck-accent);
  background: none;
  box-shadow: none;
  font-style: normal;
  color: var(--deck-soft);
  font-size: 0.85em;
  width: auto;
}
.deck-surface .reveal blockquote p { margin: 0 0 0.3em; }

.deck-surface .reveal code {
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 0.85em;
  background: color-mix(in oklab, var(--deck-ink) 7%, transparent);
  padding: 0.1em 0.3em;
  border-radius: 3px;
}

/* Sources sit at the foot of the slide they support, small and quiet. They are
   there to be verifiable, not to be read aloud. */
.deck-surface .reveal .cites {
  position: absolute;
  left: 4vw;
  right: 4vw;
  bottom: 2vh;
  display: flex;
  flex-wrap: wrap;
  gap: 0 1.2em;
  border-top: 1px solid var(--deck-rule);
  padding-top: 0.5em;
  font-size: 0.42em;
  color: var(--deck-soft);
  font-family: ui-sans-serif, -apple-system, sans-serif;
}

.deck-surface .reveal .progress { color: var(--deck-accent); }
.deck-surface .reveal .controls { color: var(--deck-soft); }

@media (prefers-reduced-motion: reduce) {
  .deck-surface .reveal .slides section { transition: none !important; }
}
`
