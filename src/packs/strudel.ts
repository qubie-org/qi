/**
 * The strudel pack, bound.
 *
 * Only the wiring lives here. The generator is `writer.ts`, split out for the
 * same reason `embed.ts` splits `onnxBackend` from its binding — and for one
 * more: the two `?url` imports below are a Vite feature, so a module containing
 * them cannot be imported by a test runner at all. Keeping them here is what
 * lets `src/packs/__tests__/writer.ts` exercise the real weights, the real
 * tokenizer and the real sampler rather than a stand-in that would let a
 * prompt-format bug pass unnoticed.
 */
import * as ort from 'onnxruntime-web'
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url'
import wasmMjsUrl from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url'
import { strudelWriter, type Write } from './writer'
import type { Binding, PackSpec } from '../model/packs'

export type { Write }

export default async function bind(spec: PackSpec): Promise<Binding> {
  let writer: Write | null = null
  return {
    async start() {
      ort.env.wasm.wasmPaths = { wasm: wasmUrl, mjs: wasmMjsUrl }
      ort.env.wasm.numThreads = Math.min(4, navigator.hardwareConcurrency || 1)
      const base = `/packs/${spec.id}`
      const tokJson = await fetch(`${base}/tokenizer.json`).then((r) => r.json())
      writer = await strudelWriter(`${base}/model_quantized.onnx`, tokJson)
    },
    capabilities: {
      // The function itself, not a flag. `provide('strudel')` then hands back
      // something callable, so nothing else needs to know this pack exists —
      // `/dj` asks for a writer and either gets one or arranges a set the old
      // way. That is the same contract `embed` has, and it is why a missing
      // pack is a quieter feature rather than a thrown error.
      strudel: ((want, seed) => {
        if (!writer) throw new Error('strudel: not started')
        return writer(want, seed)
      }) satisfies Write,
    },
  }
}
