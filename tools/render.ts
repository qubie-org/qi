/**
 * The render gate: one door to a browser, and nothing else may open it.
 *
 * `net.ts` fetches bytes. That is enough for an API and not enough for a page
 * whose content only exists after its JavaScript has run — and `search.ts`
 * already names that gap: "a page that needs JavaScript to say anything returns
 * nearly nothing here." Roughly a third of what a search engine returns is that
 * kind of page.
 *
 * The engine is Lightpanda, and the two decisions worth recording are what it
 * is *not*.
 *
 * It is not inside Wasmer. Wasmer runs the QuickJS sandbox that reduces API
 * responses, which is a place to put untrusted *data* — a 67 MB native binary
 * with its own network stack is not that, and forcing it into a wasm runtime
 * would trade a process boundary the operating system already enforces for a
 * much weaker one we would have to maintain.
 *
 * And it is not persistent. `lightpanda serve` holds a CDP server open, which
 * means a port, a lifecycle, a reconnect path and a process that outlives the
 * work. Measured here, `fetch` costs 0.44 s on a static page and 5.06 s on a
 * Next.js app — so on the one rung this exists for, startup is noise against
 * the render it is paying for. A process per request dies with the request,
 * which is the whole lifecycle.
 *
 * ── Why a gate rather than a helper ─────────────────────────────────────────
 *
 * The URL comes from a language model, so this is an SSRF surface for exactly
 * the reasons `net.ts` documents at length. It therefore reuses `net.ts`'s
 * check rather than writing its own — two copies of an address policy drift,
 * and the copy is always the one that drifts. Lightpanda's own
 * `--block-private-networks` is then set on top: it resolves independently and
 * would catch a name that changed its answer between our lookup and its own.
 *
 * ── Flags that were tried and are deliberately absent ───────────────────────
 *
 * Measured over 38 live URLs spanning news, retail, forums, government, recipe
 * and academic pages, each variant run against the same list, with the
 * unmodified command run twice first to size the noise: the usable/thin verdict
 * flipped on 1 of 38 between identical runs, so a two-page swing is signal.
 *
 *   baseline (below)        21/38 usable   12 hung   4 crashed
 *   --terminate-ms 9000     19/38 usable   12 hung   5 crashed
 *   --disable-subframes     20/38 usable   10 hung   5 crashed
 *   --disable-workers       19/38 usable   12 hung   5 crashed
 *   --wait-until load       19/38 usable   11 hung   5 crashed
 *
 * Every one of them costs more pages than it returns, and the reason to reach
 * for `--terminate-ms` turns out not to hold: it is a deadline on *JavaScript*,
 * and the hang is not in JavaScript. It left the hang count at 12 of 38
 * untouched while taking finance.yahoo.com from 50,902 characters to zero.
 * `--disable-subframes` and `--disable-workers` each independently crash
 * lowes.com, which the plain command reads twice in a row at 17,532 characters.
 * `--wait-until load` halves the median but drops ftc.gov, a page the default
 * reads in full.
 *
 * So the hang is a browser bug no flag reaches, and the only lever we own is
 * our own deadline — see TIMEOUT_MS.
 *
 * `--dump semantic_tree_text` was measured against `markdown` on the same 38
 * and rejected on the shape of what it returns rather than on how much: it is
 * an accessibility tree, so every line arrives as `12 [i] link 'Skip to
 * content'` — role syntax and node ids wrapped around the words, which would
 * land inside quotations downstream. It also serialises Wikipedia's COinS
 * citation metadata as 999-character `ctx_ver=Z39.88-2004&rft_val_fmt=…` blobs
 * that markdown does not emit, and returns 22% less text overall for no fewer
 * zeroes and one more crash.
 */
import { hookExit, supervise } from './supervise'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { allowed } from './net'

/** Beyond this a page is not being read, it is being downloaded. */
const MAX_BYTES = 2_000_000
/**
 * A page that has not rendered in this long is not going to.
 *
 * Twelve seconds, not twenty, and the number is measured rather than chosen: of
 * 76 runs over the 38-URL list, the slowest render that produced anything at
 * all finished in 10.6 s, and the 90th percentile was 6.5 s. Nothing has ever
 * been observed to arrive after that. Meanwhile a third of the list hangs
 * forever — the browser stops making progress and never exits — so the old
 * ceiling spent 20 s per hung page to return exactly what 12 s returns, which
 * is nothing.
 *
 * The floor is the browser's own `--wait-ms`, which defaults to 5 s and is
 * where the median sits; 12 s leaves better than a second of headroom over the
 * slowest success on top of that.
 */
const TIMEOUT_MS = 12_000
/**
 * Where the browser is.
 *
 * Three answers in order of specificity: an explicit override, the copy bundled
 * inside the app (which is what a shipped Qi uses — `native/build.sh` puts it
 * in Contents/MacOS next to the executable), and finally whatever is on PATH,
 * which is the development case.
 */
function findBinary(): string {
  const explicit = process.env.QI_LIGHTPANDA
  if (explicit) return explicit

  const bundled = resolve(process.cwd(), 'native/Qi.app/Contents/MacOS/lightpanda')
  if (existsSync(bundled)) return bundled

  return 'lightpanda'
}

const BINARY = findBinary()

export type RenderResult = {
  ok: boolean
  url: string
  /** Prose of the page after its own scripts have run. */
  text?: string
  why?: string
}

/**
 * The browser reporting its own failure, in the shape of a document.
 *
 * Lightpanda answers a refused or failed navigation with a *rendered page* and
 * an exit code of zero, so from the outside it is indistinguishable from a
 * successful read of a very short page. Two forms were observed across the
 * corpus, both of which reached callers as `ok: true`:
 *
 *   "# Navigation failed\n\nReason: RobotsBlocked"   42 characters
 *   "Error 408"                                       9 characters
 *
 * Reuters and both Reddit hosts return the first every time; frame.work returns
 * the second. Passing those on as content is worse than passing on nothing,
 * because `read()` compares lengths to decide whether the render beat the cheap
 * fetch, and 42 characters of apology can win that comparison against an empty
 * string. Named here so the caller is told what actually happened.
 */
const REFUSED = /^#\s*Navigation failed\s*\n+\s*Reason:\s*(.+)$/
const STATUS_ONLY = /^Error (\d{3})$/

function refusal(text: string): string | null {
  const nav = REFUSED.exec(text)
  if (nav) return `navigation failed: ${nav[1].trim()}`
  const status = STATUS_ONLY.exec(text)
  if (status) return `page returned HTTP ${status[1]}`
  return null
}

/**
 * Markdown that is worth spending a reading budget on.
 *
 * `read()` hands downstream at most a few thousand characters of a page, so
 * what those characters are spent on decides how much the page gets to say.
 * Measured across the 21 pages of the corpus that rendered at all, **46% of the
 * markdown dump was link and image URL syntax** — `[Peloponnese](https://en.wi
 * kipedia.org/wiki/Peloponnese)` spends sixty characters to say eleven. Keeping
 * the words and dropping the target costs nothing: no reader of this text ever
 * follows a link, and a URL that lands inside a quotation is noise in a
 * citation.
 *
 * The headings are the other half, and they are the more valuable one. A
 * markdown heading carries no terminal punctuation, and `sentences()` splits
 * only on `.!?` followed by whitespace — so a heading cannot be separated from
 * the paragraph beneath it by any means available downstream, and the two
 * arrive fused. These are real citations that reached output:
 *
 *   "History Founding The company was founded in 2016 by…"
 *   "Background This study aimed to evaluate…"
 *   "Stovetop Method The stovetop method is a quick…"
 *
 * Closing the heading with a full stop is the whole fix, and it is done here —
 * at the point where the text is known to be markdown — rather than downstream,
 * where the format is no longer known. A heading long enough to survive the
 * 40-character filter now becomes quotable in its own right, which is a real
 * cost; it is smaller than the one it replaces, because that heading was
 * *already* being quoted, glued to the front of a sentence that is now free of
 * it. One bad candidate replaces one bad candidate plus one lost good one.
 *
 * Together, over the same 21 pages, the number of quotable sentences falling
 * inside a 3,000-character read budget went from 37 to 139 — 3.8×.
 */
function tidy(markdown: string): string {
  return markdown
    // Images first: their alt text is a caption, not prose, and `![x](url)`
    // would otherwise leave a stray `!` behind when the link rule fires.
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    // Bare autolinked URLs on their own line — the renderer emits one under
    // most headings — say nothing and cost a line.
    .replace(/^\s*<?https?:\/\/\S+>?\s*$/gm, '')
    .replace(/^ {0,3}#{1,6}\s+(.*)$/gm, (_line, head: string) => {
      const t = head.replace(/\s*#+\s*$/, '').trim()
      if (!t) return ''
      return /[.!?:;]$/.test(t) ? t : `${t}.`
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export async function render(raw: string): Promise<RenderResult> {
  const check = await allowed(raw)
  if (!check.ok) return { ok: false, url: raw, why: check.why }
  const url = check.url.toString()

  return new Promise<RenderResult>((resolve) => {
    // Through the supervisor, not `spawn` directly. Four of these were found
    // orphaned to PID 1 after nineteen hours, holding four cores, each long
    // past a deadline that died with the process holding it. See supervise.ts.
    const { child } = supervise(
      BINARY,
      [
        'fetch',
        url,
        '--dump',
        'markdown',
        // Scripts and stylesheets have already done their work by the time the
        // DOM is serialised; keeping them in the dump is pure noise for a
        // reader, and a great deal of it.
        '--strip-mode',
        'js,css',
        '--http-timeout',
        String(TIMEOUT_MS - 2_000),
        // Its own resolution, independent of ours.
        '--block-private-networks',
        // It declares itself a bot — it refuses to impersonate a browser — so
        // the honest thing is to respect the file that governs bots.
        '--obey-robots',
      ],
      TIMEOUT_MS,
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )

    let out = ''
    let err = ''
    let capped = false
    let timedOut = false

    const done = (result: RenderResult) => {
      clearTimeout(timer)
      child.kill('SIGKILL')
      resolve(result)
    }

    // Killing the browser is not the same as throwing away what it said. A page
    // that crashed mid-dump had already written thousands of usable characters
    // to stdout — bonappetit.com aborts with SIGABRT after 3,917 of them — and
    // the old shape discarded every one of those because the deadline resolved
    // the promise itself. Now the deadline only kills; `close` decides, and it
    // decides on the bytes in hand.
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, TIMEOUT_MS)

    child.stdout?.on('data', (chunk: Buffer) => {
      if (capped) return
      out += chunk.toString()
      if (out.length > MAX_BYTES) {
        capped = true
        out = out.slice(0, MAX_BYTES)
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      // Bounded: a binary that decides to be chatty must not become the reason
      // the host runs out of memory.
      if (err.length < 4_000) err += chunk.toString()
    })

    child.on('error', (e) =>
      done({
        ok: false,
        url,
        why: `${BINARY} could not be started — is it installed? (${e.message})`,
      }),
    )

    child.on('close', (code, signal) => {
      const raw = out.trim()
      if (!raw) {
        const why = timedOut
          ? `render timed out after ${TIMEOUT_MS}ms`
          : err.trim().slice(0, 200) || (signal ? `browser died on ${signal}` : `exit ${code}`)
        return done({ ok: false, url, why })
      }
      // The browser's own error document, which arrives with exit code 0 and
      // looks exactly like a successfully read short page.
      const refused = refusal(raw)
      if (refused) return done({ ok: false, url, why: refused })
      done({ ok: true, url, text: tidy(raw) })
    })
  })
}

export async function handleRender(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (body.length > 4_000) break
  }

  let url = ''
  try {
    url = String(JSON.parse(body || '{}').url ?? '')
  } catch {
    // A malformed body is an empty URL, which `allowed` rejects by itself.
  }

  const result = await render(url)
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(result))
}
