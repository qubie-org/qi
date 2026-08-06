/**
 * Exercises the grounding mechanics: reranking, the fallback chain, and the
 * cache. The sandbox is stubbed — it needs Wasmer and a browser — so these
 * tests cover routing, ordering, retry and caching, and the browser check
 * covers the sandbox path.
 */
import { mock } from 'bun:test'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const base = path.resolve(import.meta.dir, '../../../public/models/potion')

// Stub the sandbox before anything imports it: `?url` imports are a Vite
// feature and would not resolve under bun.
let reduceCalls = 0
mock.module(path.resolve(import.meta.dir, '../sandbox.ts'), () => ({
  MAX_FACT_BYTES: 512,
  bootSandbox: async () => null,
  sandboxReady: async () => false,
  // Stand-in for QuickJS: run the reducer body with `data` in scope.
  reduce: async (body: string, payload: unknown) => {
    reduceCalls++
    try {
      const out = new Function('data', body)(payload)
      return out && typeof out.value === 'string' ? out : null
    } catch {
      return null
    }
  },
}))

const realFetch = globalThis.fetch
let fetchCount = 0
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  const u = String(url)
  if (u.includes('/models/potion')) {
    const buf = await readFile(path.join(base, path.basename(u)))
    return {
      ok: true,
      arrayBuffer: async () =>
        buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      json: async () => JSON.parse(buf.toString()),
    }
  }
  fetchCount++
  return realFetch(u, init)
}) as unknown as typeof fetch

const { loadTable } = await import('../../engine/embed')
const { buildRouter, ground, rerank, routeAll } = await import('../index')

const t = await loadTable(base)
const router = buildRouter(t)
let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}${name}${detail ? '  ' + detail : ''}`)
}

// ── B. reranking ──────────────────────────────────────────────────────────
console.log('\n── rerank: shortlist -> best match for the query')
{
  const fact = {
    label: 'Mercury (planet)',
    value: 'the smallest planet',
    src: 'wikipedia',
    hint: 'Mercury',
    candidates: [
      { label: 'Mercury (element)', value: 'a liquid metal used in thermometers' },
      { label: 'Mercury (planet)', value: 'the smallest planet in the solar system' },
      { label: 'Freddie Mercury', value: 'the singer of the band Queen' },
    ],
  }
  const planet = rerank('how big is the planet mercury', fact, t)
  const singer = rerank('who sang for queen the band', fact, t)
  const metal = rerank('liquid metal in a thermometer', fact, t)
  check('planet query -> planet', planet.label === 'Mercury (planet)', planet.label)
  check('singer query -> singer', singer.label === 'Freddie Mercury', singer.label)
  check('metal query  -> element', metal.label === 'Mercury (element)', metal.label)
  check('candidates cleared after collapse', planet.candidates === undefined)
}

// ── A. route ordering ─────────────────────────────────────────────────────
console.log('\n── routeAll: ranked, deduped, one entry per source')
{
  const hits = routeAll('what is the weather in tokyo', t, router)
  const ids = hits.map((h) => h.source.id)
  check('weather ranks first', ids[0] === 'weather', ids.join(' > '))
  check('no duplicate sources', new Set(ids).size === ids.length)
  check('sorted by score', hits.every((h, i) => i === 0 || hits[i - 1].score >= h.score))
  check('declines conversation', routeAll('i feel tired today', t, router).length === 0)
}

// ── A. fallback chain ─────────────────────────────────────────────────────
console.log('\n── fallback: a dead source must not end the turn')
{
  const { SOURCES } = await import('../sources')
  const weather = SOURCES.find((s) => s.id === 'weather')!
  const original = weather.fetch
  weather.fetch = async () => {
    throw new Error('simulated outage')
  }
  const fact = await ground('what is the weather in tokyo right now', t, router)
  weather.fetch = original
  check('survived the outage', fact !== null, fact ? `fell through to ${fact.src}` : 'gave up')
}

// ── A. cache ──────────────────────────────────────────────────────────────
console.log('\n── cache: a repeated question must not refetch')
{
  const q = 'how much is bitcoin'
  fetchCount = 0
  const first = await ground(q, t, router)
  const afterFirst = fetchCount
  const second = await ground(q, t, router)
  const afterSecond = fetchCount
  check('first call fetched', afterFirst > 0, `${afterFirst} request(s)`)
  check('second call did not', afterSecond === afterFirst, `${afterSecond - afterFirst} extra`)
  check('same fact returned', JSON.stringify(first) === JSON.stringify(second))
}

// ── A. wikipedia search fallback ──────────────────────────────────────────
console.log('\n── wiki: a 404 on direct lookup falls through to search')
{
  const { SOURCES } = await import('../sources')
  const wiki = SOURCES.find((s) => s.id === 'wiki')!
  // The fallback test above already hit Wikimedia; give it room before the
  // next burst or the 429 is our own fault rather than a real finding.
  await new Promise((r) => setTimeout(r, 1500))
  const payload: any = await wiki.fetch('the moon landing thing')
  check('search path used', !!payload.search, payload.direct ? 'direct hit' : 'searched')
  check('search returned pages', (payload.search?.length ?? 0) > 0, `${payload.search?.length ?? 0} pages`)
  const direct: any = await wiki.fetch('Moon')
  check('direct path still works', !!direct.direct, direct.direct?.title ?? '')
}

console.log(`\n${failures === 0 ? 'all grounding checks passed' : `${failures} FAILED`}`)
process.exit(failures ? 1 : 0)
