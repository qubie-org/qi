#!/usr/bin/env node
/**
 * An MCP server for the running qi app.
 *
 * The alternative was Chrome, and Chrome is the wrong process. It is a
 * different engine from WKWebView, a different window with none of the native
 * shell, and — the part that actually cost time — a dev server whose module
 * registry hands back a *fresh copy* of a module after any edit, so a module
 * holding state reads as empty from the console while the app is using a
 * different instance entirely. Several measurements this session were taken
 * against that phantom.
 *
 * This talks to the real app: the Swift shell opens a loopback port
 * (`native/Sources/qi/Control.swift`) and these tools drive it.
 *
 * Hand-rolled JSON-RPC rather than the MCP SDK, deliberately. The protocol
 * surface needed here is three methods, the whole file is shorter than the
 * dependency's install footprint, and a debugging tool that cannot itself
 * break the build it is debugging is worth the hundred lines.
 *
 *   claude mcp add qi -- node tools/mcp-qi.mjs
 *
 * Reads QI_CONTROL_PORT (default 8777).
 */
const PORT = process.env.QI_CONTROL_PORT || '8777'
const BASE = `http://127.0.0.1:${PORT}`

async function call(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    body,
    headers: body ? { 'content-type': 'text/plain' } : undefined,
  })
  const type = res.headers.get('content-type') || ''
  if (type.startsWith('image/')) {
    return { image: Buffer.from(await res.arrayBuffer()).toString('base64'), mime: type }
  }
  return res.json()
}

/** Turned into the tool list, and dispatched by the same table. */
const TOOLS = {
  qi_eval: {
    description:
      'Evaluate JavaScript inside the running qi app and return the result. ' +
      'The body of an async function, so `await` and `return` both work — e.g. ' +
      '`const m = await import("/src/engine/sound.ts"); return m.currentKey()`. ' +
      'This is the REAL app in its real window, not a browser copy.',
    schema: {
      type: 'object',
      properties: { js: { type: 'string', description: 'Async function body to run in the page.' } },
      required: ['js'],
    },
    async run({ js }) {
      const out = await call('/eval', { method: 'POST', body: js })
      return text(JSON.stringify(out, null, 1))
    },
  },

  qi_console: {
    description:
      'Recent console output from the app, including uncaught errors and ' +
      'unhandled promise rejections, which never reach console.error on their own.',
    schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'How many of the most recent messages (default 40).' },
        level: { type: 'string', description: 'Only this level: log, info, warn, error, debug.' },
      },
    },
    async run({ limit = 40, level }) {
      const { messages = [] } = await call('/console')
      const picked = (level ? messages.filter((m) => m.level === level) : messages).slice(-limit)
      if (!picked.length) return text('(no console output)')
      return text(picked.map((m) => `[${m.level}] ${m.text}`).join('\n'))
    },
  },

  qi_console_clear: {
    description: 'Drop the buffered console output, so the next read is only what happened after now.',
    schema: { type: 'object', properties: {} },
    async run() {
      await call('/console/clear', { method: 'POST' })
      return text('cleared')
    },
  },

  qi_screenshot: {
    description: 'A PNG of the app as it currently looks — the real window, native shell included.',
    schema: { type: 'object', properties: {} },
    async run() {
      const out = await call('/shot')
      if (!out.image) return text(JSON.stringify(out))
      return { content: [{ type: 'image', data: out.image, mimeType: out.mime || 'image/png' }] }
    },
  },

  qi_health: {
    description: 'Whether the app is up, what URL it has loaded, and whether it is still loading.',
    schema: { type: 'object', properties: {} },
    async run() {
      return text(JSON.stringify(await call('/health'), null, 1))
    },
  },

  qi_reload: {
    description: 'Reload the page in the app. Note this clears in-page state, including the audio unlock.',
    schema: { type: 'object', properties: {} },
    async run() {
      await call('/reload', { method: 'POST' })
      return text('reloading')
    },
  },
}

const text = (s) => ({ content: [{ type: 'text', text: s }] })

// ── JSON-RPC over stdio ────────────────────────────────────────────────────
//
// One message per line. This is the whole transport, and it is worth stating
// plainly because the first version of this file got it wrong in a way that
// produced no error anywhere.
//
// It used Content-Length framing "the same as LSP". LSP does work that way, and
// MCP looks enough like LSP that the assumption survives a read-through. MCP's
// stdio transport is newline-delimited JSON: messages are separated by `\n` and
// may not contain an embedded one. So the server sat waiting for a `\r\n\r\n`
// header that no client has ever sent, and every client sat waiting for an
// `initialize` response that was never coming. No crash, no log line, no
// timeout — just two processes waiting for each other. Both framings were
// tested against this file; the LSP one round-trips perfectly and the real one
// returned nothing at all, which is exactly the wrong way round.
//
// The reader still accepts Content-Length if it sees it. Not for clients —
// there are none — but because a header is unambiguous, so accepting it costs a
// branch and removes the chance of this being rediscovered the hard way by
// anything that copied the old shape. Output is newline-delimited only, since
// that is the side a client has to understand.
let buffer = Buffer.alloc(0)

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    const framed = takeFramed()
    const payload = framed ?? takeLine()
    if (payload === null) return
    if (!payload.trim()) continue
    let msg
    try {
      msg = JSON.parse(payload)
    } catch (err) {
      // A malformed line must not desynchronise the stream. Drop it and keep
      // reading; the next newline is a known-good boundary.
      process.stderr.write(`mcp-qi: bad JSON — ${err?.message}\n`)
      continue
    }
    handle(msg).catch((err) => {
      process.stderr.write(`mcp-qi: ${err?.stack || err}\n`)
    })
  }
})

/** A `Content-Length`-headed message, if the buffer starts with one. */
function takeFramed() {
  if (!/^content-length:/i.test(buffer.subarray(0, 15).toString())) return null
  const headEnd = buffer.indexOf('\r\n\r\n')
  if (headEnd === -1) return null
  const match = /content-length:\s*(\d+)/i.exec(buffer.subarray(0, headEnd).toString())
  if (!match) return null
  const start = headEnd + 4
  const length = Number(match[1])
  if (buffer.length < start + length) return null
  const payload = buffer.subarray(start, start + length).toString()
  buffer = buffer.subarray(start + length)
  return payload
}

/** One newline-delimited message — the transport MCP actually specifies. */
function takeLine() {
  const nl = buffer.indexOf(0x0a)
  if (nl === -1) return null
  const payload = buffer.subarray(0, nl).toString()
  buffer = buffer.subarray(nl + 1)
  return payload
}

function send(body) {
  // `JSON.stringify` never emits a bare newline inside a string — it escapes
  // them — so one line per message holds for any content the tools return.
  process.stdout.write(`${JSON.stringify(body)}\n`)
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function fail(id, message) {
  send({ jsonrpc: '2.0', id, error: { code: -32000, message } })
}

async function handle(msg) {
  const { id, method, params } = msg

  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'qi', version: '0.1.0' },
    })
  }

  // Notifications carry no id and expect no reply.
  if (id === undefined) return

  if (method === 'tools/list') {
    return reply(id, {
      tools: Object.entries(TOOLS).map(([name, t]) => ({
        name,
        description: t.description,
        inputSchema: t.schema,
      })),
    })
  }

  if (method === 'tools/call') {
    const tool = TOOLS[params?.name]
    if (!tool) return fail(id, `no such tool: ${params?.name}`)
    try {
      return reply(id, await tool.run(params.arguments ?? {}))
    } catch (err) {
      // Reported as a result rather than an error: the usual cause is the app
      // not running, and that is an answer to the question, not a crash.
      return reply(id, {
        ...text(`qi is not reachable on ${BASE} — is the app running with QI_CONTROL=1?\n${err?.message ?? err}`),
        isError: true,
      })
    }
  }

  return fail(id, `unsupported method: ${method}`)
}
