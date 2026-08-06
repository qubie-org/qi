/**
 * The page's side of the net bridge.
 *
 * Everything that reaches the open web goes through here rather than through
 * `fetch` directly, because a browser may only read a response from a host that
 * has agreed to be read. Most of the free web has not agreed: of the 761 APIs
 * in the public-apis catalogue that need no key at all, only 278 send the
 * header. Going through the host removes the question.
 *
 * The host answering this is Vite in development and the Swift shell in the
 * app, the same arrangement /packs and /otel already use. If neither is there —
 * a plain browser with no dev server — `reachable` is false and callers fall
 * back to fetching directly, which still works for the CORS-friendly minority.
 */

export type Fetched = {
  ok: boolean
  status: number
  contentType: string
  body: string
  url: string
  why?: string
}

let bridge: boolean | null = null

/** Is a host answering the bridge? Asked once. */
export async function reachable(): Promise<boolean> {
  if (bridge !== null) return bridge
  try {
    const res = await fetch('/net/fetch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    // A host that answers at all answers with our shape; the dev server's HTML
    // fallback does not, and that is the case being told apart here.
    bridge = res.ok && String(res.headers.get('content-type')).includes('json')
  } catch {
    bridge = false
  }
  return bridge
}

/**
 * Fetch a URL through the host, falling back to the browser.
 *
 * The fallback is not a formality: it is what keeps qi working as a plain web
 * page, which is what it was before there was an app. It simply reaches less.
 */
export async function net(url: string, headers: Record<string, string> = {}): Promise<Fetched> {
  if (await reachable()) {
    try {
      const res = await fetch('/net/fetch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url, headers }),
      })
      if (res.ok) return (await res.json()) as Fetched
    } catch {
      /* fall through to the direct attempt */
    }
  }

  try {
    const res = await fetch(url, { headers })
    const body = await res.text()
    return {
      ok: res.ok,
      status: res.status,
      contentType: res.headers.get('content-type') ?? '',
      body,
      url,
    }
  } catch (err) {
    return { ok: false, status: 0, contentType: '', body: '', url, why: String(err) }
  }
}

/** JSON, or null. Callers get one shape to handle rather than two. */
export async function netJson<T = unknown>(url: string, headers?: Record<string, string>): Promise<T | null> {
  const res = await net(url, headers)
  if (!res.ok || !res.body) return null
  try {
    return JSON.parse(res.body) as T
  } catch {
    return null
  }
}
