/**
 * The net bridge: the host fetches on the page's behalf.
 *
 * This is the single change that takes qi from ten sources to thousands, and
 * the reason is not capability but CORS. A browser may only read a response
 * from a host that has explicitly said it may. Of the 1,636 APIs in the
 * public-apis catalogue, 761 need no key at all — but only 278 of those send
 * the header, so a page can reach barely a third of the free web. qi's ten
 * sources were not chosen for being interesting; they were chosen for being
 * reachable.
 *
 * A native app has no such rule. The fetch happens in the host process and the
 * page is handed the bytes, so every keyless HTTPS API is in range. The same
 * contract is served here by Vite in development and by Swift in the shipped
 * app, exactly as /packs and /otel already are.
 *
 * ── The part that needs care ────────────────────────────────────────────────
 *
 * The URL comes from a language model. That makes this an SSRF surface and not
 * a hypothetical one: a model that has been told it can fetch things will
 * cheerfully fetch http://127.0.0.1:8082 and read the weights server, or the
 * cloud metadata endpoint on a machine that has one. Everything below the
 * fetch is there to make that impossible rather than unlikely — the scheme, the
 * address family, the redirect chain, the response size, and the clock.
 */
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import type { IncomingMessage, ServerResponse } from 'node:http'

const MAX_BYTES = 4_000_000
const TIMEOUT_MS = 12_000
const MAX_REDIRECTS = 3

/**
 * Address ranges the host must never be talked into reaching.
 *
 * Loopback covers qi's own model server and anything else on the machine.
 * Link-local 169.254.0.0/16 is where cloud metadata services live. The RFC1918
 * blocks are the rest of the local network, which a page has no business
 * reading through us.
 */
function isPrivate(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase()
    // ::1, unique-local fc00::/7, link-local fe80::/10, and v4-mapped forms.
    if (v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8')) return true
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v)
    return mapped ? isPrivate(mapped[1]) : false
  }
  const p = ip.split('.').map(Number)
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true
  const [a, b] = p
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  )
}

/**
 * Is this URL safe to fetch on someone else's behalf?
 *
 * The hostname is resolved rather than pattern-matched, because `localtest.me`
 * and a thousand other names resolve to 127.0.0.1 and a string check would wave
 * them straight through.
 */
/**
 * Exported so the render gate applies the same policy rather than its own.
 * Two SSRF checks that drift apart are worse than one, and the one that drifts
 * is always the copy.
 */
export async function allowed(raw: string): Promise<{ ok: true; url: URL } | { ok: false; why: string }> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, why: 'not a url' }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, why: `scheme ${url.protocol} is not fetchable` }
  }

  const host = url.hostname
  if (isIP(host)) {
    return isPrivate(host) ? { ok: false, why: 'private address' } : { ok: true, url }
  }
  try {
    const addrs = await lookup(host, { all: true })
    if (!addrs.length) return { ok: false, why: 'does not resolve' }
    // Every address, not the first: a name that resolves to one public and one
    // private address is the classic way past a check like this.
    if (addrs.some((a) => isPrivate(a.address))) return { ok: false, why: 'resolves to a private address' }
  } catch {
    return { ok: false, why: 'does not resolve' }
  }
  return { ok: true, url }
}

export type NetResult = {
  ok: boolean
  status: number
  contentType: string
  /** Decoded text, capped. Callers parse; the bridge does not interpret. */
  body: string
  url: string
  why?: string
}

/**
 * One fetch, with the redirect chain checked at every hop.
 *
 * Redirects are followed by hand precisely so each new location goes back
 * through `allowed`. `redirect: 'follow'` would let a public URL bounce us to
 * localhost with the check already behind us.
 */
export async function netFetch(raw: string, headers: Record<string, string> = {}): Promise<NetResult> {
  let target = raw
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const verdict = await allowed(target)
    if (!verdict.ok) {
      return { ok: false, status: 0, contentType: '', body: '', url: target, why: verdict.why }
    }

    const control = new AbortController()
    const timer = setTimeout(() => control.abort(), TIMEOUT_MS)
    try {
      const res = await fetch(verdict.url, {
        headers: {
          // Some public APIs refuse an agent with no identity, and a few ban
          // the default one. Saying what we are is both politer and more
          // reliable than pretending to be a browser.
          'user-agent': 'qi/0.1 (local; +https://github.com/shinyobjectz)',
          accept: 'application/json, text/plain, text/html;q=0.8, */*;q=0.5',
          ...headers,
        },
        redirect: 'manual',
        signal: control.signal,
      })

      if (res.status >= 300 && res.status < 400) {
        const next = res.headers.get('location')
        if (!next) return { ok: false, status: res.status, contentType: '', body: '', url: target, why: 'redirect with no location' }
        target = new URL(next, verdict.url).toString()
        continue
      }

      const type = res.headers.get('content-type') ?? ''
      // Capped by reading rather than by trusting content-length, which is
      // absent on chunked responses and a lie on a hostile one.
      const reader = res.body?.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > MAX_BYTES) {
            await reader.cancel()
            break
          }
          chunks.push(value)
        }
      }
      const body = new TextDecoder().decode(
        chunks.reduce((all, c) => {
          const next = new Uint8Array(all.length + c.length)
          next.set(all)
          next.set(c, all.length)
          return next
        }, new Uint8Array()),
      )
      return { ok: res.ok, status: res.status, contentType: type, body, url: verdict.url.toString() }
    } catch (err) {
      const why = (err as Error)?.name === 'AbortError' ? 'timed out' : String(err)
      return { ok: false, status: 0, contentType: '', body: '', url: target, why }
    } finally {
      clearTimeout(timer)
    }
  }
  return { ok: false, status: 0, contentType: '', body: '', url: target, why: 'too many redirects' }
}

/** The route, shared by the dev server and anything else that hosts the page. */
export async function handleNet(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const chunks: Buffer[] = []
  req.on('data', (c: Buffer) => chunks.push(c))
  await new Promise<void>((done) => req.on('end', () => done()))

  let payload: { url?: string; headers?: Record<string, string> } = {}
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  } catch {
    /* an unparseable body is an empty one */
  }

  const out = payload.url
    ? await netFetch(payload.url, payload.headers ?? {})
    : { ok: false, status: 0, contentType: '', body: '', url: '', why: 'no url' }

  res.statusCode = 200
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(out))
}
