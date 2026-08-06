/**
 * Grammar-constrained decoding for needle, ported from Cactus's
 * needle/model/constrained.py.
 *
 * This is not an optimisation — it is load-bearing. Unconstrained, base needle
 * emits the right tool name and garbage arguments (its own card reports 32%
 * argument accuracy). With the mask on, arguments come out clean, and it also
 * absorbs most int8 quantization drift because the wrong tokens were never
 * reachable.
 *
 * Output grammar: [{"name":"tool","arguments":{"key":value,...}}]
 * Constrained spans: tool names after "name":" and argument keys inside
 * "arguments":{ . Argument *values* are free.
 */

class TrieNode {
  children = new Map<string, TrieNode>()
  terminal = false
}

class Trie {
  root = new TrieNode()

  insert(word: string): void {
    let node = this.root
    for (const ch of word) {
      let next = node.children.get(ch)
      if (!next) {
        next = new TrieNode()
        node.children.set(ch, next)
      }
      node = next
    }
    node.terminal = true
  }

  getNode(prefix: string): TrieNode | null {
    let node = this.root
    for (const ch of prefix) {
      const next = node.children.get(ch)
      if (!next) return null
      node = next
    }
    return node
  }
}

/**
 * `parameters` is read as a flat map of name → spec, matching Cactus's
 * reader (it iterates the object directly, not a JSON-Schema `properties`).
 */
export class ToolConstraints {
  nameTrie = new Trie()
  paramTries = new Map<string, Trie>()

  constructor(toolsJson: string) {
    let tools: unknown
    try {
      tools = JSON.parse(toolsJson)
    } catch {
      tools = []
    }
    if (!Array.isArray(tools)) return

    for (const tool of tools) {
      if (!tool || typeof tool !== 'object') continue
      const name = (tool as any).name
      if (typeof name !== 'string' || !name) continue
      this.nameTrie.insert(name)

      const params = (tool as any).parameters
      if (params && typeof params === 'object') {
        const trie = new Trie()
        for (const [key, val] of Object.entries(params)) {
          if (val && typeof val === 'object') trie.insert(key)
        }
        this.paramTries.set(name, trie)
      }
    }
  }
}

type State = 'free' | 'name' | 'argKey'

class JsonStateMachine {
  state: State = 'free'
  buffer = ''
  constrainedBuf = ''
  currentFunction = ''
  private inArguments = false
  private argumentsDepth = 0
  private nestingDepth = 0
  private inString = false
  private prevEscape = false

  feed(text: string): void {
    for (const ch of text) this.feedChar(ch)
  }

  private feedChar(ch: string): void {
    if (this.state !== 'free') {
      if (ch === '"') {
        if (this.state === 'name') this.currentFunction = this.constrainedBuf
        this.constrainedBuf = ''
        this.state = 'free'
      } else {
        this.constrainedBuf += ch
      }
      this.buffer += ch
      return
    }

    this.buffer += ch

    if (this.inString) {
      if (this.prevEscape) {
        this.prevEscape = false
        return
      }
      if (ch === '\\') {
        this.prevEscape = true
        return
      }
      if (ch === '"') this.inString = false
      return
    }

    if (ch === '{' || ch === '[') {
      this.nestingDepth++
    } else if (ch === '}' || ch === ']') {
      this.nestingDepth = Math.max(0, this.nestingDepth - 1)
      if (ch === '}' && this.inArguments && this.nestingDepth < this.argumentsDepth) {
        this.inArguments = false
      }
      return
    }

    if (this.buffer.endsWith('"name":"') && !this.inArguments) {
      this.state = 'name'
      this.constrainedBuf = ''
      return
    }

    if (this.buffer.endsWith('"arguments":{')) {
      this.inArguments = true
      this.argumentsDepth = this.nestingDepth
      return
    }

    if (this.inArguments && this.nestingDepth === this.argumentsDepth && this.atArgKeyStart()) {
      this.state = 'argKey'
      this.constrainedBuf = ''
      return
    }

    if (ch === '"' && this.isValueQuote()) this.inString = true
  }

  /** An argument key is opening when the buffer ends with `{"` or `,"`. */
  private atArgKeyStart(): boolean {
    const tail = this.buffer.slice(-2)
    return tail === '{"' || tail === ',"'
  }

  /** A quote opens a string *value* when the last non-space char was `:`. */
  private isValueQuote(): boolean {
    for (let j = this.buffer.length - 2; j >= 0; j--) {
      const c = this.buffer[j]
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') continue
      return c === ':'
    }
    return false
  }
}

/** First character → candidate token ids, so masking never scans the vocab. */
class TokenIndex {
  private index = new Map<string, number[]>()

  constructor(tokenStrings: string[]) {
    tokenStrings.forEach((s, tid) => {
      if (!s) return
      const first = s[0]
      const bucket = this.index.get(first)
      if (bucket) bucket.push(tid)
      else this.index.set(first, [tid])
    })
  }

  candidatesFor(ch: string): number[] {
    return this.index.get(ch) ?? []
  }
}

/**
 * A token is a valid continuation if every character before the closing quote
 * walks the trie. Characters after the quote are structural JSON and are left
 * to the state machine.
 */
function tokenValid(text: string, from: TrieNode): boolean {
  let node = from
  for (const ch of text) {
    if (ch === '"') return node.terminal
    const next = node.children.get(ch)
    if (!next) return false
    node = next
  }
  return true
}

export class ConstrainedDecoder {
  private machine = new JsonStateMachine()
  private index: TokenIndex

  constructor(
    private readonly tools: ToolConstraints,
    private readonly tokenStrings: string[],
  ) {
    this.index = new TokenIndex(tokenStrings)
  }

  get active(): boolean {
    return this.machine.state !== 'free'
  }

  /** Masks in place: invalid tokens go to -Infinity. */
  constrain(logits: Float32Array): Float32Array {
    const state = this.machine.state
    if (state === 'free') return logits

    const trie =
      state === 'name' ? this.tools.nameTrie : this.tools.paramTries.get(this.machine.currentFunction)
    if (!trie) return logits

    const node = trie.getNode(this.machine.constrainedBuf)
    if (!node) return logits // off-trie: fall back rather than deadlock

    const allowed = new Set<string>(node.children.keys())
    if (node.terminal) allowed.add('"')

    const keep = new Uint8Array(logits.length)
    let any = false
    for (const ch of allowed) {
      for (const tid of this.index.candidatesFor(ch)) {
        if (keep[tid]) continue
        if (tokenValid(this.tokenStrings[tid], node)) {
          keep[tid] = 1
          any = true
        }
      }
    }
    if (!any) return logits // nothing legal — better unconstrained than stuck

    for (let i = 0; i < logits.length; i++) if (!keep[i]) logits[i] = -Infinity
    return logits
  }

  update(tokenId: number): void {
    this.machine.feed(this.tokenStrings[tokenId] ?? '')
  }
}
