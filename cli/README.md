# qiui

Set up and run [qi](https://github.com/qubie-org/qi) — a local text river with
Granite, research that cites its sources, and no account.

```sh
npx @qi-ui/cli setup     # choose a size, fetch it
npx @qi-ui/cli run       # start the model server and open the page
```

Or install it: `npm i -g @qi-ui/cli`, then `qiui`.

## Sizes

| | model | install | needs | gate |
|---|---|---|---|---|
| `3b` | Granite 4.1 3B | 2.6 GB | ~8 GB RAM | activated |
| `8b` | Granite 4.1 8B | 6.1 GB | ~16 GB RAM | activated |
| `30b` | Granite 4.1 30B | 17.9 GB | ~32 GB RAM | plain — slower |

The gate decides whether a page answers your question at all, and it runs once
per source read. Activated, it reuses the base model's cache and costs 0.04s;
plain, it reprocesses the prompt and costs seconds — eight times a question.
IBM ships the activated adapters as safetensors, so the GGUF conversions are
ours; 3b and 8b are done, 30b is not yet.

## Non-interactive

```sh
qiui setup --model 8b --yes
```

Without a terminal and without `--yes`, setup refuses rather than guessing —
`qiui` in a pipe should never move six gigabytes because nobody was there to
answer. Weights land in `~/.qi`, or `QI_HOME`.

## Needs

Node 20+, and `llama-server` on PATH (`brew install llama.cpp`).

AGPL-3.0.
