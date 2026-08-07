/**
 * The host side of the pack bus, as a Vite plugin.
 *
 * Five jobs, and they exist so that the page never has to know anything about
 * a filesystem or about who is allowed to talk to whom:
 *
 *   GET  /packs/installed      which packs have all their files on disk
 *   POST /packs/:id/install    run the installer, streaming its progress back
 *   GET  /packs/:id/:file      serve a weight, with range requests
 *   POST /otel/v1/traces       spans, to a collector or to telemetry/
 *   POST /net/fetch            fetch a URL on the page's behalf, past CORS
 *   POST /net/render           render a URL in a real browser, past a JS shell
 *
 * The install endpoint shells out to tools/pull.sh rather than reimplementing
 * it, so the button in the UI and the command in the terminal are the same
 * code. When qi moves into the native shell this plugin's three routes are
 * what Swift has to answer instead — which is the point of keeping them this
 * small.
 *
 * Weights are served from packs/ rather than public/ because Vite copies
 * public/ into the build output, and nobody wants a 2 GB dist directory.
 */
import { spawn } from 'node:child_process'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import type { Plugin, ViteDevServer } from 'vite'
import { handleNet } from './net'
import { handleRender } from './render'

/**
 * A file is a path, or {from, to} when the repo's own name would collide —
 * granitelib names all five of its adapters Lora-bf16.gguf.
 */
type FileSpec = string | { from: string; to: string }
type Spec = { id: string; files: FileSpec[] }

const localName = (f: FileSpec) => (typeof f === 'string' ? (f.split('/').pop() ?? f) : f.to)

const TYPES: Record<string, string> = {
  '.onnx': 'application/octet-stream',
  '.gguf': 'application/octet-stream',
  '.json': 'application/json',
}

export function packsPlugin(root: string): Plugin {
  const dir = resolve(root, 'packs')
  const catalog = resolve(root, 'src/model/catalog.json')

  const specs = async (): Promise<Spec[]> =>
    JSON.parse(await readFile(catalog, 'utf8')).packs as Spec[]

  const installed = async (): Promise<string[]> => {
    const list = await specs()
    return list
      .filter(
        (p) =>
          p.files.length > 0 && p.files.every((f) => existsSync(join(dir, p.id, localName(f)))),
      )
      .map((p) => p.id)
  }

  const configure = (server: ViteDevServer) => {
    server.middlewares.use(async (req, res, next) => {
      const url = req.url ?? ''

      // The host fetches for the page, so CORS stops deciding which of the
      // web's APIs qi can reach. See tools/net.ts — including why the URL
      // needs checking rather than trusting, given a model chooses it.
      // The escalation rung: a page whose content only exists after its own
      // JavaScript has run. One door, guarded exactly as /net/fetch is —
      // see tools/render.ts.
      // The conversation, kept by the host because the page cannot keep it.
      //
      // WebKit hands this webview an origin-private filesystem it can list and
      // cannot write — `createSyncAccessHandle` and `createWritable` are both
      // undefined — so SQLite's OPFS backends cannot work and the store has
      // been silently running in memory, discarding every turn on reload.
      //
      // In the shipped app the Swift host answers these two routes against
      // Application Support. Here it is a file beside the project, so a
      // developer's conversation survives a restart the same way.
      if (url === '/store/snapshot') {
        const file = resolve(root, '.qi', 'snapshot.json')
        if (req.method === 'GET') {
          try {
            res.setHeader('content-type', 'application/json')
            res.end(await readFile(file, 'utf8'))
          } catch {
            // Nothing saved yet is not an error; it is the first run.
            res.statusCode = 404
            res.end('{}')
          }
          return
        }
        if (req.method === 'PUT') {
          const chunks: Buffer[] = []
          req.on('data', (c: Buffer) => chunks.push(c))
          req.on('end', async () => {
            try {
              await mkdir(dirname(file), { recursive: true })
              await writeFile(file, Buffer.concat(chunks))
              res.statusCode = 204
            } catch (err) {
              console.warn('store: could not save snapshot —', err)
              res.statusCode = 500
            }
            res.end()
          })
          return
        }
      }

      if (url === '/net/render' && req.method === 'POST') {
        await handleRender(req, res)
        return
      }

      if (url === '/net/fetch' && req.method === 'POST') {
        await handleNet(req, res)
        return
      }

      // OTLP over HTTP/JSON, which is what the browser exporter speaks.
      //
      // Two destinations, and the choice is not ours to make: if
      // OTEL_EXPORTER_OTLP_ENDPOINT is set, spans go to whatever collector the
      // person is running and this process stays out of it. If it is not, they
      // are appended to telemetry/ as JSONL — because the default has to be
      // that the data exists, not that it needs infrastructure first.
      if (url === '/otel/v1/traces' && req.method === 'POST') {
        const chunks: Buffer[] = []
        req.on('data', (c: Buffer) => chunks.push(c))
        req.on('end', async () => {
          const body = Buffer.concat(chunks)
          const collector = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
          try {
            if (collector) {
              await fetch(`${collector.replace(/\/$/, '')}/v1/traces`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body,
              })
            } else {
              const dir = resolve(root, 'telemetry')
              await mkdir(dir, { recursive: true })
              const day = new Date().toISOString().slice(0, 10)
              // One JSON document per line, each the OTLP payload as sent, so a
              // file can be replayed into a real collector later without any
              // reformatting.
              await appendFile(join(dir, `${day}.jsonl`), `${body.toString('utf8')}\n`)
            }
          } catch (err) {
            console.warn('telemetry: could not persist spans —', err)
          }
          // 200 regardless. A failed export must never make the page retry
          // forever, and least of all must it surface to whoever is talking.
          res.statusCode = 200
          res.setHeader('content-type', 'application/json')
          res.end('{}')
        })
        return
      }

      if (!url.startsWith('/packs/')) return next()

      if (url === '/packs/installed') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(await installed()))
        return
      }

      const install = /^\/packs\/([\w-]+)\/install$/.exec(url)
      if (install && req.method === 'POST') {
        const id = install[1]
        // Streamed as plain text, not SSE: the installer's progress bar is
        // already a stream of bytes, and re-framing it would mean parsing
        // curl's output on the host just to reassemble it in the browser.
        res.setHeader('content-type', 'text/plain; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        const child = spawn(resolve(root, 'tools/pull.sh'), [id], { cwd: root })
        child.stdout.on('data', (b) => res.write(b))
        child.stderr.on('data', (b) => res.write(b))
        child.on('close', (code) => res.end(`\n[exit ${code}]\n`))
        req.on('close', () => child.kill())
        return
      }

      const file = /^\/packs\/([\w-]+)\/([\w.-]+)$/.exec(url.split('?')[0])
      if (file && (req.method === 'GET' || req.method === 'HEAD')) {
        const path = join(dir, file[1], file[2])
        if (!existsSync(path)) {
          res.statusCode = 404
          res.end('no such file')
          return
        }
        const { size } = statSync(path)
        res.setHeader('content-type', TYPES[extname(path)] ?? 'application/octet-stream')
        res.setHeader('accept-ranges', 'bytes')
        // Cross-origin isolation is on for the wasm sandbox, which makes the
        // browser refuse any subresource that does not opt in — including ones
        // from this very origin.
        res.setHeader('cross-origin-resource-policy', 'cross-origin')

        // onnxruntime asks for byte ranges of a graph rather than the whole
        // file; without this it silently falls back to downloading all of it.
        const range = /bytes=(\d*)-(\d*)/.exec(String(req.headers.range ?? ''))
        if (range) {
          const start = Number(range[1] || 0)
          const end = range[2] ? Number(range[2]) : size - 1
          res.statusCode = 206
          res.setHeader('content-range', `bytes ${start}-${end}/${size}`)
          res.setHeader('content-length', end - start + 1)
          if (req.method === 'HEAD') return res.end()
          createReadStream(path, { start, end }).pipe(res)
          return
        }
        res.setHeader('content-length', size)
        if (req.method === 'HEAD') return res.end()
        createReadStream(path).pipe(res)
        return
      }

      next()
    })
  }

  return {
    name: 'qi-packs',
    configureServer: configure,
    configurePreviewServer: configure as unknown as Plugin['configurePreviewServer'],
  }
}
