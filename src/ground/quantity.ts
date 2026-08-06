/**
 * Quantities as data, formatted by the platform.
 *
 * A number that reaches the screen as a pre-baked string is unverifiable: you
 * cannot re-derive it, convert it, or tell when it was true. Reducers emit
 * `Quantity` records — the raw number, its unit, where in the response it came
 * from, and when — and formatting happens here at the last possible moment.
 *
 * Formatting is `Intl`, not a hand-written table. It covers the CLDR unit list
 * (celsius, kilometer-per-hour, byte, percent…), currencies, compact notation
 * and relative time, it is locale-correct, and it costs zero bytes. A bespoke
 * `{ celsius: '°C' }` map is strictly worse and needs maintaining forever.
 *
 * The payoff is `verify()`: because a Quantity carries its own path, a claim
 * on screen can be re-fetched and checked against the live source.
 */
import type { Quantity } from './sandbox'

/** Units Intl understands directly; anything else is looked up below. */
const ALIAS: Record<string, string> = {
  c: 'celsius',
  f: 'fahrenheit',
  km: 'kilometer',
  'km/h': 'kilometer-per-hour',
  m: 'meter',
  mi: 'mile',
  kg: 'kilogram',
  s: 'second',
  min: 'minute',
  h: 'hour',
}

const CURRENCY = /^[a-z]{3}$/i
const KNOWN_CURRENCIES = new Set(['usd', 'eur', 'gbp', 'jpy', 'chf', 'cad', 'aud', 'cny', 'inr', 'brl', 'sek', 'nok'])

const supported = new Map<string, boolean>()
function intlKnows(unit: string): boolean {
  const cached = supported.get(unit)
  if (cached !== undefined) return cached
  let ok = false
  try {
    new Intl.NumberFormat('en-US', { style: 'unit', unit }).format(1)
    ok = true
  } catch {
    ok = false
  }
  supported.set(unit, ok)
  return ok
}

/**
 * Render a quantity for display. Precision comes from the source, not taste;
 * `compact` is for counts large enough that every digit is noise.
 */
export function format(q: Quantity, locale = 'en-US'): string {
  const digits = q.precision ?? 1
  const base: Intl.NumberFormatOptions = {
    minimumFractionDigits: 0,
    maximumFractionDigits: Math.max(0, digits),
  }
  const raw = (q.unit ?? '').trim()
  const unit = ALIAS[raw.toLowerCase()] ?? raw

  if (unit && KNOWN_CURRENCIES.has(unit.toLowerCase())) {
    return new Intl.NumberFormat(locale, {
      ...base,
      style: 'currency',
      currency: unit.toUpperCase(),
      notation: Math.abs(q.n) >= 1e7 ? 'compact' : 'standard',
    }).format(q.n)
  }
  if (unit && CURRENCY.test(unit) && !intlKnows(unit)) {
    // An unrecognised three-letter code is far more likely a currency than a
    // unit; show the code rather than inventing a symbol.
    return `${new Intl.NumberFormat(locale, base).format(q.n)} ${unit.toUpperCase()}`
  }
  if (unit && intlKnows(unit)) {
    return new Intl.NumberFormat(locale, {
      ...base,
      style: 'unit',
      unit,
      unitDisplay: 'short',
      notation: Math.abs(q.n) >= 1e7 ? 'compact' : 'standard',
    }).format(q.n)
  }
  const n = new Intl.NumberFormat(locale, {
    ...base,
    notation: Math.abs(q.n) >= 1e7 ? 'compact' : 'standard',
  }).format(q.n)
  return unit ? `${n} ${unit}` : n
}

/**
 * Split a formatted quantity into its number and everything else.
 *
 * Colouring "26°C · 8 km/h" end to end puts a solid block of accent on the
 * page; the references colour a single word and leave the rest in ink. Using
 * `formatToParts` rather than a regex means the split follows the locale — a
 * currency symbol leads in English and trails in French, and neither needs
 * special-casing here.
 */
export function formatParts(q: Quantity, locale = 'en-US'): { number: string; rest: string } {
  const whole = format(q, locale)
  try {
    const spec = (q.unit ?? '').trim()
    const digits = q.precision ?? 1
    const opts: Intl.NumberFormatOptions = {
      minimumFractionDigits: 0,
      maximumFractionDigits: Math.max(0, digits),
    }
    const parts = new Intl.NumberFormat(locale, opts).formatToParts(q.n)
    const numeric = new Set(['integer', 'group', 'decimal', 'fraction', 'minusSign', 'plusSign'])
    const number = parts.filter((p) => numeric.has(p.type)).map((p) => p.value).join('')
    if (number && whole.includes(number)) {
      const at = whole.indexOf(number)
      return { number, rest: (whole.slice(0, at) + whole.slice(at + number.length)).trim() }
    }
  } catch {
    /* fall through */
  }
  return { number: whole, rest: '' }
}

const DIVISIONS: [number, Intl.RelativeTimeFormatUnit][] = [
  [60, 'second'],
  [60, 'minute'],
  [24, 'hour'],
  [7, 'day'],
  [4.34524, 'week'],
  [12, 'month'],
  [Infinity, 'year'],
]

/** "3 minutes ago" — staleness stated rather than left for the reader to assume. */
export function age(q: Quantity, now = Date.now(), locale = 'en-US'): string | null {
  if (!q.asOf) return null
  const then = Date.parse(q.asOf)
  if (!Number.isFinite(then)) return null
  let delta = (then - now) / 1000
  // Clocks disagree by seconds; a source is not "in 4 seconds".
  if (delta > 0 && delta < 90) delta = 0
  if (delta > 0) return null

  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  for (const [span, unit] of DIVISIONS) {
    if (Math.abs(delta) < span) return rtf.format(Math.round(delta), unit)
    delta /= span
  }
  return null
}

/** Read a dotted path out of a response body, for re-checking a claim. */
export function at(body: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc == null) return undefined
    const idx = Number(key)
    return Array.isArray(acc) && Number.isInteger(idx)
      ? acc[idx]
      : (acc as Record<string, unknown>)[key]
  }, body)
}

export type Check = {
  ok: boolean
  claimed: number
  found: unknown
  drift?: number
  reason?: string
}

/**
 * Re-derive a displayed number from a freshly fetched body.
 *
 * `tolerance` exists because live sources move: a temperature checked a minute
 * later is legitimately different. A mismatch beyond it means the claim was
 * wrong, the path was wrong, or the source changed shape — all worth knowing.
 */
export function verify(q: Quantity, body: unknown, tolerance = 0): Check {
  const found = at(body, q.path)
  if (found == null) return { ok: false, claimed: q.n, found, reason: `no value at ${q.path}` }
  const n = typeof found === 'number' ? found : Number(found)
  if (!Number.isFinite(n)) return { ok: false, claimed: q.n, found, reason: 'not numeric' }
  const drift = Math.abs(n - q.n)
  const allowed = tolerance || Math.max(Math.abs(q.n) * 0.001, 1e-9)
  return { ok: drift <= allowed, claimed: q.n, found: n, drift }
}
