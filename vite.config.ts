import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { packsPlugin } from './tools/vite-packs'
import { audioWorklet } from './tools/vite-audioworklet'

// Wasmer's SDK spins a Web Worker threadpool over a SharedArrayBuffer, so the
// page has to be cross-origin isolated. onnxruntime-web's threaded build wants
// the same headers, so the embed pack gets faster inference for free.
const isolate = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'cross-origin',
}

// One llama-server per installed llama pack, started by tools/serve.sh. The
// ports come from src/model/catalog.json, which is also what the installer and
// the page read — the list exists once.
//
//   /llm       :8082  core, granite-4.1-3b
//   /pack/see  :8083  vision, only running if the pack is installed
//
// Proxying keeps the browser same-origin, so no server needs CORS configured
// and cross-origin isolation stays intact.
const proxy = {
  '/llm': { target: 'http://127.0.0.1:8082', rewrite: (p: string) => p.replace(/^\/llm/, '') },
  '/pack/see': {
    target: 'http://127.0.0.1:8083',
    rewrite: (p: string) => p.replace(/^\/pack\/see/, ''),
  },
  '/pack/hear': {
    target: 'http://127.0.0.1:8084',
    rewrite: (p: string) => p.replace(/^\/pack\/hear/, ''),
  },
}

export default defineConfig({
  plugins: [react(), packsPlugin(import.meta.dirname), audioWorklet()],
  server: { headers: isolate, port: 8322, proxy },
  preview: { headers: isolate, port: 8322, proxy },
  // These ship real .wasm sidecars; letting Vite pre-bundle them breaks the
  // relative URLs they resolve their workers against.
  // Strudel's packages must all be excluded together. Pre-bundling some and
  // not others gives you two copies of @strudel/core — which the library itself
  // warns about at runtime, and which quietly breaks anything that registers
  // global state: `setStringParser` would register mini-notation on one copy
  // while `note()` came from the other, and patterns would parse as literals.
  optimizeDeps: {
    exclude: [
      '@wasmer/sdk',
      'onnxruntime-web',
      'superdough',
      '@strudel/core',
      '@strudel/mini',
      '@strudel/webaudio',
    ],
  },
  build: { target: 'es2022' },
})
