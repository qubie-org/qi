/**
 * Showing a picture, without asking the model whether to.
 *
 * Every attempt to route a picture request *through* the model failed, and each
 * one failed differently. Asked to show a humpback whale it replied "I'm sorry,
 * but I don't have the ability to retrieve or display images" having called
 * nothing — a refusal assembled from its own idea of what a language model is,
 * while a working image search sat one tool call away. Given a fallback that
 * caught refusals, it stopped refusing and started emitting `/look?query=…` as
 * literal prose instead, so no tool ran and the refusal test never matched.
 *
 * The request is not ambiguous. "Show me a photo of a humpback whale" has one
 * reading, and a model is not needed to find it — so this does not consult one.
 * The words are matched, the subject is extracted, Openverse is asked, and the
 * result is checked. That is the whole path, and none of it can decline.
 *
 * ── Why there is a check at all ─────────────────────────────────────────────
 *
 * Because retrieval without validation is how a request for a volcano comes
 * back as a stock photo of a candle. Openverse ANDs its terms and widens when a
 * query returns nothing — good behaviour, and it means a specific request can
 * quietly become a general one. Something has to notice.
 *
 * The check is the embedder, not a vision model. It compares what was asked for
 * against what the image *says it is* — its title and creator, which Openverse
 * returns with every hit. That is cheap, already installed, and honest about
 * its limit: it validates the label, not the pixels. A mislabelled photograph
 * passes. What it reliably catches is the common failure, where the search
 * widened and the thing that came back is about something else entirely.
 *
 * A vision model would check the pixels and cost four gigabytes. That trade is
 * available — `granite-vision-4.1-4b` is in the catalogue — and it is not worth
 * making for a caption check.
 */
import { cosine, embed } from '../model/vectors'
import type { Fact } from './sandbox'
import { fromSource } from './index'

/**
 * Did they ask to be shown something?
 *
 * Narrow on purpose. A false negative costs a picture nobody insisted on; a
 * false positive staples a photograph to a question that never wanted one,
 * which is the more jarring of the two.
 */
const ASKED = /\b(photo|photograph|picture|image|pic)s?\b/i
const NEGATED = /\b(without|no|don'?t|do not)\s+(a\s+)?(photo|photograph|picture|image)/i

export const wantsPicture = (text: string): boolean => ASKED.test(text) && !NEGATED.test(text)

/**
 * What the picture should be of.
 *
 * "show me a photo of" is addressed to qi, not to an image index, and leaving
 * it on makes the query worse — Openverse ANDs every term, so the scaffolding
 * competes with the subject.
 */
export function subjectOf(text: string): string {
  return (
    text
      .replace(/^\s*(please\s+)?(can|could|would)\s+you\s+/i, '')
      .replace(/^\s*(show|find|get|give)\s+(me\s+)?/i, '')
      .replace(/^\s*(a|an|the|some)\s+/i, '')
      .replace(/\b(photo|photograph|picture|image|pic)s?\s+of\s+/i, '')
      .replace(/^\s*(a|an|the|some)\s+/i, '')
      .replace(/[?.!]+\s*$/, '')
      .trim() || text
  )
}

/**
 * The floor, which catches catastrophe and nothing finer.
 *
 * It started at 0.42, chosen to mean "close enough", and the measurement threw
 * it out. Against real captions the correct and incorrect matches *overlap*:
 *
 *     humpback whale breaching  ·  "Whale watching boat at sunset"   0.460
 *     bumblebee                 ·  "Bombus terrestris on lavender"   0.384
 *
 * The first is a boat and the second is a bumblebee. No threshold accepts one
 * and rejects the other, because the embedder does not know *Bombus* is a
 * bumblebee and does know boats have to do with whales. Absolute similarity
 * between a query and a caption is simply not a good enough signal to gate on.
 *
 * What it does separate cleanly is the thing that is about something else
 * entirely — a candle for a volcano, ramen for Mount Fuji, a school bus for a
 * bumblebee all landed between 0.058 and 0.187, far below anything plausible.
 * So the number is set to catch only that, and the finer question — which of
 * these four — is answered by ranking instead, where every candidate came back
 * from the same search and only their order has to be right.
 */
export const FLOOR = 0.25

export type Checked = { fact: Fact; score: number }

/**
 * Find a picture, and decide whether it is worth showing.
 *
 * Almost all of this is machinery that already existed. `fromSource` runs the
 * Openverse source without consulting the router, and `rerank` — which the
 * source path already applies — embeds the query and every candidate and keeps
 * the closest. Reimplementing that ranking here was the first thing tried, and
 * it was a second copy of a function twenty lines away.
 *
 * What is genuinely added is the two ends: deciding to ask at all without a
 * model in the loop, and refusing the answer when even the best candidate is
 * about something else. `rerank` always returns a winner; someone has to be
 * willing to say none of them won.
 */
export async function pictureFor(text: string): Promise<Checked | null> {
  const subject = subjectOf(text)
  const fact = await fromSource('image', subject).catch(() => null)
  if (!fact?.chip) return null

  // The caption the winner claims for itself, against what was asked for.
  const [want, got] = await Promise.all([embed(subject), embed(String(fact.label ?? ''))])
  const score = cosine(want, got)
  return score < FLOOR ? null : { fact, score }
}
