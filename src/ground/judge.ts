/**
 * The adapters, put in the path.
 *
 * `packs/rag.ts` binds five LoRA intrinsics IBM trained against the exact
 * weights the core is running — 376 MB of rank-32 deltas, loaded into the
 * server at startup, named per request. The binding is correct, documented and
 * complete. Four of the five were called from nowhere.
 *
 * That is the gap this file closes, and it matters more than it sounds: every
 * control decision in the grounding path is currently a number someone chose.
 * Is this page long enough to be worth reading (320 characters). Is this
 * operation near enough to the question (a calibrated cosine). Is the value the
 * model extracted real (does it occur as a leaf). Those are all proxies for one
 * question — *does this text answer what was asked* — which is exactly what
 * `answerability` was trained to decide, and it decides it far better than a
 * threshold can.
 *
 * The same applies at the other end. `hallucination_detection` marks which
 * sentences of a reply are not supported by the documents it was given, which
 * is the failure this codebase keeps rediscovering under different names: the
 * generic API reducer inferring a field, the ClickHouse query filtering on the
 * wrong column, a page that mentioned the subject without answering about it.
 * Every one of those produces a confident sentence with a real source link.
 *
 * ── Everything here fails open ──────────────────────────────────────────────
 *
 * The rag pack is optional. On a bare install the adapters are not loaded and
 * `rag.ts` throws by design. A judgement that cannot be made must not become a
 * refusal to answer, so each of these returns "no opinion" rather than "no" —
 * the app is exactly as capable without the pack as it was before, and better
 * with it. That asymmetry is the whole reason to put the calls behind this file
 * instead of inline at the call sites.
 */
import { answerable, cite, clarify, unsupported, type Doc, type Span, type Turn } from '../packs/rag'

/** Documents in the shape the adapters were trained to receive. */
export const asDoc = (text: string, id = 'd0'): Doc => ({ doc_id: id, text })

/**
 * Does this text answer the question?
 *
 * `null` means nobody knows — the pack is absent, or the call failed — and the
 * caller should carry on as though it had never asked. Only `false` is a
 * verdict, and only a verdict should stop anything.
 */
export async function answers(question: string, passage: string): Promise<boolean | null> {
  if (!passage.trim()) return false
  try {
    return await answerable([{ role: 'user', content: question }], [asDoc(passage)])
  } catch {
    return null
  }
}

/**
 * Which sentences of a reply the documents do not support.
 *
 * Empty means either "all of it is supported" or "nobody checked", and the two
 * are deliberately not distinguished here: a caller that treats an empty list
 * as permission to show the reply behaves correctly in both cases.
 *
 * This was dead for a while and the reason is recorded in `granite.judge`: the
 * intrinsics that judge a reply need the reply as a trailing assistant message,
 * and llama.cpp's chat endpoint cannot combine that with a grammar. It goes
 * through `/completion` with a hand-closed turn now. Verified both ways — a
 * planted claim is flagged, a fully supported reply is not.
 */
export async function unsupportedSpans(question: string, reply: string, sources: string[]): Promise<Span[]> {
  if (!reply.trim() || !sources.length) return []
  try {
    return await unsupported(
      [
        { role: 'user', content: question },
        { role: 'assistant', content: reply },
      ],
      sources.map((text, i) => asDoc(text, `d${i}`)),
    )
  } catch {
    return []
  }
}

/** Which document sentence supports which part of the reply. */
export async function citations(question: string, reply: string, sources: string[]): Promise<Span[]> {
  if (!reply.trim() || !sources.length) return []
  try {
    return await cite(
      [
        { role: 'user', content: question },
        { role: 'assistant', content: reply },
      ],
      sources.map((text, i) => asDoc(text, `d${i}`)),
    )
  } catch {
    return []
  }
}

/**
 * The question that should have been asked instead, if this one is ambiguous.
 *
 * Null for a clear question, and null when the pack is missing. Used at the
 * front of the loop rather than the back: the cheapest way to avoid a confident
 * wrong answer is to notice that the question had two readings before spending
 * a retrieval on the wrong one.
 */
export async function ambiguity(turns: Turn[]): Promise<string | null> {
  try {
    return await clarify(turns)
  } catch {
    return null
  }
}
