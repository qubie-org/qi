/**
 * Asking a database instead of the web.
 *
 * Search answers "what has someone written about this". It is bad at "how
 * many", "what is the median", "how has it changed since 2015" — questions
 * where the answer is a computation over records nobody has happened to blog
 * about. Qi's other quantitative path, the operations index, has the opposite
 * problem: 2,721 endpoints, each returning one prepared answer that either fits
 * the question or does not.
 *
 * ClickHouse runs a public demo at play.clickhouse.com with no key, no account
 * and — verified, not assumed — no write access at all: `CREATE TABLE` comes
 * back "Not enough privileges". Behind it sit datasets worth actually asking
 * questions of: 3.5 billion New York taxi trips, 3.2 billion GitHub events,
 * 37 million Hacker News posts, 30 million UK property sales, every scheduled
 * US flight since 1987.
 *
 * ── Why the model may write SQL here, having been refused Strudel ───────────
 *
 * The dj command deliberately does not let the model write code, because a
 * wrong pattern fails inside an audio callback where nothing can catch it.
 * SQL against this endpoint is the opposite situation, and the difference is
 * worth naming rather than looking inconsistent:
 *
 *   the blast radius is a syntax error. The server is read-only by grant, so
 *   the very worst a wrong query does is return nothing;
 *
 *   it is checked before it is sent — one statement, must begin with SELECT,
 *   no semicolons, a LIMIT forced on;
 *
 *   and the result is a table, which either answers the question or visibly
 *   does not. There is no plausible-looking wrong answer of the kind the
 *   generic API reducer produces.
 *
 * The schema is retrieved, not dumped. The demo has hundreds of tables and
 * showing them all would spend the context on nothing; the question is embedded
 * and matched against a description of each dataset, exactly as the operations
 * index works, so the model sees the two or three tables that might help and
 * their real columns.
 */
import { granite } from '../model/granite'
import { cosine, embed } from '../model/vectors'
import { net } from './net'

const ENDPOINT = 'https://play.clickhouse.com/?user=play&default_format=JSON'

/** Rows past this are not an answer, they are a download. */
const MAX_ROWS = 40

export type Dataset = {
  table: string
  /** What it holds, in the words someone would ask about it. Embedded. */
  what: string
}

/**
 * The datasets worth asking about.
 *
 * Curated rather than discovered. The demo carries the ClickHouse project's own
 * CI telemetry — hundreds of billions of rows of build checks and query metrics
 * — which is genuinely the largest thing there and never what anybody means.
 * Listing every table would bury the fourteen that answer human questions under
 * the ones that answer ClickHouse's questions about itself.
 */
export const DATASETS: Dataset[] = [
  { table: 'hackernews', what: 'Hacker News posts, comments, stories, titles, authors, scores, links, technology discussion since 2006' },
  { table: 'github_events', what: 'GitHub activity: stars, forks, pull requests, issues, commits, repositories, open source projects and contributors' },
  { table: 'trips', what: 'New York City taxi rides: pickup and dropoff, distance, fare, tip, passenger count, time of day' },
  { table: 'uk_price_paid', what: 'UK house and property sales: price paid, date, town, county, postcode, property type' },
  { table: 'ontime', what: 'US airline flights: departure and arrival delays, cancellations, carriers, airports, routes, since 1987' },
  { table: 'opensky', what: 'flights and aircraft tracking: origin and destination airports, callsign, altitude, air traffic' },
  { table: 'covid', what: 'COVID-19 cases and deaths by country and date, pandemic statistics over time' },
  { table: 'cell_towers', what: 'mobile phone cell towers worldwide: radio type, operator, country, latitude and longitude' },
  { table: 'menu_item_denorm', what: 'historical restaurant menus and dish prices from the New York Public Library collection, food over time' },
  { table: 'stock', what: 'stock market prices over time: open, high, low, close, volume by ticker symbol' },
  { table: 'tranco', what: 'website popularity ranking: the most visited domains on the internet' },
]

type Ranked = Dataset & { score: number }

/** The datasets nearest a question. */
export async function findDatasets(question: string, k = 3): Promise<Ranked[]> {
  const q = await embed(question)
  const scored = await Promise.all(
    DATASETS.map(async (d) => ({ ...d, score: cosine(q, await embed(d.what)) })),
  )
  return scored.sort((a, b) => b.score - a.score).slice(0, k)
}

export type Columns = { numeric: string[]; text: string[]; time: string[] }

/** Real columns, asked of the server rather than remembered here. */
export async function columnsOf(table: string): Promise<Columns | null> {
  const clean = table.replace(/[^a-z_0-9]/gi, '')
  const sql = `SELECT name, type FROM system.columns WHERE database='default' AND table='${clean}' FORMAT TSV`
  const res = await net(`${ENDPOINT}&query=${encodeURIComponent(sql)}`)
  if (!res.ok || !res.body) return null

  const out: Columns = { numeric: [], text: [], time: [] }
  for (const line of res.body.split('\n')) {
    const [name, type = ''] = line.split('\t')
    if (!name) continue
    if (/Date|DateTime/.test(type)) out.time.push(name)
    else if (/Int|Float|Decimal/.test(type)) out.numeric.push(name)
    else if (/String|FixedString/.test(type)) out.text.push(name)
  }
  return out.numeric.length || out.text.length ? out : null
}

/**
 * What the model may ask for.
 *
 * Not SQL. This is the second time the same lesson has been learned in this
 * codebase and the first time it was written down: the dj command refuses to
 * let the model write Strudel and has it fill a struct instead, and the reason
 * given there — "everything it can say is playable by construction" — applies
 * here exactly. Given three table schemas and asked for SQL, the model wrote
 * `SELECT repo_name ... FROM hackernews`: the right column from one table and
 * the FROM clause of another.
 *
 * A spec cannot do that. The column names are `enum`s built from the schema
 * that was just read off the server, so a column that does not exist is not a
 * thing the grammar can emit — the failure is unexpressible rather than
 * unlikely. There is no FROM clause to get wrong because the code writes it.
 *
 * The cost is expressiveness: no joins, no windows, no subqueries. That is a
 * real limit and it is worth what it buys, because the questions people ask —
 * how many, what is the average, which is the biggest — are all count, mean,
 * sum, extreme, optionally grouped, optionally filtered. A 270M text-to-SQL
 * specialist would write better free SQL than a 3B does; it would still be
 * generating a string that can name a column that is not there.
 */
export type Spec = {
  metric: 'count' | 'avg' | 'sum' | 'max' | 'min'
  column?: string
  groupBy?: string
  filterColumn?: string
  filterContains?: string
}

/** Turn a spec into SQL. The only place a query is written. */
export function build(table: string, spec: Spec, cols: Columns): { ok: true; sql: string } | { ok: false; why: string } {
  const known = new Set([...cols.numeric, ...cols.text, ...cols.time])
  const q = (name: string) => `\`${name}\``

  if (spec.metric !== 'count') {
    if (!spec.column || !cols.numeric.includes(spec.column)) {
      return { ok: false, why: `${spec.metric} needs a numeric column` }
    }
  }
  const value = spec.metric === 'count' ? 'count()' : `${spec.metric}(${q(spec.column!)})`

  const parts: string[] = ['SELECT']
  if (spec.groupBy && known.has(spec.groupBy)) parts.push(`${q(spec.groupBy)},`)
  parts.push(`${value} AS value FROM ${q(table)}`)

  if (spec.filterColumn && spec.filterContains && cols.text.includes(spec.filterColumn)) {
    // Escaped rather than interpolated. The endpoint is read-only so this is
    // not the security boundary, but a stray quote is a failed query and a
    // failed query is indistinguishable from an absent answer.
    const needle = spec.filterContains.replace(/\\/g, '').replace(/'/g, "''").slice(0, 60)
    parts.push(`WHERE ${q(spec.filterColumn)} ILIKE '%${needle}%'`)
  }

  if (spec.groupBy && known.has(spec.groupBy)) {
    parts.push(`GROUP BY ${q(spec.groupBy)} ORDER BY value DESC`)
  }
  parts.push(`LIMIT ${spec.groupBy ? 10 : 1}`)

  return { ok: true, sql: parts.join(' ') }
}

export type Queried = { sql: string; rows: Record<string, unknown>[]; table: string } | null

const SYSTEM = [
  'You are reading a question about one table of data.',
  '',
  'You do not write SQL. You describe what to measure, and the query is built',
  'for you from what you say.',
  '',
  'metric      what to compute. `count` needs no column.',
  'column      which numeric column to average, sum or take the extreme of.',
  'groupBy     leave empty for one overall number; set it to break the answer',
  '            down, which is what a "which" or "top" question wants.',
  'filterColumn / filterContains   narrow to rows whose text column contains a',
  '            word. Leave both empty when the question asks about everything.',
].join('\n')

/**
 * Ask the database.
 *
 * Returns null rather than throwing on every failure path — no relevant table,
 * a query that will not pass `safe`, a server error, no rows. A quantitative
 * question this cannot answer should fall through to the other grounding paths,
 * not fail the turn.
 */
export async function ask(question: string): Promise<Queried> {
  if (!granite.ready) return null

  // One table, named explicitly — not the top three.
  //
  // Showing three schemas and letting the model choose looked like the careful
  // option and is the opposite. Asked which GitHub repos have the most stars it
  // retrieved `github_events` correctly at 0.675 against 0.374 for the runner
  // up, then wrote `SELECT repo_name ... FROM hackernews`: the right column
  // from one table and the FROM clause of another. A model this size treats
  // several schemas in one prompt as one schema. Retrieval is already good
  // enough to decide, so it decides.
  const near = await findDatasets(question, 1)
  if (!near.length) return null

  const table = near[0].table
  const cols = await columnsOf(table)
  if (!cols) return null

  let spec: Spec
  try {
    // The column names are enums drawn from the schema that was just read off
    // the server, so the grammar cannot emit one that does not exist.
    spec = await granite.fill<Spec>(
      [
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content: [
            `Table: ${table}`,
            cols.numeric.length ? `Numeric columns: ${cols.numeric.join(', ')}` : '',
            cols.text.length ? `Text columns: ${cols.text.join(', ')}` : '',
            '',
            `Question: ${question}`,
          ]
            .filter(Boolean)
            .join('\n'),
        },
      ],
      {
        type: 'object',
        properties: {
          metric: { type: 'string', enum: ['count', 'avg', 'sum', 'max', 'min'] },
          column: { type: 'string', enum: cols.numeric.length ? cols.numeric : [''] },
          groupBy: { type: 'string', enum: ['', ...cols.text, ...cols.numeric].slice(0, 40) },
          filterColumn: { type: 'string', enum: ['', ...cols.text].slice(0, 40) },
          filterContains: { type: 'string' },
        },
        required: ['metric'],
      },
      { maxTokens: 120 },
    )
  } catch (err) {
    console.warn('clickhouse: could not read the question', err)
    return null
  }

  const checked = build(table, spec, cols)
  if (!checked.ok) {
    console.warn(`clickhouse: refused a query — ${checked.why}`)
    return null
  }

  const res = await net(`${ENDPOINT}&query=${encodeURIComponent(checked.sql)}`)
  if (!res.ok || !res.body) return null

  try {
    const parsed = JSON.parse(res.body) as { data?: Record<string, unknown>[] }
    const rows = (parsed.data ?? []).slice(0, MAX_ROWS)
    if (!rows.length) return null

    // A row is not an answer. Asked for the average taxi tip the model wrote a
    // WHERE clause filtering New York out of a table that is entirely New York,
    // and ClickHouse dutifully returned one row reading `{average_tip: null}` —
    // which passed a length check and would have been rendered as a fact. An
    // aggregate over nothing is the shape a wrong query takes here, so the
    // emptiness has to be looked for inside the row rather than around it.
    const empty = rows.every((row) =>
      Object.values(row).every((v) => v === null || v === '' || v === undefined),
    )
    if (empty) return null

    return { sql: checked.sql, rows, table }
  } catch {
    // ClickHouse answers an error as plain text, not JSON. That is a failed
    // query, which is a fall-through rather than a fault.
    return null
  }
}
