/** Does a sentence reach the right source — and decline when it should? */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { loadTable } from '../../engine/embed'
import { buildRouter, route } from '../index'

const base = path.resolve(import.meta.dir, '../../../public/models/potion')
globalThis.fetch = (async (url: string) => {
  const buf = await readFile(path.join(base, path.basename(String(url))))
  return {
    ok: true,
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    json: async () => JSON.parse(buf.toString()),
  }
}) as unknown as typeof fetch

const t = await loadTable(base)
const router = buildRouter(t)

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
  const hit = route(q, t, router)
  const got = hit?.source.id ?? null
  const ok = got === want
  pass += Number(ok)
  const score = hit ? hit.score.toFixed(2) : '—'
  console.log(`${ok ? 'OK  ' : 'BAD '}${q.slice(0, 34).padEnd(34)}${String(want).padEnd(10)}${String(got).padEnd(10)}${score}`)
}
console.log(`\n${pass}/${CASES.length} routed correctly`)
if (pass !== CASES.length) process.exit(1)
