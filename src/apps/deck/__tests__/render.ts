/**
 * The deck renderer, which is the half of `/present` that cannot be allowed to
 * be approximately right.
 *
 * Everything a slide shows was checked once already — the quote against its
 * page, the claim against its quote. All of that is worth nothing if the
 * assembly step loses a citation, swallows a slide, or turns a claim containing
 * `<` into broken markup. Those are exactly the failures that look fine until
 * the one deck where they matter.
 *
 * Pure functions over strings, so this runs under bun with no app, no model and
 * no network:
 *
 *   bun src/apps/deck/__tests__/render.ts
 */
import { deckHtml, frontmatterOf, inlineHtml, slidesFrom } from '../render'

let failed = 0
const ok = (name: string, cond: boolean, detail = '') => {
  if (!cond) failed++
  console.log(`  ${cond ? 'OK ' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
}

console.log('\n── splitting into slides')
const three = '# One\n\nbody one\n---\n## Two\n\nbody two\n---\n## Three'
ok('three slides', slidesFrom(three).length === 3, String(slidesFrom(three).length))
ok('heading is lifted off the body', slidesFrom(three)[0]?.heading === 'One')
ok('and is not left in it', !slidesFrom(three)[0]?.body.includes('One'))
ok('body survives', slidesFrom(three)[0]?.body === 'body one')
ok('a slide that is only a heading is still a slide', slidesFrom(three)[2]?.heading === 'Three')

// The separator is `---` alone on a line. A run of dashes inside a sentence, or
// a longer rule, must not split the deck.
ok('inline dashes do not split', slidesFrom('a --- b').length === 1)
ok('trailing spaces still split', slidesFrom('a\n--- \nb').length === 2)

console.log('\n── frontmatter is metadata, not an empty first slide')
const withFm = '---\ntheme: dark\n---\n# Real\n\nbody'
ok('fields are read', frontmatterOf(withFm).fields.theme === 'dark')
ok('one slide, not two', slidesFrom(withFm).length === 1, String(slidesFrom(withFm).length))
ok('and it is the real one', slidesFrom(withFm)[0]?.heading === 'Real')

console.log('\n── citations are lifted out of the body')
const cited = '## Finding\n\nA claim.\n\n> the quoted sentence\n\n[Some Page](https://example.com/a)'
const slide = slidesFrom(cited)[0]
ok('the source is captured', slide?.cites[0]?.url === 'https://example.com/a')
ok('with its title', slide?.cites[0]?.title === 'Some Page')
ok('and removed from the body', !slide?.body.includes('example.com'))
ok('the quote stays in the body', slide?.body.includes('> the quoted sentence') === true)
// A deck whose citation silently vanished would look correct and be unverifiable,
// which is the worst of the available failures.
ok('a slide with no citation has none', slidesFrom('## X\n\nbody')[0]?.cites.length === 0)

console.log('\n── markdown, only as much as a slide uses')
ok('bullets become a list', inlineHtml('- one\n- two').includes('<ul>\n<li>one</li>'))
ok('a list closes', inlineHtml('- one\n\ntext').includes('</ul>'))
ok('quotes become blockquote', inlineHtml('> said').includes('<blockquote>'))
ok('bold', inlineHtml('a **b** c').includes('<strong>b</strong>'))
ok('italic', inlineHtml('a *b* c').includes('<em>b</em>'))
ok('code', inlineHtml('use `x` here').includes('<code>x</code>'))
ok('plain text becomes a paragraph', inlineHtml('just words') === '<p>just words</p>')

console.log('\n── escaping, because a claim is arbitrary text')
// Real claims from today's runs contained `<`, `&` and quote marks. Any of them
// unescaped is a broken slide at best.
ok('angle brackets', inlineHtml('a < b').includes('a &lt; b'))
ok('ampersand', inlineHtml('this & that').includes('this &amp; that'))
ok('a tag is not a tag', !inlineHtml('<script>x</script>').includes('<script>'))
ok('escaping happens before markup', inlineHtml('**<b>**').includes('<strong>&lt;b&gt;</strong>'))

console.log('\n── the whole deck')
const html = deckHtml(three)
ok('one section per slide', (html.match(/<section>/g) ?? []).length === 3)
ok('headings render as h2', html.includes('<h2>One</h2>'))
const citedHtml = deckHtml(cited)
ok('citations render as a footer', citedHtml.includes('class="cites"'))
ok('the url is a title attribute, not a link', citedHtml.includes('title="https://example.com/a"') && !citedHtml.includes('<a '))

console.log('\n── nothing in, nothing out')
ok('empty is empty', slidesFrom('').length === 0)
ok('whitespace is empty', slidesFrom('\n\n  \n').length === 0)
ok('empty deck renders to empty string', deckHtml('') === '')

console.log(failed ? `\n${failed} FAILED` : '\nall deck render checks passed')
if (failed) process.exit(1)
