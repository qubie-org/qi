/**
 * Packs: the plug-and-play part.
 *
 * qi ships one model and a bus. Everything else — eyes, ears, a document
 * parser, a reranker, citation adapters, a Python data-science lane — is a pack:
 * a declared set of weights that can be absent, downloaded on demand, and then
 * *bind* into the running app without anything upstream of it changing.
 *
 * A pack contributes two kinds of thing, and only these two:
 *
 *   verbs        tool declarations plus their executors. Installing a pack
 *                literally adds a verb the agent can choose. Nothing is
 *                hardcoded in the loop; the loop asks the registry.
 *
 *   capabilities named functions other code can ask for by name — `embed`,
 *                `rerank`, `see`, `read`, `listen`. A caller asks whether the
 *                capability is there and degrades honestly when it is not,
 *                rather than the app having a hole in the middle of it.
 *
 * The catalog is a JSON file shared with tools/pull.sh, so the installer and
 * the app cannot disagree about what a pack is or where its files live.
 *
 * The design rule that keeps this from rotting: a pack may only bind *down*.
 * It can use the core model, the store and the page space; nothing in those
 * imports a pack. So an uninstalled pack is a missing capability, never a
 * broken import.
 */
import catalog from './catalog.json'

export type Runtime = 'llama' | 'onnx' | 'mlx' | 'lora' | 'wasm'

export type PackSpec = {
  id: string
  title: string
  what: string
  repo: string
  files: string[]
  bytes: number
  runtime: Runtime
  required?: boolean
  binds: string[]
}

/** A tool the agent can choose, and the code that runs it. */
export type Verb = {
  /** OpenAI-shaped declaration, folded into Granite's chat template by llama-server. */
  declaration: {
    type: 'function'
    function: { name: string; description: string; parameters: unknown }
  }
  /** Returns prose. It goes to the summariser, never straight into context. */
  /**
   * A verb that found nothing says so with `{ empty: true }` rather than by
   * returning a shorter string.
   *
   * The distinction is load-bearing. "No page called lighthouse-photo" is
   * perfectly good prose, and while a bare string was the only return type it
   * counted as a success — so the model read the sentence as confirmation and
   * announced a photograph it had never seen.
   */
  run: (
    args: Record<string, unknown>,
    ctx: unknown,
  ) => Promise<string | { work: string; empty?: boolean }>
  /** Shown on the badge while the step runs. */
  verb: string
}

export type Binding = {
  verbs?: Verb[]
  capabilities?: Record<string, unknown>
  /** Called once when the pack is first bound. Loads weights, warms sessions. */
  start?: () => Promise<void>
}

/** What a pack module must export as default. */
export type PackModule = (spec: PackSpec) => Promise<Binding> | Binding

export type PackState = {
  spec: PackSpec
  /** Its files are on disk. */
  installed: boolean
  /** It has been loaded and its bindings are live. */
  bound: boolean
  error?: string
}

const SPECS = (catalog as { packs: PackSpec[] }).packs

/**
 * Pack loaders, registered rather than imported.
 *
 * Vite would happily static-import every pack and bundle all of them, which
 * would mean shipping the ONNX runtime to someone who never installed the embed
 * pack. Each entry is a dynamic import, so a pack's code is fetched the first
 * time it binds and never otherwise.
 */
const LOADERS: Record<string, () => Promise<{ default: PackModule }>> = {
  embed: () => import('../packs/embed'),
  see: () => import('../packs/see'),
  rag: () => import('../packs/rag'),
  strudel: () => import('../packs/strudel'),
}

class Registry {
  private state = new Map<string, PackState>()
  private bindings = new Map<string, Binding>()
  private listeners = new Set<() => void>()
  /** Set once the host has been asked what is actually on disk. */
  private surveyed: Promise<void> | null = null

  constructor() {
    for (const spec of SPECS) this.state.set(spec.id, { spec, installed: false, bound: false })
  }

  all(): PackState[] {
    return [...this.state.values()]
  }

  get(id: string): PackState | undefined {
    return this.state.get(id)
  }

  /**
   * Re-read what is actually on disk. The host answers; the catalog only claims.
   *
   * Memoised, because `bind` calls it too. Without that, binding a pack before
   * anything had surveyed reported it as not installed — and the failure looked
   * exactly like a missing download rather than an ordering mistake.
   */
  async survey(force = false): Promise<void> {
    if (this.surveyed && !force) return this.surveyed
    this.surveyed = this.doSurvey()
    return this.surveyed
  }

  private async doSurvey(): Promise<void> {
    try {
      const res = await fetch('/packs/installed')
      const ids: string[] = res.ok ? await res.json() : []
      for (const s of this.state.values()) s.installed = ids.includes(s.spec.id)
    } catch {
      /* no host endpoint: nothing is installed as far as the page knows */
    }
    this.changed()
  }

  /**
   * Download a pack, reporting progress as it goes.
   *
   * The host does the fetching — the same tools/pull.sh a person would run — so
   * there is exactly one code path that puts weights on disk, and the UI button
   * and the terminal command cannot drift apart.
   */
  async install(id: string, onProgress?: (pct: number, line: string) => void): Promise<void> {
    const res = await fetch(`/packs/${id}/install`, { method: 'POST' })
    if (!res.ok || !res.body) throw new Error(`install ${id}: ${res.status}`)
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const line = decoder.decode(value, { stream: true })
      const pct = Number(/(\d+(?:\.\d+)?)%/.exec(line)?.[1] ?? NaN)
      onProgress?.(Number.isFinite(pct) ? pct : -1, line.trim())
    }
    await this.survey()
  }

  /**
   * Load a pack and make its bindings live.
   *
   * Binding twice is a no-op, and binding something uninstalled is an error
   * rather than a silent nothing: a capability that quietly does not exist is
   * the hardest kind of bug to see from the outside.
   */
  async bind(id: string): Promise<Binding> {
    const existing = this.bindings.get(id)
    if (existing) return existing

    await this.survey()
    const state = this.state.get(id)
    if (!state) throw new Error(`no pack '${id}'`)
    if (!state.installed) throw new Error(`pack '${id}' is not installed`)

    const loader = LOADERS[id]
    if (!loader) throw new Error(`pack '${id}' has no loader yet`)

    try {
      const mod = await loader()
      const binding = await mod.default(state.spec)
      await binding.start?.()
      this.bindings.set(id, binding)
      state.bound = true
      state.error = undefined
      this.changed()
      return binding
    } catch (err) {
      state.error = String(err)
      this.changed()
      throw err
    }
  }

  /** Bind everything installed. Failures are reported, never fatal. */
  async bindInstalled(): Promise<void> {
    await this.survey(true)
    await Promise.allSettled(
      this.all()
        .filter((s) => s.installed && LOADERS[s.spec.id])
        .map((s) => this.bind(s.spec.id)),
    )
  }

  /** Every verb currently on the bus. This is what the agent is offered. */
  verbs(): Verb[] {
    return [...this.bindings.values()].flatMap((b) => b.verbs ?? [])
  }

  /**
   * Ask for a capability by name.
   *
   * Returns undefined when no bound pack provides it, which callers are
   * expected to handle — that is the whole contract. `embed` missing means the
   * page falls back to hashed vectors and says so, not that retrieval throws.
   */
  provide<T>(name: string): T | undefined {
    for (const b of this.bindings.values()) {
      const cap = b.capabilities?.[name]
      if (cap) return cap as T
    }
    return undefined
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private changed() {
    for (const fn of this.listeners) fn()
  }
}

export const packs = new Registry()
