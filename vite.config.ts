import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Wasmer's SDK spins a Web Worker threadpool over a SharedArrayBuffer, so the
// page has to be cross-origin isolated. wllama's multi-thread build wants the
// same headers, so we get faster inference for free by turning them on.
const isolate = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'cross-origin',
}

export default defineConfig({
  plugins: [react()],
  // Two local llama-servers, started by tools/serve.sh. Proxying keeps the
  // browser same-origin, so neither needs CORS configured and cross-origin
  // isolation (required by Wasmer) stays intact.
  //
  //   /llm  A1-4B, the agent that decides and answers
  //   /sum  summarizer-800m, which compresses tool results and names the steps
  server: {
    headers: isolate,
    port: 8322,
    proxy: {
      '/llm': { target: 'http://127.0.0.1:8082', rewrite: (p) => p.replace(/^\/llm/, '') },
      '/sum': { target: 'http://127.0.0.1:8081', rewrite: (p) => p.replace(/^\/sum/, '') },
    },
  },
  preview: {
    headers: isolate,
    port: 8322,
    proxy: {
      '/llm': { target: 'http://127.0.0.1:8082', rewrite: (p) => p.replace(/^\/llm/, '') },
      '/sum': { target: 'http://127.0.0.1:8081', rewrite: (p) => p.replace(/^\/sum/, '') },
    },
  },
  // These ship real .wasm/.onnx sidecars; letting Vite pre-bundle them breaks
  // the relative URLs they resolve their workers against.
  optimizeDeps: { exclude: ['@wllama/wllama', '@wasmer/sdk', 'onnxruntime-web'] },
  build: { target: 'es2022' },
})
