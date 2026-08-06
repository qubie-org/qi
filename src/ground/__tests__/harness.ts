/**
 * The grounding suites, wired to the real thing.
 *
 * Routing is pure embeddings and needs only the vector harness. Everything past
 * routing — filling parameters, reading a response, clearing the gates — needs
 * the model server and the operations index, and neither is reachable from a
 * bun process the way it is from the page: the page talks to `/llm` and
 * `/apis`, which are Vite proxy paths, and a relative URL means nothing here.
 *
 * So the paths are bridged rather than the code changed. Nothing under test
 * knows it is being tested, which is the property that makes these suites worth
 * running: `granite` is the same singleton the app uses, `loadOperations` reads
 * the same index the app reads, and `net` reaches the same open web.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { granite } from '../../model/granite'

export { ready as vectorsReady } from '../../model/__tests__/harness'

const root = path.resolve(import.meta.dir, '../../..')
const LLAMA = 'http://127.0.0.1:8082'

let installed = false

/**
 * Point the page's relative URLs at the real services.
 *
 * Only the two prefixes the page actually serves locally are mapped. Anything
 * else — including `/net/fetch` — is handed to the real fetch and allowed to
 * fail, which is what makes `net()` fall back to fetching directly. That
 * fallback is the correct behaviour here rather than a workaround: bun has no
 * CORS, so a direct fetch reaches exactly what the bridge would have.
 */
function bridgePaths(): void {
  if (installed) return
  installed = true
  const real = globalThis.fetch

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url

    if (url.startsWith('/llm/')) return real(`${LLAMA}${url.slice(4)}`, init)
    if (url.startsWith('/apis/')) {
      const file = path.join(root, 'public', url)
      const body = readFileSync(file)
      return new Response(new Uint8Array(body), {
        headers: {
          'content-type': url.endsWith('.json') ? 'application/json' : 'application/octet-stream',
        },
      })
    }
    return real(input as RequestInfo, init)
  }) as typeof fetch
}

/**
 * Is the whole stack up?
 *
 * Answered rather than assumed, because these suites reach a model server and
 * the open web and both are allowed to be absent. A suite that cannot run says
 * so and skips; it does not fail, and it does not quietly pass either.
 */
export const modelReady = (async () => {
  bridgePaths()
  try {
    await granite.load()
    return true
  } catch {
    return false
  }
})()

/**
 * Printed once by any suite that had to skip, so a green run is never a lie.
 *
 * The reason is spelled out rather than assumed. A suite that skips because the
 * model server is down and a suite that skips because the reducer sandbox
 * cannot boot are different problems with different fixes, and a single
 * catch-all message sends you to restart a server that was never the issue.
 */
export function skipNote(what: string, why = `no model server on ${LLAMA}`): void {
  console.log(`\n  SKIPPED ${what} — ${why}`)
  console.log(`  model server: bash tools/serve.sh`)
  console.log(`  the reducer sandbox needs the Wasmer registry and does not run under bun;`)
  console.log(`  verify these against the running app instead.\n`)
}
