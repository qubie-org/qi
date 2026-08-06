/**
 * Teach Vite the `?audioworklet` import that superdough ships with.
 *
 * Strudel's audio engine begins with this line:
 *
 *     import workletsUrl from './worklets.mjs?audioworklet'
 *
 * which is a convention from Strudel's own repository, not anything Vite knows.
 * Without a plugin the import fails to resolve and the whole module graph dies
 * at transform time — before any runtime switch like `disableWorklets` could
 * matter, because the import is static and top-level.
 *
 * Handing Vite the raw file instead does not work either. An AudioWorklet is
 * loaded by URL into a global scope that cannot resolve module specifiers, and
 * `worklets.mjs` imports four things — an OLA processor, an FFT, superdough's
 * own helpers, and the kabelsalat ugen library. It has to arrive as one
 * self-contained script or not at all.
 *
 * So the file is bundled here, with esbuild, which Vite already carries. The
 * result is inlined as a string and turned into a blob URL at runtime rather
 * than emitted as an asset: `addModule` is equally happy with a blob, and one
 * mechanism then works identically in dev and in a build, instead of a dev
 * middleware plus an asset-emitting branch that only ever breaks in production.
 */
import { build } from 'esbuild'
import type { Plugin } from 'vite'

const SUFFIX = '?audioworklet'
const PREFIX = '\0audioworklet:'

export function audioWorklet(): Plugin {
  return {
    name: 'qi:audioworklet',
    // Ahead of Vite's own resolver, which would otherwise treat the query as a
    // request for the raw file and hand back something a worklet cannot run.
    enforce: 'pre',

    async resolveId(source, importer) {
      if (!source.endsWith(SUFFIX)) return null
      const bare = source.slice(0, -SUFFIX.length)
      const found = await this.resolve(bare, importer, { skipSelf: true })
      return found ? PREFIX + found.id : null
    },

    async load(id) {
      if (!id.startsWith(PREFIX)) return null
      const entry = id.slice(PREFIX.length)

      const bundled = await build({
        entryPoints: [entry],
        bundle: true,
        format: 'esm',
        // The worklet runs in AudioWorkletGlobalScope, which is not a browser
        // window: no DOM, no document. Naming a browser platform here would
        // let esbuild resolve a package's browser build, which is usually the
        // one that touches `window`.
        platform: 'neutral',
        mainFields: ['module', 'main'],
        conditions: ['import', 'default'],
        target: 'es2022',
        write: false,
        minify: true,
      })

      const code = bundled.outputFiles[0].text

      // Blob rather than asset: `addModule` accepts either, and a blob needs no
      // emitFile in build and no middleware in dev. Made eagerly and exported
      // as a plain string — the alternative is an object with a `toString`,
      // which works only because `addModule` happens to stringify its argument,
      // and that is too clever for something the whole audio system hangs off.
      return [
        `const source = ${JSON.stringify(code)}`,
        'export default URL.createObjectURL(new Blob([source], { type: "text/javascript" }))',
      ].join('\n')
    },
  }
}
