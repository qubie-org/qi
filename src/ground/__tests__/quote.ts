/**
 * The citation check, against the ways a page actually renders.
 *
 * This function decides whether a claim keeps its source, so a bug in it is
 * invisible: research simply returns nothing, which looks like "the web had no
 * answer". It did exactly that once — eight sources, zero findings — because a
 * page rendered as `distribution , so` and the model quoted `distribution, so`.
 */
import { quotesFrom } from '../research'

let failed = 0
const t = (name: string, cond: boolean) => { if (!cond) failed++; console.log(`  ${cond ? 'OK ' : 'FAIL'}  ${name}`) }

const page = 'The verification preserves the target model’s original output distribution , so the technique produces the same results as standard decoding — only faster.'

console.log('\n── rendering artefacts are forgiven')
t('space before a comma', quotesFrom(page, 'original output distribution, so the technique'))
t('curly apostrophe vs straight', quotesFrom(page, "the target model's original output"))
t('em dash vs hyphen', quotesFrom(page, 'as standard decoding - only faster'))
t('collapsed whitespace', quotesFrom(page, 'preserves   the   target   model’s   original'))
t('non-breaking space', quotesFrom('a b c definitely long enough here', 'a b c definitely long enough here'))

console.log('\n── meaning is not forgiven')
t('a paraphrase fails', !quotesFrom(page, 'the output distribution stays the same as normal decoding'))
t('an invented sentence fails', !quotesFrom(page, 'speculative decoding gives a threefold speedup in all cases'))
t('a changed number fails', !quotesFrom('measured a 2.4x speedup on the benchmark suite', 'measured a 3.4x speedup on the benchmark suite'))
t('a too-short fragment is not evidence', !quotesFrom(page, 'the same'))

console.log(`\n${failed === 0 ? 'all quote checks passed' : `${failed} FAILED`}`)
if (failed) process.exit(1)
