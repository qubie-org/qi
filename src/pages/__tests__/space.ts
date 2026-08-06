/** Addressing: exact ids are law, descriptions resolve softly, misses fail. */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { loadTable } from '../../engine/embed'
import { addressOf, address, clear, put, resolve, slug } from '../space'

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
let fails = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) fails++
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}${name}${detail ? '  ' + detail : ''}`)
}

console.log('\n── addresses')
check('scheme parsed', addressOf('toki:weather') === 'weather')
check('external ignored', addressOf('https://example.com') === null)
check('round trip', addressOf(address('bend oregon')) === 'bend oregon')
check('slug', slug('The Apollo Program!') === 'the-apollo-program', slug('The Apollo Program!'))

clear()
put({ id: 'weather', kind: 'app', title: 'weather',
      aliases: ['temperature', 'how hot is it', 'forecast'], body: '' })
put({ id: 'apollo-program', kind: 'source', title: 'Apollo program',
      aliases: ['moon landing', 'nasa moon mission'], body: '' })
put({ id: 'sources', kind: 'page', title: 'sources',
      aliases: ['catalogue', 'index', 'directory', 'tools', 'lookup'], body: '' })

console.log('\n── deterministic: an exact id always wins')
{
  const hit = resolve('weather', t)
  check('exact id', hit?.page.id === 'weather' && hit.exact, `${hit?.page.id} exact=${hit?.exact}`)
  const viaSlug = resolve('Apollo Program', t)
  check('title slugs to id', viaSlug?.page.id === 'apollo-program' && viaSlug.exact,
        `${viaSlug?.page.id} exact=${viaSlug?.exact}`)
}

console.log('\n── soft: a description lands by meaning, not spelling')
{
  const moon = resolve('the nasa mission that landed on the moon', t)
  check('description -> page', moon?.page.id === 'apollo-program',
        `${moon?.page.id} score=${moon?.score.toFixed(2)} exact=${moon?.exact}`)
  const hot = resolve('is it hot outside', t)
  check('phrasing -> app', hot?.page.id === 'weather',
        `${hot?.page.id} score=${hot?.score.toFixed(2)}`)
  const cat = resolve('show me the source directory', t)
  check('index reachable', cat?.page.id === 'sources',
        `${cat?.page.id} score=${cat?.score.toFixed(2)}`)
}

console.log('\n── misses fail rather than guessing')
{
  const junk = resolve('quarterly amortisation schedule', t)
  check('unrelated -> null', junk === null, junk ? `${junk.page.id} ${junk.score.toFixed(2)}` : '')
}

console.log(`\n${fails === 0 ? 'all addressing checks passed' : `${fails} FAILED`}`)
process.exit(fails ? 1 : 0)
