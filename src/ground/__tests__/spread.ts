/**
 * Does the grounding layer cover the shape of what people actually ask?
 *
 * The existing suites each check one thing well. `route.ts` asserts a question
 * reaches the right source, `taint.ts` asserts a plausible-but-wrong API answer
 * is refused, `leaf.ts` checks one pure function. None of them asks the
 * question this file exists for: across the *kinds* of thing someone might ask,
 * where does an answer come from, and where is there nothing at all?
 *
 * That matters because every path added here has been added for a reason and
 * none of them was added against a map. Hand-written sources cover ten
 * subjects. The operations index covers 2,721 endpoints that happen to be
 * keyless. ClickHouse covers eleven datasets that happen to be public. Web
 * search covers everything and answers precisely nothing. The union of those is
 * not a design, it is a pile — and the only way to see the shape of a pile is
 * to throw a spread of questions at it and record where each one lands.
 *
 * ── This is a report, not a gate ────────────────────────────────────────────
 *
 * It never fails. There is no correct distribution to assert, and a threshold
 * here would be a number invented to be met. What it produces is a table: query
 * kind down the side, which path answered across the top, and the questions
 * nothing could answer listed at the bottom. The last group is the useful one —
 * it is the backlog, in priority order, written by the questions themselves.
 *
 * It reaches real endpoints, so it is not in CI. Run it deliberately:
 *
 *     bun src/ground/__tests__/spread.ts
 */
import { ground, buildRouter } from '../index'
import { openStore } from '../../store/db'
import { startVectors } from '../../model/vectors'
import { granite } from '../../model/granite'

/**
 * The spread.
 *
 * Grouped by what the question *wants* rather than by subject, because the
 * subject is what retrieval already scores on and the shape is what decides
 * whether any of these paths can help. A question wanting a number in a unit
 * is a different problem from one wanting a name, whoever it is about.
 */
const QUERIES: { kind: string; q: string }[] = [
  // A single current number. The thing APIs are for.
  { kind: 'live quantity', q: 'what is the weather in oslo' },
  { kind: 'live quantity', q: 'how much is a bitcoin worth' },
  { kind: 'live quantity', q: 'dollars to euros' },
  { kind: 'live quantity', q: 'where is the international space station' },

  // A number that is a fact rather than a reading.
  { kind: 'static quantity', q: 'what is the population of reykjavik' },
  { kind: 'static quantity', q: 'how tall is mount everest' },
  { kind: 'static quantity', q: 'how many countries are in the european union' },

  // Computation over records. Nobody publishes the answer; it has to be counted.
  { kind: 'aggregate', q: 'how many hacker news posts mention rust' },
  { kind: 'aggregate', q: 'what is the average new york taxi fare' },
  { kind: 'aggregate', q: 'which github repositories have the most events' },

  // Prose. What search is actually good at.
  { kind: 'explanation', q: 'why is the sky blue' },
  { kind: 'explanation', q: 'what is a vacuum flask' },
  { kind: 'explanation', q: 'how does a heat pump work' },

  // A name or an entity, not a number.
  { kind: 'entity', q: 'who invented the thermos flask' },
  { kind: 'entity', q: 'who is the prime minister of iceland' },

  // Pictures.
  { kind: 'media', q: 'show me a photo of a volcano' },
  { kind: 'media', q: 'a picture of a bumblebee' },

  // Lists. Structurally not an API answer.
  { kind: 'enumeration', q: 'list the nordic countries' },
  { kind: 'enumeration', q: 'what are the planets in the solar system' },

  // Two things measured against each other.
  { kind: 'comparison', q: 'is tokyo bigger than delhi' },
  { kind: 'comparison', q: 'which is colder, oslo or reykjavik' },

  // Time.
  { kind: 'temporal', q: 'when did the berlin wall fall' },
  { kind: 'temporal', q: 'what happened in iceland in 2010' },

  // Should be declined, not answered.
  { kind: 'small talk', q: 'hello' },
  { kind: 'small talk', q: 'thanks, that was helpful' },

  // Genuinely ambiguous — the honest answer is a question back.
  { kind: 'ambiguous', q: 'how big is it' },
  { kind: 'ambiguous', q: 'what about mercury' },
]

async function main() {
  console.log('\n── waking the model and the index')
  const [, vectors] = await Promise.all([openStore(), startVectors()])
  if (!vectors) console.log('   (no embed pack — routing will be approximate)')
  await granite.load().catch(() => console.log('   (no model server — model paths will decline)'))
  const router = await buildRouter()

  const rows: { kind: string; q: string; src: string; value: string }[] = []

  for (const { kind, q } of QUERIES) {
    let src = '—'
    let value = ''
    try {
      const fact = await ground(q, router)
      if (fact) {
        src = fact.src || 'unnamed'
        value = String(fact.value ?? '').replace(/\s+/g, ' ').slice(0, 54)
      }
    } catch (err) {
      src = 'threw'
      value = String(err).slice(0, 54)
    }
    rows.push({ kind, q, src, value })
    console.log(`  ${src === '—' ? '   ' : 'got'}  ${kind.padEnd(16)} ${q.slice(0, 40).padEnd(42)} ${src}`)
  }

  console.log('\n── where answers came from, by kind')
  const kinds = [...new Set(rows.map((r) => r.kind))]
  for (const kind of kinds) {
    const mine = rows.filter((r) => r.kind === kind)
    const answered = mine.filter((r) => r.src !== '—' && r.src !== 'threw')
    const sources = [...new Set(answered.map((r) => r.src))].join(', ') || '—'
    console.log(`  ${kind.padEnd(17)} ${answered.length}/${mine.length}  ${sources}`)
  }

  // The backlog, written by the questions rather than by us.
  const gaps = rows.filter((r) => r.src === '—' && r.kind !== 'small talk' && r.kind !== 'ambiguous')
  console.log(`\n── nothing answered these (${gaps.length})`)
  for (const g of gaps) console.log(`  ${g.kind.padEnd(17)} ${g.q}`)

  // Declining is correct for these two kinds, so it is reported as a success.
  const declined = rows.filter((r) => (r.kind === 'small talk' || r.kind === 'ambiguous') && r.src === '—')
  console.log(`\n── correctly declined ${declined.length}/${rows.filter((r) => r.kind === 'small talk' || r.kind === 'ambiguous').length} of the questions that should be declined`)
}

main().catch((err) => {
  console.error('spread: could not run —', err)
  process.exit(0)
})
