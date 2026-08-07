# Troubleshooting

Every entry here is a failure this project has actually had. They are ordered by
how hard they are to identify from the symptom, worst first. Match on the
**symptom**; the cause is almost never guessable from it.

## The model emits `<tool_call></tool_response>` forever

The adapter shelf is applied rather than merely loaded.

`--lora-init-without-apply` is documented to load adapters without applying
them. In llama.cpp **b10250 it does not**: `/lora-adapters` reports every
adapter at scale 1.0, and five rank-32 deltas stacked on top of each other turn
the model into a machine that emits that string and nothing else.

It passes no test and fails no startup check. The server comes up fine and the
weights are quietly wrong.

Check:

```sh
curl -s http://127.0.0.1:8082/lora-adapters | python3 -m json.tool
```

Every `scale` must be `0`. Fix — zero them once the server answers:

```sh
curl -s -X POST http://127.0.0.1:8082/lora-adapters \
  -H 'content-type: application/json' \
  -d '[{"id":0,"scale":0},{"id":1,"scale":0},{"id":2,"scale":0},{"id":3,"scale":0},{"id":4,"scale":0}]'
```

The Swift app does this automatically in `Model.silence()`. If you upgrade
llama.cpp, re-check this before anything else.

## `tools/check.sh` claim 4 fails — "the shelf"

An adapter selected per request does not change the answer. Two causes:

1. The scales are not zeroed (above), so every adapter is always on and naming
   one changes nothing.
2. Two copies of one adapter are on the shelf under different ids. A name
   appearing in both `packs/rag/` and `packs/rag/alora/` is the *same* intrinsic
   in two forms, and the activated one must win. Loading both means a request
   naming the plain one silently gets different weights.

The union rule lives in `tools/serve.sh` and is duplicated in
`Model.adapters()`. Both enumerate every name either directory offers and prefer
`alora/`. Driving the loop off the plain files and checking for an activated
twin looked equivalent and was not: deleting a superseded plain file removed the
only thing naming its intrinsic, and three adapters silently stopped loading.

## The download hangs at 0 B/s, or crawls

Hugging Face's Xet client stalls against this CDN often enough that a download
either finishes or hangs forever with no way to tell which — measured at 5 KB/s
where plain HTTPS did 2 MB/s.

`tools/pull.sh` uses curl, always. Do not "improve" it with `huggingface-cli`.
`HF_XET_HIGH_PERFORMANCE=1` does nothing in the Swift installer either, because
nothing there is `huggingface_hub` — it is URLSession against `/resolve/main/`,
a plain CDN redirect. Throughput there comes from asking for several byte ranges
at once.

Also: a model's official repository is not always its fastest. IBM's own GGUF
served at 50 KB/s while two community mirrors of the same weights served at
2 MB/s — four minutes against twenty-three hours. `pull.sh` probes every source
before committing to anything large, and **each mirror carries its own hash**,
because a different llama.cpp version writes different GGUF metadata and the
file differs even when the weights do not.

## The server refuses to load a model that downloaded "fine"

A corrupt GGUF. This has happened, and `llama-bench` benchmarked it perfectly
happily — nothing noticed until the server refused it.

```sh
shasum -a 256 packs/core/granite-4.1-3b-Q4_K_M.gguf
```

Compare against `src/model/catalog.json`. A mismatch means delete and re-fetch.

Related: the 3b checksum in `cli/models.mjs` was once wrong in a specific way
worth recognising — its first sixteen characters were real and the remaining
forty-eight were invented. Every hash in this repository must come from
HuggingFace's LFS oid or from hashing the file. Never from memory.

## An interrupted install never resumes

A partial download leaves a directory full of `.partN` files. Treating the
directory's existence as "installed" is how a first run that was cancelled once
never resumes. `Install.complete()` checks for the *files*, not the directory.
If you are stuck, `rm -rf` the pack directory and start again.

## The page is blank, or the sandbox never starts

The wasm sandbox needs a `SharedArrayBuffer`, which the browser only grants to a
cross-origin-isolated document. Isolation requires two response headers, and it
requires them on **every resource the page loads**, not only the document — miss
it on the wasm and the `SharedArrayBuffer` is simply absent, with no error
naming the cause.

- In development, Vite sets them.
- In the app, `Serve.swift` sets them on every response. That is why the app
  serves over loopback HTTP rather than `file://`: `file://` has no responses to
  put headers on.

Check in the page console: `crossOriginIsolated` must be `true`.

## The app will not start, or starts with no model

- **Port already in use.** `Model.start()` checks whether something already
  answers on 8082 and declines rather than producing a bind error, an app with
  no model, and no obvious connection between the two. During development this
  is usually your own `tools/serve.sh`.
- **No `llama-server`.** `brew install llama.cpp`. In the app it is bundled;
  `native/build.sh` walks its dylib closure and rewrites it to `@rpath`.
- **Read the log.** The bundled server writes to
  `$TMPDIR/qi-llama.log`, not to the app's stderr, so a crash leaves something
  to read.

## Sound arrives a second or two late, intermittently

`AudioContext.currentTime` is not smooth. Sampled every 100 ms against the wall
clock it stalled in 42 of 60 ticks — falling as much as 464 ms behind, then
lurching 128 ms forward. superdough rejects any deadline at or behind its clock,
so a 40 ms lead computed during a stall is already in the past when it is read.

`audioNow()` in `src/engine/sound.ts` treats the reported time as a floor and
advances it with the wall clock in between. If you touch scheduling, do not
reach for `ctx.currentTime` directly.

Also: no sound at all before the first gesture is correct. Every browser refuses
to start an `AudioContext` otherwise.

## A picture request returns a temperature

Two different bugs have produced this.

1. **Routing.** "show me a photo of a lighthouse in a storm at night" is
   genuinely about a storm, and the weather anchors outscored the photo anchors
   0.39 to 0.36. Fixed by `PICTURE_FORM` — a test on the sentence's *grammar*,
   which puts the image source at the front with no margin to beat.
2. **Openverse ANDs every term.** "volcano" returns 240 images; "volcano
   erupting near the ocean at midnight" returns zero, and the request fell
   through to whichever source answered next. Fixed by widening: the query is
   tried whole, then shortened to its first three words, two, one.

If the model *declines* to call the tool at all and says it cannot display
images, that is the open defect in the README, not this.

## The model answers with a single emoji

An old system prompt opened "You answer in very few words" and mentioned tools
fourth. Asked to be brief above all else, a 3B obliges, and an emoji is the
briefest thing there is. The obligation to call a tool must come **first** in
`SYSTEM` in `src/agent/loop.ts`. Ordering there is load-bearing, not stylistic.

## A command or app silently does not appear

`import.meta.glob` is rewritten by Vite at build time by *reading the source*.
It must appear literally, with literal arguments, at the top level of
`src/skills/discover.ts`. A helper that forwards to it type-checks, runs, and
returns an empty object. No commands, no error.

Also: `commandFrom` returns null without an `id` or a `run()`, and logs a
warning naming the path. Check the console.

## The eval dies partway through

Lightpanda has segfaulted on a chrome-heavy page, taking fifteen minutes of real
network traffic with it. `domains.ts` is driven in slices from outside and each
slice hands its results back so the caller can write them down. Do not run it as
one call.
