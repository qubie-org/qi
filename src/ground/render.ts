/**
 * Reading a page that only exists after its own JavaScript has run.
 *
 * The plain read fetches bytes and strips tags, which works for most of the
 * web and returns almost nothing for the rest — a single-page app serves a
 * shell, and stripping tags from a shell yields a nav bar. `search.ts` has
 * always said so in its own docstring; this is the other half.
 *
 * Nothing happens in the page. A browser engine cannot run inside a browser,
 * and the host already owns the one door to the network — so this is a POST to
 * the same bridge `net()` uses, and the process on the other side is spawned,
 * read and killed per request. See `tools/render.ts` for why it is a
 * subprocess rather than a persistent server, and why it is not in Wasmer.
 *
 * The cost is real and is the reason this is an escalation rather than the
 * default: measured at 0.44 s on a static page and 5.06 s on a Next.js app,
 * against roughly 200 ms for a plain fetch. It should be reached for when the
 * cheap read has already come back thin, and never speculatively.
 */

export type Rendered = { ok: boolean; text: string; why?: string }

/**
 * How long the host is given, including spawning the browser.
 *
 * This is a backstop, not the real deadline — the host's own is 12 s and it
 * always fires first, because it is the side holding the process. Three
 * seconds over it is enough to cover the spawn and the round trip while still
 * failing fast if the bridge itself has gone away, which is the only case this
 * number is actually for.
 */
const TIMEOUT_MS = 15_000

export async function renderPage(url: string): Promise<Rendered> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    const res = await fetch('/net/render', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
      signal: controller.signal,
    })
    clearTimeout(timer)
    if (!res.ok) return { ok: false, text: '', why: `render bridge ${res.status}` }
    const out = (await res.json()) as { ok: boolean; text?: string; why?: string }
    return { ok: !!out.ok, text: out.text ?? '', why: out.why }
  } catch (err) {
    // The bridge is absent in a plain browser tab, and that is not an error
    // worth surfacing — it means the cheap read is all there is.
    return { ok: false, text: '', why: String(err).slice(0, 120) }
  }
}
