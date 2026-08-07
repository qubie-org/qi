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
import { compose } from '../../engine/compose'
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
    const { key, page } = await startSet(mood, placed)
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
        : `${written ? 'arranged' : 'a preset'} ${mood.id} set is playing${kit}`,
    }
  } catch (err) {
    console.warn('dj: could not start', err)
    return null
  }
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
