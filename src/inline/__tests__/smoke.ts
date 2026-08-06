import { downgrade } from '../downgrade'
import { parse } from '../parse'

const cases: [string,string][] = [
  ['heading', '# Big Title\n\nsome text'],
  ['fence', 'try this:\n```js\nconst a = 1\nconsole.log(a)\n```\ndone'],
  ['list', 'things:\n- one\n- two\n\n1. first\n2. second'],
  ['table', '| a | b |\n|---|---|\n| 1 | 2 |'],
  ['quote', '> wisdom here\nafter'],
  ['rule', 'before\n\n---\n\nafter'],
  ['motifs', 'The [[line|color]] is the :eye: visual narrator, it moves :squiggle: around.'],
  ['deco', '[[community|circle]], [[process|scribble]], and [[tools|underline]] :arrow:'],
  ['sub', '[[How|sub-o:burst]] will t[[o|sub-o:asterisk]]day change?'],
  ['chip', 'And ![desk](/a.jpg) that pattern is simple.'],
  ['mixed', '**bold** and *em* and `code` and ==sweep== and [link](/x) and ~~gone~~'],
  ['nonmotif', 'meet at 3:30: bring :notarealmotif: and a 2:1 ratio'],
  ['broken', 'a [[unclosed and ** dangling and `tick'],
]
for (const [name, src] of cases) {
  console.log(`\n── ${name}`)
  console.log('  raw:  ' + JSON.stringify(src))
  console.log('  down: ' + JSON.stringify(downgrade(src)))
  console.log('  ast:  ' + JSON.stringify(parse(src)))
}

console.log('\n═══ lists ═══')
const lists: [string,string][] = [
  ['bullets', 'shopping:\n- milk\n- eggs\n- bread'],
  ['numbered', 'steps:\n1. preheat the oven\n2. mix the batter\n3. bake it'],
  ['lettered', 'options:\na) stay\nb) go\nc) decide later'],
  ['roman', 'acts:\ni. setup\nii. conflict\niii. resolution'],
  ['paren-num', '1) first\n2) second'],
  ['not-a-list', 'Note. this is a sentence, not a list item.'],
  ['mixed', '## Plan\n- research\n1. draft\n2. revise'],
]
for (const [name, src] of lists) {
  console.log(`\n── ${name}`)
  console.log('  down: ' + JSON.stringify(downgrade(src)))
  console.log('  ast:  ' + JSON.stringify(parse(src)))
}
