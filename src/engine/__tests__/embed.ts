/** Runs the browser embedding path in bun by pointing fetch at the packed files. */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { cosine, embed, loadTable, tokenize } from '../embed'

const base = path.resolve(import.meta.dir, '../../../public/models/potion')

globalThis.fetch = (async (url: string) => {
  const buf = await readFile(path.join(base, path.basename(String(url))))
  return {
    ok: true,
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    json: async () => JSON.parse(buf.toString()),
  }
}) as unknown as typeof fetch

const t0 = performance.now()
const t = await loadTable(base)
console.log(`loaded ${t.words.length} × ${t.dim} in ${(performance.now() - t0).toFixed(0)}ms\n`)

console.log('tokenize:')
for (const s of ['the ocean is enormous', 'useMemo re-renders', 'Kraków, 3:30pm!']) {
  console.log(`  ${JSON.stringify(s)} -> ${tokenize(t, s).map((i) => t.words[i]).join(' ')}`)
}

const probes = ['ocean', 'sea', 'water', 'grief', 'sadness', 'rocket', 'money', 'the']
console.log('\ncosine grid:')
const vecs = Object.fromEntries(probes.map((p) => [p, embed(t, p)]))
process.stdout.write('        ' + probes.map((p) => p.slice(0, 6).padStart(7)).join('') + '\n')
for (const a of probes) {
  process.stdout.write(a.slice(0, 7).padEnd(8))
  for (const b of probes) process.stdout.write(cosine(vecs[a], vecs[b]).toFixed(2).padStart(7))
  process.stdout.write('\n')
}

const t1 = performance.now()
const N = 2000
for (let i = 0; i < N; i++) embed(t, 'the line is the visual narrator that moves around')
console.log(`\nembed(9 words) × ${N}: ${((performance.now() - t1) / N).toFixed(3)}ms each`)
