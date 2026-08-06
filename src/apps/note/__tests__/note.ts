/**
 * The parts of @note that can actually be wrong without a browser saying so.
 *
 * The editor is a contenteditable, so most of it is only true in a real DOM and
 * was verified in the real shell instead. What *can* be checked here is the
 * conversion at either end of it — markdown in, blocks, markdown out — and that
 * is the part where a text editor quietly loses your writing. Every assertion
 * about `parseDoc`/`writeDoc` below is really one assertion: opening a note and
 * saving it again without touching it must not change it.
 *
 * Search is here for a different reason. Its ranking is a claim about
 * behaviour — a title match beats a body match, an empty query is not an error,
 * and nothing matching means nothing comes back rather than the nearest thing
 * coming back anyway. That last one is the whole argument of `search.ts` and it
 * should fail loudly if someone ever "improves" it into a total ordering.
 */
import { CYCLE, kindOf, markerFor, nextKind, readBlock } from '../blocks'
import { parseDoc, parseInline, writeDoc, writeInline } from '../doc'
import { literal, nearest } from '../search'
import { titleOf, type Note } from '../../../store/notes'

let failed = 0
const ok = (name: string, cond: boolean, detail = '') => {
  if (!cond) failed++
  console.log(`  ${cond ? 'OK ' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
}

/** Open a note and save it again without touching it. */
const round = (md: string) => writeDoc(parseDoc(md))

const note = (over: Partial<Note>): Note => ({
  id: over.id ?? 'x',
  title: over.title ?? null,
  body: over.body ?? '',
  created: over.created ?? 0,
  updated: over.updated ?? 0,
  vec: over.vec,
})

console.log('\n── a block is its prefix')
ok('plain text is a paragraph', kindOf('just words') === 'paragraph')
ok('a hash is a heading', kindOf('# a title') === 'heading')
ok('six hashes still a heading', kindOf('###### deep') === 'heading')
ok('a hash with no space is not', kindOf('#hashtag') === 'paragraph')
ok('a dash is a list', kindOf('- one') === 'list')
ok('a star is a list', kindOf('* one') === 'list')
ok('a number is a list', kindOf('1. one') === 'list')
ok('an angle is a quote', kindOf('> said') === 'quote')
ok('four spaces is code', kindOf('    let x = 1') === 'code')
ok('three spaces is not code', kindOf('   nearly') === 'paragraph')
ok('code wins over the list inside it', kindOf('    - not a list') === 'code')
ok('the prefix is the exact characters', readBlock('##  spaced').prefix === '##  ')
ok('and the text is what is left', readBlock('##  spaced').text === 'spaced')

console.log('\n── the cycle closes')
ok('five kinds', CYCLE.length === 5)
ok('paragraph → heading', nextKind('paragraph') === 'heading')
ok('code → paragraph', nextKind('code') === 'paragraph')
ok(
  'five presses return to the start',
  CYCLE.reduce<ReturnType<typeof nextKind>>((k) => nextKind(k), 'paragraph') === 'paragraph',
)

console.log('\n── typing a marker is a gesture, not text')
ok('a hash and a space is a heading', markerFor('# ') === 'heading')
ok('a hyphen and a space is a list', markerFor('- ') === 'list')
ok('an ordered marker too', markerFor('1. ') === 'list')
ok('an angle is a quote', markerFor('> ') === 'quote')
ok('a fence is code', markerFor('```') === 'code')
ok('an incomplete marker is nothing', markerFor('#') === null)
ok('a year is not a list', markerFor('1980') === null)
ok('a word is nothing', markerFor('the ') === null)

console.log('\n── inline marks survive the round trip')
ok('plain text is one span', parseInline('hello there').length === 1)
ok('strong is found', parseInline('a **b** c')[1]?.strong === true)
ok('and its text excludes the markers', parseInline('a **b** c')[1]?.text === 'b')
ok('em is found', parseInline('a *b* c')[1]?.em === true)
ok('code is found', parseInline('a `b` c')[1]?.code === true)
ok('code is opaque', parseInline('`a * b`')[0]?.text === 'a * b')
ok('strong beats em on the same run', parseInline('**b**')[0]?.strong === true)
ok('written back unchanged', writeInline(parseInline('a **b** and *c* and `d`')) === 'a **b** and *c* and `d`')

console.log('\n── a note opened and saved untouched is unchanged')
const docs: [string, string][] = [
  ['plain', 'just a sentence.'],
  ['heading', '# Parts to order'],
  ['list', '- one\n- two\n- three'],
  ['quote', '> they said two weeks'],
  ['code', '    let x = 1'],
  ['mixed', '# Title\n\nsome prose here.\n\n- one\n- two\n\n> quoted\n\n    code line\n\nand the end.'],
  ['emphasis', 'a **bold** and an *italic* and a `snippet`'],
]
for (const [name, md] of docs) ok(name, round(md) === md, round(md) === md ? '' : JSON.stringify(round(md)))
ok('a second pass changes nothing further', round(round(docs[5][1])) === docs[5][1])
ok('blank lines do not multiply', round('a\n\n\n\nb') === 'a\n\nb')
ok('an ordered list comes back as a bullet', round('1. one\n2. two') === '- one\n- two')
ok('a fence becomes an indent', round('```\nx = 1\n```') === '    x = 1')
ok('an empty note is one empty paragraph', parseDoc('').length === 1)
ok('and writes back as nothing', round('') === '')
ok('markdown inside a code block stays literal', round('    # not a heading') === '    # not a heading')

console.log('\n── the title is the first line, unless it is not')
ok('first line wins', titleOf({ title: null, body: 'Groceries\nmilk' }) === 'Groceries')
ok('markup is stripped from it', titleOf({ title: null, body: '# Groceries\nmilk' }) === 'Groceries')
ok('a bullet too', titleOf({ title: null, body: '- Groceries' }) === 'Groceries')
ok('leading blank lines are skipped', titleOf({ title: null, body: '\n\nReal title' }) === 'Real title')
ok('an empty note is untitled', titleOf({ title: null, body: '   ' }) === 'untitled')
ok('an explicit title overrides', titleOf({ title: 'Set', body: '# Derived' }) === 'Set')

console.log('\n── literal search')
const notes = [
  note({ id: 'a', body: 'Tax return\nfile before April', updated: 3 }),
  note({ id: 'b', body: 'Groceries\nmilk, bread, apples', updated: 2 }),
  note({ id: 'c', body: 'Reading\nthe book about tax policy', updated: 1 }),
]
ok('an empty query lists everything', literal(notes, '').length === 3)
ok('and keeps the given order', literal(notes, '')[0].note.id === 'a')
ok('a title match comes first', literal(notes, 'tax')[0].note.id === 'a')
ok('a body match still matches', literal(notes, 'tax').length === 2)
ok('and comes second', literal(notes, 'tax')[1].note.id === 'c')
ok('case does not matter', literal(notes, 'GROCERIES').length === 1)
ok('nothing matching returns nothing', literal(notes, 'zebra').length === 0, 'this is the point')
ok('a body hit marks the characters', literal(notes, 'bread')[0].mark !== null)
ok(
  'and the marked range is the query',
  (() => {
    const h = literal(notes, 'bread')[0]
    return h.mark ? h.snippet.slice(h.mark[0], h.mark[1]).toLowerCase() === 'bread' : false
  })(),
)

console.log('\n── a snippet says something the title did not')
ok(
  'the title line is not repeated under itself',
  literal(notes, '')[1].snippet === 'milk, bread, apples',
  literal(notes, '')[1].snippet,
)
ok('a one-line note has no snippet at all', literal([note({ body: 'Solo' })], '')[0].snippet === '')
ok(
  'but a match is shown wherever it falls, title line included',
  literal(notes, 'Tax return')[0].snippet.includes('Tax return'),
)

console.log('\n── meaning is a fallback, and it is allowed to decline')
const unit = (v: number[]) => {
  const a = new Float32Array(v)
  let n = 0
  for (const x of a) n += x * x
  n = Math.sqrt(n) || 1
  for (let i = 0; i < a.length; i++) a[i] /= n
  return a
}
const vecNotes = [
  note({ id: 'near', body: 'a', vec: unit([1, 0, 0]) }),
  note({ id: 'far', body: 'b', vec: unit([0, 1, 0]) }),
  note({ id: 'blind', body: 'c' }),
]
ok('the aligned note comes back', nearest(vecNotes, unit([1, 0, 0]))[0]?.note.id === 'near')
ok('the orthogonal one does not', nearest(vecNotes, unit([1, 0, 0])).length === 1)
ok('a note with no vector is skipped, not scored zero', !nearest(vecNotes, unit([0, 0, 1])).length)
ok('nothing above the floor is nothing', nearest(vecNotes, unit([0, 0, 1])).length === 0)
ok('the floor can be lowered', nearest(vecNotes, unit([1, 1, 0]), 5, 0.5).length === 2)

console.log(`\n${failed === 0 ? 'all note checks passed' : `${failed} FAILED`}`)
if (failed) process.exit(1)
