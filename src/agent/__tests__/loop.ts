/**
 * The agent loop, end to end, against the two real servers.
 *
 * This is an integration test and it is meant to be: the things that break here
 * are not logic errors, they are agreements between four processes — llama's
 * tool-call streaming, the summariser's grammar, the store's retrieval, and
 * A1's willingness to answer from context instead of fetching again. None of
 * those can be mocked without testing the mock.
 *
 * The second turn is the point of the whole exercise. "is that cold?" contains
 * no subject; the only way to answer it is to have kept the first turn's
 * finding. If the agent calls `look` again there, continuity has failed however
 * good the sentence it eventually produces.
 *
 *   bun src/agent/__tests__/loop.ts     (needs tools/serve.sh running)
 */
import { ready } from '../../model/__tests__/harness'
import { buildRouter } from '../../ground'
import { openStore } from '../../store/db'
import { Digest } from '../digest'
import { Agent, type AgentEvent } from '../loop'

const A1 = 'http://127.0.0.1:8082'
const SUM = 'http://127.0.0.1:8081'
const base = path.resolve(import.meta.dir, '../../../public/models/potion')

// The app talks to vite-proxied relative paths. Outside the browser there is no
// proxy, so the same paths are rewritten to the servers directly and everything
// else — model files from disk, real source APIs over the network — is left
// alone. The code under test is unchanged.
const real = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(typeof input === 'string' || input instanceof URL ? input : input.url)
  if (url.startsWith('/llm')) return real(A1 + url.slice(4), init)
  if (url.startsWith('/sum')) return real(SUM + url.slice(4), init)
  if (url.startsWith('/models/')) {
    const buf = await readFile(path.join(base, path.basename(url)))
    return new Response(buf as unknown as BodyInit)
  }
  return real(input, init)
}) as typeof fetch

const up = async (name: string, url: string) => {
  try {
    if ((await real(url, { signal: AbortSignal.timeout(2000) })).ok) return true
  } catch {
    /* not running */
  }
  console.error(`✗ ${name} is not up at ${url} — start tools/serve.sh`)
  return false
}

if (!((await up('A1', `${A1}/health`)) && (await up('summarizer', `${SUM}/health`)))) process.exit(1)

const table = await loadTable('/models/potion')
const store = await openStore()
const digest = new Digest()
const agent = new Agent(digest)
await Promise.all([agent.load(), digest.load()])

const ctx = { table, router: buildRouter(table), store, needle: undefined }

async function turn(text: string) {
  const steps: string[] = []
  const statuses: string[] = []
  const started = Date.now()
  const out = await agent.run(text, ctx, (e: AgentEvent) => {
    if (e.t === 'step' && e.state !== 'running') steps.push(`${e.kind}(${e.subject}) → ${e.note?.title ?? '?'}`)
    if (e.t === 'status') statuses.push(e.text)
  })
  console.log(`\n  › ${text}`)
  for (const s of steps) console.log(`      ${s}`)
  if (statuses.length) console.log(`      status: ${statuses[statuses.length - 1]}`)
  console.log(`      "${out.reply}"   ${((Date.now() - started) / 1000).toFixed(1)}s`)
  store.addTurn('user', text)
  store.addTurn('agent', out.reply)
  return { ...out, steps }
}

console.log('── two turns, the second with no subject of its own')
const first = await turn("what's the weather in reykjavik?")
const topic = await digest.topic(store.recentTurns(4))
if (topic) store.putNote('topic', topic, null, (await import('../../engine/embed')).embed(table, topic))
console.log(`\n  topic: ${topic}`)
const second = await turn('is that cold?')

console.log('\n── checks')
const checks: [string, boolean][] = [
  ['first turn took at least one step', first.steps.length >= 1],
  ['first turn answered', first.reply.length > 0],
  ['second turn answered', second.reply.length > 0],
  // The whole point: the second turn must not re-fetch what the first found.
  ['second turn did not look up again', !second.steps.some((s) => s.startsWith('look('))],
  ['a topic line was written', !!topic],
  ['steps were recorded', store.stepsFor(1).length >= 1],
]
for (const [what, ok] of checks) console.log(`  ${ok ? '✓' : '✗'} ${what}`)
process.exit(checks.every(([, ok]) => ok) ? 0 : 1)
