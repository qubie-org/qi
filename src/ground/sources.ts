/**
 * Grounded sources.
 *
 * Discovered through public-apis, then verified by tools/probe_endpoints.py —
 * every one below answered a real cross-origin GET with no key. The README's
 * CORS column is self-reported and often wrong, so nothing goes in here that
 * has not actually been called.
 *
 * `fetch` runs on the host (it needs the network). `reducer` runs in the
 * QuickJS sandbox and is the only thing that touches the response body.
 */

export type Source = {
  id: string
  /** Phrases that should route here; matched by embedding, not keywords. */
  anchors: string[]
  /** Pulls the argument out of the user's sentence. */
  arg?: (text: string) => string
  fetch: (arg: string) => Promise<unknown>
  /** Body of `reduce(data)`, executed in the sandbox. Must return a Fact. */
  reducer: string
}

const json = async (url: string, headers?: Record<string, string>) => {
  const r = await fetch(url, headers ? { headers } : undefined)
  if (!r.ok) throw new Error(`${url} -> ${r.status}`)
  return r.json()
}

/**
 * Wikimedia rate-limits anonymous clients hard — a couple of quick requests
 * earns a 429. They ask for an identifying User-Agent, which browsers refuse
 * to let scripts set, so their documented substitute is `Api-User-Agent`.
 */
const WIKI_HEADERS = { 'Api-User-Agent': 'toki/0.1 (https://github.com/shinyobjectz/toki)' }

/**
 * needle's view of a source — deliberately ONE tool at a time.
 *
 * Measured on the int8 graphs: given all nine tools, base needle collapses to
 * a single choice for every query; given two, it still mis-selects (`what is
 * the moon` -> get_weather). Given exactly one, it extracts the argument
 * correctly 6/8. Its own card agrees — 27.5% exact match, 32% argument
 * accuracy — and the pi fine-tune only reached 80% by training on its own
 * four tools.
 *
 * So selection belongs to the embedding router, which is accurate and free,
 * and needle does the one thing it is genuinely good at: copying the argument
 * out of the sentence. Names follow glaive convention (`get_weather`, not
 * `weather`) because that is the distribution it was trained on.
 */
const TOOL_DESCRIPTIONS: Record<string, { name: string; description: string; param: [string, string] }> = {
  wiki: {
    name: 'search_encyclopedia',
    description: 'Look up a topic in an encyclopedia.',
    param: ['topic', 'the subject to look up'],
  },
  weather: {
    name: 'get_weather',
    description: 'Get the current weather for a location.',
    param: ['location', 'the city name'],
  },
  crypto: {
    name: 'get_crypto_price',
    description: 'Get the price of a cryptocurrency.',
    param: ['coin', 'the coin name'],
  },
  fx: {
    name: 'get_exchange_rate',
    description: 'Get a currency exchange rate.',
    param: ['currency', 'the three letter currency code'],
  },
  image: {
    name: 'search_images',
    description: 'Find a photograph of something.',
    param: ['subject', 'what the photo should show'],
  },
  art: {
    name: 'search_artwork',
    description: 'Find a painting by subject.',
    param: ['subject', 'what the artwork shows'],
  },
}

/** Sources with no argument to extract — needle is skipped for these. */
export const NO_ARG = new Set(['iss', 'catfact', 'dog', 'joke'])

/** A one-tool schema for the source the router already picked. */
export function toolJson(id: string): string | null {
  const t = TOOL_DESCRIPTIONS[id]
  if (!t) return null
  return JSON.stringify([
    {
      name: t.name,
      description: t.description,
      parameters: { [t.param[0]]: { type: 'string', description: t.param[1] } },
    },
  ])
}

/** Strip the question scaffolding, keep the thing being asked about. */
const topic = (t: string) =>
  t
    .replace(/^\s*(what|who|where|when|why|how)\s+(is|are|was|were|does|do|did)\s+/i, '')
    .replace(/^\s*(tell me about|explain|describe|define)\s+/i, '')
    .replace(/[?.!,]+\s*$/g, '')
    .trim()

export const SOURCES: Source[] = [
  {
    // The backbone: a real definition plus a picture, for almost any noun.
    id: 'wiki',
    anchors: ['what is', 'who is', 'tell me about', 'explain', 'define', 'history of', 'meaning of'],
    arg: topic,
    // Direct title lookup 404s on natural phrasing more often than not, so a
    // miss falls back to search and hands the reducer a shortlist for the
    // reranker rather than guessing at the first hit.
    fetch: async (a) => {
      const summary = (title: string) =>
        json(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`, WIKI_HEADERS)
      try {
        return { direct: await summary(a) }
      } catch {
        const found: any = await json(
          `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(a)}` +
            `&srlimit=4&format=json&origin=*`,
          WIKI_HEADERS,
        )
        const titles: string[] = (found.query?.search ?? []).map((r: any) => r.title)
        // Sequential, not Promise.all: three simultaneous summary requests is
        // exactly the burst that earns a 429.
        const pages = []
        for (const title of titles.slice(0, 3)) {
          const page = await summary(title).catch(() => null)
          if (page) pages.push(page)
        }
        return { search: pages }
      }
    },
    reducer: `
      var first = function (p) {
        var s = (p.extract || '').split(/(?<=[.!?])\\s/)[0];
        return s.length > 180 ? s.slice(0, 177) + '…' : s;
      };
      if (data.direct && data.direct.extract) {
        var d = data.direct, s = first(d);
        return {
          label: d.title, value: s,
          chip: d.thumbnail && d.thumbnail.source,
          src: 'wikipedia',
          srcUrl: d.content_urls && d.content_urls.desktop && d.content_urls.desktop.page,
          hint: d.title + ': ' + s.split(/\\s+/).slice(0, 8).join(' ')
        };
      }
      var hits = (data.search || []).filter(function (p) { return p && p.extract; });
      if (!hits.length) return null;
      return {
        label: hits[0].title, value: first(hits[0]),
        chip: hits[0].thumbnail && hits[0].thumbnail.source,
        src: 'wikipedia',
        srcUrl: hits[0].content_urls && hits[0].content_urls.desktop && hits[0].content_urls.desktop.page,
        hint: hits[0].title,
        candidates: hits.map(function (p) {
          return { label: p.title, value: first(p), chip: p.thumbnail && p.thumbnail.source };
        })
      };`,
  },

  {
    id: 'weather',
    anchors: ['weather', 'temperature', 'how hot is it', 'how cold', 'forecast', 'raining'],
    arg: (t) => topic(t).replace(/^(the\s+)?weather\s+(in|at|for)\s+/i, '').trim() || 'San Francisco',
    fetch: async (a) => {
      // needle hands back natural language ("bend oregon"); the geocoder wants
      // something canonical and returns nothing for that exact string. Try
      // progressively simpler forms rather than giving up on the first miss.
      const forms = [a, a.replace(/\s+/g, ', '), a.split(/[\s,]+/)[0]].filter(
        (v, i, all) => v && all.indexOf(v) === i,
      )
      let hit: any = null
      for (const form of forms) {
        const geo: any = await json(
          `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(form)}&count=1`,
        )
        hit = geo.results?.[0]
        if (hit) break
      }
      if (!hit) throw new Error(`no such place: ${a}`)
      const wx = await json(
        `https://api.open-meteo.com/v1/forecast?latitude=${hit.latitude}&longitude=${hit.longitude}` +
          `&current=temperature_2m,wind_speed_10m`,
      )
      return { place: hit.name, country: hit.country, wx }
    },
    reducer: `
      var c = data.wx && data.wx.current;
      if (!c || typeof c.temperature_2m !== 'number') return null;
      // open-meteo stamps "2026-08-04T20:45" with no zone and defaults to GMT.
      // Left as-is it parses as local time and staleness silently disappears.
      var t = c.time && !/[Zz+]|-\\d\\d:\\d\\d$/.test(c.time) ? c.time + 'Z' : c.time;
      return {
        label: data.place,
        value: String(c.temperature_2m),
        src: 'open-meteo',
        hint: data.place + ' ' + Math.round(c.temperature_2m) + 'C',
        quantities: [
          { n: c.temperature_2m, unit: 'celsius', precision: 0, asOf: t,
            path: 'wx.current.temperature_2m', raw: c.temperature_2m },
          { n: c.wind_speed_10m, unit: 'km/h', precision: 0, asOf: t,
            path: 'wx.current.wind_speed_10m', raw: c.wind_speed_10m }
        ]
      };`,
  },

  {
    id: 'crypto',
    anchors: ['bitcoin price', 'ethereum', 'crypto', 'how much is bitcoin', 'coin price'],
    arg: (t) => (/eth/i.test(t) ? 'ethereum' : /sol/i.test(t) ? 'solana' : 'bitcoin'),
    fetch: (a) =>
      json(`https://api.coingecko.com/api/v3/simple/price?ids=${a}&vs_currencies=usd`),
    reducer: `
      var k = Object.keys(data)[0];
      if (!k || !data[k] || typeof data[k].usd !== 'number') return null;
      var v = data[k].usd;
      return {
        label: k,
        value: String(v),
        src: 'coingecko',
        hint: k + ' $' + v,
        quantities: [{ n: v, unit: 'usd', precision: 0, path: k + '.usd', raw: v }]
      };`,
  },

  {
    id: 'fx',
    anchors: ['exchange rate', 'convert currency', 'dollars to euros', 'how many euros'],
    arg: (t) => (t.match(/\b([A-Z]{3})\b/)?.[1] ?? 'EUR'),
    fetch: (a) => json(`https://api.frankfurter.app/latest?from=USD&to=${a}`),
    reducer: `
      var k = Object.keys(data.rates || {})[0];
      if (!k || typeof data.rates[k] !== 'number') return null;
      var r = data.rates[k];
      return {
        label: 'USD to ' + k,
        value: String(r),
        src: 'frankfurter',
        hint: '1 USD = ' + r + ' ' + k,
        quantities: [{ n: r, unit: k.toLowerCase(), precision: 4, asOf: data.date,
                       path: 'rates.' + k, raw: r }]
      };`,
  },

  {
    id: 'iss',
    // Specifically the ISS's live position — not spaceflight in general.
    // "astronauts orbit" used to swallow "tell me about the apollo landing".
    anchors: ['international space station', 'iss position', 'iss overhead'],
    fetch: () => json('https://api.wheretheiss.at/v1/satellites/25544'),
    reducer: `
      if (typeof data.altitude !== 'number') return null;
      var when = data.timestamp ? new Date(data.timestamp * 1000).toISOString() : undefined;
      return {
        label: 'space station',
        value: String(data.altitude),
        src: 'wheretheiss.at',
        hint: 'ISS ' + Math.round(data.altitude) + 'km up',
        quantities: [
          { n: data.altitude, unit: 'km', precision: 0, asOf: when, path: 'altitude', raw: data.altitude },
          { n: data.velocity, unit: 'km/h', precision: 0, asOf: when, path: 'velocity', raw: data.velocity }
        ]
      };`,
  },

  {
    // General imagery. Openverse indexes CC-licensed work and returns creator
    // and licence with every hit, which is the only kind of image source that
    // can be shown without lying about where it came from.
    id: 'image',
    anchors: ['picture of', 'photo of', 'image of', 'show me what', 'what does it look like', 'photograph'],
    arg: (t) =>
      topic(t)
        .replace(/^(show me|find me)\s+/i, '')
        .replace(/^(a|an|the)\s+/i, '')
        .replace(/^(picture|photo|image|photograph)s?\s+of\s+/i, '')
        .trim(),
    fetch: (a) =>
      json(
        `https://api.openverse.org/v1/images/?q=${encodeURIComponent(a)}` +
          `&page_size=4&mature=false&license_type=commercial,modification`,
      ),
    reducer: `
      var hits = (data.results || []).filter(function (r) { return r && r.thumbnail; });
      if (!hits.length) return null;
      var name = function (r) { return r.title || r.creator || 'untitled'; };
      var credit = function (r) {
        return (r.creator ? r.creator + ' · ' : '') + (r.license || '').toUpperCase();
      };
      return {
        label: name(hits[0]),
        value: credit(hits[0]),
        chip: hits[0].thumbnail,
        chipW: hits[0].width,
        chipH: hits[0].height,
        src: 'openverse',
        srcUrl: hits[0].foreign_landing_url,
        hint: name(hits[0]),
        candidates: hits.map(function (r) {
          return { label: name(r), value: credit(r), chip: r.thumbnail,
                   chipW: r.width, chipH: r.height };
        })
      };`,
  },

  {
    id: 'art',
    anchors: ['show me art', 'painting', 'artwork', 'a picture of', 'museum'],
    arg: (t) => topic(t).replace(/^(show me|a picture of)\s+/i, '').trim() || 'blue',
    fetch: (a) =>
      json(
        `https://api.artic.edu/api/v1/artworks/search?q=${encodeURIComponent(a)}&limit=1` +
          `&fields=id,title,image_id,artist_title`,
      ),
    reducer: `
      var d = data.data && data.data[0];
      if (!d || !d.image_id) return null;
      var iiif = (data.config && data.config.iiif_url) || 'https://www.artic.edu/iiif/2';
      return {
        label: d.title,
        value: d.artist_title || 'unknown artist',
        chip: iiif + '/' + d.image_id + '/full/400,/0/default.jpg',
        src: 'art institute of chicago',
        hint: d.title
      };`,
  },

  {
    id: 'catfact',
    anchors: ['cat fact', 'tell me about cats', 'something about cats'],
    fetch: () => json('https://catfact.ninja/fact'),
    reducer: `
      if (!data.fact) return null;
      return { label: 'cats', value: data.fact, src: 'catfact.ninja', hint: 'cat fact' };`,
  },

  {
    id: 'dog',
    anchors: ['show me a dog', 'dog picture', 'puppy photo'],
    fetch: () => json('https://dog.ceo/api/breeds/image/random'),
    reducer: `
      if (!data.message) return null;
      return { label: 'a dog', value: 'here', chip: data.message, src: 'dog.ceo', hint: 'a dog' };`,
  },

  {
    id: 'joke',
    // No "make me laugh" — bag-of-words matches it against any "how to make…".
    anchors: ['joke', 'funny', 'humour', 'comedy', 'pun'],
    fetch: () => json('https://official-joke-api.appspot.com/random_joke'),
    reducer: `
      if (!data.setup) return null;
      return {
        label: 'a joke',
        value: data.setup + ' ' + data.punchline,
        src: 'official-joke-api',
        hint: 'a joke'
      };`,
  },
]
