/**
 * The taint suite: questions whose nearest operation is confidently wrong.
 *
 * A retrieval index of 2,721 operations always has a nearest one. That is the
 * whole danger of the API path — "nearest" is not a claim about relevance, but
 * a wrong operation still returns 200, still parses as JSON, still yields a
 * value, and still renders with a real hostname and a real source link. There
 * is nothing on screen to tell a user that the boiling point of water came from
 * an underwater GPS unit.
 *
 * These cases were not invented. They were found by scoring a few dozen
 * ordinary questions against the live index and keeping the ones whose top
 * operation clears the calibrated bar while having nothing to do with the
 * question. The score is printed with each case so it is clear this is a real
 * near-miss and not a straw man.
 *
 * What is asserted is not "the answer is right" — for most of these there is no
 * API in the index that could answer them at all. It is that the wrong answer
 * does not reach the screen *as an API fact*: either a gate drops it, or the
 * question is answered from the web, where the passage carries its own URL.
 */
import { vectorsReady, modelReady, skipNote } from './harness'
import { apiBars, buildRouter, groundTraced } from '../index'
import { callOperation, factFrom, findOperations, verify } from '../operations'

await vectorsReady
if (!(await modelReady)) {
  skipNote('taint suite')
  process.exit(0)
}

const router = await buildRouter()
const bars = apiBars()

/**
 * Questions the operations index has a plausible-but-wrong answer for.
 *
 * The comment on each is the operation that actually wins retrieval, which is
 * the joke and the point at once.
 */
const TAINTED: string[] = [
  'what is the boiling point of water',        // → The Water Linked Underwater GPS API
  'what is the freezing point of mercury',     // → The Water Linked Underwater GPS API
  'what is the temperature on mars',           // → The Water Linked Underwater GPS API
  'how many languages are spoken in india',    // → LanguageTool API
  'how many countries are in africa',          // → Mtaa API
  'what is the area of texas',                 // → Flinkster_API_NG (car sharing)
  'how many hospitals are in london',          // → Highways England API
  'what is the population density of india',   // → Advicent.FactFinderService
  'what is the traffic like in seattle',       // → City of Surrey Traffic Loop Count
  'how many satellites orbit earth',           // → NeoWs Near Earth Object service
  'how many airports are in france',           // → Airport Nearest Relevant
  'what is the air quality in delhi',          // → U.S. EPA Enforcement and Compliance
  'what is the currency of thailand',          // → OpenFinTech.io
  'what is the flight time to paris',          // → Flight Cheapest Date Search
  'how much does a gallon of milk cost',       // → Spending Pulse
]

/** An API fact that survived every gate is the only outcome that fails. */
type Row = {
  q: string
  op: string
  opScore: number
  via: string | null
  verdict: string
  value: string
  ok: boolean
}

const rows: Row[] = []

for (const q of TAINTED) {
  const ops = await findOperations(q, 1).catch(() => [])
  const top = ops[0]

  const got = await groundTraced(q, router)
  const via = got.via
  const verdict = got.verdict?.why ?? '—'

  // The assertion. Reaching the web is fine — a passage says where it came
  // from. Reaching a hand-written source is fine — those are right by
  // construction. Declining is fine. Returning an unverified API value is not.
  const ok = via !== 'api'

  rows.push({
    q,
    op: top ? top.title.slice(0, 34) : '—',
    opScore: top ? top.score : 0,
    via,
    verdict,
    value: got.fact ? String(got.fact.value).replace(/\s+/g, ' ').slice(0, 34) : '—',
    ok,
  })
}

console.log(`\noperation bar ${bars.op.toFixed(3)}   path bar ${bars.path.toFixed(3)}   agreement bar ${bars.agree.toFixed(3)}\n`)
console.log(
  `${'question'.padEnd(38)}${'nearest operation'.padEnd(36)}${'S_op'.padEnd(7)}${'via'.padEnd(9)}${'gate'.padEnd(16)}value`,
)
console.log('-'.repeat(132))

for (const r of rows) {
  console.log(
    `${r.ok ? 'OK  ' : 'BAD '}${r.q.slice(0, 34).padEnd(34)}${r.op.padEnd(36)}${r.opScore.toFixed(3).padEnd(7)}${String(r.via).padEnd(9)}${r.verdict.padEnd(16)}${r.value}`,
  )
}

/**
 * The same questions with the gates switched off.
 *
 * Held at the same retrieval bar, so what this measures is the gates alone and
 * not the bar being recalibrated. Each line is an answer the old pipeline would
 * have rendered as a fact from a named host — and the `kept` column says which
 * gate, if any, now catches it.
 */
console.log('\nungated baseline — what the same questions produced before the gates\n')
console.log(`${'question'.padEnd(38)}${'would have shown'.padEnd(38)}${'from path'.padEnd(22)}caught by`)
console.log('-'.repeat(118))

let ungated = 0
for (const q of TAINTED) {
  const ops = await findOperations(q, 1).catch(() => [])
  const top = ops[0]
  if (!top || top.score < bars.op) continue

  const called = await callOperation(top, q, { refuseGuessed: false }).catch(() => null)
  if (!called) continue
  const read = await factFrom(top, called, q).catch(() => null)
  if (!read?.value) continue

  ungated += 1
  const v = await verify(called, read, q).catch(() => null)
  const caught = v?.ok ? 'NOTHING — still shown' : (v?.why ?? 'error')
  console.log(
    `    ${q.slice(0, 34).padEnd(34)}${read.value.replace(/\s+/g, ' ').slice(0, 34).padEnd(38)}${read.path.slice(0, 20).padEnd(22)}${caught}`,
  )
}

const pass = rows.filter((r) => r.ok).length
const overBar = rows.filter((r) => r.opScore >= bars.op).length

console.log(`\n${overBar}/${rows.length} questions had an operation clear the retrieval bar`)
console.log(`before: ${ungated}/${rows.length} produced an API value with the gates off`)
console.log(`after:  ${pass}/${rows.length} were kept off the API path by a gate`)

// A run where nothing even reached the gates proves nothing about the gates.
if (!overBar) {
  console.log('\n  WARNING: no operation cleared the bar — this run did not exercise the gates')
}

if (pass !== rows.length) process.exit(1)
