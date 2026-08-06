/**
 * Real vectors, in a test runner.
 *
 * onnxruntime-web's wasm build runs under bun, so the suite scores words with
 * the same weights the app does rather than against a stand-in. That is the
 * only way these tests are worth anything: what they are checking is whether
 * "the ocean has a rhythm" finds the right words, and a fake backend would let
 * a tokenizer or pooling mistake pass every assertion.
 *
 * Importing this module binds the backend as a side effect, so a test file only
 * has to `await ready` before it embeds anything.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { onnxBackend } from '../../packs/embed'
import { calibrate, useBackend } from '../vectors'

const base = path.resolve(import.meta.dir, '../../../packs/embed')

export const ready = (async () => {
  try {
    const model = new Uint8Array(readFileSync(path.join(base, 'model.onnx')))
    const tok = JSON.parse(readFileSync(path.join(base, 'tokenizer.json'), 'utf8'))
    useBackend(await onnxBackend(model, tok))
    // The app centres the space at boot, so a test that skips it is measuring a
    // different model to the one that ships.
    await calibrate()
    return true
  } catch (err) {
    // A checkout without the embed pack pulled should say so once, clearly,
    // rather than failing every assertion with a cosine that means nothing.
    console.error(`\nembed pack missing — run tools/pull.sh embed\n  (${String(err)})\n`)
    process.exit(1)
  }
})()
