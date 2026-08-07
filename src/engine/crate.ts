/**
 * The record box.
 *
 * `dj.ts` synthesises everything it plays, which is why it can never be wrong
 * and never be surprising. A crate is the other half: real recordings, found by
 * subject, licensed so they can actually be used, analysed well enough that
 * code can decide where they go.
 *
 * Openverse is the right index for this for exactly the reason it was the right
 * one for pictures — every hit carries a creator, a licence and a landing page,
 * so a set assembled out of it can say where each sound came from. That is not
 * a nicety. A set built from CC audio that cannot name its sources is a set
 * that cannot be published, played to anyone, or defended.
 *
 * ── CORS, which was the thing most likely to sink this ─────────────────────
 *
 * qi is cross-origin isolated: `Cross-Origin-Opener-Policy: same-origin` and
 * `Cross-Origin-Embedder-Policy: require-corp`, because the wasm sandbox needs
 * a SharedArrayBuffer. Under `require-corp` the browser refuses any subresource
 * that has not opted in, and `dj.ts` already has a scar from this — the drum
 * kit had to be moved to jsdelivr because that is the host which sends
 * `Cross-Origin-Resource-Policy: cross-origin`.
 *
 * An Openverse audio result is a URL on somebody else's CDN, so the same
 * question had to be asked again before a line of this was written. It was
 * measured inside the running app rather than reasoned about, and the answer is
 * better than the drum-kit case:
 *
 *   cdn.freesound.org           200, 1682889 bytes, decoded 69.75 s
 *   prod-1.storage.jamendo.com  200, 7311175 bytes, decoded 281.22 s
 *   upload.wikimedia.org        200,   16175 bytes, decoded  1.30 s
 *
 * All three worked. None of them sends CORP. The rule that matters is the one
 * that is easy to misread: **CORP is only required for a `no-cors` request.** A
 * plain `fetch(url)` is a CORS request, and a CORS request that succeeds
 * satisfies `require-corp` on its own. Every provider above sends
 * `access-control-allow-origin: *`, so all of them are directly readable and
 * nothing needs to go through the host's `/net/fetch` bridge.
 *
 * Which is fortunate, because that bridge could not have carried them anyway:
 * it UTF-8-decodes the response into a string (`tools/net.ts`, `NetResult.body`),
 * which destroys binary. If a provider ever does appear that refuses CORS, the
 * fix is a byte channel on the bridge — base64 or a second route — not anything
 * in this file. Until then a candidate whose bytes will not load is *dropped*,
 * with the reason recorded, rather than silently half-registered.
 *
 * ── Bandwidth, which was the thing that actually hurt ──────────────────────
 *
 * Measured from here, freesound's CDN gives about 80 KB/s: 1.6 MB took 21.8
 * seconds in the page and 21.7 from curl, so it is the network and not the
 * runtime. Downloading four candidates whole would be a minute and a half
 * before the set starts, which is not a feature anybody wants.
 *
 * Two measurements make that survivable. Range requests are honoured — 206
 * with `content-range`, and the CORS headers survive the ranged request. And a
 * *truncated* MP3 still decodes: 400 000 bytes of that file decoded to 16.86 s
 * of audio, 800 000 bytes to 33.21 s. So the crate asks for a prefix and stops.
 * Sixteen seconds is more than the tempo estimator needs and more than a set is
 * going to play of any one sample, and a slice of a long recording is what
 * anybody using a long recording was going to take anyway.
 */
import { samples } from '@strudel/webaudio'
import { getAudioContext } from 'superdough'
import { analyse, saidTempo, type Analysis } from './analyse'

/**
 * How many bytes of any one file to pull.
 *
 * 600 KB is about 25 s of a 128 kbps MP3 and about 7 s of a 44.1 kHz WAV, and
 * at the measured 80 KB/s it is a 7-second wait. Raising it buys analysis
 * accuracy that was already sufficient and costs the one thing the command has
 * none of, which is patience.
 */
const MAX_BYTES = 600_000

/** Openverse's own cap is 20 per page; four is what a person can be offered. */
const SHORTLIST = 4

export type Sound = {
  /** Openverse's id, and the crate's key. */
  id: string
  /** What it is called in a pattern: `s("crate0")`. */
  name: string
  title: string
  creator: string
  /** Short code as Openverse gives it: `cc0`, `by`, `by-sa`, `by-nc`… */
  license: string
  licenseUrl: string
  /** The direct audio file, as Openverse gave it. What a credit points at. */
  url: string
  /**
   * The same bytes, same-origin, which is what actually plays.
   *
   * Kept separately from `url` because these two are not interchangeable and
   * confusing them is a real bug rather than a theoretical one: the first
   * version of `emptyCrate` revoked `url`, which is a remote https address and
   * therefore a no-op, so every set leaked its whole crate.
   */
  blobUrl: string
  /** The page a human should be sent to for the original. */
  landing: string
  provider: string
  /** Openverse's ready-made credit line. Never rewritten, only shown. */
  attribution: string
  /** Seconds of audio actually held, which is not the original's length. */
  seconds: number
  /** True when only a prefix of the file was fetched. */
  clipped: boolean
  analysis: Analysis
}

/** What was found and analysed this session, by Openverse id. */
const crate = new Map<string, Sound>()
/** Ids that failed, with why, so the same dead URL is not retried all set. */
const refused = new Map<string, string>()
/** Names are handed out in order, so a pattern string is stable to read. */
let minted = 0

export const inCrate = (): Sound[] => [...crate.values()]
export const soundNamed = (name: string): Sound | undefined =>
  [...crate.values()].find((s) => s.name === name)

/**
 * Every credit for everything currently in the crate.
 *
 * One line per sound, in Openverse's own words. This exists so that "say where
 * each sound came from" is one call rather than a thing each caller assembles
 * slightly differently and eventually gets wrong.
 */
export const credits = (): string[] => inCrate().map((s) => s.attribution)

type Hit = {
  id?: string
  title?: string
  creator?: string
  license?: string
  license_url?: string
  url?: string
  foreign_landing_url?: string
  provider?: string
  attribution?: string
  /** Milliseconds, when the provider bothered to say. */
  duration?: number
  filesize?: number
  filetype?: string
  tags?: { name?: string }[]
}

/**
 * Ask Openverse, widening until something comes back.
 *
 * The same failure the image source records applies here and is if anything
 * sharper: Openverse ANDs every term, so a natural request — "something like
 * rain on a window at 3am" — matches nothing at all, and a source that returns
 * nothing is indistinguishable from a source that is broken. The query is tried
 * whole, then progressively shortened, and the first attempt that returns
 * anything wins.
 *
 * `length=shortest` is asked for first and then given up, because a short file
 * is both a better sample and a faster download, but "there are no short ones"
 * must not mean "there are none".
 */
async function ask(subject: string, extra: string): Promise<Hit[]> {
  const words = subject.split(/\s+/).filter(Boolean)
  const queries = [words, words.slice(0, 3), words.slice(0, 2), words.slice(0, 1)]
    .map((w) => w.join(' '))
    .filter((q, i, all) => q && all.indexOf(q) === i)

  for (const q of queries) {
    for (const length of ['&length=shortest', '']) {
      const url =
        `https://api.openverse.org/v1/audio/?q=${encodeURIComponent(q)}` +
        `&page_size=12&mature=false&license_type=commercial,modification${length}${extra}`
      const body = await fetch(url)
        .then((r) => (r.ok ? (r.json() as Promise<{ results?: Hit[] }>) : null))
        .catch(() => null)
      if (body?.results?.length) return body.results
    }
  }
  return []
}

/**
 * Formats the browser will decode, and formats it will not.
 *
 * Openverse indexes `mp3`, `mp32` (Jamendo's name for an MP3), `ogg`, `oga`,
 * `wav`, `flac` and a long tail of things WebKit has never heard of. Filtering
 * here rather than discovering it at `decodeAudioData` means a bad candidate
 * costs nothing instead of costing a download.
 */
const PLAYABLE = /^(mp3|mp32|mpeg|ogg|oga|opus|wav|wave|flac|m4a|aac|mp4)$/i

/**
 * Order candidates before spending any bandwidth on them.
 *
 * Everything here is known from the search response, so the sort is free. Short
 * beats long because a short file is a faster download and a better sample.
 * Small beats large for the same reason twice over. A file with no declared
 * size sinks, because an unknown size is how a 40 MB FLAC gets to the front.
 */
function worth(h: Hit): number {
  const seconds = (h.duration ?? 0) / 1000
  const bytes = h.filesize ?? 0
  let score = 0
  // 3–30 s is the band a sample lives in: long enough for a tempo to exist,
  // short enough to be a sample rather than a track.
  if (seconds >= 3 && seconds <= 30) score += 3
  else if (seconds > 30 && seconds <= 120) score += 1
  else if (seconds && seconds < 3) score -= 1
  if (bytes && bytes <= MAX_BYTES) score += 2
  else if (bytes && bytes <= MAX_BYTES * 4) score += 1
  else if (!bytes) score -= 1
  // CC0 needs no attribution to be legal, though it gets one anyway.
  if (h.license === 'cc0' || h.license === 'pdm') score += 1
  return score
}

/**
 * Fetch a bounded prefix and hand back both the raw bytes and a decoded buffer.
 *
 * One download for two jobs, which is the entire reason this is not two
 * functions. The bytes become a `blob:` URL that superdough loads as a sample;
 * the decoded buffer is what the analysis reads. Fetching twice — once for the
 * analysis and once again when the sampler wants it — would double a wait that
 * is already the slowest thing in the command.
 *
 * The `blob:` URL is also the belt to the CORS braces. It is same-origin by
 * construction, so nothing about cross-origin isolation applies to it, and the
 * sampler's own `fetch` inside superdough cannot fail for a reason this file
 * has not already checked for.
 */
async function bytes(url: string, mime: string): Promise<{ blobUrl: string; buf: AudioBuffer; clipped: boolean }> {
  const res = await fetch(url, { headers: { Range: `bytes=0-${MAX_BYTES - 1}` } })
  if (!res.ok) throw new Error(`http ${res.status}`)
  const raw = await res.arrayBuffer()
  if (!raw.byteLength) throw new Error('no bytes')

  // 206 means the server honoured the range and there is more file than this.
  // 200 means it ignored it and sent everything, which is also fine — the
  // difference only matters for whether we are allowed to call this the
  // whole recording.
  const clipped = res.status === 206 && raw.byteLength >= MAX_BYTES

  const ctx = getAudioContext()
  // `slice(0)` because `decodeAudioData` detaches the buffer it is given, and
  // the same bytes are still needed for the Blob.
  const buf = await ctx.decodeAudioData(raw.slice(0))
  const blobUrl = URL.createObjectURL(new Blob([raw], { type: mime }))
  return { blobUrl, buf, clipped }
}

const MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  mp32: 'audio/mpeg',
  mpeg: 'audio/mpeg',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  wave: 'audio/wav',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  mp4: 'audio/mp4',
}

/**
 * Download one candidate, analyse it, and register it as a playable sound.
 *
 * Registration is the part with a trap in it. superdough keeps one map from
 * name to voice, and the synthesised kit — `sawtooth`, `triangle`, `white`,
 * `sbd` — lives in the same map as anything `samples()` adds. A crate sound
 * registered as `bd` would replace the drum machine's kick for the rest of the
 * session and there would be no error, only a set that had quietly stopped
 * sounding like itself. So names are minted, never taken from the title:
 * `crate0`, `crate1`, and nothing that could ever collide with a voice
 * somebody else registered.
 */
async function bring(hit: Hit): Promise<Sound | null> {
  const id = String(hit.id ?? '')
  const url = String(hit.url ?? '')
  if (!id || !url) return null
  if (crate.has(id)) return crate.get(id)!
  if (refused.has(id)) return null

  const kind = String(hit.filetype ?? 'mp3').toLowerCase()
  try {
    const { blobUrl, buf, clipped } = await bytes(url, MIME[kind] ?? 'audio/mpeg')
    const name = `crate${minted++}`
    // The base URL is '' rather than absent: `samples()` concatenates it onto
    // every entry, and a `blob:` URL with anything in front of it is not a URL.
    await samples({ [name]: [blobUrl] }, '')

    const sound: Sound = {
      id,
      name,
      title: String(hit.title ?? 'untitled'),
      creator: String(hit.creator ?? 'unknown'),
      license: String(hit.license ?? '').toLowerCase(),
      licenseUrl: String(hit.license_url ?? ''),
      url,
      blobUrl,
      landing: String(hit.foreign_landing_url ?? ''),
      provider: String(hit.provider ?? 'openverse'),
      attribution: String(
        hit.attribution ??
          `"${hit.title ?? 'untitled'}" by ${hit.creator ?? 'unknown'} — ${String(hit.license ?? '').toUpperCase()}`,
      ),
      seconds: +buf.duration.toFixed(2),
      clipped,
      analysis: analyse(buf),
    }
    crate.set(id, sound)
    return sound
  } catch (err) {
    // Recorded rather than thrown. One unreachable file must not take out a
    // search that found three good ones, and the reason is worth keeping
    // because "which provider stopped sending CORS" is exactly the question
    // this file will be asked in a year.
    refused.set(id, String(err))
    console.warn(`crate: ${hit.title ?? id} would not load —`, err)
    return null
  }
}

export type FindOptions = {
  /** A tempo to prefer, if the caller has one. Candidates are ranked, not filtered. */
  bpm?: number
  /** Free words appended to the query — 'dark', 'acoustic', 'field recording'. */
  mood?: string
  /** How many to actually download. Each one costs seconds. */
  take?: number
}

/**
 * Find sounds for a subject, analysed and ready to play.
 *
 * Candidates are downloaded **in sequence**, not in parallel, and that is a
 * decision rather than an oversight: four simultaneous requests over an 80 KB/s
 * link finish at the same time as four sequential ones and all of them finish
 * late, whereas in sequence the first usable sample is available in about seven
 * seconds and the caller can start on it.
 */
export async function findSound(subject: string, opts: FindOptions = {}): Promise<Sound[]> {
  const query = [subject, opts.mood].filter(Boolean).join(' ').trim()
  if (!query) return []

  const hits = (await ask(query, ''))
    .filter((h) => h.url && h.id && PLAYABLE.test(String(h.filetype ?? '')))
    .sort((a, b) => worth(b) - worth(a))

  const want = Math.max(1, Math.min(SHORTLIST, opts.take ?? 3))
  const out: Sound[] = []
  for (const hit of hits) {
    if (out.length >= want) break
    const sound = await bring(hit)
    if (sound) out.push(sound)
  }

  /**
   * Re-ranked after analysis, because before it there was nothing to rank on.
   *
   * A tempo request can only be honoured once the tempo is known, and it is
   * honoured softly: a sound whose BPM is half or double the target is nearly
   * as useful as one that matches, since a sampler can play it at twice the
   * rate. Confidence is part of the sort so that a sound with a *believable*
   * 124 outranks one with a wild guess of 120.
   */
  if (opts.bpm) {
    const distance = (s: Sound) => {
      if (!s.analysis.bpm) return 99
      const ratios = [1, 2, 0.5]
      return Math.min(...ratios.map((r) => Math.abs(s.analysis.bpm! * r - opts.bpm!) / opts.bpm!))
    }
    out.sort((a, b) => distance(a) - distance(b) || b.analysis.confidence - a.analysis.confidence)
  }
  return out
}

/**
 * One line a language model can read about a sound.
 *
 * Deliberately prose and deliberately short. Nothing downstream of this ever
 * sees a response body, an array of section objects or a floating-point RMS —
 * the same contract `ground.ts` holds for facts, for the same reason: a 3B
 * model reasons about one sentence and drowns in a record.
 */
export function said(s: Sound): string {
  const a = s.analysis
  const parts = [`${s.name}: "${s.title}" by ${s.creator}`, `${Math.round(s.seconds)}s`, saidTempo(a)]
  if (a.pitchName) parts.push(`around ${a.pitchName}`)
  const drop = a.sections.find((x) => x.role === 'drop')
  if (drop) parts.push(`loudest from ${Math.round(drop.from)}s`)
  else if (a.sections.some((x) => x.role === 'intro')) parts.push('starts quiet')
  return `${parts.join(', ')} (${s.license.toUpperCase()})`
}

/**
 * The one tool Granite is given for this.
 *
 * Shaped exactly like the verbs in `agent/tools.ts`, and offered exactly the
 * way `ground/sources.ts` offers its sources: **one at a time**. That file
 * records the measurement this obeys — given nine tools a small model collapses
 * to a single choice for everything, given two it still mis-selects, given one
 * it extracts the argument correctly six times in eight. So this is not added
 * to `CORE_VERBS`, where it would be a fourth option competing with `look`,
 * `recall` and `open` and would degrade all three. It is handed to the model
 * alone, inside the one command that has already decided sound is what is
 * wanted.
 *
 * Note what the model is *not* asked for. Not a URL, not a filename, not a
 * sample rate, not a gain — three words describing a sound, and optionally a
 * tempo. Everything else is measured or chosen by code.
 */
export const FIND_SOUND = {
  type: 'function' as const,
  function: {
    name: 'find_sound',
    description:
      'Find a real recording to use in the set: a drum loop, a chord, a field recording, an instrument. ' +
      'Use once, for the sound the set is built around. Do not use for the drums, which are synthesised.',
    parameters: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'What the sound is, in one to three words.' },
        bpm: { type: 'number', description: 'Preferred tempo, if the set has one.' },
        mood: { type: 'string', description: 'One word: dark, bright, soft, harsh, warm.' },
      },
      required: ['subject'],
    },
  },
}

/** Run the tool call. Returns prose for the model, and the sounds for the code. */
export async function runFindSound(
  args: Record<string, unknown>,
): Promise<{ work: string; empty?: boolean; sounds: Sound[] }> {
  const subject = String(args.subject ?? '').trim()
  if (!subject) return { work: 'no subject given', empty: true, sounds: [] }
  const bpm = Number(args.bpm)
  const sounds = await findSound(subject, {
    bpm: Number.isFinite(bpm) && bpm >= 40 && bpm <= 220 ? bpm : undefined,
    mood: typeof args.mood === 'string' ? args.mood : undefined,
  })
  if (!sounds.length) {
    return { work: `No usable recording of "${subject}".`, empty: true, sounds: [] }
  }
  return { work: `Found for "${subject}": ${sounds.map(said).join('; ')}.`, sounds }
}

/** Forget everything, releasing the object URLs. Called when a set stops. */
export function emptyCrate(): void {
  for (const s of crate.values()) {
    // The blob is held by superdough's own cache too, so this only drops our
    // reference — but not dropping it leaks the whole file for the session.
    try {
      URL.revokeObjectURL(s.blobUrl)
    } catch {
      /* already gone */
    }
  }
  crate.clear()
  refused.clear()
}
