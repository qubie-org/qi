/**
 * Making the space visible without the model having to remember it.
 *
 * Asking a language model to recall a list of addresses and spell them into
 * `[text](toki:id)` is a way to get wrong links: it will invent plausible ids
 * the same way it invented a plausible image URL. Instead the render layer
 * links what it can *verify* exists — a word is only ever linked when a page
 * with that exact id is already registered.
 *
 * Deterministic and conservative on purpose: exact matches only, a hard cap per
 * turn, and never the same page twice. An over-linked paragraph reads like a
 * wiki stub, and toki is meant to read like a sentence.
 */
import type { Node } from '../inline/types'
import { address, get, slug } from './space'

/** More than this and the reply stops being prose. */
const MAX_LINKS = 2
/** Short words match too eagerly and are rarely the subject. */
const MIN_WORD = 4

export function autolink(nodes: Node[], max = MAX_LINKS): Node[] {
  let placed = 0
  const used = new Set<string>()

  const walk = (ns: Node[]): Node[] =>
    ns.flatMap((n): Node[] => {
      if (placed >= max) return [n]

      // Never inside something that is already a link, a mark or code.
      if (n.t === 'link' || n.t === 'code' || n.t === 'src') return [n]

      if (n.t === 'text') {
        const parts = n.v.split(/(\s+)/)
        const out: Node[] = []
        let buf = ''
        for (const part of parts) {
          const bare = part.replace(/[^\p{L}\p{N}'-]/gu, '')
          const id = slug(bare)
          const page = bare.length >= MIN_WORD && !used.has(id) ? get(id) : undefined
          if (!page || placed >= max) {
            buf += part
            continue
          }
          // Punctuation stays outside the link, as with every other mark.
          const at = part.indexOf(bare)
          const lead = part.slice(0, at)
          const trail = part.slice(at + bare.length)
          if (buf + lead) out.push({ t: 'text', v: buf + lead })
          buf = trail
          out.push({ t: 'link', href: address(page.id), kids: [{ t: 'text', v: bare }] })
          used.add(id)
          placed++
        }
        if (buf) out.push({ t: 'text', v: buf })
        return out
      }

      if ('kids' in n) return [{ ...n, kids: walk(n.kids) } as Node]
      return [n]
    })

  return walk(nodes)
}
