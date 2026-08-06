/**
 * Did the value actually occur in the response?
 *
 * This is the cheapest gate on the API path and the one that carries the most
 * weight, so it is tested as pure code against fixed bodies: no model, no
 * network, no embeddings, nothing that can drift between runs. Every case here
 * is a real failure shape observed or reachable on the generic reducer —
 * a paraphrase, a rounding, a number lifted out of an identifier, a value
 * invented wholesale — and each one has to be rejected by arithmetic rather
 * than by asking a model to mark its own work.
 */
import { leafOccurs, leaves, pathWords } from '../operations'

/** A weather response, the shape the reducer was designed against. */
const WEATHER = {
  coord: { lon: 10.75, lat: 59.91 },
  weather: [{ id: 803, main: 'Clouds', description: 'broken clouds' }],
  main: { temp: 11.3, feels_like: 10.1, pressure: 1013, humidity: 76 },
  wind: { speed: 4.63, deg: 210 },
  name: 'Oslo',
  id: 3143244,
}

/** A record whose only numbers are identifiers — the substring trap. */
const RECORD = {
  data: [{ id: 'user-11342', ref: 'AB-1130', count: 7, city: 'Bend', region: 'Oregon' }],
  meta: { page: 1, total: 1130 },
}

/** A population response with formatted and unformatted forms of one number. */
const POP = {
  results: [{ name: 'Bend', population: 102059, formatted: '102,059', country: 'US' }],
}

type Case = [name: string, body: unknown, value: string, want: boolean]

const CASES: Case[] = [
  // ── real leaves, accepted ────────────────────────────────────────────────
  ['number leaf, exact', WEATHER, '11.3', true],
  ['number leaf with unit appended', WEATHER, '11.3 °C', true],
  ['number leaf, unit no space', WEATHER, '11.3°C', true],
  ['number leaf, trailing zero', WEATHER, '11.30', true],
  ['string leaf, exact', WEATHER, 'Oslo', true],
  ['string leaf, different case', WEATHER, 'oslo', true],
  ['string leaf, surrounding space', WEATHER, '  broken clouds  ', true],
  ['integer leaf', WEATHER, '1013', true],
  ['nested array leaf', WEATHER, 'Clouds', true],
  ['thousands separator against a bare integer', POP, '102,059', true],
  ['bare integer against a separated string leaf', POP, '102059', true],
  ['leaf that is itself a formatted string', POP, '102,059', true],

  // ── paraphrase, rejected ─────────────────────────────────────────────────
  ['paraphrase of a number', WEATHER, 'about 11 degrees', false],
  ['paraphrase of a string', WEATHER, 'mostly cloudy', false],
  ['prose restating the value', WEATHER, 'it is 11.3 degrees in Oslo right now', false],

  // ── rounded and near-miss numbers, rejected ──────────────────────────────
  ['rounded down', WEATHER, '11', false],
  ['rounded up', WEATHER, '12', false],
  ['plausible neighbour', WEATHER, '11.4', false],
  ['right digits, wrong scale', WEATHER, '113', false],

  // ── invented, rejected ───────────────────────────────────────────────────
  ['invented number', WEATHER, '27', false],
  ['invented string', WEATHER, 'Bergen', false],
  ['empty value', WEATHER, '', false],
  ['whitespace only', WEATHER, '   ', false],

  // ── the substring trap: digits that appear only inside a longer leaf ─────
  ['digits from inside an identifier', RECORD, '11342', false],
  ['digits from inside a reference code', RECORD, '1130', true], // meta.total really is 1130
  ['partial identifier', RECORD, '113', false],
  ['a real leaf in the same body', RECORD, 'Bend', true],
  ['a plausible sibling that is not there', RECORD, 'Portland', false],

  // ── unit handling ────────────────────────────────────────────────────────
  //
  // `76 km` is accepted, and that is the honest boundary of this gate rather
  // than a hole in it. 76 really is a leaf of the body — it is the humidity —
  // so the claim "this value occurs in the response" is true. What is wrong
  // with `76 km` is the *unit*, and no amount of looking at the body can say
  // so: units are not in the response, they are in the meaning of the field.
  //
  // That is the second gate's job. `main.humidity` scored against "how far is
  // it" is what rejects this, and the quantity check is what rejects a name
  // offered where a number was asked for. A gate that tried to do all three
  // would do none of them well, and would have to guess.
  ['a number under the wrong key is still an occurrence', WEATHER, '76 km', true],
  ['a unit alone is not a value', WEATHER, '°C', false],
]

let pass = 0
console.log(`${'case'.padEnd(46)}${'value'.padEnd(34)}want  got`)
console.log('-'.repeat(92))

for (const [name, body, value, want] of CASES) {
  const got = leafOccurs(body, value)
  const ok = got === want
  pass += Number(ok)
  console.log(
    `${ok ? 'OK  ' : 'BAD '}${name.slice(0, 42).padEnd(42)}${JSON.stringify(value).slice(0, 32).padEnd(34)}${String(want).padEnd(6)}${got}`,
  )
}

// `leaves` is the other half of the contract: if it misses a field, the gate
// rejects a value that really was in the response.
const found = leaves(WEATHER)
const expectLeaves: [string, boolean][] = [
  ['11.3', found.includes('11.3')],
  ['Oslo', found.includes('Oslo')],
  ['broken clouds', found.includes('broken clouds')],
  ['nested in an array', found.includes('803')],
  ['deeply nested', found.includes('59.91')],
]
console.log('')
for (const [what, ok] of expectLeaves) {
  pass += Number(ok)
  console.log(`${ok ? 'OK  ' : 'BAD '}leaves() finds ${what}`)
}

// Path words feed the second gate; a path that collapses to nothing would score
// zero against every question and silently reject everything.
const paths: [string, string][] = [
  ['main.temp', 'main temp'],
  ['data.0.id', 'data id'],
  ['results[2].population_total', 'results population total'],
  ['currentWeather.windSpeed', 'current Weather wind Speed'],
]
console.log('')
for (const [input, want] of paths) {
  const got = pathWords(input)
  const ok = got === want
  pass += Number(ok)
  console.log(`${ok ? 'OK  ' : 'BAD '}pathWords(${input}) = ${JSON.stringify(got)}`)
}

const total = CASES.length + expectLeaves.length + paths.length
console.log(`\n${pass}/${total} leaf checks passed`)
if (pass !== total) process.exit(1)
