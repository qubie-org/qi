/**
 * Finding the folders. The only Vite-specific file here.
 *
 * `import.meta.glob` is rewritten by Vite at build time by *reading the source*,
 * so it must appear literally, with literal arguments, at the top level. A
 * helper that forwarded to it — written so this module could also be imported
 * by the test runner — type-checked, ran, and returned an empty object, because
 * a call Vite cannot see is not a call it transforms. The failure is silent: no
 * commands, no error.
 *
 * So the globs live alone in this file, and everything that can be tested lives
 * in `index.ts`, which imports nothing from Vite.
 */
import { loadFrom, type Files } from './index'
import { loadAppsFrom, type AppFiles } from '../apps'

const commands: Files = {
  docs: import.meta.glob('../commands/*/COMMAND.md', { query: '?raw', import: 'default', eager: true }),
  code: import.meta.glob('../commands/*/command.ts', { eager: true }),
}

// Apps are the third folder-shaped namespace, and they are globbed here rather
// than in `apps/index.ts` for the reason this file exists at all: the glob must
// appear literally, in a file that is only ever built by Vite. The loader it
// feeds is pure and lives next to the apps themselves.
const apps: AppFiles = {
  docs: import.meta.glob('../apps/*/APP.md', { query: '?raw', import: 'default', eager: true }),
  code: import.meta.glob('../apps/*/app.tsx', { eager: true }),
}

export const loadFolders = () => ({ ...loadFrom(commands), apps: loadAppsFrom(apps) })
