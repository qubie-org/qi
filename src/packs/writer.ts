/**
 * The strudel pack: SmolLM2-135M finetuned to write Strudel.
 *
 * `compose.ts` has the model fill a struct — `kick`, `snare`, `hat`, `bass`,
 * `pad` — under a grammar that makes anything unplayable unexpressible. That is
 * safe, and it is also the ceiling: a struct can only ever describe the
 * arrangement it was shaped around, so asked for something that is not that
 * shape the best it can do is the nearest preset. Which is why every set came
 * out sounding like one.
 *
 * This writes the pattern instead. Measured against five prompts with sampling
 * at 0.8, it produced `voicing()`, `chord("<Dm7 Cmaj7 Gmaj7>")`,
 * `.every(3, x => x.rev())`, `.delayfeedback()` and `bank("RolandTR808")` —
 * none of which the struct has a field for — and gave "a limping seven-beat
 * thing" a genuinely seven-step kick, which is conditioning the struct route
 * never managed.
 *
 * Two things make it affordable rather than a second model to feed:
 *
 *   It is 135M, int8, 137 MB. The core is 2.1 GB.
 *   Its tokenizer is byte-level BPE, the same scheme `bpe.ts` already
 *   implements for the embedder, so nothing new is pulled in to read it.
 *
 * ── Greedy decoding is wrong here, and not subtly ────────────────────────────
 *
 * The first measurement used argmax and concluded the model was a template:
 * "a chill lofi beat" and "a limping seven-beat thing that keeps stumbling"
 * came back near-identical, same kick, same `note("<c2 c2 eb2 g1>")`, differing
 * in one `.gain()`. Every generation ended `.slow(1)`.
 *
 * That was the decoder, not the weights. Argmax on a small finetune collapses
 * onto its modal output, and the model card's own snippet uses temperature 0.8.
 * With sampling the same prompts diverge properly. So temperature is not a
 * flourish here — at zero this model has nothing to say.
 *
 * What it cannot do is stay inside the language: it invents sound names
 * (`gm_tide`, `gm_slow_tide`) and calls functions that do not exist
 * (`voicing`). That is `verify.ts`'s job, and the division is deliberate —
 * generate freely, check mechanically, exactly as the research process treats a
 * quote.
 */
import * as ort from 'onnxruntime-web'
import { BPE } from './bpe'

/** From the model's own config.json. Head dimension is hidden / heads. */
const LAYERS = 30
const KV_HEADS = 3
const HEAD_DIM = 64

const SYSTEM = 'You are a Strudel live-coding assistant. Reply with Strudel code only.'

/** How many tokens a pattern is allowed. Past this it is repeating itself. */
const MAX_NEW = 240

export type Write = (want: string, seed?: number) => Promise<string>

/**
 * A deterministic PRNG, so a seed reproduces a set exactly.
 *
 * `Math.random` would make a failed generation unreproducible, and the retry
 * loop in `verify.ts` needs each attempt to differ *and* be repeatable — the
 * seed is what a bug report can carry.
 */
function rng(seed: number): () => number {
  let x = (seed >>> 0) || 0x9e3779b9
  return () => {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    return (x >>> 0) / 4294967296
  }
}

/**
 * Temperature and top-p over the head of the distribution.
 *
 * Only the top 200 logits are considered. A full sort of 49,152 candidates per
 * token, 240 times, is most of the cost of a generation, and nothing below the
 * top 200 survives top-p 0.95 on a model this confident.
 */
function sample(
  logits: Float32Array,
  base: number,
  size: number,
  temp: number,
  topP: number,
  rand: () => number,
): number {
  const head: [number, number][] = []
  let floor = -Infinity
  for (let i = 0; i < size; i++) {
    const v = logits[base + i]
    if (head.length < 200) {
      head.push([i, v])
      if (head.length === 200) {
        head.sort((a, b) => b[1] - a[1])
        floor = head[199][1]
      }
    } else if (v > floor) {
      head[199] = [i, v]
      head.sort((a, b) => b[1] - a[1])
      floor = head[199][1]
    }
  }
  head.sort((a, b) => b[1] - a[1])

  const max = head[0][1] / temp
  let sum = 0
  const probs = head.map(([i, v]) => {
    const p = Math.exp(v / temp - max)
    sum += p
    return [i, p] as [number, number]
  })

  let acc = 0
  const kept: [number, number][] = []
  for (const [i, p] of probs) {
    const norm = p / sum
    kept.push([i, norm])
    acc += norm
    if (acc >= topP) break
  }

  let r = rand() * acc
  for (const [i, p] of kept) {
    r -= p
    if (r <= 0) return i
  }
  return kept[kept.length - 1][0]
}

/**
 * The graph and the tokenizer, however they arrived.
 *
 * Split from the pack's loading for the same reason `embed.ts` splits its own:
 * a test can hand it bytes off disk and exercise the real weights rather than a
 * stand-in that would let a prompt-format or sampling bug pass unnoticed.
 */
export async function strudelWriter(
  model: string | Uint8Array,
  tokJson: Parameters<typeof BPE.fromJson>[0],
): Promise<Write> {
  const session = await ort.InferenceSession.create(model as never, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  })
  const bpe = BPE.fromJson(tokJson)

  const imStart = bpe.id('<|im_start|>')
  const imEnd = bpe.id('<|im_end|>')
  if (imStart === undefined || imEnd === undefined) {
    throw new Error('strudel: tokenizer has no ChatML markers')
  }
  const skip = new Set([imStart, imEnd])
  const newline = bpe.raw('\n')

  const prompt = (want: string): number[] => [
    imStart, ...bpe.raw(`system\n${SYSTEM}`), imEnd, ...newline,
    imStart, ...bpe.raw(`user\nWrite Strudel code for: ${want}`), imEnd, ...newline,
    imStart, ...bpe.raw('assistant\n'),
  ]

  const empty = () => {
    const past: Record<string, ort.Tensor> = {}
    for (let l = 0; l < LAYERS; l++) {
      for (const kind of ['key', 'value']) {
        past[`past_key_values.${l}.${kind}`] = new ort.Tensor(
          'float32',
          new Float32Array(0),
          [1, KV_HEADS, 0, HEAD_DIM],
        )
      }
    }
    return past
  }

  return async function write(want, seed = 1) {
    const rand = rng(seed)
    let past = empty()
    let tokens = prompt(want)
    let offset = 0
    const out: number[] = []

    for (let step = 0; step < MAX_NEW; step++) {
      const len = tokens.length
      const total = offset + len
      const big = (a: number[]) => BigInt64Array.from(a, BigInt)

      const res = await session.run({
        input_ids: new ort.Tensor('int64', big(tokens), [1, len]),
        attention_mask: new ort.Tensor('int64', big(Array(total).fill(1)), [1, total]),
        position_ids: new ort.Tensor('int64', big(tokens.map((_, i) => offset + i)), [1, len]),
        ...past,
      })

      const logits = res.logits.data as Float32Array
      const size = res.logits.dims[2] as number
      const next = sample(logits, (len - 1) * size, size, 0.8, 0.95, rand)
      if (next === imEnd) break
      out.push(next)

      // The cache is the model's own output, handed straight back. Rebuilding
      // it from the full sequence each step would make generation quadratic and
      // is the difference between five seconds and a minute.
      past = {}
      for (let l = 0; l < LAYERS; l++) {
        for (const kind of ['key', 'value']) {
          past[`past_key_values.${l}.${kind}`] = res[`present.${l}.${kind}`] as ort.Tensor
        }
      }
      offset = total
      tokens = [next]
    }

    return bpe.decode(out, skip).trim()
  }
}
