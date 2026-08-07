---
name: qi-setup
description: Install, run and verify qi — either from npm via @qi-ui/cli or from source with bun, vite and llama-server. Use when setting up qi for the first time, choosing a model size, starting or stopping the model server, checking that generation, tool calling, grammars and the adapter shelf actually work, or diagnosing an install that produces no answers, no sound, no images, a blank page or a connection error.
license: AGPL-3.0-or-later
compatibility: macOS on Apple silicon. Requires Node 20+; llama-server on PATH (brew install llama.cpp); 8/16/32 GB RAM depending on model size.
metadata:
  org.qubie.qi.role: setup
---

# Setting qi up, and proving it works

Two ways in. Pick by what the user is doing, not by preference.

## Path A — just run it

For someone who wants the app, not the repository.

```sh
npx @qi-ui/cli setup     # asks one question: which size
npx @qi-ui/cli run       # starts llama-server and opens the page
npx @qi-ui/cli status    # what is installed, what is running
npx @qi-ui/cli models    # the sizes and what each costs
```

Weights land in `~/.qi/packs`, or `$QI_HOME/packs`. Downloads resume and are
checked against a pinned hash.

Non-interactive:

```sh
npx @qi-ui/cli setup --model 8b --yes
```

Without a TTY and without `--yes`, setup **refuses** rather than assuming
consent. Do not add a flag to work around this — it exists because the CLI once
downloaded 2.5 GB when run with no arguments in a pipe.

Choosing a size: `3b` unless the user has a reason. It is the only size every
number in this project was measured against. `8b` is the only alternative — 30b
was offered and has been withdrawn, because no file in its plan carried a
`sha256`. See `qi-models` before recommending anything else.

## Path B — from source

For anyone editing the code.

```sh
bun install
bash tools/pull.sh          # every required weight, ~2.5 GB
bash tools/serve.sh         # the model server(s), one per installed pack
bun run dev                 # the page, on Vite
```

`tools/pull.sh --list` shows what exists, what is present, and what it costs.
`tools/pull.sh see embed` installs named packs only.

Three ports matter:

| Port | What |
|---|---|
| `8082` | `core` — Granite 4.1, the shelf of five adapters |
| `8083` | `see` — the vision pack, only if installed |
| `8085` | `fast` — granite-4.0-h-tiny, only if installed |
| `8777` | the Swift app's control port, for the MCP tools |

There is no configuration. What runs is what is on disk: install a pack and it
gets a server on the next start, remove it and it does not. The page discovers
the same thing over `/packs/installed`, so neither side holds a stale list.

## Prove it works

Do not declare a setup finished on the strength of the page loading. Run:

```sh
bash tools/check.sh          # against :8082
bash tools/check.sh 8083     # against another pack's server
```

It tests four claims over curl, with no browser and no build step, and each one
is load-bearing somewhere:

1. **tool calling** — the agent loop is built on it.
2. **JSON-schema grammars** — the digest and every intrinsic are built on them.
3. **documents reach the chat template** — the RAG adapters were trained with
   documents in the template, and there is no field for them in an OpenAI
   request. The probe word is deliberately not a real word: if the model repeats
   it, it read the document.
4. **the shelf** — an adapter selected per request actually changes the answer.
   Otherwise an intrinsic is base weights wearing a hat, which looks identical
   from the outside.

If check 4 fails, read `references/troubleshooting.md` first. It has failed for
a reason that produces no error anywhere.

There is also a script in this skill:

```sh
bash scripts/doctor.sh
```

It checks prerequisites and reports what is missing, without downloading or
starting anything.

## The test suite

```sh
bun test
```

Twelve suites, none of which touch the network. They are fast and they are the
gate for any edit. `src/ground/__tests__/domains.ts` is **not** in this suite —
it reaches real endpoints and takes about fifteen minutes. See `qi-research`.

## The standalone app

```sh
npx vite build
bash native/build.sh        # → native/Qi.app
bash native/build.sh run    # …and launch it
```

The app carries its own `llama-server` and its own Lightpanda, serves the page
over a loopback HTTP server, and installs weights to Application Support on
first run. `QI_BUNDLE_PACKS=1` bundles the weights instead and needs no network
at all. Details and signing in `qi-ship`.

## Reference

- [troubleshooting.md](references/troubleshooting.md) — every failure mode this
  project has actually had, with the symptom that identifies it. Read the
  symptom column, not the cause column.
