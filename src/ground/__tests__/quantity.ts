/**
 * Quantities as data: formatting, staleness, and — the point of the exercise —
 * re-deriving a displayed number from a freshly fetched response.
 */
import { age, at, format, verify } from '../quantity'
import type { Quantity } from '../sandbox'

let failures = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}${name}${detail ? '  ' + detail : ''}`)
}

console.log('\n── format: precision comes from the source, not from taste')
{
  const q = (o: Partial<Quantity>): Quantity => ({ n: 0, path: 'x', raw: 0, ...o })
  check('celsius', format(q({ n: 25.7, unit: 'celsius', precision: 0 })) === '26°C',
        format(q({ n: 25.7, unit: 'celsius', precision: 0 })))
  check('usd thousands', format(q({ n: 64317.42, unit: 'usd', precision: 0 })) === '$64,317',
        format(q({ n: 64317.42, unit: 'usd', precision: 0 })))
  check('fx 4dp', format(q({ n: 0.86123, unit: 'eur', precision: 4 })) === '€0.8612',
        format(q({ n: 0.86123, unit: 'eur', precision: 4 })))
  check('km/h', format(q({ n: 27540.3, unit: 'km/h', precision: 0 })) === '27,540 km/h',
        format(q({ n: 27540.3, unit: 'km/h', precision: 0 })))
  check('unknown unit degrades', format(q({ n: 12.34 })) === '12.3', format(q({ n: 12.34 })))
}

console.log('\n── age: staleness stated, not implied')
{
  const now = Date.parse('2026-08-04T12:00:00Z')
  const q = (iso?: string): Quantity => ({ n: 1, path: 'x', raw: 1, asOf: iso })
  // Intl.RelativeTimeFormat phrasing, not a hand-rolled abbreviation.
  check('minutes', age(q('2026-08-04T11:57:00Z'), now) === '3 minutes ago',
        String(age(q('2026-08-04T11:57:00Z'), now)))
  check('hours', age(q('2026-08-04T08:00:00Z'), now) === '4 hours ago',
        String(age(q('2026-08-04T08:00:00Z'), now)))
  check('days', age(q('2026-08-01T12:00:00Z'), now) === '3 days ago',
        String(age(q('2026-08-01T12:00:00Z'), now)))
  check('clock skew is not "in 4 seconds"', age(q('2026-08-04T12:00:04Z'), now) === 'now',
        String(age(q('2026-08-04T12:00:04Z'), now)))
  check('no timestamp -> null', age(q(undefined), now) === null)
}

console.log('\n── at: dotted paths, including array indices')
{
  const body = { wx: { current: { temperature_2m: 25.7 } }, rates: { EUR: 0.86 }, list: [{ v: 9 }] }
  check('nested', at(body, 'wx.current.temperature_2m') === 25.7)
  check('array index', at(body, 'list.0.v') === 9)
  check('missing -> undefined', at(body, 'wx.nope.deep') === undefined)
}

console.log('\n── verify: re-derive the claim from a fresh body')
{
  const q: Quantity = {
    n: 25.7, unit: 'celsius', precision: 0,
    path: 'wx.current.temperature_2m', raw: 25.7,
  }
  const same = verify(q, { wx: { current: { temperature_2m: 25.7 } } })
  check('exact match passes', same.ok, `drift ${same.drift}`)

  const moved = verify(q, { wx: { current: { temperature_2m: 25.9 } } }, 0.5)
  check('within tolerance passes', moved.ok, `drift ${moved.drift?.toFixed(2)}`)

  const wrong = verify(q, { wx: { current: { temperature_2m: 40 } } }, 0.5)
  check('beyond tolerance fails', !wrong.ok, `drift ${wrong.drift?.toFixed(2)}`)

  const gone = verify(q, { wx: { current: {} } })
  check('missing field fails loudly', !gone.ok, gone.reason ?? '')

  const nonNumeric = verify(q, { wx: { current: { temperature_2m: 'warm' } } })
  check('non-numeric fails', !nonNumeric.ok, nonNumeric.reason ?? '')
}

console.log('\n── end to end: a live claim, re-fetched and checked')
{
  const url =
    'https://api.open-meteo.com/v1/forecast?latitude=44.0582&longitude=-121.3153' +
    '&current=temperature_2m,wind_speed_10m'
  const first: any = await (await fetch(url)).json()
  const claim: Quantity = {
    n: first.current.temperature_2m,
    unit: 'celsius',
    precision: 0,
    asOf: first.current.time,
    path: 'current.temperature_2m',
    raw: first.current.temperature_2m,
  }
  console.log(`  claimed on screen: ${format(claim)}  (${age(claim) ?? 'no timestamp'})`)

  const second: any = await (await fetch(url)).json()
  const result = verify(claim, second, 2)
  check('live claim verifies against a re-fetch', result.ok,
        `claimed ${result.claimed} found ${result.found} drift ${result.drift}`)

  // The same claim must fail against the wrong field — proof the path is real
  // and not just decoration.
  const bogus = verify({ ...claim, path: 'current.wind_speed_10m' }, second, 0.01)
  check('wrong path is detected', !bogus.ok,
        `claimed ${bogus.claimed} found ${bogus.found}`)
}

console.log(`\n${failures === 0 ? 'all quantity checks passed' : `${failures} FAILED`}`)
process.exit(failures ? 1 : 0)
