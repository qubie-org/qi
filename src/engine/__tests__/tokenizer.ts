/** Gate: the TS SentencePiece port must match real sentencepiece byte-for-byte. */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { NeedleTokenizer } from '../needle/tokenizer'

const base = path.resolve(import.meta.dir, '../../../public/models/needle')
const spec = JSON.parse(await readFile(path.join(base, 'needle.tokenizer.json'), 'utf8'))
const goldens: Record<string, number[]> = JSON.parse(
  await readFile(path.join(base, 'needle.tokenizer.golden.json'), 'utf8'),
)

const tok = new NeedleTokenizer(spec)
console.log(`vocab ${tok.vocabSize}, byteFallback ${spec.byteFallback}, specials`, tok.specials)

let pass = 0
for (const [text, want] of Object.entries(goldens)) {
  const got = tok.encode(text)
  const ok = got.length === want.length && got.every((v, i) => v === want[i])
  pass += Number(ok)
  console.log(`\n${ok ? 'OK   ' : 'FAIL '}${JSON.stringify(text)}`)
  if (!ok) {
    console.log(`  want ${want.join(' ')}`)
    console.log(`  got  ${got.join(' ')}`)
  }
  const round = tok.decode(got)
  if (round !== text) console.log(`  roundtrip differs: ${JSON.stringify(round)}`)
}

console.log(`\n${pass}/${Object.keys(goldens).length} golden tokenizations match`)
if (pass !== Object.keys(goldens).length) process.exit(1)
