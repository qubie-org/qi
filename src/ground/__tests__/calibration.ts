/**
 * The calibration report. Not a test — it does not pass or fail.
 *
 * Every bar in the grounding path is measured at boot rather than written down,
 * which is the right design and also an opaque one: nothing on screen says what
 * the numbers came out at, or how much daylight there is between a question
 * that should route and one that should not. When a model is swapped, the
 * question "did the bars move somewhere sensible" has to be answerable by
 * looking, and this is the thing to look at.
 *
 * It prints, for a spread of questions across every category the router knows
 * about: the routing score, the best operation score, the field path the model
 * claimed to read, and the verdict each gate returned. Read the columns for
 * separation — the interesting failure is not a wrong number but two categories
 * whose distributions have started to overlap.
 */
import { vectorsReady, modelReady, skipNote } from './harness'
import { apiBars, buildRouter, groundTraced, routeAll } from '../index'
import { findOperations } from '../operations'

await vectorsReady
const router = await buildRouter()
const bars = apiBars()

console.log('\ncalibrated bars')
console.log('─'.repeat(72))
console.log(`  operation   ${bars.op.toFixed(4)}   an operation must beat what small talk scores`)
console.log(`  path        ${bars.path.toFixed(4)}   a field name must beat what an id field scores`)
console.log(`  agreement   ${bars.agree.toFixed(4)}   two answers must beat what a near miss scores`)

/** Questions by what they ought to do, so the columns can be read as groups. */
const GROUPS: [string, string[]][] = [
  ['hand-written source', [
    'what is the weather in oslo',
    'how cold is it in Reykjavik',
    'how much is bitcoin',
    'dollars to euros',
    'where is the international space station',
  ]],
  ['encyclopedia', [
    'who was Ada Lovelace',
    'what is the moon',
    'tell me about basque cheesecake',
  ]],
  ['tainted — nearest operation is wrong', [
    'what is the boiling point of water',
    'what is the area of texas',
    'how many satellites orbit earth',
    'what is the currency of thailand',
  ]],
  ['small talk — must decline', [
    'i need help',
    'thanks',
    'what do you think',
    'that is really beautiful',
  ]],
]

const ready = await modelReady

console.log('\nscore distribution')
console.log('─'.repeat(118))
console.log(
  `${'question'.padEnd(42)}${'S_route'.padEnd(9)}${'S_op'.padEnd(8)}${'via'.padEnd(9)}${'path'.padEnd(24)}gate`,
)
console.log('─'.repeat(118))

for (const [group, questions] of GROUPS) {
  console.log(`\n  ${group}`)
  for (const q of questions) {
    const hits = await routeAll(q, router, 1)
    const sRoute = hits[0]?.score ?? 0
    const ops = await findOperations(q, 1).catch(() => [])
    const sOp = ops[0]?.score ?? 0

    let via = '—'
    let gate = '—'
    let path = '—'
    if (ready) {
      const got = await groundTraced(q, router)
      via = String(got.via)
      gate = got.verdict?.why ?? '—'
      if (got.verdict && 'path' in got.verdict && typeof got.verdict.path === 'number') {
        path = `${got.verdict.path.toFixed(3)}`
      }
    }

    // A star marks a score that cleared its bar — the thing being read for.
    const routeMark = sRoute > 0 ? '*' : ' '
    const opMark = sOp >= bars.op ? '*' : ' '
    console.log(
      `    ${q.slice(0, 38).padEnd(38)}${(sRoute.toFixed(3) + routeMark).padEnd(9)}${(sOp.toFixed(3) + opMark).padEnd(8)}${via.padEnd(9)}${path.padEnd(24)}${gate}`,
    )
  }
}

if (!ready) {
  skipNote('the via/gate columns')
} else {
  console.log('\n  * cleared its bar')
}

console.log('\nreport only — nothing here fails a build\n')
