import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { loadTable } from '../embed'
import { buildBank, explain, place } from '../place'
import { parse } from '../../inline/parse'
import { plain, type Node } from '../../inline/types'

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
const bank = buildBank(t)

const lines = [
  'The line is the visual narrator that moves around and discovers things.',
  'I keep searching for a pattern in all this noise.',
  'The ocean has a rhythm you can feel in your chest.',
  'Deploy the build, then check the logs for errors.',
  'It was a sudden flash and then everything went quiet.',
  'Money moves in cycles, it always returns to the same place.',
]

console.log('── top matches per line (threshold', bank.threshold, ')\n')
for (const l of lines) {
  const top = explain(l, t, bank).slice(0, 4)
  console.log(' ', l)
  console.log(
    '   ',
    top.map((h) => `${h.word}→${h.kind} ${h.score.toFixed(2)}${h.score >= bank.threshold ? '*' : ''}`).join('   '),
  )
}

console.log('\n── rendered result\n')
const show = (ns: Node[]): string =>
  ns
    .map((n) => {
      if (n.t === 'text') return n.v
      if (n.t === 'motif') return `[${n.kind}]`
      if (n.t === 'deco')
        return n.deco === 'color'
          ? `<${['blue','red','gold','green'][n.tone ?? 0]}:${plain(n.kids)}>`
          : `<${n.deco}:${plain(n.kids)}>`
      if ('kids' in n) return show(n.kids)
      return ''
    })
    .join('')

lines.forEach((l, i) => console.log(' ', show(place(parse(l), t, bank, { seed: i }))))
