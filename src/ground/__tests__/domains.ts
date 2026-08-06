/**
 * Does the research process work anywhere, or only where it was built?
 *
 * Every question this process was measured against while it was being fixed was
 * a machine-learning paper: speculative decoding, mamba, mixture-of-experts,
 * rope scaling, grouped-query attention, flash attention. Six prompts, one
 * domain, and every decision made in `research.ts` was made against that one
 * distribution. Several of them are visibly shaped by it:
 *
 *   readable()      strips LaTeX, which exists on arXiv and nowhere else
 *   says pattern    permits "2.29" because ML papers report speedups
 *   candidates()    wants sentences of 40–300 characters, which is paper prose;
 *                   a recipe step and a spec-sheet line are shorter than that
 *   first person    rejected as "somebody's opinion" — but an interview, a
 *                   memoir, or a field report *is* first person, and there the
 *                   rule throws away the only source there is
 *
 * None of those were wrong when they were made. They were made against the
 * evidence available, and the evidence was all from one place. That is the
 * definition of overfitting, and the only way to see it is to ask the process
 * questions from somewhere else.
 *
 * ── Grouped by what the question does to the process ────────────────────────
 *
 * Not by subject. Subject is what retrieval already scores on; what matters
 * here is which part of the pipeline each question stresses, and the groups are
 * chosen so that a failure is attributable:
 *
 *   technical      the lane it was built in — the control, and it should stay
 *                  good or something has regressed
 *   current        recency. Weights are stale and the gate has no clock, so a
 *                  confidently dated answer is the failure to watch for
 *   health         where an unsupported claim is not merely wrong. The quote
 *                  check has to hold hardest here
 *   law            long sentences, jurisdiction, and a shifting answer
 *   history        disputed, and the sources disagree on purpose
 *   practical      the answer is a procedure, not a claim. `Claim` may simply
 *                  be the wrong shape, and that is worth finding out
 *   commercial     marketing copy is fluent, quotable and worthless. Chrome
 *                  density is highest here
 *   people         disambiguation, and a name the model half-remembers
 *   finance        time-sensitive numbers, which is the worst case for a
 *                  process that cannot tell when a page was written
 *   combinatorial  two fields at once, where no single source answers and the
 *                  note only works if claims from different places compose.
 *                  This is the case that justifies research over lookup, and
 *                  nothing has ever tested it
 *
 * Every question is terse, because that is what people type.
 *
 * ── A report, not a gate ────────────────────────────────────────────────────
 *
 * There is no correct number of claims for "why did the bronze age collapse",
 * and a threshold here would be a number invented to be met. What this produces
 * is a table — domain down the side, yield and losses across — plus every claim
 * in full, because whether a research note is any good is a judgement no
 * assertion in this file can make, and the claims have to be readable to be
 * judged.
 *
 * What it *can* decide mechanically is the overfitting tells: a claim that
 * merely restates its own quote, a quote too short to be evidence, and page
 * chrome that reached the note anyway. Those are counted per domain, because if
 * they cluster in one group that group is where the paper-shaped assumptions
 * broke.
 *
 * It reaches real endpoints and takes tens of seconds per question, so it is
 * not in CI. Run it in the app — under bun the sandbox cannot load:
 *
 *   curl -s -X POST http://127.0.0.1:8777/eval --data \
 *     'const m = await import("/src/ground/__tests__/domains.ts"); return m.run()'
 */
import { research, type Claim, type Losses } from '../research'

export type Domain =
  | 'technical'
  | 'current'
  | 'health'
  | 'law'
  | 'history'
  | 'practical'
  | 'commercial'
  | 'people'
  | 'finance'
  | 'combinatorial'

export type Case = {
  q: string
  domain: Domain
  /** What this question is here to stress. */
  why: string
}

export const CASES: Case[] = [
  // The control. If these degrade, a fix for somewhere else broke home.
  { q: 'speculative decoding speedup', domain: 'technical', why: 'the exact question everything was tuned on' },
  { q: 'crispr off target effects', domain: 'technical', why: 'a different science, same paper-shaped sources' },

  { q: 'eu ai act enforcement timeline', domain: 'current', why: 'dates the weights cannot know' },
  { q: 'opec production cuts', domain: 'current', why: 'answer changes month to month' },

  { q: 'creatine cognitive effects', domain: 'health', why: 'contested, and an unsupported claim matters' },
  { q: 'intermittent fasting blood pressure', domain: 'health', why: 'popular press contradicts the trials' },

  { q: 'noncompete ban status', domain: 'law', why: 'jurisdiction-dependent and recently moved' },
  { q: 'section 230 reform proposals', domain: 'law', why: 'long sentences, many competing bills' },

  { q: 'why did the bronze age collapse', domain: 'history', why: 'sources genuinely disagree' },
  { q: 'did tulip mania actually happen', domain: 'history', why: 'the popular account is the wrong one' },

  { q: 'how to season a carbon steel pan', domain: 'practical', why: 'the answer is steps, not a claim' },
  { q: 'fix a leaking compression fitting', domain: 'practical', why: 'procedural, and sentences are short' },

  { q: 'framework laptop vs thinkpad repairability', domain: 'commercial', why: 'marketing copy is quotable and empty' },
  { q: 'heat pump vs gas furnace running cost', domain: 'commercial', why: 'numbers buried in chrome-heavy pages' },

  { q: 'who founded huggingface', domain: 'people', why: 'a name the model half-remembers' },
  { q: 'was ada lovelace the first programmer', domain: 'people', why: 'a contested claim stated as fact everywhere' },

  { q: 'yen carry trade unwind', domain: 'finance', why: 'time-sensitive, and undated pages read as current' },
  { q: 'private credit systemic risk', domain: 'finance', why: 'opinion and analysis, little hard fact' },

  // The case the whole process exists for: no single page answers these.
  { q: 'caffeine effect on marathon performance', domain: 'combinatorial', why: 'physiology plus sport science' },
  { q: 'ai datacenter water usage drought', domain: 'combinatorial', why: 'infrastructure plus environment plus policy' },
  { q: 'lithium mining indigenous land rights', domain: 'combinatorial', why: 'industry plus law plus ethics' },
  { q: 'ozempic shortage causes', domain: 'combinatorial', why: 'medicine plus supply chain economics' },
]

/** Things that are wrong regardless of domain, and cheap to spot. */
export type Tells = {
  /** The claim restates its own quote, so the citation adds nothing. */
  echo: number
  /** A quote too short to establish anything. */
  thin: number
  /** Navigation, cookie banners and calls to action, quoted as evidence. */
  chrome: number
}

const CHROME =
  /\b(key takeaways|skip to (main )?content|sign in|log ?in|subscribe|newsletter|cookie|accept all|privacy policy|related articles|share this|read more|advertisement)\b/i

export function tellsFor(claims: Claim[]): Tells {
  const flat = (s: string) => s.replace(/\W+/g, '').toLowerCase()
  let echo = 0
  let thin = 0
  let chrome = 0
  for (const c of claims) {
    const a = flat(c.says)
    const b = flat(c.quote)
    if (a === b || b.startsWith(a) || a.startsWith(b)) echo++
    if (c.quote.length < 60) thin++
    if (CHROME.test(c.quote)) chrome++
  }
  return { echo, thin, chrome }
}

export type Result = {
  q: string
  domain: Domain
  why: string
  ms: number
  claims: Claim[]
  lost: Losses
  tells: Tells
  angles: string[]
  threw?: string
}

/**
 * Results so far, across calls.
 *
 * Twenty-two questions at forty seconds each is fifteen minutes, and the
 * control server's bridge drops a completion handler long before that — an
 * 86-second call has already been lost that way. So the run is driven in
 * slices from outside and accumulates here, in the module, which survives
 * between calls because the page caches it.
 */
const collected: Result[] = []

/** Everything gathered so far, and how much is left. */
export const progress = () => ({ done: collected.length, of: CASES.length })

/** Throw away a part-finished run before starting a new one. */
export function reset(): void {
  collected.length = 0
}

/**
 * Ask a slice of the questions, appending to `collected`.
 *
 * Sequential on purpose, and one or two at a time from outside. `research`
 * already pools five reads and four model calls internally; running two of it
 * at once oversubscribes the model server's slots and stops being polite to the
 * sites being read.
 */
export async function ask(
  from: number,
  to = from + 1,
): Promise<{ done: number; of: number; results: Result[] }> {
  const fresh: Result[] = []
  for (const c of CASES.slice(from, to)) {
    const r = await one(c)
    fresh.push(r)
    collected.push(r)
  }
  // The results go back to the caller, not just into `collected`.
  //
  // They lived only in this array once, and the app died on question fourteen
  // of twenty-two — lightpanda segfaulted reading a chrome-heavy page — taking
  // every result with it. Fifteen minutes of real network traffic, gone, with
  // nothing on disk but a progress counter.
  //
  // An eval that is expensive enough to run in slices is expensive enough to
  // lose, so each slice now hands back what it found and the caller writes it
  // down. `collected` stays for `report()` inside a single session; the copy
  // that matters is the one outside this process.
  return { done: collected.length, of: CASES.length, results: fresh }
}

async function one(c: Case): Promise<Result> {
  try {
    const f = await research(c.q)
    return {
      q: c.q,
      domain: c.domain,
      why: c.why,
      ms: f.ms,
      claims: f.claims,
      lost: f.lost,
      tells: tellsFor(f.claims),
      angles: f.angles,
    }
  } catch (err) {
    return {
      q: c.q,
      domain: c.domain,
      why: c.why,
      ms: 0,
      claims: [],
      lost: { thin: 0, offTopic: 0, irrelevant: 0, failed: 0, misquoted: 0, duplicate: 0 },
      tells: { echo: 0, thin: 0, chrome: 0 },
      angles: [],
      threw: String(err).slice(0, 120),
    }
  }
}

export async function run(on: (line: string) => void = () => {}): Promise<{
  results: Result[]
  byDomain: Record<string, unknown>[]
  barren: { q: string; domain: Domain; lost: Losses }[]
  overall: Record<string, unknown>
}> {
  const results: Result[] = []

  for (const c of CASES) {
    on(`${c.domain}  ${c.q}`)
    results.push(await one(c))
  }
  return report(results)
}

/**
 * The table, over whatever has been asked.
 *
 * Separate from asking so a run driven in slices reports the same way an
 * all-at-once run does, and so a part-finished run can still be read.
 */
export function report(results: Result[] = collected): {
  results: Result[]
  byDomain: Record<string, unknown>[]
  barren: { q: string; domain: Domain; lost: Losses }[]
  overall: Record<string, unknown>
} {
  const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0)
  const median = (ns: number[]) => [...ns].sort((a, b) => a - b)[Math.floor(ns.length / 2)] ?? 0

  const domains = [...new Set(CASES.map((c) => c.domain))]
  const byDomain = domains.map((d) => {
    const mine = results.filter((r) => r.domain === d)
    const claims = sum(mine.map((r) => r.claims.length))
    return {
      domain: d,
      asked: mine.length,
      claims,
      // The number that matters: a question that produced nothing at all.
      barren: mine.filter((r) => !r.claims.length).length,
      medianSec: Math.round(median(mine.map((r) => r.ms)) / 100) / 10,
      lost: {
        thin: sum(mine.map((r) => r.lost.thin)),
        offTopic: sum(mine.map((r) => r.lost.offTopic)),
        irrelevant: sum(mine.map((r) => r.lost.irrelevant)),
        failed: sum(mine.map((r) => r.lost.failed)),
        misquoted: sum(mine.map((r) => r.lost.misquoted)),
      },
      tells: {
        echo: sum(mine.map((r) => r.tells.echo)),
        thin: sum(mine.map((r) => r.tells.thin)),
        chrome: sum(mine.map((r) => r.tells.chrome)),
      },
    }
  })

  return {
    results,
    byDomain,
    // The backlog, written by the questions rather than by us.
    barren: results.filter((r) => !r.claims.length).map((r) => ({ q: r.q, domain: r.domain, lost: r.lost })),
    overall: {
      asked: results.length,
      claims: sum(results.map((r) => r.claims.length)),
      barren: results.filter((r) => !r.claims.length).length,
      threw: results.filter((r) => r.threw).length,
      medianSec: Math.round(median(results.map((r) => r.ms)) / 100) / 10,
      tells: {
        echo: sum(results.map((r) => r.tells.echo)),
        thin: sum(results.map((r) => r.tells.thin)),
        chrome: sum(results.map((r) => r.tells.chrome)),
      },
    },
  }
}
