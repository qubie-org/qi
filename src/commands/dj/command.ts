/**
 * `/dj` — the script behind the set.
 *
 * This began as a skill and was wrong as one. A skill changes what the agent
 * *knows*: its brief is loaded into context and the next thing the model says is
 * said by something better informed. `dj` does not inform anything. It starts an
 * audio graph, holds a scheduler and pins a key — it is a script with a side
 * effect, which is exactly what a command is.
 *
 * The tell was that its brief was four paragraphs the model never needed to
 * read: describing four moods to a model whose only job was to pass a word
 * through to `moodFor`. A command takes the word directly.
 */
import type { Fact } from '../../ground/sandbox'
import { haveSamples, isPlaying, nowPlaying, setSource, startSet, stopSet } from '../../engine/dj'
import type { Attempt } from '../../engine/verify'
import { compose } from '../../engine/compose'
import { packs } from '../../model/packs'
import type { Write } from '../../packs/strudel'
import { credits, inCrate } from '../../engine/crate'
import { address } from '../../pages/space'

/** Words that mean stop, checked before anything is started. */
const STOP = /\b(stop|quiet|silence|off|enough|end|kill|pause)\b/i

export async function run(argument: string): Promise<Fact | null> {
  const said = argument.trim()

  if (STOP.test(said) || (!said && isPlaying())) {
    // An empty argument while something is playing means stop. It is the
    // gesture people already use for a toggle, and asking "did you mean stop?"
    // of someone who typed `/dj` into a room that is already playing would be
    // obtuse.
    stopSet()
    return { label: 'set', value: 'stopped', src: 'dj', hint: 'the set stopped' }
  }

  try {
    // The model arranges it; the presets are the fallback and the worked
    // examples it is shown. Everything it can say is playable by construction —
    // see engine/compose.ts for why it fills a struct rather than writing code.
    const { mood, written, placed } = await compose(said)

    // The strudel pack writes the pattern; without it the struct arranges one.
    // Asking by capability rather than by import is what keeps this a quieter
    // feature when the pack is not installed instead of a broken one.
    const write = packs.provide<Write>('strudel')
    const { key, page, wrote } = await startSet(mood, placed, write)
    const kit = haveSamples() ? '' : ' (synth kit)'

    /**
     * Attribution rides on the fact, not on a log line.
     *
     * A set assembled out of Creative Commons recordings has to be able to say
     * where each one came from, and the only place in this app that is
     * guaranteed to be rendered is the fact itself — `src` and `srcUrl` are
     * always shown. So when the set has found sounds in it, the fact points at
     * the generated file, which carries every credit in full, and the hint
     * names the creators out loud rather than leaving them a click away.
     */
    const found = inCrate()
    const who = found.map((s) => s.creator).join(', ')
    return {
      label: mood.id,
      value: key,
      src: found.length ? 'openverse' : 'dj',
      srcUrl: found.length ? address(page) : undefined,
      hint: found.length
        ? `${mood.id} set with ${found.length === 1 ? 'a sample' : `${found.length} samples`} by ${who}`
        : `${how(wrote, written)} ${mood.id} set is playing${kit}`,
    }
  } catch (err) {
    console.warn('dj: could not start', err)
    return null
  }
}

/**
 * How the set came to exist, in one word.
 *
 * Worth saying out loud rather than hiding, because the three are genuinely
 * different things to be listening to. `composed` is a pattern the strudel pack
 * wrote and that passed every check. `arranged` is the struct in compose.ts,
 * filled by the core model. `a preset` is neither — the words were read and one
 * of four moods was matched.
 *
 * A retry is mentioned when it happened. Needing three attempts is not a
 * failure, it is the cost of letting the model write freely, and a hint that
 * never admits it makes the feature look more reliable than it is.
 */
function how(wrote: Attempt | null, written: boolean): string {
  if (wrote?.ok) return wrote.tries > 1 ? `a composed (${wrote.tries} tries)` : 'a composed'
  return written ? 'an arranged' : 'a preset'
}

/**
 * Every credit for everything currently playing.
 *
 * Exported rather than folded into the fact because the licence obligation
 * outlives the moment the set started: something that shows what is playing an
 * hour later still has to be able to name the creators, and re-deriving that
 * from a `hint` string is not naming them.
 */
export const playingCredits = (): string[] => credits()

/** The generated Strudel, for anything that wants to show or copy the set. */
export const playingSource = (): string => setSource()

/** Whether the chrome should show this command's controls. */
export const running = (): boolean => isPlaying()

/** What the controls in the chrome do. */
export function control(action: string): void {
  if (action === 'stop') stopSet()
}

/** Shown beside the controls, so the chip says what is playing. */
export const status = (): string => nowPlaying()?.mood ?? ''
