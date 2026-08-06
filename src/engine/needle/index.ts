/**
 * needle — a 26M encoder-decoder that turns a sentence into a tool call.
 *
 * Runs onnxruntime-web on the int8 graphs quantized by tools/quantize_needle.py
 * (139.8 MB fp32 -> 36.7 MB). Decoding follows Cactus's own loop exactly:
 *
 *   encoder input   = query_tokens + [<tools>] + tools_tokens
 *   decoder         = seeded with EOS, greedy argmax, stops at EOS
 *   past_self_kv    = (layers, 2, batch, kv_heads, seq, head_dim), starts empty
 *   output          = "<tool_call>[{...}]", prefix stripped
 *
 * Constrained decoding is always on. See constrain.ts for why it is not
 * optional.
 */
import * as ort from 'onnxruntime-web'
// These are exposed at the bare subpath by onnxruntime-web's exports map —
// the ./dist/ form is not exported and vite will refuse to resolve it.
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url'
import wasmMjsUrl from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url'
import { ConstrainedDecoder, ToolConstraints } from './constrain'
import { NeedleTokenizer } from './tokenizer'

const LAYERS = 8
const KV_HEADS = 4
const HEAD_DIM = 64
const EOS = 1
const TOOLS_SEP = 5
const MAX_ENC = 1024
const MAX_GEN = 64

export type ToolCall = { name: string; arguments: Record<string, unknown> }

export class Needle {
  private encoder: ort.InferenceSession | null = null
  private decoder: ort.InferenceSession | null = null
  private tok: NeedleTokenizer | null = null
  private tokenStrings: string[] = []
  ready = false

  async load(base = '/models/needle'): Promise<void> {
    if (this.ready) return

    ort.env.wasm.wasmPaths = { wasm: wasmUrl, mjs: wasmMjsUrl }
    // Cross-origin isolation is already on for Wasmer, so threads are available.
    ort.env.wasm.numThreads = Math.min(4, navigator.hardwareConcurrency || 1)

    const opts: ort.InferenceSession.SessionOptions = {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    }
    const [enc, dec, tok] = await Promise.all([
      ort.InferenceSession.create(`${base}/encoder.q8.onnx`, opts),
      ort.InferenceSession.create(`${base}/decoder_step.q8.onnx`, opts),
      NeedleTokenizer.load(base),
    ])
    this.encoder = enc
    this.decoder = dec
    this.tok = tok
    this.tokenStrings = tok.tokenStrings()
    this.ready = true
  }

  /** query + <tools> + tools, truncated the way Cactus truncates. */
  private encoderInput(query: string, toolsJson: string): BigInt64Array {
    const tok = this.tok!
    let q = tok.encode(query)
    if (q.length > MAX_ENC - 2) q = q.slice(0, MAX_ENC - 2)
    const t = tok.encode(toolsJson).slice(0, MAX_ENC - q.length - 1)
    return BigInt64Array.from([...q, TOOLS_SEP, ...t].map(BigInt))
  }

  async call(query: string, toolsJson: string): Promise<ToolCall[]> {
    if (!this.encoder || !this.decoder || !this.tok) throw new Error('needle: load() first')

    const ids = this.encoderInput(query, toolsJson)
    const { encoder_out } = await this.encoder.run({
      input_ids: new ort.Tensor('int64', ids, [1, ids.length]),
    })

    let past: ort.Tensor = new ort.Tensor(
      'float32',
      new Float32Array(0),
      [LAYERS, 2, 1, KV_HEADS, 0, HEAD_DIM],
    )
    const guard = new ConstrainedDecoder(new ToolConstraints(toolsJson), this.tokenStrings)

    let next = EOS
    const produced: number[] = []
    for (let step = 0; step < MAX_GEN; step++) {
      const out = await this.decoder.run({
        decoder_input_ids: new ort.Tensor('int64', BigInt64Array.from([BigInt(next)]), [1, 1]),
        encoder_out: encoder_out as ort.Tensor,
        past_self_kv: past,
      })
      const logits = out.logits.data as Float32Array
      past = out.present_self_kv as ort.Tensor

      next = argmax(guard.active ? guard.constrain(logits.slice()) : logits)
      if (next === EOS) break
      produced.push(next)
      guard.update(next)
    }

    let text = this.tok.decode(produced)
    if (text.startsWith('<tool_call>')) text = text.slice('<tool_call>'.length)
    return parseCalls(text)
  }
}

function argmax(v: Float32Array): number {
  let best = 0
  let bestV = -Infinity
  for (let i = 0; i < v.length; i++) {
    if (v[i] > bestV) {
      bestV = v[i]
      best = i
    }
  }
  return best
}

/** needle's output is usually valid JSON; when it isn't, salvage nothing. */
function parseCalls(text: string): ToolCall[] {
  try {
    const parsed = JSON.parse(text.trim())
    const list = Array.isArray(parsed) ? parsed : [parsed]
    return list.filter(
      (c): c is ToolCall => !!c && typeof c.name === 'string' && typeof c.arguments === 'object',
    )
  } catch {
    return []
  }
}
