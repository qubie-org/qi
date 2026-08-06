/**
 * `/research` — the process, wired to a note.
 *
 * The command is thin on purpose. `ground/research.ts` is the process and
 * `store/notes.ts` is the destination; this is the twenty lines that decide a
 * note gets written at all, and that is genuinely all a command should be.
 *
 * It writes rather than returning prose because research that evaporates when
 * the turn scrolls away is not research. A fact belongs in the river; eight
 * sources and their quotes belong somewhere you can come back to.
 */
import type { Fact } from '../../ground/sandbox'
import { research } from '../../ground/research'
import { newNote, putNote } from '../../store/notes'

let running = false
let cancelled = false
let stage = ''

export const isRunning = (): boolean => running
export const status = (): string => stage

export function control(action: string): void {
  if (action === 'stop') cancelled = true
}

export async function run(argument: string): Promise<Fact | null> {
  const question = argument.trim()
  if (!question) return null
  if (running) return { label: 'research', value: 'already running', src: 'research', hint: 'research is already running' }

  running = true
  cancelled = false
  try {
    const found = await research(question, (s, detail) => {
      stage = detail ? `${s} ${detail}` : s
    })

    if (cancelled) {
      return { label: 'research', value: 'stopped', src: 'research', hint: 'the research was stopped' }
    }

    // A note with no claims is an honest outcome and still worth keeping — it
    // records what was searched and that nothing answered, which is the thing
    // you would otherwise repeat next week.
    const note = newNote(found.note)
    await putNote(note)

    const n = found.claims.length
    const dropped = Object.values(found.lost).reduce((a, b) => a + b, 0)
    return {
      label: 'research',
      value: `${n} finding${n === 1 ? '' : 's'} from ${new Set(found.claims.map((c) => c.url)).size} sources${dropped ? `, ${dropped} set aside` : ''}`,
      src: 'research',
      srcUrl: found.claims[0]?.url,
      hint: `a note with ${n} sourced finding${n === 1 ? '' : 's'}`,
    }
  } catch (err) {
    console.warn('research failed', err)
    return null
  } finally {
    running = false
    stage = ''
  }
}
