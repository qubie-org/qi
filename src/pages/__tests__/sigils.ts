/**
 * The three namespaces, and the parser that reaches them.
 *
 * Two properties matter more than the contents, because the contents will
 * change and these must not:
 *
 *   a sigil resolves in exactly one namespace, so the same word can exist as a
 *   command and as an app without a press picking the wrong one;
 *
 *   and a sigil mid-word is never an invocation, because "and/or", "US$40" and
 *   an email address all contain one and none of them is a chip.
 */
import { parse } from '../../inline/parse'
import { COMMANDS, find, immediate, isSigil, match, SIGILS } from '../sigils'
import { commandFrom, parseControls } from '../../skills'
import { appFrom } from '../../apps'
import { register } from '../sigils'
import { readFileSync } from 'node:fs'
import type { Node } from '../../inline/types'

let failed = 0
const ok = (name: string, cond: boolean, detail = '') => {
  if (!cond) failed++
  console.log(`  ${cond ? 'OK ' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
}

const invocations = (s: string): string[] => {
  const out: string[] = []
  const walk = (nodes: Node[]) => {
    for (const n of nodes) {
      if (n.t === 'invoke') out.push(`${n.sigil}${n.id}`)
      else if ('kids' in n && Array.isArray(n.kids)) walk(n.kids)
    }
  }
  walk(parse(s))
  return out
}

// Skills live in folders. The app finds them with Vite's glob, which does not
// exist here — so the file is read directly and put through the same pure
// builder the app uses. What is being tested is the parsing and the registry,
// which is the part that can actually be wrong.
// `dj` is a command, not a skill — it runs a script rather than informing the
// agent. Built here through the same pure builder the app uses, since Vite's
// glob does not exist in the test runner.
const dj = commandFrom(
  '../commands/dj/COMMAND.md',
  readFileSync(new URL('../../commands/dj/COMMAND.md', import.meta.url), 'utf8'),
  { run: async () => null, running: () => false, control: () => {} },
)
if (dj) register([dj])

// Same story for the first app. The surface is a stand-in — what is being
// tested is that a folder becomes a registry entry in the right namespace, not
// what it draws, and drawing it would drag React and a DOM into a runner that
// has neither.
const noteApp = appFrom(
  '../apps/note/APP.md',
  readFileSync(new URL('../../apps/note/APP.md', import.meta.url), 'utf8'),
  { surface: (() => null) as never },
)
if (noteApp) register([noteApp])

console.log('\n── the registries are what they claim to be')
// Three entries under `/`: two commands and one app. They share the namespace
// and are told apart by shape.
ok('three entries under /', COMMANDS.length === 3, COMMANDS.map((c) => c.id).join())
ok('it is the coin price', COMMANDS[0]?.id === 'crypto' && COMMANDS[0]?.name === 'coin price')
ok('commands carry a runner', typeof COMMANDS[0]?.run === 'function')
ok('dj loaded from its folder as a command', COMMANDS.some((c) => c.id === 'dj'))
ok('and declares a stop control', COMMANDS.find((c) => c.id === 'dj')?.controls?.[0]?.action === 'stop')
ok('there is no skill namespace', !('$' in SIGILS))
ok('and no search namespace', !('#' in SIGILS))
const noteEntry = COMMANDS.find((c) => c.id === 'note')
ok('the app loaded from its folder', noteEntry !== undefined)
ok('under the command sigil', noteEntry?.sigil === '/')
ok('carrying its surface', noteEntry !== undefined && 'surface' in noteEntry)
ok('and knowing how to ask for the page', noteEntry !== undefined && typeof (noteEntry as { enter?: unknown }).enter === 'function')
// The one property an app must have that a command must not: it takes the page
// on choice rather than first asking a question.
ok('an app is immediate', noteEntry !== undefined && immediate(noteEntry) === true)
// Apps and commands share `/`, so what distinguishes them has to be on the
// entry. `enter` is that property, and the app.tsx choose path branches on it.
ok('an app is told apart by having a surface, not by its sigil', noteEntry !== undefined && 'enter' in noteEntry && !('run' in noteEntry))
ok('and it is registered in the command namespace', SIGILS['/'].entries.some((e) => e.id === 'note'))
ok('an app with no surface is not an app', appFrom('./x/APP.md', '---\nid: x\n---\nbody', {}) === null)
ok('every entry knows its own sigil', COMMANDS.every((c) => c.sigil === '/'))

console.log('\n── sigils')
ok('two of them', Object.keys(SIGILS).length === 2, Object.keys(SIGILS).join(''))
ok('isSigil accepts both', ['/', '@'].every(isSigil))
// `$` is here on purpose: it was a namespace once, and a stale parser that
// still accepted it would silently route to nothing.
ok('isSigil rejects others, including the retired $ and #', !['!', '&', 'a', '', '%', '$', '#'].some(isSigil))
ok('kinds are distinct', new Set(Object.values(SIGILS).map((s) => s.kind)).size === 2)

console.log('\n── matching')
ok('empty query lists everything', match('/', '').length === COMMANDS.length)
ok('prefix finds the coin price', match('/', 'co')[0]?.id === 'crypto')
ok('id also matches', match('/', 'cry')[0]?.id === 'crypto')
ok('no match is empty, not everything', match('/', 'zzzz').length === 0)
ok('dj is in the command namespace', match('/', 'dj')[0]?.id === 'dj')
ok('an app is matched under /', match('/', 'no')[0]?.id === 'note')
// `@` resolves to results from the store, not to registered entries, so there
// is nothing here for `match` to find and that is the design rather than a gap.
ok('@ has no registry to match against', match('@', '').length === 0)
ok('coin price is not immediate', immediate(COMMANDS[0]) === false)

console.log('\n── find crosses namespaces but not sigils')
ok('by id', find('crypto')?.id === 'crypto')
ok('by name', find('coin price')?.id === 'crypto')
ok('unknown is undefined', find('nonesuch') === undefined)

console.log('\n── the parser')
ok('a command', invocations('try /crypto now').join() === '/crypto')
ok('a retired $ sigil does not parse', invocations('try $research now').length === 0)
ok('a found thing', invocations('open @canvas now').join() === '@canvas')
ok('both at once', invocations('/crypto @canvas').join() === '/crypto,@canvas')
ok('a retired # sigil does not parse', invocations('see #notes now').length === 0)

console.log('\n── controls, parsed from frontmatter')
ok('one control', parseControls('⏹ stop stop the set').length === 1)
ok('glyph and action split', parseControls('⏹ stop stop the set')[0]?.glyph === '⏹')
ok('rest is the tooltip', parseControls('⏹ stop stop the set')[0]?.title === 'stop the set')
ok('several, comma separated', parseControls('⏸ pause pause it, ⏹ stop stop it').length === 2)
ok('empty is empty', parseControls(undefined).length === 0)
ok('a command with no run is not a command', commandFrom('./x/COMMAND.md', '---\nid: x\n---\nbody', {}) === null)

console.log('\n── and never mid-word')
ok('a path', invocations('read and/or write').length === 0, invocations('read and/or write').join())
ok('an email', invocations('mail shane@example.com').length === 0, invocations('mail shane@example.com').join())
ok('a price', invocations('costs US$40 today').length === 0, invocations('costs US$40 today').join())
ok('a url keeps its slashes', invocations('see https://a.com/b now').length === 0, invocations('see https://a.com/b now').join())

console.log('\n── punctuation is not part of the name')
ok('trailing full stop', invocations('run /crypto.').join() === '/crypto')
ok('inside brackets', invocations('(/crypto)').join() === '/crypto')

console.log(`\n${failed === 0 ? 'all sigil checks passed' : `${failed} FAILED`}`)
if (failed) process.exit(1)
