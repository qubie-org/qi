/**
 * Apps, loaded from folders — the same shape commands and skills already use.
 *
 * A folder with `APP.md` in it: frontmatter saying what it is, and a body. The
 * split from `skills/index.ts` is copied deliberately rather than shared,
 * because what the body is *for* differs in each of the three namespaces and
 * that difference is the namespaces:
 *
 *   a skill's body is a **brief**, loaded into the model's context;
 *   a command's body is **documentation**, read by a person and sent nowhere;
 *   an app's body is documentation too — an app informs nobody and returns
 *   nothing, it takes over the page, so its prose exists for whoever opens the
 *   folder next.
 *
 * Everything here is pure. `import.meta.glob` is rewritten by Vite by *reading
 * the source*, so it must appear literally at the top level of the one file
 * that is allowed to know Vite exists — `skills/discover.ts`. A helper that
 * forwards to it type-checks, runs, and silently returns nothing. That failure
 * has already been paid for once in this codebase; this module takes the file
 * maps as an argument so it never has to be paid again, and so the loader can
 * be tested by a runner that has no bundler.
 */
import type { ComponentType } from 'react'
import { register, type App } from '../pages/sigils'
import { frontmatter } from '../skills'

/**
 * How an app asks the shell to give it the page.
 *
 * A DOM event rather than a callback threaded through the registry, matching
 * `NAVIGATE` / `EXPAND` / `INVOKE` in `inline/Render.tsx`. The registry is a
 * plain data structure that many modules import; handing it a live reference to
 * the shell's state would invert that, and every entry would need wiring at
 * construction by whoever happened to build it.
 */
export const OPEN_APP = 'qi:app'

export type Opening = { id: string; argument: string }

/**
 * How an app says where inside itself you are.
 *
 * There is exactly one breadcrumb on screen and the shell draws it. The first
 * version had the shell draw `conversation › note` and let the app draw its own
 * `‹ all notes` underneath, which is two trails for one position — the reader
 * has to work out which of the two back-arrows is the one they want, and they
 * disagree about where they lead. An app publishes its trail instead and the
 * shell renders one row: `conversation › note › Groceries`.
 *
 * The shell keeps ownership of the root crumb, so leaving the app is always
 * available whether or not an app remembered to publish anything.
 */
export const CRUMBS = 'qi:crumbs'

/** One step in the trail. Without `go` it is where you are, not a link. */
export type Crumb = { label: string; go?: () => void }

export const setCrumbs = (crumbs: Crumb[]): void => {
  dispatchEvent(new CustomEvent<Crumb[]>(CRUMBS, { detail: crumbs }))
}

/**
 * What an app renders as.
 *
 * `onExit` rather than the surface reaching for the shell itself: the shell
 * owns the breadcrumb and therefore owns leaving. A surface that could close
 * itself by dispatching an event would be a second way out that the breadcrumb
 * does not know about.
 */
export type Surface = ComponentType<{ argument: string; onExit: () => void }>

export type AppModule = { surface?: Surface }
export type AppFiles = { docs: Record<string, string>; code: Record<string, AppModule> }

const folderOf = (path: string): string => path.split('/').slice(-2)[0] ?? path

/**
 * One app, from its path, its text and its module.
 *
 * Returns null without a surface, for the same reason `commandFrom` returns
 * null without a `run`: an app is a place the page becomes, and one with
 * nothing to become is not an app. Its prose cannot stand in for its screen.
 *
 * Registered under `/` alongside commands. The two were separate namespaces
 * until a command — `/present` — wrote a deck and then opened it, at which
 * point "returns a fact" against "becomes a place" was no longer a distinction
 * a sigil could carry. What tells them apart now is that one has a `surface`,
 * which is a property of the entry rather than of the character in front of
 * it.
 */
export function appFrom(path: string, text: string, code?: AppModule): App | null {
  const { fields } = frontmatter(text)
  const id = fields.id || folderOf(path)
  if (!id || !code?.surface) return null
  return {
    sigil: '/',
    id,
    name: fields.name || id,
    needs: fields.needs ?? '',
    gives: fields.gives ?? '',
    tone: Number(fields.tone ?? 0) % 4,
    surface: code.surface,
    makes: fields.makes || undefined,
    // The one behaviour every app shares, written once here rather than in
    // each folder: asking for the page. What it returns to is the breadcrumb,
    // which the shell owns — see `pages/sigils.ts`.
    enter: (argument: string) =>
      dispatchEvent(new CustomEvent<Opening>(OPEN_APP, { detail: { id, argument } })),
  }
}

/** Build the registry from already-discovered files. */
export function loadAppsFrom(files: AppFiles): App[] {
  const apps: App[] = []
  for (const [path, text] of Object.entries(files.docs)) {
    const app = appFrom(path, text, files.code[path.replace(/APP\.md$/, 'app.tsx')])
    if (app) apps.push(app)
    else console.warn(`app ${path}: no id or no surface — skipped`)
  }
  apps.sort((a, b) => a.name.localeCompare(b.name))
  register(apps)
  return apps
}
