/**
 * The guard against a claim naming something its evidence does not.
 *
 * This exists because of one output, and the output is worth writing down in
 * full because nothing else this process has produced was as bad:
 *
 *   asked   who founded huggingface
 *   quote   "Background Moonshot was founded in March 2023 by Yang Zhilin, Zhou
 *            Xinyu and Wu Yuxin who were schoolfriends at Tsinghua University."
 *   claim   "Hugging Face was founded in March 2023 by three former schoolmates
 *            from Tsinghua University: Yang Zhilin, Zhou Xinyu, and Wu Yuxin."
 *
 * Every name right. Every date right. The company swapped for the one in the
 * question — and it went onto a slide, under a Wikipedia link that contradicted
 * it. A citation is what makes a claim look checked, so a false claim with a
 * real citation is worse than a guess with none.
 *
 * The prompt fix (the summarising call no longer sees the question) removed the
 * pressure that caused it. This is the half that does not depend on a prompt
 * continuing to work, which is the only kind of guarantee worth having about a
 * 3B model.
 *
 *   bun src/ground/__tests__/invents.ts
 */
import { invents } from '../research'

let failed = 0
const ok = (name: string, cond: boolean, detail = '') => {
  if (!cond) failed++
  console.log(`  ${cond ? 'OK ' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
}

console.log('\n── the case this was written for')
const quote =
  'Background Moonshot was founded in March 2023 by Yang Zhilin, Zhou Xinyu and Wu Yuxin who were schoolfriends at Tsinghua University.'
const fabricated =
  'Hugging Face was founded in March 2023 by three former schoolmates from Tsinghua University: Yang Zhilin, Zhou Xinyu, and Wu Yuxin.'
const faithful =
  'Moonshot was founded in March 2023 by Yang Zhilin, Zhou Xinyu, and Wu Yuxin, who were schoolfriends at Tsinghua University.'

ok('the substitution is caught', invents(fabricated, quote).length > 0, invents(fabricated, quote).join(', '))
ok('and it is named', invents(fabricated, quote).some((w) => /hugging|face/i.test(w)))
ok('the faithful restatement passes', invents(faithful, quote).length === 0, invents(faithful, quote).join(', '))

console.log('\n── what must not be flagged')
// The first word is capitalised because sentences are. Flagging it would reject
// every claim ever written.
ok('a leading capital is not a name', invents('Caffeine helps runners.', 'caffeine helps runners in longer events') .length === 0)
ok('names present in the quote pass', invents('Delangue co-founded it.', 'Clément Delangue co-founded the company') .length === 0)
ok('case differences pass', invents('The COMPANY was French.', 'the company was french') .length === 0)
ok('repeats are reported once', invents('Moonshot and Moonshot.', 'nothing here').length === 1)
ok('short capitals are ignored', invents('It is UK based.', 'it is uk based') .length === 0)

console.log('\n── what must be flagged')
ok('a company the quote never names', invents('Anthropic built it.', 'the lab built it').length === 1)
ok('a place the quote never names', invents('It happened in Tsinghua.', 'it happened at a university').length === 1)
ok(
  'several at once',
  invents('Alice met Bob in Paris.', 'two people met somewhere').length === 3,
  invents('Alice met Bob in Paris.', 'two people met somewhere').join(', '),
)

console.log('\n── degenerate input')
ok('empty claim invents nothing', invents('', 'anything').length === 0)
ok('empty quote flags every name', invents('Only Moonshot.', '').length === 1)

console.log(failed ? `\n${failed} FAILED` : '\nall invention checks passed')
if (failed) process.exit(1)
