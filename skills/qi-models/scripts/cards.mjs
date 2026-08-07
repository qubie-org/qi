#!/usr/bin/env node
/**
 * Every model card qi has, printed from the two files that own them.
 *
 *   node scripts/cards.mjs            every pack and every size
 *   node scripts/cards.mjs 8b         one size, with its full download plan
 *   node scripts/cards.mjs --packs    the catalogue only
 *   node scripts/cards.mjs --json     the same, as JSON
 *
 * It reads `src/model/catalog.json` and `cli/models.mjs` rather than restating
 * them, which is the whole point: a card that is transcribed is a card that
 * goes stale, and the failure is an agent confidently quoting a checksum that
 * has not been true for two releases.
 *
 * Zero dependencies, for the same reason `cli/qiui.mjs` has none.
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const ROOT = process.env.PLUGIN_ROOT ?? fileURLToPath(new URL('../../../', import.meta.url))

const argv = process.argv.slice(2)
const wantJson = argv.includes('--json')
const packsOnly = argv.includes('--packs')
const sizesOnly = argv.includes('--sizes')
const size = argv.find((a) => !a.startsWith('-'))

const bold = (s) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s)
const dim = (s) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s)
const say = (s = '') => process.stdout.write(`${s}\n`)

const human = (n) =>
  !n ? '—' : n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : `${Math.round(n / 1e3)} kB`

/** Wrap prose so a card is readable in a terminal and in a transcript. */
const wrap = (text, width = 76, indent = '  ') => {
  const words = String(text ?? '').split(/\s+/).filter(Boolean)
  const lines = []
  let line = ''
  for (const w of words) {
    if (line && line.length + 1 + w.length > width) {
      lines.push(indent + line)
      line = w
    } else line = line ? `${line} ${w}` : w
  }
  if (line) lines.push(indent + line)
  return lines.join('\n')
}

async function load() {
  const catalog = JSON.parse(await readFile(join(ROOT, 'src/model/catalog.json'), 'utf8'))
  // A dynamic import so this script still prints the catalogue if the CLI has
  // been moved or is mid-edit. Half a report beats an exception.
  let models = null
  try {
    models = await import(new URL('cli/models.mjs', `file://${ROOT.endsWith('/') ? ROOT : ROOT + '/'}`).href)
  } catch (err) {
    if (!packsOnly) say(dim(`  (cli/models.mjs unreadable: ${String(err).slice(0, 90)})`))
  }
  return { catalog, models }
}

function printSize(models, id) {
  const m = models.MODELS[id]
  if (!m) return
  const items = models.plan(id)
  const total = models.totalBytes(id)
  const gate = m.activated?.length ? `activated (${m.activated.join(', ')})` : 'plain LoRA — seconds per source'

  say()
  say(`${bold(m.title)}  ${dim(`· ${id}`)}`)
  say(`  repo        ${m.repo}`)
  say(`  base file   ${m.file ?? '—'}  ${dim(human(m.bytes))}`)
  if (m.sha256) say(`  sha256      ${m.sha256}`)
  say(`  install     ${human(total)} total, ${items.length} files`)
  say(`  needs       ${m.ram} RAM`)
  say(`  gate        ${gate}`)
  say(`  adapters    lora dir ${m.lora}   alora dir ${m.alora}`)
  if (m.note) say(`  note        ${wrap(m.note, 64, '              ').trimStart()}`)

  if (size === id) {
    say()
    say(dim('  download plan'))
    for (const it of items) {
      const verified = it.sha256 ? 'sha256' : dim('unverified')
      say(`    ${it.pack.padEnd(6)} ${String(it.to).padEnd(28)} ${human(it.bytes).padStart(7)}  ${verified}`)
    }
  }
}

function printPack(p) {
  const files = (p.files ?? []).map((f) => (typeof f === 'string' ? f : `${f.from} → ${f.to}`))
  const hashes = Object.keys(p.sha256 ?? {}).length

  say()
  say(`${bold(p.title ?? p.id)}  ${dim(`· ${p.id}${p.required ? ' · required' : ''}`)}`)
  if (p.what) say(wrap(p.what))
  say(`  repo        ${p.repo ?? '—'}`)
  say(`  runtime     ${p.runtime}${p.port ? `   port ${p.port}` : ''}`)
  say(`  size        ${human(p.bytes)}`)
  if (p.binds?.length) say(`  binds       ${p.binds.join(', ')}`)
  if (files.length) say(`  files       ${files.join('\n              ')}`)
  say(`  verified    ${hashes ? `${hashes} sha256` : 'no hashes — cannot be verified'}`)
  if (p.derived?.length) say(`  derived     ${p.derived.join(', ')}  ${dim('(converted here, not mirrored)')}`)
  for (const m of p.mirrors ?? []) {
    say(`  mirror      ${m.repo}`)
    if (m.why) say(wrap(m.why, 74, '              '))
  }
}

const { catalog, models } = await load()

if (wantJson) {
  const out = { packs: catalog.packs }
  if (models) {
    out.sizes = Object.fromEntries(
      Object.entries(models.MODELS).map(([id, m]) => [id, { ...m, installBytes: models.totalBytes(id) }]),
    )
  }
  say(JSON.stringify(out, null, 2))
  process.exit(0)
}

if (!packsOnly && models) {
  say(bold('── sizes') + dim('  (cli/models.mjs)'))
  for (const id of size ? [size] : Object.keys(models.MODELS)) printSize(models, id)
  if (size && !models.MODELS[size]) {
    say(`  no such size: ${size}. Try ${Object.keys(models.MODELS).join(', ')}.`)
    process.exit(1)
  }
  say()
}

if (!sizesOnly && !size) {
  say(bold('── packs') + dim('  (src/model/catalog.json)'))
  if (catalog.note) say(wrap(catalog.note))
  for (const p of catalog.packs) printPack(p)
  say()
  say(dim('  All weights Apache-2.0 and IBM\'s. Not covered by qi\'s AGPL-3.0 —'))
  say(dim('  that licence follows from bundling Lightpanda.'))
  say()
}
