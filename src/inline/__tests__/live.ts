/**
 * The streaming formatter, checked one character at a time.
 *
 * The property that matters is not "does it format" but "does raw syntax ever
 * reach the page" — so the important test feeds a sentence in prefix by prefix,
 * exactly as tokens arrive, and asserts that no marker character survives in
 * any of the hundred-odd intermediate renderings.
 */
import { liveSpans } from '../live'

let failed = 0
const ok = (name: string, cond: boolean, detail = '') => {
  if (!cond) failed++
  console.log(`  ${cond ? 'OK ' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
}

const flat = (s: string) => liveSpans(s).map((x) => x.text).join('')
const kinds = (s: string) => liveSpans(s).map((x) => `${x.kind}${x.pending ? '?' : ''}:${x.text}`).join('|')

console.log('\n── closed markup is styled')
ok('bold', kinds('a **b** c') === 'plain:a |strong:b|plain: c', kinds('a **b** c'))
ok('italic', kinds('a *b* c') === 'plain:a |em:b|plain: c', kinds('a *b* c'))
ok('code', kinds('a `b` c') === 'plain:a |code:b|plain: c', kinds('a `b` c'))
ok('bold beats italic', kinds('**b**') === 'strong:b', kinds('**b**'))

console.log('\n── open markup withholds its marker')
ok('open bold shows text only', flat('a **bo') === 'a bo', flat('a **bo'))
ok('open bold is not styled yet', liveSpans('a **bo').some((s) => s.pending === true))
ok('open code', flat('a `x') === 'a x', flat('a `x'))

console.log('\n── links show their body, never their url')
ok('link body', flat('see [Iceland](https://x.com) now') === 'see Iceland now', flat('see [Iceland](https://x.com) now'))
ok('image dropped', flat('a ![alt](u) b') === 'a  b', flat('a ![alt](u) b'))
ok('half link', flat('see [Icel') === 'see Icel', flat('see [Icel'))
ok('link with url half typed shows body only', flat('see [Iceland](htt') === 'see Iceland', flat('see [Iceland](htt'))

console.log('\n── the invariant: no marker survives at any prefix')
const sentence = 'Iceland sits on the **Mid-Atlantic Ridge**, where `plates` pull apart — see [the map](https://example.com/a_b) for *more* detail.'
let leaked: string[] = []
for (let i = 1; i <= sentence.length; i++) {
  const rendered = flat(sentence.slice(0, i))
  // An underscore inside a URL is legitimate text once the link resolves; the
  // markers that must never appear are the ones that mean formatting.
  if (/\*|`|\]\(|^\[|\s\[/.test(rendered)) leaked.push(`${i}: ${JSON.stringify(rendered.slice(-28))}`)
}
ok(`no leaked syntax across ${sentence.length} prefixes`, leaked.length === 0, leaked.slice(0, 3).join('  '))

console.log('\n── text is never lost or duplicated')
ok('final render matches plain reading',
  flat(sentence) === 'Iceland sits on the Mid-Atlantic Ridge, where plates pull apart — see the map for more detail.',
  flat(sentence))

console.log(`\n${failed === 0 ? 'all live-markup checks passed' : `${failed} FAILED`}`)
if (failed) process.exit(1)
