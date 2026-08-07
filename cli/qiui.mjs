#!/usr/bin/env node
/**
 * qiui — set up qi, and run it.
 *
 * The alternative was a 2.3 GB disk image, which is a lot of bytes to move
 * before anyone knows whether they want the thing. This asks one question —
 * which size — and fetches only what that answer needs.
 *
 *   qiui                      set up if needed, then run
 *   qiui setup                the wizard
 *   qiui setup --model 8b -y  the same, answered in advance
 *   qiui run                  start the server and open the page
 *   qiui status               what is installed and what is running
 *   qiui models               the sizes, and what each costs
 *
 * ── Interactive and not, from one description ───────────────────────────────
 *
 * Both modes read the same `plan()`. A setup script that diverges from the
 * wizard is a setup script that installs something subtly different from what
 * a person would have got, and the difference surfaces weeks later as "works on
 * mine". Here `--model` and `--yes` skip the asking, and nothing else changes.
 *
 * Zero dependencies, deliberately. Node 20 has fetch, readline/promises,
 * createHash and a http server; a setup tool that itself needs an install step
 * has failed at the one job it has.
 */
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
import { createServer } from 'node:http'
import { extname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

import { human, MODELS, plan, totalBytes } from './models.mjs'

const HOME = process.env.QI_HOME || join(homedir(), '.qi')
const PACKS = join(HOME, 'packs')
const CONFIG = join(HOME, 'config.json')
const LLM_PORT = Number(process.env.QI_LLM_PORT || 8082)

const dim = (s) => `\x1b[2m${s}\x1b[0m`
const bold = (s) => `\x1b[1m${s}\x1b[0m`
const say = (s = '') => process.stdout.write(`${s}\n`)

// ── argument parsing ─────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
const command = argv.find((a) => !a.startsWith('-')) ?? ''
const flag = (name, short) => {
  const i = argv.findIndex((a) => a === `--${name}` || (short && a === `-${short}`))
  if (i < 0) return undefined
  const next = argv[i + 1]
  return next && !next.startsWith('-') ? next : true
}
const yes = !!flag('yes', 'y')

// ── state ────────────────────────────────────────────────────────────────────

const readConfig = async () => {
  try {
    return JSON.parse(await (await open(CONFIG)).readFile('utf8'))
  } catch {
    return null
  }
}
const writeConfig = async (c) => {
  await mkdir(HOME, { recursive: true })
  const fh = await open(CONFIG, 'w')
  await fh.writeFile(JSON.stringify(c, null, 2) + '\n')
  await fh.close()
}
const exists = async (p) => {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}
const sizeOf = async (p) => {
  try {
    return (await stat(p)).size
  } catch {
    return 0
  }
}

/** Which of a plan's files are already on disk and the right size. */
async function missing(size) {
  const out = []
  for (const item of plan(size)) {
    const target = join(PACKS, item.pack, item.to)
    // Size is the cheap check. A file that is short is a download that stopped,
    // and re-fetching it is correct; the hash is what catches the subtler case.
    const have = await sizeOf(target)
    if (have === 0) out.push(item)
    else if (item.bytes && have < item.bytes * 0.98) out.push(item)
  }
  return out
}

// ── downloading ──────────────────────────────────────────────────────────────

/**
 * One file, resumable, retried, verified.
 *
 * `.part` beside the target so an interrupted run leaves progress rather than
 * rubble, and a Range request continues it. Two gigabytes over a bad link is a
 * sequence of interrupted downloads, not a download.
 */
async function fetchFile(item, onProgress) {
  const dir = join(PACKS, item.pack)
  await mkdir(join(dir, item.to.includes('/') ? item.to.split('/')[0] : ''), { recursive: true }).catch(() => {})
  await mkdir(dir, { recursive: true })
  const target = join(dir, item.to)
  const part = `${target}.part`

  for (let attempt = 0; attempt < 5; attempt++) {
    const have = await sizeOf(part)
    try {
      const res = await fetch(item.url, {
        headers: have > 0 ? { Range: `bytes=${have}-` } : {},
        redirect: 'follow',
      })
      if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`)
      // A server that ignores Range answers 200 with the whole file, and the
      // bytes already on disk are then the wrong bytes to keep.
      const resuming = res.status === 206
      if (!resuming && have > 0) await rm(part, { force: true })

      const total = Number(res.headers.get('content-length') || 0) + (resuming ? have : 0)
      let done = resuming ? have : 0
      const out = createWriteStream(part, { flags: resuming ? 'a' : 'w' })
      for await (const chunk of res.body) {
        done += chunk.length
        out.write(chunk)
        onProgress?.(done, total || item.bytes || 0)
      }
      await new Promise((r) => out.end(r))

      if (item.sha256) {
        const h = createHash('sha256')
        await pipeline(createReadStream(part), h)
        const got = h.digest('hex')
        if (got !== item.sha256) {
          await rm(part, { force: true })
          throw new Error(`checksum mismatch — expected ${item.sha256.slice(0, 12)}…, got ${got.slice(0, 12)}…`)
        }
      }
      await rename(part, target)
      return
    } catch (err) {
      if (attempt === 4) throw err
      // Backed off, because the failures at this size are rate limits and
      // transient gateways, and hammering them turns slow into refused.
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt))
    }
  }
}

function bar(done, total, label) {
  const frac = total ? Math.min(1, done / total) : 0
  const width = 28
  const full = Math.round(frac * width)
  const line = `  ${label.padEnd(26)} ${'█'.repeat(full)}${dim('░'.repeat(width - full))} ${String(Math.round(frac * 100)).padStart(3)}%`
  process.stdout.write(`\r\x1b[2K${line}`)
}

// ── commands ─────────────────────────────────────────────────────────────────

function showModels() {
  say()
  say(bold('  Granite 4.1, three sizes'))
  say()
  for (const m of Object.values(MODELS)) {
    const gate = m.activated.length
      ? '\x1b[32mactivated gate\x1b[0m'
      : dim('plain gate — slower')
    say(`  ${bold(m.id.padEnd(4))} ${m.title.padEnd(18)} ${human(totalBytes(m.id)).padStart(8)}  needs ~${m.ram.padEnd(6)} ${gate}`)
    say(`       ${dim(m.note)}`)
  }
  say()
  say(dim('  The gate decides whether a page answers the question at all. Activated,'))
  say(dim('  it reuses the base model\'s cache and costs 0.04s; plain, it reprocesses'))
  say(dim('  the prompt and costs seconds — once per source, eight times a question.'))
  say()
}

async function ask(question, choices, fallback) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = (await rl.question(question)).trim().toLowerCase()
    if (!answer) return fallback
    return choices.includes(answer) ? answer : fallback
  } finally {
    rl.close()
  }
}

async function setup() {
  let size = flag('model', 'm')
  if (typeof size !== 'string') size = undefined

  if (!size) {
    if (!process.stdin.isTTY && !yes) {
      // No terminal to ask in, and no answer given in advance. The old
      // behaviour here was to assume 3b and start downloading, which meant
      // `qiui` in a pipe or a CI step quietly moved 2.5 GB with nobody having
      // asked for it. Refusing and naming the flag is the only defensible
      // reading of "no answer".
      say()
      say('  nothing to go on: no terminal to ask in, and no --model given.')
      say(`  ${dim('qiui setup --model 3b --yes')}   ${dim(`(${human(totalBytes('3b'))})`)}`)
      say(`  ${dim('qiui models')}                    ${dim('what the sizes cost')}`)
      say()
      process.exit(1)
    }
    if (yes) {
      // Answered in advance, but not told which. The size everything here was
      // measured against, rather than the largest or the newest.
      size = '3b'
      say(dim(`  no --model given; using ${size}`))
    } else {
      showModels()
      size = await ask(`  ${bold('which size?')} ${dim('[3b] 8b 30b  ›')} `, ['3b', '8b', '30b'], '3b')
    }
  }
  if (!MODELS[size]) {
    say(`  unknown size ${size}. one of: ${Object.keys(MODELS).join(', ')}`)
    process.exit(1)
  }

  const want = await missing(size)
  const bytes = want.reduce((a, b) => a + (b.bytes ?? 0), 0)

  say()
  say(`  ${bold(MODELS[size].title)} → ${dim(HOME)}`)
  if (!want.length) {
    say(`  everything is already here.`)
    await writeConfig({ ...(await readConfig()), model: size })
    return size
  }
  say(`  ${want.length} file${want.length === 1 ? '' : 's'} to fetch, about ${human(bytes)}.`)
  if (!MODELS[size].activated.length) {
    say(dim(`  note: no converted activated adapters for ${size} yet, so the`))
    say(dim(`  answerability gate will use the plain LoRA and cost seconds per source.`))
  }
  say()

  if (!yes && !process.stdin.isTTY) {
    say(`  ${dim('re-run with --yes to fetch it')}`)
    process.exit(1)
  }
  if (!yes && process.stdin.isTTY) {
    const go = await ask(`  ${bold('go ahead?')} ${dim('[Y/n] ›')} `, ['y', 'n', 'yes', 'no'], 'y')
    if (go.startsWith('n')) {
      say('  stopped.')
      process.exit(0)
    }
    say()
  }

  for (const item of want) {
    const label = `${item.pack}/${item.to}`
    try {
      await fetchFile(item, (done, total) => bar(done, total, label))
      bar(1, 1, label)
      process.stdout.write(` ${dim('done')}\n`)
    } catch (err) {
      process.stdout.write(`\r\x1b[2K  ${label} — \x1b[31m${err.message}\x1b[0m\n`)
      process.exit(1)
    }
  }

  await writeConfig({ ...(await readConfig()), model: size, installedAt: new Date().toISOString() })
  say()
  say(`  ready. ${dim('qiui run')}`)
  return size
}

async function status() {
  const config = await readConfig()
  say()
  if (!config?.model) {
    say(`  not set up. ${dim('qiui setup')}`)
    say()
    return
  }
  const want = await missing(config.model)
  say(`  model     ${bold(MODELS[config.model]?.title ?? config.model)}`)
  say(`  home      ${dim(HOME)}`)
  say(`  weights   ${want.length ? `\x1b[33m${want.length} missing\x1b[0m` : '\x1b[32mcomplete\x1b[0m'}`)
  const up = await fetch(`http://127.0.0.1:${LLM_PORT}/props`).then((r) => r.ok).catch(() => false)
  say(`  server    ${up ? `\x1b[32mrunning on ${LLM_PORT}\x1b[0m` : dim('not running')}`)
  say()
}

/** Every adapter on disk, activated preferred over plain. */
async function adapters() {
  const rag = join(PACKS, 'rag')
  const plain = await readdir(rag).catch(() => [])
  const activated = await readdir(join(rag, 'alora')).catch(() => [])
  const names = [...new Set([...plain, ...activated])].filter((n) => n.endsWith('.gguf')).sort()
  const out = []
  for (const n of names) {
    const a = join(rag, 'alora', n)
    out.push((await exists(a)) ? a : join(rag, n))
  }
  return out
}

async function run() {
  const config = await readConfig()
  if (!config?.model) {
    say(dim('  not set up yet — running setup first'))
    config.model = await setup()
  }
  const want = await missing(config.model)
  if (want.length) {
    say(`  ${want.length} file${want.length === 1 ? '' : 's'} still missing. ${dim('qiui setup')}`)
    process.exit(1)
  }

  const model = join(PACKS, 'core', MODELS[config.model].file)
  const loras = (await adapters()).flatMap((p) => ['--lora', p])

  const args = [
    '-m', model, ...loras,
    '--port', String(LLM_PORT), '--host', '127.0.0.1',
    // Without --jinja the model's own chat template never applies and Granite
    // cannot emit a tool call at all.
    '--jinja',
    '-c', '32768', '-ngl', '99', '--no-webui',
    '-ctk', 'q8_0', '-ctv', 'q8_0',
  ]

  say()
  say(`  ${bold(MODELS[config.model].title)} ${dim(`+ ${loras.length / 2} adapters`)}`)
  const llama = spawn('llama-server', args, { stdio: 'ignore' })
  llama.on('error', () => {
    say('  \x1b[31mllama-server is not on PATH\x1b[0m — brew install llama.cpp')
    process.exit(1)
  })

  // Wait for it, then put every adapter back to zero. `--lora-init-without-apply`
  // is documented to load without applying and in b10250 does not: all five come
  // up at scale 1.0, and five stacked rank-32 deltas turn the model into a
  // machine that emits <tool_call> forever. It fails no startup check.
  for (let i = 0; i < 90; i++) {
    if (await fetch(`http://127.0.0.1:${LLM_PORT}/props`).then((r) => r.ok).catch(() => false)) break
    await new Promise((r) => setTimeout(r, 1000))
  }
  if (loras.length) {
    await fetch(`http://127.0.0.1:${LLM_PORT}/lora-adapters`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(Array.from({ length: loras.length / 2 }, (_, id) => ({ id, scale: 0 }))),
    }).catch(() => say(dim('  warning: could not zero adapter scales')))
  }

  const port = await serve()
  say(`  ${bold(`http://127.0.0.1:${port}`)}`)
  say(dim('  ctrl-c to stop'))
  say()
  const stop = () => {
    llama.kill()
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

/**
 * The page, with the headers that make its sandbox possible.
 *
 * COOP and COEP are not optional decoration: the wasm sandbox runs over a
 * SharedArrayBuffer, which the browser withholds from any document that is not
 * cross-origin isolated. Serve the same files without these and everything
 * loads and nothing works, with no error naming the cause.
 */
function serve() {
  const web = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'dist')
  const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.wasm': 'application/wasm',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.woff2': 'font/woff2',
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const isolate = {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    }

    // The model server, proxied so the browser stays same-origin — which is
    // what keeps cross-origin isolation intact and means nothing needs CORS.
    if (url.pathname.startsWith('/llm')) {
      const target = `http://127.0.0.1:${LLM_PORT}${url.pathname.replace(/^\/llm/, '') || '/'}${url.search}`
      const body = req.method === 'POST' ? await new Promise((r) => {
        const c = []
        req.on('data', (d) => c.push(d)).on('end', () => r(Buffer.concat(c)))
      }) : undefined
      try {
        const up = await fetch(target, { method: req.method, body, headers: { 'content-type': 'application/json' } })
        res.writeHead(up.status, { ...isolate, 'content-type': up.headers.get('content-type') ?? 'application/json' })
        // Piped rather than buffered: replies stream, and a proxy that waits
        // for the end shows nothing until the end.
        for await (const chunk of up.body) res.write(chunk)
        res.end()
      } catch {
        res.writeHead(502, isolate).end('{"error":"model server unreachable"}')
      }
      return
    }

    if (url.pathname.startsWith('/packs/')) {
      const file = join(PACKS, url.pathname.slice('/packs/'.length))
      if (!file.startsWith(PACKS)) return res.writeHead(403, isolate).end()
      if (await exists(file)) {
        res.writeHead(200, { ...isolate, 'content-type': 'application/octet-stream' })
        return createReadStream(file).pipe(res)
      }
      return res.writeHead(404, isolate).end()
    }

    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
    let file = join(web, rel)
    if (!file.startsWith(web) || !(await exists(file))) file = join(web, 'index.html')
    res.writeHead(200, { ...isolate, 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
    createReadStream(file).pipe(res)
  })

  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)))
}

// ── entry ────────────────────────────────────────────────────────────────────

const commands = {
  setup,
  run,
  status,
  models: async () => showModels(),
  doctor: status,
  // Bare `qiui` runs what is already set up. It does *not* set up — the first
  // run of a command should never be the expensive one, and someone typing the
  // name of a tool to see what it does has not asked for a download.
  '': async () => {
    const config = await readConfig()
    if (config?.model) return run()
    say()
    say(`  qi is not set up yet.  ${dim('qiui setup')}`)
    say()
  },
}

const wantsHelp = argv.includes('--help') || argv.includes('-h')
const fn = wantsHelp ? null : commands[command]
if (!fn) {
  say(`
  ${bold('qiui')} — set up qi, and run it

    qiui                      set up if needed, then run
    qiui setup                choose a model size and fetch it
    qiui setup --model 8b -y  the same, answered in advance
    qiui run                  start the model server and the page
    qiui status               what is installed, what is running
    qiui models               the sizes, and what each costs

  ${dim(`weights live in ${HOME} — override with QI_HOME`)}
`)
  process.exit(command ? 1 : 0)
}
fn().catch((err) => {
  say(`  \x1b[31m${err.message}\x1b[0m`)
  process.exit(1)
})
