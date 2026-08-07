/**
 * The three sizes, and what choosing one actually costs.
 *
 * Granite 4.1 ships at 3b, 8b and 30b, and every one of them has a matching set
 * of RAG intrinsics — so the choice cascades cleanly: pick a size and the
 * adapters that were trained against those exact weights come with it. That is
 * not a given. Adapters are rank-32 deltas against a specific hidden size, and
 * a set trained for another base does not load at all.
 *
 * ── The column people will not think to ask about ───────────────────────────
 *
 * `activated`. IBM publishes each intrinsic twice: a plain LoRA, and an
 * *activated* one that engages only after its invocation tokens, which leaves
 * the base model's KV cache for the prompt valid. On `answerability` — which
 * runs once per source the research process reads, eight times a question —
 * that is 16.98s against 0.04s per call. It is the difference between research
 * being affordable and not.
 *
 * IBM ships the activated variants as safetensors only, so the GGUF conversions
 * are this project's own — 3b and 8b are done and published beside the app; 30b
 * is not, and until it is that size falls back to plain LoRA and a gate costing
 * seconds instead of milliseconds. That is a real difference in how the app
 * feels, so the setup says it out loud rather than letting someone discover it
 * as unexplained slowness.
 */

/** Where this project publishes what it converted itself. */
export const RELEASES = 'https://github.com/qubie-org/qi/releases/download/weights-v1'

export const MODELS = {
  '3b': {
    id: '3b',
    title: 'Granite 4.1 3B',
    repo: 'ibm-granite/granite-4.1-3b-GGUF',
    file: 'granite-4.1-3b-Q4_K_M.gguf',
    sha256: '662b0626cd58f443baea23559b469df6576a81d349649c59413b36a9fb32eb29',
    bytes: 2_099_501_664,
    /** Directory naming in granitelib-rag-r1.0. The two conventions differ. */
    lora: 'granite4.1_3b',
    alora: 'granite-4.1-3b',
    /** Activated adapters we have already converted to GGUF. */
    activated: ['answerability', 'query_clarification', 'query_rewrite'],
    activatedSha: {
      "answerability": "819d5d10e3fbe2e7ebdce078585afb4477131d991d1ed4a11ce0bbc421273502",
      "query_clarification": "9bb08cd41de220424e6cfcd5a2095643831a924cb5b4b7c742784b033360c796",
      "query_rewrite": "c312f60f44f6b3997824cadf912b7aa39d7770eb9cd1c7c7589b3a5bc26201f7"
    },
    ram: '8 GB',
    note: 'The one everything here was measured against.',
  },
  '8b': {
    id: '8b',
    title: 'Granite 4.1 8B',
    repo: 'ibm-granite/granite-4.1-8b-GGUF',
    file: 'granite-4.1-8b-Q4_K_M.gguf',
    sha256: 'ed902ac9eb6adce5a90c6a08c8ea201b50e23fdc5976d1cd0362006afac5309e',
    bytes: 5_350_000_000,
    lora: 'granite4.1_8b',
    alora: 'granite-4.1-8b',
    activated: ['answerability', 'query_clarification', 'query_rewrite'],
    activatedSha: {
      "answerability": "0894d09cbf87605ca29ea89c80c7d92e1ad911ba4dc167d486676b02262b5a25",
      "query_clarification": "598e8de6e6a675430f786addd061b93cf10d3805659b34577abf862412dad2c8",
      "query_rewrite": "1761c108def26c99ad8c94071fa4cb78082697b234913d93644561714b74cdeb"
    },
    ram: '16 GB',
    note: 'Better answers, same activated gate.',
  },
  '30b': {
    id: '30b',
    title: 'Granite 4.1 30B',
    repo: 'ibm-granite/granite-4.1-30b-GGUF',
    file: 'granite-4.1-30b-Q4_K_M.gguf',
    bytes: 17_490_000_000,
    lora: 'granite4.1_30b',
    alora: 'granite-4.1-30b',
    activated: [],
    ram: '32 GB',
    note: 'Mixture-of-experts. Large on disk, fewer active parameters than it looks.',
  },
}

/** The five intrinsics, in the order the server loads them. */
export const INTRINSICS = [
  'answerability',
  'citations',
  'hallucination_detection',
  'query_clarification',
  'query_rewrite',
]

/**
 * The release asset for an activated adapter.
 *
 * 3b was converted first and its assets carry no size in the name. Renaming
 * them would break every install already pointing at them, so the prefix
 * starts at 8b and 3b stays the exception.
 */
const assetName = (size, name) =>
  size === '3b' ? `rag-alora-${name}.gguf` : `rag-${size}-alora-${name}.gguf`

/** Everything a chosen size needs to fetch, as flat work items. */
export function plan(size) {
  const m = MODELS[size]
  if (!m) throw new Error(`unknown model size: ${size}`)

  const items = [
    {
      pack: 'core',
      to: m.file,
      url: `https://huggingface.co/${m.repo}/resolve/main/${m.file}`,
      bytes: m.bytes,
      sha256: m.sha256,
    },
  ]

  for (const name of INTRINSICS) {
    // An activated adapter is a different file from its plain twin and lives in
    // its own directory, which is what lets the server prefer one without a
    // second naming scheme. Where we have no conversion, the plain one is used
    // and the gate is slower — stated in `note` rather than hidden.
    const isActivated = m.activated.includes(name)
    items.push(
      isActivated
        ? {
            pack: 'rag',
            to: `alora/${name}.gguf`,
            // 3b was converted first and its assets are unprefixed; everything
            // after it carries its size. Renaming the originals would break
            // every install that already points at them.
            url: `${RELEASES}/${assetName(size, name)}`,
            sha256: m.activatedSha?.[name],
            bytes: size === '3b' ? 90_000_000 : 160_000_000,
          }
        : {
            pack: 'rag',
            to: `${name}.gguf`,
            url: `https://huggingface.co/ibm-granite/granitelib-rag-r1.0/resolve/main/${name}/${m.lora}/lora/Lora-bf16.gguf`,
            bytes: 60_000_000,
          },
    )
  }

  for (const f of ['model.onnx', 'tokenizer.json', 'config.json']) {
    items.push({
      pack: 'embed',
      to: f,
      url: `https://huggingface.co/ibm-granite/granite-embedding-30m-english/resolve/main/${f}`,
      bytes: f === 'model.onnx' ? 120_000_000 : 2_000_000,
    })
  }

  return items
}

export const human = (n) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : `${Math.round(n / 1e3)} kB`

export const totalBytes = (size) => plan(size).reduce((a, b) => a + (b.bytes ?? 0), 0)
