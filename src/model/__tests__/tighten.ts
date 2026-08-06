/**
 * Sentence splitting, held to one rule above all others: nothing disappears.
 *
 * The regression these exist for was not a wrong answer, it was a *plausible*
 * one. `[^.!?]+[.!?]+` cannot cross a full stop, so any string containing a
 * dotted token — a domain, an abbreviation, a version number — matched nothing
 * until after the last one, and the beginning of the sentence was dropped in
 * silence. What reached the screen was still grammatical, which is why it
 * survived so long: "com), licensed BY." reads like a truncation, not like a
 * bug.
 */
import { sentences, tighten } from '../granite'

let failed = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failed++
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}${name}${detail ? '  ' + detail : ''}`)
}

console.log('\n── nothing is ever dropped')
const KEEP = [
  'The photo is by Giuseppe Milo (www.pixael.com), licensed BY.',
  'Dr. Smith went to Washington D.C. yesterday.',
  'Version 4.1 of the model ships today.',
  'It is 11°C with wind at 12 km/h.',
  'Reykjavik is the capital. It has 140,000 people.',
  'No terminator at all',
  'Ends with a question? Then a statement.',
]
for (const text of KEEP) {
  // The pieces must reassemble into the original, ignoring the whitespace the
  // split consumed. That is the whole contract.
  const rejoined = sentences(text).join(' ').replace(/\s+/g, ' ')
  check(
    JSON.stringify(text.slice(0, 42)),
    rejoined === text.replace(/\s+/g, ' ').trim(),
    rejoined === text.replace(/\s+/g, ' ').trim() ? '' : `got ${JSON.stringify(rejoined)}`,
  )
}

console.log('\n── a dotted token is one sentence, not three')
check(
  'domain survives',
  tighten('The photo is by Giuseppe Milo (www.pixael.com), licensed BY.').startsWith('The photo'),
  tighten('The photo is by Giuseppe Milo (www.pixael.com), licensed BY.'),
)
check(
  'abbreviation survives',
  tighten('Dr. Smith went to Washington D.C. yesterday.').startsWith('Dr. Smith'),
  tighten('Dr. Smith went to Washington D.C. yesterday.'),
)

console.log('\n── the soft limit still trims whole sentences')
const long = 'Reykjavik is the capital of Iceland and sits on the southwest coast. ' +
  'It has about 140,000 people. It is the northernmost capital in the world.'
const cut = tighten(long, 18)
check('stops on a sentence boundary', /[.!?]$/.test(cut), cut)
check('shorter than the whole', cut.length < long.length)

console.log(`\n${failed === 0 ? 'all tighten checks passed' : `${failed} FAILED`}`)
process.exit(failed ? 1 : 0)
