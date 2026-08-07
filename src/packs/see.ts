/**
 * The see pack: granite-vision-4.1-4b.
 *
 * Its own llama-server on its own port, because llama.cpp serves one model per
 * process and the core is already occupying one. That is the honest shape of a
 * vision pack: another 3.3 GB and another ~2.5 GB resident while it is loaded.
 *
 * It is a separate model but not a foreign one — the language tower is the same
 * Granite 4.1 the core runs, so the chat template, the tokenizer and the tool
 * grammar are identical. A conversation can hand it an image and get back text
 * the core understands without any translation layer between them.
 *
 * What it is actually good at is worth stating, because it is not "describe
 * this photo". It was trained on documents: charts to CSV, tables to HTML or
 * OTSL, key-value pairs out of a scanned form. The verb below is written for
 * that — the useful question is what a table says, not what a picture looks
 * like.
 */
import type { Binding, PackSpec, Verb } from '../model/packs'
import { Granite } from '../model/granite'

/** A second client, pointed at the pack's own server rather than the core's. */
class VisionClient extends Granite {}

const client = new VisionClient()
// Granite's constructor-free design means the base URL is the one thing to
// override, and it is read at call time.
Object.defineProperty(client, 'base', { value: '/pack/see' })

/**
 * Images the page has attached to this turn, newest last.
 *
 * The pack does not reach into the DOM for them. The app puts them here when
 * the user drops a file or pastes a screenshot, which keeps the pack a pure
 * consumer and means a headless test can set it directly.
 */
const attached: string[] = []

export function attach(dataUrl: string): void {
  attached.push(dataUrl)
  if (attached.length > 4) attached.shift()
}

export function attachments(): readonly string[] {
  return attached
}

const verb: Verb = {
  verb: 'reading',
  declaration: {
    type: 'function',
    function: {
      name: 'see',
      description:
        'Read the image the user attached: what it shows, what a chart plots, what a table says, ' +
        'what a form field contains. Only use when an image is actually attached.',
      parameters: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: 'What to find out from the image, in a few words.',
          },
        },
        required: ['question'],
      },
    },
  },
  async run(args) {
    if (!attached.length) return { work: 'No image is attached.', empty: true }
    const question = String(args.question ?? 'What does this show?')
    const text = await client.see(attached.slice(-1), question)
    return text
      ? { work: `Read the image. ${text}` }
      : { work: 'The image could not be read.', empty: true }
  },
}

export default async function bind(_spec: PackSpec): Promise<Binding> {
  return {
    async start() {
      await client.load()
      if (!client.caps.vision) {
        throw new Error('see: server started without --mmproj, so it has no eyes')
      }
    },
    verbs: [verb],
    capabilities: {
      see: (images: string[], prompt: string) => client.see(images, prompt),
      attach,
    },
  }
}
