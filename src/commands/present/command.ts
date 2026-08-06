/**
 * `/present` — the same process, ending in slides.
 *
 * A deck is not a different capability from a note; it is a different shape for
 * the same verified claims. So this runs `research()` exactly as `/research`
 * does and then lays the result out, which means every bullet on every slide is
 * something that survived the quote check and carries the page it came from.
 *
 * The alternative — hand a model a topic and ask it for a deck — is the thing
 * this codebase has spent its whole life measuring and rejecting. Asked to
 * generate at length, this model invents: it produced "the Mamba video game
 * engine" from an ambiguous topic, and "enhancing its non-stick properties"
 * from a sentence that said no such thing. A deck is *more* dangerous than a
 * note in that respect, not less, because a slide is read as a conclusion and
 * has no room for the hedging that would give it away.
 *
 * ── Where the model is allowed to write ─────────────────────────────────────
 *
 * Two places, both small and both under a grammar:
 *
 *   the title      one line, from the question and the findings
 *   each heading   three to six words labelling one claim
 *
 * Everything else is assembly. The claim's own sentence, its quotation and its
 * source are copied through unchanged — they were checked once and re-writing
 * them here would be the third time in this codebase that a summary of a
 * summary lost the thing it was summarising.
 *
 * A run that finds nothing still writes a deck, for the reason the empty note
 * exists: "there is nothing to show" and "I did not look" are different, and
 * only one of them is worth repeating next week.
 */
import type { Fact } from '../../ground/sandbox'
import { research, type Claim } from '../../ground/research'
import { granite } from '../../model/granite'
import { newDeck, putDeck, type Deck } from '../../store/notes'
import { find } from '../../pages/sigils'

let running = false
let cancelled = false
let stage = ''

export const isRunning = (): boolean => running
export const status = (): string => stage

export function control(action: string): void {
  if (action === 'stop') cancelled = true
}

/** A heading is a label, so it has no terminal punctuation and no quotes. */
const HEADING = '^[^".!?\\n]{3,48}$'

/**
 * A short label for one claim.
 *
 * Shown the claim and nothing else — the same isolation that fixed extraction,
 * and for the same reason. A model shown all the claims at once and asked for
 * headings writes headings for the wrong ones.
 */
async function headingFor(claim: Claim): Promise<string> {
  try {
    const out = await granite.fill<{ heading?: string }>(
      [
        { role: 'system', content: 'You write short titles for slides.' },
        { role: 'user', content: `Slide text: ${claim.says}` },
      ],
      {
        type: 'object',
        properties: {
          heading: {
            type: 'string',
            pattern: HEADING,
            description: 'A title for this slide — three to six words, no full stop.',
          },
        },
        required: ['heading'],
      },
      { maxTokens: 40 },
    )
    return (out.heading ?? '').trim()
  } catch {
    return ''
  }
}

/** A title for the deck. Falls back to the question, which is never wrong. */
async function titleFor(question: string, claims: Claim[]): Promise<string> {
  if (!claims.length) return question
  try {
    const out = await granite.fill<{ title?: string }>(
      [
        { role: 'system', content: 'You write short titles for presentations.' },
        {
          role: 'user',
          content: [`Question: ${question}`, '', 'What was found:', ...claims.map((c) => `- ${c.says}`)].join('\n'),
        },
      ],
      {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            pattern: HEADING,
            description: 'A title for the whole presentation — under eight words, no full stop.',
          },
        },
        required: ['title'],
      },
      { maxTokens: 40 },
    )
    return (out.title ?? '').trim() || question
  } catch {
    return question
  }
}

/**
 * The deck, assembled.
 *
 * Pure string work over data that has already been checked, which is why it is
 * a separate function with no model in it: everything above can fail and fall
 * back, and this cannot fail at all.
 */
export function compose(question: string, title: string, claims: Claim[], headings: string[], lost: Record<string, number>): string {
  const slides: string[] = []

  // The subtitle is the question, unless the title already is the question.
  //
  // `titleFor` falls back to the question whenever the model declines or there
  // is nothing to title, so the first deck built came out reading
  //
  //     # intermittent fasting blood pressure
  //     Intermittent fasting blood pressure
  //
  // which is the same echo defect the extractor had, in a new place: two fields
  // filled from one source with nothing to distinguish them. Compared on words
  // rather than characters so a difference of capitalisation or punctuation
  // still counts as the same line.
  const same = (a: string, b: string) => a.toLowerCase().replace(/\W+/g, '') === b.toLowerCase().replace(/\W+/g, '')
  const opening = same(title, question)
    ? `# ${title}`
    : [`# ${title}`, '', question.replace(/^\w/, (m) => m.toUpperCase())].join('\n')
  slides.push(opening)

  claims.forEach((c, i) => {
    const heading = headings[i] || `Finding ${i + 1}`
    slides.push([`## ${heading}`, '', c.says, '', `> ${c.quote}`, '', `[${c.title.slice(0, 70)}](${c.url})`].join('\n'))
  })

  // The last slide is the one a deck normally leaves out. What was searched and
  // what was thrown away is the difference between "this is what there is" and
  // "this is what I could get", and a deck that omits it is claiming the first
  // while having done the second.
  const dropped = Object.entries(lost).filter(([, n]) => n > 0)
  const words: Record<string, string> = {
    thin: 'unreadable',
    offTopic: 'did not answer it',
    irrelevant: 'had nothing to add',
    misquoted: 'could not be quoted accurately',
    duplicate: 'repeated another source',
    failed: 'could not be read by the model',
  }
  slides.push(
    [
      '## Where this came from',
      '',
      claims.length
        ? `${claims.length} finding${claims.length === 1 ? '' : 's'}, each quoted from ${new Set(claims.map((c) => c.url)).size} source${new Set(claims.map((c) => c.url)).size === 1 ? '' : 's'}.`
        : 'Nothing here could be attributed to a source that survived checking.',
      dropped.length ? '' : '',
      dropped.length ? `Set aside: ${dropped.map(([k, n]) => `${n} ${words[k] ?? k}`).join(', ')}.` : '',
    ]
      .filter((l, i, a) => !(l === '' && a[i - 1] === ''))
      .join('\n'),
  )

  return slides.join('\n---\n')
}

export async function run(argument: string): Promise<Fact | null> {
  const question = argument.trim()
  if (!question) return null
  if (running) return { label: 'present', value: 'already running', src: 'present', hint: 'a deck is already being built' }

  running = true
  cancelled = false
  try {
    const found = await research(question, (s, detail) => {
      stage = detail ? `${s} ${detail}` : s
    })
    if (cancelled) return { label: 'present', value: 'stopped', src: 'present', hint: 'the deck was abandoned' }

    stage = 'writing slides'
    // Headings first and together — they are independent of each other, and the
    // model server has four slots.
    const [title, headings] = await Promise.all([
      titleFor(question, found.claims),
      Promise.all(found.claims.map(headingFor)),
    ])
    if (cancelled) return { label: 'present', value: 'stopped', src: 'present', hint: 'the deck was abandoned' }

    const deck: Deck = newDeck(compose(question, title, found.claims, headings, found.lost))
    await putDeck(deck)

    // Opening it is the point. A command that wrote a deck and then said so
    // would leave the one useful next action to be found by hand.
    const app = find('deck')
    if (app && 'enter' in app) app.enter(deck.id)

    const n = found.claims.length
    return {
      label: 'present',
      value: `${n + 2} slide${n + 2 === 1 ? '' : 's'} from ${new Set(found.claims.map((c) => c.url)).size} source${new Set(found.claims.map((c) => c.url)).size === 1 ? '' : 's'}`,
      src: 'present',
      srcUrl: found.claims[0]?.url,
      hint: `a deck of ${n} sourced finding${n === 1 ? '' : 's'}`,
    }
  } catch (err) {
    console.warn('present failed', err)
    return null
  } finally {
    running = false
    stage = ''
  }
}
