/**
 * Research as a process, rather than as a lucky search.
 *
 * The agent loop can already reach a paper. Asked about speculative decoding it
 * searches, gets `arxiv.org/abs/2302.01318` at 0.897 — the actual paper — reads
 * it in 163 ms, and answers. That is a good lookup and it is not research,
 * because a lookup asks one question once and believes the first thing that
 * comes back.
 *
 * Research is the thing worth building around the same pieces: ask the question
 * several ways, read more than one source, keep only what actually answers,
 * make every claim point at the sentence it came from, and notice when the
 * sources disagree. None of that is capability — it is *order*, and order is
 * the one thing a 3B model reliably will not impose on itself. Given four tool
 * calls and a hard question it does not decompose, it restates.
 *
 * So the process is code and the judgement is the model's, which is the split
 * that has worked everywhere else in this codebase: grammar-constrained
 * struct-filling for what needs judgement, plain control flow for what does
 * not.
 *
 *   1  rewrite      make the question standalone            [aLoRA]
 *   2  decompose    into angles that would need separate searches
 *   3  gather       multi-engine search per angle, deduped by canonical URL
 *   4  read         cheap fetch, escalating to a real browser when thin
 *   5  admit        does this passage answer the angle?     [aLoRA]
 *   6  extract      one claim per passage, with a verbatim quote
 *   7  verify       the quote must occur in the passage      [pure code]
 *   8  write        a note, with every claim attributed
 *
 * Steps 1 and 5 are why the aLoRA conversion mattered. `answerability` runs
 * once per passage — the most-called model path in the app — and it now
 * inherits the base model's KV cache instead of reprocessing under changed
 * weights. Before that this loop would have been unaffordable.
 *
 * Step 7 is the one with no model in it and it is the load-bearing one. A
 * claim whose quote is not a substring of its source is discarded, so a
 * paraphrase cannot become a citation and an invention cannot become a fact.
 * Everything above it is a suggestion; this is the part that is true.
 */
import { granite, sentences } from '../model/granite'
import { cosine, embed } from '../model/vectors'
import { search, read } from './search'
import { answers } from './judge'

export type Source = { url: string; title: string; text: string; gated?: boolean }

/**
 * Does this quote actually occur in this source?
 *
 * The comparison has to forgive typography and forgive nothing else, and
 * getting that line right took a real failure to find. A page rendered to text
 * here reads `output distribution , so the technique` — a space before the
 * comma, left behind when block tags became whitespace. The model quoted it the
 * way it is written rather than the way it was mangled, `distribution, so`, and
 * a plain substring test threw the citation away. Every claim from every source
 * failed this way: eight sources, zero findings, and nothing in the logs to say
 * why.
 *
 * So both sides are normalised for the things that are artefacts of rendering —
 * whitespace, spacing around punctuation, curly quotes and dashes — and for
 * nothing that changes a word. A paraphrase still fails, which is the point.
 */
export function quotesFrom(source: string, quote: string): boolean {
  const flat = (s: string) =>
    s
      .toLowerCase()
      // Typographic characters a page uses and a model does not reproduce.
      .replace(/[\u2018\u2019\u02bc]/g, "'")
      .replace(/[\u201c\u201d]/g, '"')
      .replace(/[\u2010-\u2015\u2212]/g, '-')
      .replace(/\u00a0/g, ' ')
      // Rendering artefacts: a space before punctuation is never authored.
      .replace(/\s+([,.;:!?)\]])/g, '$1')
      .replace(/([([])\s+/g, '$1')
      .replace(/\s+/g, ' ')
      .trim()

  const q = flat(quote)
  // A fragment this short is not evidence of anything.
  if (q.length < 24) return false
  return flat(source).includes(q)
}

export type Claim = {
  /**
   * The gate said this source did not answer the question, and it was read
   * anyway. Only ever set under `shadowGate`, and it is the whole point of that
   * mode: a verified claim carrying this flag is a rejection the gate got wrong.
   */
  gated?: boolean
  /** What the source says, in the model's words. */
  says: string
  /** Verbatim from the source. Checked, not trusted. */
  quote: string
  url: string
  title: string
}

/**
 * Where sources went.
 *
 * One `rejected` count was useless. Seven of eight sources were being dropped
 * and the number could not say whether they were unreachable, off-topic, or
 * fine-but-misquoted — three problems with three different fixes. A tally that
 * cannot be attributed cannot be acted on.
 */
export type Losses = {
  /** Fetch failed, or the page had almost no text. */
  thin: number
  /** `answerability` said this passage does not answer the question. */
  offTopic: number
  /** The model itself said the source does not bear on the question. */
  irrelevant: number
  /**
   * The extraction call did not return at all.
   *
   * Split out of `irrelevant` after they were the same number for a while and
   * that number went to six with no way to tell which. "The model read it and
   * had nothing to say" and "the grammar would not compile" are not the same
   * event, and only one of them is a bug — which is the whole argument this
   * type was created to make, applied to the one bucket that was still lumping
   * two things together.
   */
  failed: number
  /** A claim was made and its quote was not in the source. */
  misquoted: number
  /** Said the same thing as a claim already kept. */
  duplicate: number
}

export type Finding = {
  question: string
  angles: string[]
  claims: Claim[]
  lost: Losses
  note: string
  ms: number
  /** Wall-clock inside each stage, for knowing what to make faster. */
  timing: Record<string, number>
}

export type Progress = (stage: string, detail?: string) => void

/** How many angles the question is split into. */
const ANGLES = 3
/** Results considered per angle. */
const PER_ANGLE = 4
/** Sources actually read. More than this and the wall-clock stops being worth it. */
const MAX_READ = 8
/** A passage shorter than this had nothing on the page. */
const MIN_PASSAGE = 200

/**
 * Split the question into angles.
 *
 * Not sub-questions in the logical sense — searches. The test for a good angle
 * is "would this return different pages", which is why the prompt asks for
 * search phrasings rather than for a decomposition. A model asked to decompose
 * produces a numbered restatement; asked what it would type into a search box,
 * it produces something usable.
 *
 * ── What was tried instead, and why it is not here ──────────────────────────
 *
 * Real prompts are two or three words, and two or three words are ambiguous, so
 * a step was added ahead of this one to write the question out in full and let
 * everything downstream ask *that*. It made the process worse twice, in two
 * different ways, and both are worth keeping written down.
 *
 * Asked to name the field first — the conditioning trick that works elsewhere
 * in this codebase — the model guessed the field and then conditioned
 * faithfully on its guess: `mamba vs transformers` became "the Mamba video game
 * engine and the Transformers franchise", `moe routing collapse` went to
 * networking. Shown the titles its own search had just returned, so it would
 * not have to guess, it stopped guessing and started copying: the angles came
 * back as verbatim page titles, and the question came back as "…based on the
 * titles of the pages found".
 *
 * Then the premise turned out to be false anyway. The rewrite existed because
 * `answerability` is trained on conversations and a noun phrase is not a
 * question — but measured against a paper it plainly answers, `mamba vs
 * transformers` passes the gate, and the model's expanded question is the one
 * form that fails it. The terse words were never the problem.
 *
 * What the gate was actually rejecting was pages, correctly, because the angles
 * had drifted and the searches were bringing back the wrong ones.
 */
async function decompose(question: string): Promise<string[]> {
  try {
    const out = await granite.fill<{ searches?: string[] }>(
      [
        {
          role: 'system',
          content: [
            'You are given a question someone wants researched.',
            'Answer with the search phrases you would type to find out — different',
            'phrasings that would return different pages, not restatements of each',
            'other. Include the specific terms an expert would use.',
          ].join(' '),
        },
        { role: 'user', content: question },
      ],
      {
        type: 'object',
        properties: {
          searches: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: ANGLES },
        },
        required: ['searches'],
      },
      { maxTokens: 200 },
    )
    const angles = (out.searches ?? []).map((s) => s.trim()).filter(Boolean).slice(0, ANGLES)
    // The original question is always one of the angles. A decomposition that
    // loses the thing actually asked is worse than no decomposition.
    return angles.includes(question) ? angles : [question, ...angles].slice(0, ANGLES + 1)
  } catch {
    return [question]
  }
}

/**
 * Every distinct URL the angles turn up, best first.
 *
 * The angles run together. They were sequential, and measured across a real
 * question that was 45 of the 91 seconds — half the run spent waiting for four
 * searches that have nothing to say to each other. Each angle already fans out
 * across nine engines internally, so this is a second layer of the same
 * concurrency rather than a new idea.
 */
async function gather(
  question: string,
  angles: string[],
  /** Searches already in flight, keyed by the angle they were started for. */
  running: Map<string, Promise<Awaited<ReturnType<typeof search>>>>,
  on: Progress,
): Promise<{ url: string; title: string }[]> {
  const seen = new Map<string, { url: string; title: string; score: number }>()
  on('searching', `${angles.length} angles`)
  const perAngle = await Promise.all([
    ...angles.map((a) => running.get(a) ?? search(a, PER_ANGLE).catch(() => [])),
    // Anything started before the angles were known and not among them.
    ...[...running].filter(([a]) => !angles.includes(a)).map(([, p]) => p),
  ])

  /**
   * The words typed outrank anything the model wrote.
   *
   * Angles drift, and on a terse question they drift badly — `rope scaling
   * long context` produced "dynamic rope climbing", `mamba vs transformers`
   * produced "Mamba (video game) vs Transformers". Filtering them was tried
   * and abandoned: scored against the domain those searches themselves return,
   * the video-game angle came out *highest* of the three, because it shares
   * every content word with the right one and embeddings cannot tell two
   * meanings of "Mamba" apart. Neither can the search results, which is why the
   * domain vector was polluted too.
   *
   * What is reliable is which query produced a page. A drifted angle cannot be
   * detected, but it also cannot contaminate the one query nobody invented. So
   * the read budget is spent on the typed words first and angles fill what is
   * left — they still contribute, and a page several angles agree on can still
   * outrank one, but they no longer crowd out the results that were never in
   * doubt.
   */
  const TYPED = 1.6

  perAngle.forEach((hits, i) => {
    const weight = angles[i] === question ? TYPED : 1
    for (const h of hits) {
      const prev = seen.get(h.url)
      // A page found by two different angles is more likely to be central, so
      // agreement adds to its score rather than replacing it.
      if (prev) prev.score += (h.score ?? 0) * 0.5 * weight
      else seen.set(h.url, { url: h.url, title: h.title ?? h.url, score: (h.score ?? 0) * weight })
    }
  })
  return [...seen.values()].sort((a, b) => b.score - a.score).slice(0, MAX_READ)
}

/**
 * One claim from one passage, quoting a sentence the page actually contains.
 *
 * Asking a model to copy does not make it copy. Told "quote the words that
 * support it, copied exactly, do not tidy it", this one returned "Speculative
 * decoding is a technique used to improve the efficiency of language models" —
 * fluent, accurate, and nowhere in the source. Three of five sources failed the
 * same way, all of them paraphrases beginning "Speculative decoding is/refers
 * to/offers". The verification was working; the instruction was not.
 *
 * So the model no longer writes the quote. The source is split into its
 * sentences, they are offered as an enumeration, and it picks one by number.
 * The grammar admits only those numbers, so the quote is verbatim by
 * construction — a paraphrase is not a thing the model is able to emit. This is
 * the same move as the ClickHouse query spec and the dj arrangement: where a
 * wrong answer can be made unexpressible, that beats asking for a right one.
 *
 * `says` is still free text, because that is a summary and is supposed to be in
 * the model's own words. The sentence behind it is what has to be real.
 */
/**
 * Strip the reporting voice off a finding.
 *
 * Told to state the fact, a small model still opens with "The source
 * establishes that" about a third of the time — the instruction competes with a
 * very strong prior. Removing the preamble afterwards is cheaper and more
 * reliable than another round of prompt wording, and it cannot fail in a way
 * that loses content.
 */
function tidy(says: string): string {
  const out = says
    .trim()
    .replace(
      /^(the |this )?(source|paper|article|study|text|document|author|passage|sentence|quote|line)s?\s+(establishes|states|says|shows|notes|explains|describes|discusses|reports|indicates|suggests|mentions|argues|claims|demonstrates|tells us|tells the reader)\s+(that\s+)?/i,
      '',
    )
    .replace(/^(it|this)\s+(states|says|shows|notes|explains)\s+(that\s+)?/i, '')
    .trim()
  return out ? out.charAt(0).toUpperCase() + out.slice(1) : ''
}

/**
 * A quotation someone can read.
 *
 * Papers are written in LaTeX and a page rendered to text keeps it — a real
 * quote came back as "boosts inference speed by up to $2.29\times$", which is
 * accurate and unreadable. Only the markup is touched; every word survives, so
 * the quote still says exactly what the source said.
 */
function readable(quote: string): string {
  return quote
    // Wikipedia's furniture, which the renderer leaves inline: "[ citation
    // needed ] History [ edit ] Founding [ edit ] The company was founded in
    // 2016…". It is not part of the sentence and it is not part of the claim.
    .replace(/\[\s*(edit|citation needed|\d+)\s*\]/gi, ' ')
    .replace(/\$([^$]*)\$/g, '$1')
    .replace(/\\times/g, '×')
    .replace(/\\%/g, '%')
    .replace(/\\[a-z]+\{([^}]*)\}/gi, '$1')
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The sentences of a page that could be quoted.
 *
 * The length bounds are obvious — too short to be evidence, too long to be a
 * quotation. The terminal-stop rule is not, and it was bought with a citation
 * that read:
 *
 *     "Speculative decoding - Wikipedia Jump to content From Wikipedia, the
 *      free encyclopedia Machine learning and data mining Paradigms…"
 *
 * attached to a perfectly good claim. Every check passed. It is verbatim, it is
 * in the source, it is the right length — and it is the masthead, offered as
 * evidence. `sentences()` returns it as one candidate for the same reason it is
 * worthless: navigation has no sentences in it, so nothing splits it.
 *
 * That absence is the test. Prose ends in a full stop; a strip of menu items
 * ends in whatever the next element happened to be. Requiring the terminal
 * punctuation removes the chrome as a class, without a list of words to
 * maintain and without touching a single real sentence.
 */
function candidates(text: string): string[] {
  return sentences(text)
    .map((x) => x.replace(/\s+/g, ' ').trim())
    .filter((x) => x.length >= 40 && x.length <= 300)
    // Closing quotes and brackets may follow the stop; nothing else may.
    .filter((x) => /[.!?][")'\]]*$/.test(x))
    // A heading is not a sentence, and `?` was letting every one of them
    // through. "How Does Caffeine Affect Running Performance?" and "Could a yen
    // carry trade unwind trigger a crash?" both reached the note as findings —
    // verbatim, cited, and answering nothing. The terminal-stop rule catches
    // navigation because navigation has no punctuation; interrogative headings
    // slip past it because they do. A source that asks the question is not a
    // source that answers it.
    .filter((x) => !/\?[")'\]]*$/.test(x))
    .slice(0, 40)
}

/**
 * The part of a page worth judging.
 *
 * The gate used to see the first 2,200 characters, which on a paper is the
 * masthead and on a blog is the menu. Widening that window was a patch on the
 * wrong axis: more of the top of the page is still the top of the page.
 *
 * Sentences are the right unit, and `candidates` already produces them — the
 * same ones the extractor will choose a quote from. Its length filter does the
 * work incidentally, because navigation is made of fragments and prose is not:
 * "Skip to main content", "Login", "Subscribe" are all under forty characters
 * and none of them survive. What is left is what the page says.
 */
function prose(text: string, budget = 2400): string {
  const out: string[] = []
  let n = 0
  for (const s of candidates(text)) {
    if (n + s.length > budget) break
    out.push(s)
    n += s.length + 1
  }
  return out.join(' ') || text.slice(0, budget)
}

/**
 * Names in the claim that are not in the evidence.
 *
 * The guard that does not depend on a prompt, and the one that would have
 * caught the worst thing this process has produced. Asked who founded Hugging
 * Face and shown a sentence from the Moonshot AI page, the model wrote "Hugging
 * Face was founded in March 2023 by three former schoolmates from Tsinghua
 * University" — every name right, every date right, the company swapped for the
 * one in the question. A fabricated claim carrying a real citation that
 * contradicts it, which is worse than an unsourced guess: the citation is what
 * makes it look checked.
 *
 * A restatement of a sentence cannot introduce a company, a person or a place
 * the sentence never mentioned. If it does, the model supplied it.
 *
 * Every capitalised word is checked, including the first — which the initial
 * version did not, and that version would have missed the very failure it was
 * written for. Skipping the leading character to avoid flagging "The" meant
 * "Anthropic built it." passed clean, and the Hugging Face substitution was
 * caught only by luck, because the name was two words long and `Face` was not
 * the first. A guard whose coverage depends on the length of the fabricated
 * name is not a guard.
 *
 * The first word is instead exempted by *what it is*: a small list of words
 * that genuinely start English sentences. Anything else capitalised is treated
 * as a name, which does reject the occasional honest paraphrase — "Runners"
 * where the source said "athletes" — and that trade is taken deliberately. The
 * cost of a false positive is one claim lost from one slide. The cost of a
 * false negative is a fabricated sentence under a citation that appears to
 * support it.
 *
 * Compared against the quote alone — the question is not a source, and letting
 * its words through here would permit precisely the substitution this exists to
 * stop.
 */
const OPENERS = new Set(
  ('the this that these those there their they them it its a an and but or for in on at by with ' +
    'when while where what which who whom how why if as so some most many much both each every all ' +
    'one two three after before during because however although though since under over about ' +
    'between among from into through no not only also more less than then such using based given ' +
    'according unlike despite within without across around')
    .split(' '),
)

export function invents(says: string, quote: string): string[] {
  const named = says.match(/\b[A-Z][\w'\u2019-]{2,}/g) ?? []
  const inQuote = quote.toLowerCase()
  const first = (says.trim().split(/\s+/)[0] ?? '').replace(/[^\w'\u2019-]/g, '').toLowerCase()
  const seen = new Set<string>()

  return named.filter((w) => {
    const k = w.toLowerCase()
    if (inQuote.includes(k) || seen.has(k)) return false
    // The one exemption: a sentence beginning with an ordinary word.
    if (k === first && OPENERS.has(k)) return false
    seen.add(k)
    return true
  })
}

type Extracted = { claim: Claim } | { lost: 'irrelevant' | 'misquoted' | 'failed'; why?: string }

async function extract(question: string, source: Source): Promise<Extracted> {
  const lines = candidates(source.text)
  if (!lines.length) return { lost: 'irrelevant' }

  try {
    // ── One: which sentence. Nothing else.
    const pick = await granite.fill<{ sentence?: number; relevant?: boolean }>(
      [
        {
          role: 'system',
          content: 'You answer questions about a source you are shown. The source is given as numbered sentences.',
        },
        {
          role: 'user',
          content: [`Question: ${question}`, `Source: ${source.title}`, '', ...lines.map((l, i) => `${i}. ${l}`)].join('\n'),
        },
      ],
      {
        type: 'object',
        properties: {
          relevant: { type: 'boolean', description: 'False if this source does not bear on the question.' },
          sentence: {
            type: 'integer',
            minimum: 0,
            maximum: lines.length - 1,
            description: 'The number of the sentence that best answers the question.',
          },
        },
        required: ['relevant', 'sentence'],
      },
      { maxTokens: 40 },
    )

    if (!pick.relevant) return { lost: 'irrelevant' }
    const quote = lines[pick.sentence ?? -1]
    if (!quote) return { lost: 'misquoted' }
    if (!quotesFrom(source.text, quote)) return { lost: 'misquoted' }

    // ── Two: what it says, shown that sentence and nothing else.
    const out = await granite.fill<{ says?: string }>(
      [
        {
          role: 'system',
          content: 'You restate, in one sentence of your own words, what a given sentence says. Add nothing that is not in it.',
        },
        // The question is deliberately absent.
        //
        // It was here, and it produced the worst output this process has made.
        // Asked "who founded huggingface" and shown a sentence from the
        // Moonshot AI page, the model wrote "Hugging Face was founded in March
        // 2023 by three former schoolmates from Tsinghua University" — every
        // name correct, every date correct, and the company swapped to the one
        // in the question. A fabricated claim carrying a genuine citation that
        // contradicts it, which is worse than an unsourced guess, because the
        // citation is what makes it look checked.
        //
        // Given a sentence and a question that do not match, a model will
        // reconcile them, and the sentence is the only one of the two it is
        // allowed to change. So it does not get the question. Whether the
        // sentence bears on it at all was already decided by the call above,
        // where the whole page was there to judge against.
        { role: 'user', content: `Sentence: ${quote}` },
      ],
      {
        type: 'object',
        properties: {
          says: {
            type: 'string',
            pattern: '^([^.!?"]|\\.[0-9]){20,220}[.!?]$',
            description: 'What that sentence tells you about the subject, in one sentence. The finding itself.',
          },
        },
        required: ['says'],
      },
      { maxTokens: 160 },
    )

    const says = tidy(out.says ?? '')
    if (!says) return { lost: 'irrelevant' }
    if (/^(the |a )?(number|index|sentence|finding|answer|value|field)\b/i.test(says)) return { lost: 'irrelevant' }
    if (/^i[\s\'\u2019]/i.test(says)) return { lost: 'irrelevant' }
    if ((out.says ?? '').length >= 221) return { lost: 'failed', why: 'says hit the length ceiling' }

    const invented = invents(says, quote)
    if (invented.length) {
      return { lost: 'misquoted', why: `claim names ${invented.slice(0, 3).join(', ')}, absent from the quote` }
    }

    return { claim: { says, quote: readable(quote), url: source.url, title: source.title } }
  } catch (err) {
    return { lost: 'failed', why: String(err).slice(0, 160) }
  }
}

/** Drop claims that say the same thing, keeping the first. */
async function distinct(claims: Claim[]): Promise<Claim[]> {
  if (claims.length < 2) return claims
  const vecs = await Promise.all(claims.map((c) => embed(c.says)))
  const kept: Claim[] = []
  const keptVecs: Float32Array[] = []
  claims.forEach((c, i) => {
    if (keptVecs.some((v) => cosine(v, vecs[i]) > 0.9)) return
    kept.push(c)
    keptVecs.push(vecs[i])
  })
  return kept
}

/**
 * The note.
 *
 * Written here rather than by the model. A model asked to produce the final
 * markdown will rewrite the claims on its way past — it is generating, and
 * generating is where the quotes stop matching. The claims have already been
 * verified against their sources; assembling them is string work, and string
 * work should not go near a model.
 */
function compose(question: string, angles: string[], claims: Claim[], lost: Losses): string {
  const bySource = new Map<string, Claim[]>()
  for (const c of claims) {
    bySource.set(c.url, [...(bySource.get(c.url) ?? []), c])
  }

  const lines: string[] = [
    question.replace(/^\w/, (m) => m.toUpperCase()),
    '',
    `Researched ${new Date().toISOString().slice(0, 10)} across ${bySource.size} sources.`,
    '',
    '# What the sources say',
    '',
  ]

  for (const c of claims) {
    // When the finding is the sentence, print it once.
    //
    // The extractor emits the evidence before the claim, so the claim is about
    // the evidence rather than about the page — which is the point, and which
    // also means it sometimes *is* the sentence, near enough. Printing
    //
    //     - Routing collapse occurs when a small number of experts…
    //       > Routing collapse occurs when a small number of experts…
    //
    // reads as a bug whether or not it is one. A quotation that says the same
    // thing as the line above it is not a citation, it is an echo.
    const same = c.says.replace(/\W+/g, '').toLowerCase()
    const asQuote = c.quote.replace(/\W+/g, '').toLowerCase()
    const echo = same === asQuote || asQuote.startsWith(same) || same.startsWith(asQuote)

    if (echo) lines.push(`- > ${c.quote.slice(0, 300)}`)
    else {
      lines.push(`- ${c.says}`)
      lines.push(`  > ${c.quote.slice(0, 300)}`)
    }
    lines.push(`  [${c.title.slice(0, 70)}](${c.url})`)
    lines.push('')
  }

  if (!claims.length) {
    // A run that found nothing and a run where nothing worked produce the same
    // empty list, and they mean opposite things. The losses tell them apart —
    // and when there are no losses either, nothing was ever reached, which is
    // the one outcome that must not be reported as a finished search.
    const anyLoss = Object.values(lost).some((n) => n > 0)
    lines.push(
      anyLoss
        ? 'Nothing here could be attributed to a source that survived checking.'
        : 'No sources were reached at all — this did not fail to find an answer, it failed to look.',
      '',
    )
  }

  lines.push('# How this was searched', '')
  for (const a of angles) lines.push(`- ${a}`)
  // What did not make it, and why. A note that only lists what was found reads
  // as complete whether or not it is; saying six sources were off-topic is the
  // difference between "this is what there is" and "this is what I could get".
  const dropped = Object.entries(lost).filter(([, n]) => n > 0)
  if (dropped.length) {
    const words: Record<string, string> = {
      thin: 'unreadable',
      offTopic: 'did not answer it',
      irrelevant: 'had nothing to add',
      misquoted: 'could not be quoted accurately',
      duplicate: 'repeated another source',
      failed: 'could not be read by the model',
    }
    lines.push('', 'Sources set aside: ' + dropped.map(([k, n]) => `${n} ${words[k] ?? k}`).join(', ') + '.')
  }

  return lines.join('\n')
}

/**
 * Run the process.
 *
 * Reports progress as it goes because it takes tens of seconds and a silent
 * minute is indistinguishable from a hang.
 */
/**
 * Run N promises at a time.
 *
 * Two different ceilings, for two different reasons. Reads are bounded by
 * politeness — these are strangers' servers and eight simultaneous fetches from
 * one machine is rude. Model calls are bounded by the hardware: llama-server
 * reports four slots, so a fifth concurrent request queues behind the others
 * and buys nothing but a longer tail.
 */
async function pool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return out
}

/** Strangers' servers. */
const READ_AT_ONCE = 5
/** Slots the model server actually has. */
const MODEL_AT_ONCE = 4

/**
 * Run the process.
 *
 * Reports progress as it goes because it takes tens of seconds and a silent
 * minute is indistinguishable from a hang.
 */
export type Options = {
  /**
   * Run the gate but do not obey it.
   *
   * `offTopic` is 40% of every source fetched, in all ten domains measured —
   * far and away the largest loss in the process. What that number cannot say
   * is whether the gate is wrong or whether retrieval is bringing back junk for
   * it to correctly refuse, and those have opposite fixes.
   *
   * So the rejections get read anyway and their claims are tagged. The quote
   * check is pure code and does not care what the gate thought, so a verified,
   * on-topic claim from a rejected source is a false rejection with the receipt
   * attached — and a rejected source that yields nothing is the gate being
   * right. Counting both settles it without anyone having to judge a page.
   */
  shadowGate?: boolean
}

export async function research(
  question: string,
  on: Progress = () => {},
  opts: Options = {},
): Promise<Finding> {
  const started = performance.now()
  const timing: Record<string, number> = {}
  const clock = async <T,>(name: string, fn: () => Promise<T>): Promise<T> => {
    const t = performance.now()
    const r = await fn()
    timing[name] = Math.round(performance.now() - t)
    return r
  }

  const lost: Losses = { thin: 0, offTopic: 0, irrelevant: 0, misquoted: 0, duplicate: 0, failed: 0 }

  on('planning')
  // The words typed are searched while the plan is still being made. The
  // planner cannot change what that search should be — it is the question —
  // so waiting for it buys nothing but its own latency.
  // The words typed are searched while the plan is still being made — the
  // planner cannot change what that search should be — and searched twice as
  // wide as any angle. They are the query the gate will judge every page
  // against, and they are the only query in the run nobody made up.
  const running = new Map([[question, search(question, PER_ANGLE * 2).catch(() => [])]])
  const angles = await clock('plan', () => decompose(question))

  const found = await clock('search', () => gather(question, angles, running, on))

  // Reading and admitting, concurrently. These were sequential and it was the
  // single largest cost in the run: eight pages fetched one after another, each
  // followed by its own model call, none of them dependent on any other.
  type Admitted = { lost: keyof Losses } | { source: Source }

  on('reading', `${found.length} sources`)
  const admitted = await clock('read', () =>
    pool<{ url: string; title: string }, Admitted>(found, READ_AT_ONCE, async (f) => {
      const text = await read(f.url, 3000).catch(() => '')
      if (text.length < MIN_PASSAGE) return { lost: 'thin' }
      // The aLoRA gate. Cheap now, and it is what keeps a page that merely
      // mentions the subject out of the note.
      //
      // Both of its arguments were wrong for a long time, in the same way: it
      // was asked whether the top of a page answered a string of typed words,
      // when what it can judge is whether prose answers a question. It is given
      // the sentences of the page and the question they were meant to answer.
      // Never dropped here. The gate's verdict is recorded and carried; what
      // to do about it is decided below, once it is known how many sources
      // survived — which is not knowable one page at a time.
      const refused = (await answers(question, prose(text))) === false
      return { source: { url: f.url, title: f.title, text, gated: refused } }
    }),
  )

  const sources: Source[] = []
  const refused: Source[] = []
  for (const a of admitted) {
    if ('lost' in a) lost[a.lost]++
    else if (a.source.gated) refused.push(a.source)
    else sources.push(a.source)
  }

  /**
   * The gate demotes rather than discards.
   *
   * `offTopic` was 40% of every source fetched across ten domains, so its
   * rejections were read anyway and judged one by one. The gate is right about
   * half the time and right about the things that matter most: asked who
   * founded Hugging Face it threw out pages about Moonshot AI and a Tsinghua
   * spin-out, which are different companies, and six sources it refused for
   * `creatine cognitive effects` produced not one claim when forced.
   *
   * But when it is wrong it is wrong expensively. `caffeine effect on marathon
   * performance` returned nothing at all, while a source it had refused said
   * plainly that caffeine improves performance in longer endurance events. A
   * note that says nothing is not more accurate than a note with one good
   * finding in it — it is just empty, and emptiness reads as "there is nothing
   * to know" rather than "I declined to look".
   *
   * So the verdict is obeyed while there is anything else to read, and ignored
   * when there is not. A run with plenty of admitted sources stays as strict as
   * it was; a run facing a blank page takes the noise instead, because at that
   * point noise is the only thing on offer that could be useful. The claims are
   * still tagged, still quote-checked, and still have to survive everything
   * downstream.
   */
  const ENOUGH = 3
  const want = opts.shadowGate ? refused.length : Math.max(0, ENOUGH - sources.length)
  const take = refused.slice(0, want)
  sources.push(...take)
  lost.offTopic += refused.length - take.length

  on('extracting', `${sources.length} sources`)
  const results = await clock('extract', () =>
    pool(sources, MODEL_AT_ONCE, async (src) => {
      const r = await extract(question, src)
      return 'claim' in r && src.gated ? { claim: { ...r.claim, gated: true } } : r
    }),
  )

  const raw: Claim[] = []
  for (const r of results) {
    if ('lost' in r) {
      lost[r.lost]++
      // A count says how often; only the message says what to fix.
      if (r.why) on('failed', r.why)
    } else raw.push(r.claim)
  }

  const claims = await clock('dedup', () => distinct(raw))
  lost.duplicate = raw.length - claims.length

  on('writing')
  const note = compose(question, angles, claims, lost)

  return { question, angles, claims, lost, note, ms: Math.round(performance.now() - started), timing }
}
