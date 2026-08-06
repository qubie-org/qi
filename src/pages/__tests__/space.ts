/** Addressing: exact ids are law, descriptions resolve softly, misses fail. */
import { ready } from '../../model/__tests__/harness'
import { addressOf, address, clear, put, resolve, slug } from '../space'

await ready
let fails = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) fails++
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}${name}${detail ? '  ' + detail : ''}`)
}

console.log('\n── addresses')
check('scheme parsed', addressOf('qi:weather') === 'weather')
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
  const hit = await resolve('weather')
  check('exact id', hit?.page.id === 'weather' && hit.exact, `${hit?.page.id} exact=${hit?.exact}`)
  const viaSlug = await resolve('Apollo Program')
  check('title slugs to id', viaSlug?.page.id === 'apollo-program' && viaSlug.exact,
        `${viaSlug?.page.id} exact=${viaSlug?.exact}`)
}

console.log('\n── soft: a description lands by meaning, not spelling')
{
  const moon = await resolve('the nasa mission that landed on the moon')
  check('description -> page', moon?.page.id === 'apollo-program',
        `${moon?.page.id} score=${moon?.score.toFixed(2)} exact=${moon?.exact}`)
  const hot = await resolve('is it hot outside')
  check('phrasing -> app', hot?.page.id === 'weather',
        `${hot?.page.id} score=${hot?.score.toFixed(2)}`)
  const cat = await resolve('show me the source directory')
  check('index reachable', cat?.page.id === 'sources',
        `${cat?.page.id} score=${cat?.score.toFixed(2)}`)
}

console.log('\n── misses fail rather than guessing')
{
  const junk = await resolve('quarterly amortisation schedule')
  check('unrelated -> null', junk === null, junk ? `${junk.page.id} ${junk.score.toFixed(2)}` : '')
}

console.log(`\n${fails === 0 ? 'all addressing checks passed' : `${fails} FAILED`}`)
process.exit(fails ? 1 : 0)
