/**
 * The embed pack: granite-embedding-30m-english.
 *
 * Six Roberta layers, 384 dimensions, CLS-pooled and L2-normalised. It is the
 * smallest thing IBM ships that has actual context — the whole point of moving
 * off a static table — and at 30M it stays under a few milliseconds a string on
 * CPU, which is what makes the cache in vectors.ts a bridge rather than a lie.
 *
 * Two backends, one capability:
 *
 *   onnx    onnxruntime-web, in the page. Works in any browser, no shell.
 *   ane     the native shell's CoreML session over a local endpoint.
 *
 * The choice is made by asking the host, not by configuration. Running inside
 * the chromeless WKWebView, `/native/embed` exists and the Neural Engine does
 * the work at a fraction of the power and without contending with the 3B model
 * for the GPU. Running in a plain browser during development, it does not, and
 * the wasm graph runs instead. Same vectors either way — same weights, same
 * pooling — so a cache warmed under one is valid under the other.
 */
import * as ort from 'onnxruntime-web'
// Exposed at the bare subpath by onnxruntime-web's exports map; the ./dist/
// form is not exported and vite will refuse to resolve it.
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url'
import wasmMjsUrl from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url'
import { BPE } from './bpe'
import type { Binding, PackSpec } from '../model/packs'
import { useBackend, type Backend } from '../model/vectors'

const DIM = 384
const MAX_SEQ = 512

/**
 * Does the native shell offer a Neural Engine session?
 *
 * A header, not a status code. The obvious version of this — HEAD the endpoint
 * and trust `res.ok` — is wrong in exactly the environment it matters in: a dev
 * server answers unknown paths with the SPA's index.html and a cheerful 200, so
 * the probe succeeded, the ANE backend was selected, and every embedding
 * afterwards 404'd. Answering a question nobody asked is worse than not
 * answering.
 *
 * So the shell has to say so explicitly, and only the shell can.
 */
async function nativeAvailable(): Promise<boolean> {
  try {
    const res = await fetch('/native/embed', { method: 'HEAD' })
    return res.ok && res.headers.get('x-qi-native') === 'embed'
  } catch {
    return false
  }
}

function ane(): Backend {
  return {
    dim: DIM,
    async encode(texts) {
      const res = await fetch('/native/embed', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ texts }),
      })
      if (!res.ok) throw new Error(`native embed: ${res.status}`)
      const body = (await res.json()) as { vectors: number[][] }
      return body.vectors.map((v) => new Float32Array(v))
    },
  }
}

/**
 * The graph and the tokenizer, wherever they came from.
 *
 * Split out from the pack's own loading so the tests can hand it bytes off
 * disk instead of URLs. That matters more than it sounds: it means the test
 * suite scores words with the same weights the app does, rather than against a
 * stand-in that would let a tokenizer or pooling bug pass unnoticed.
 */
export async function onnxBackend(
  model: string | Uint8Array,
  tokJson: { model: { vocab: Record<string, number>; merges: (string | [string, string])[] } },
): Promise<Backend> {
  const session = await ort.InferenceSession.create(model as never, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  })
  const bpe = BPE.fromJson(tokJson)
  const vocabSize = Object.keys(tokJson.model.vocab).length

  return {
    dim: DIM,
    // Exposed so salience can read rarity off vocabulary position rather than
    // shipping corpus statistics to say what the vocabulary already encodes.
    tokenize: (text: string) => bpe.encode(text).slice(1, -1),
    vocab: vocabSize,
    async encode(texts) {
      // Padded to the longest in the batch, not to 512: attention is quadratic
      // and these are mostly single words, so the difference is large.
      const rows = texts.map((t) => bpe.encode(t, MAX_SEQ))
      const width = Math.max(1, ...rows.map((r) => r.length))
      const ids = new BigInt64Array(rows.length * width)
      const mask = new BigInt64Array(rows.length * width)
      rows.forEach((row, i) => {
        for (let j = 0; j < width; j++) {
          const inside = j < row.length
          ids[i * width + j] = BigInt(inside ? row[j] : bpe.pad)
          mask[i * width + j] = inside ? 1n : 0n
        }
      })

      const dims = [rows.length, width]
      const feeds: Record<string, ort.Tensor> = {
        input_ids: new ort.Tensor('int64', ids, dims),
        attention_mask: new ort.Tensor('int64', mask, dims),
      }
      // Some exports of this graph still take the Bert-era token_type_ids even
      // though Roberta has a single segment. Feeding zeros is correct and
      // cheaper than maintaining two code paths.
      if (session.inputNames.includes('token_type_ids')) {
        feeds.token_type_ids = new ort.Tensor('int64', new BigInt64Array(rows.length * width), dims)
      }

      const out = await session.run(feeds)
      const hidden = out[session.outputNames[0]].data as Float32Array

      // CLS pooling: position 0 of each row, per 1_Pooling/config.json. Mean
      // pooling here would be a different model with the same weights.
      return rows.map((_, i) => {
        const v = hidden.slice(i * width * DIM, i * width * DIM + DIM)
        let n = 0
        for (const x of v) n += x * x
        n = Math.sqrt(n) || 1
        for (let j = 0; j < DIM; j++) v[j] /= n
        return v
      })
    },
  }
}

async function inPage(base: string): Promise<Backend> {
  ort.env.wasm.wasmPaths = { wasm: wasmUrl, mjs: wasmMjsUrl }
  // Cross-origin isolation is already on for the wasm sandbox, so threads are
  // available; four is where this graph stops getting faster.
  ort.env.wasm.numThreads = Math.min(4, navigator.hardwareConcurrency || 1)
  const tokJson = await fetch(`${base}/tokenizer.json`).then((r) => r.json())
  return onnxBackend(`${base}/model.onnx`, tokJson)
}

export default async function bind(spec: PackSpec): Promise<Binding> {
  return {
    async start() {
      const backend = (await nativeAvailable()) ? ane() : await inPage(`/packs/${spec.id}`)
      useBackend(backend)
    },
    capabilities: {
      // Named so other packs can ask for it too — the reranker wants the same
      // tokenizer, and a data-science pack wants vectors without knowing what
      // produced them.
      embed: true,
    },
  }
}
