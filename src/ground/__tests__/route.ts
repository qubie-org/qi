/**
 * Does a sentence reach the right source — and decline when it should?
 *
 * Two phases, because they check different things and fail for different
 * reasons. The first asserts the *routing decision*, which is pure embeddings
 * and always runnable. The second asserts the *path actually taken* end to end,
 * which needs the model server and the reducer sandbox.
 *
 * The split was not a design preference; it was forced by a bug. `route()` said
 * `weather` for "what is the weather in oslo" and this suite asserted that and
 * passed, while `ground()` fetched a Wikipedia article about Oslo — because the
 * ordering rule downstream of the routing decision demoted the weather source.
 * A suite that only ever asked the router could not see it. Asserting where the
 * answer came from is what caught it, so that is now asserted too.
 */
import { ready } from '../../model/__tests__/harness'
import { modelReady, skipNote } from './harness'
import { buildRouter, groundTraced, route, sandboxReady } from '../index'

await ready
const router = await buildRouter()

/** [query, expected source id or null for "should not ground"] */
const CASES: [string, string | null][] = [
  ['what is the weather in bend oregon', 'weather'],
  ['how cold is it in Reykjavik', 'weather'],
  ['is it raining in london', 'weather'],
  ['what is the moon', 'wiki'],
  ['tell me about basque cheesecake', 'wiki'],
  ['who was Ada Lovelace', 'wiki'],
  ['how much is bitcoin', 'crypto'],
  ['ethereum price', 'crypto'],
  ['where is the international space station', 'iss'],
  // An explicit lookup must reach the encyclopedia rather than a source whose
  // anchors merely brush the topic — this used to hit the ISS tracker.
  ['tell me about the apollo moon landing', 'wiki'],
  // Named exactly, the live source wins even under a "what is" form: an exact
  // anchor match is the strongest signal there is, and answering "432 km up"
  // is a fair reading of the question.
  ['what is the international space station', 'iss'],
  ['show me a dog', 'dog'],
  ['tell me a joke', 'joke'],
  ['a cat fact', 'catfact'],
  ['show me a painting of water lilies', 'art'],
  ['show me a picture of the ocean at night', 'image'],
  ['photo of a lighthouse', 'image'],
  ['dollars to euros', 'fx'],
  // How-to questions want steps, not a lookup — and "how to *make* a grilled
  // cheese" must not collide with a joke source.
  ['how to make a grilled cheese', null],
  ['how do i make pancakes', null],
  ['top 5 presidents', null],
  ['what are the steps to deploy', null],
  // Must decline — these are conversation, not lookups.
  ['i need help', null],
  ['hi there', null],
  ['thanks', null],
  ['that is really beautiful', null],
  ['i feel tired today', null],
  ['what do you think', null],
]

let pass = 0
console.log(`${'query'.padEnd(38)}${'want'.padEnd(10)}${'got'.padEnd(10)}score`)
console.log('-'.repeat(70))
for (const [q, want] of CASES) {
  const hit = await route(q, router)
  const got = hit?.source.id ?? null
  const ok = got === want
  pass += Number(ok)
  const score = hit ? hit.score.toFixed(2) : '—'
  console.log(`${ok ? 'OK  ' : 'BAD '}${q.slice(0, 34).padEnd(34)}${String(want).padEnd(10)}${String(got).padEnd(10)}${score}`)
}
console.log(`\n${pass}/${CASES.length} routed correctly`)
if (pass !== CASES.length) process.exit(1)

/* ── phase two: which path actually answered ────────────────────────────────
 *
 * `source_id | 'api' | 'web' | null` — the route the fact came back through,
 * not the route the router would have preferred.
 */

/** [query, expected path] */
const PATHS: [string, string | null][] = [
  // A hand-written source must not be displaced by the encyclopedia just
  // because the question is phrased as a lookup. This is the case that was
  // silently wrong.
  ['what is the weather in oslo', 'weather'],
  ['how cold is it in Reykjavik', 'weather'],
  ['how much is bitcoin', 'crypto'],
  ['dollars to euros', 'fx'],
  ['where is the international space station', 'iss'],
  // Lookup-shaped questions no source claims fall to the encyclopedia.
  ['who was Ada Lovelace', 'wiki'],
  ['tell me about basque cheesecake', 'wiki'],
  ['tell me about the apollo moon landing', 'wiki'],
  // Conversation must still decline, and must not reach an API or the web —
  // both of those always have something to return.
  ['i need help', null],
  ['thanks', null],
  ['what do you think', null],
  ['that is really beautiful', null],
]

const sandbox = await sandboxReady()
if (!(await modelReady) || !sandbox) {
  // Reducers run in QuickJS inside Wasmer, which needs the package registry —
  // absent here, every hand-written source returns nothing and every one of
  // these assertions would be measuring the harness rather than the code.
  skipNote(
    'path assertions',
    `model ${(await modelReady) ? 'up' : 'down'}, reducer sandbox ${sandbox ? 'up' : 'down'}`,
  )
  process.exit(0)
}

let paths = 0
console.log(`\n${'query'.padEnd(38)}${'want'.padEnd(10)}${'got'.padEnd(10)}gate`)
console.log('-'.repeat(78))

for (const [q, want] of PATHS) {
  const got = await groundTraced(q, router)
  const ok = got.via === want
  paths += Number(ok)
  console.log(
    `${ok ? 'OK  ' : 'BAD '}${q.slice(0, 34).padEnd(34)}${String(want).padEnd(10)}${String(got.via).padEnd(10)}${got.verdict?.why ?? '—'}`,
  )
}

console.log(`\n${paths}/${PATHS.length} took the expected path`)
if (paths !== PATHS.length) process.exit(1)
