# Adding a grounding source, and changing the router

`SOURCES` in `src/ground/sources.ts` is the ten things the app can look up.
Adding one is four fields; getting it *routed* correctly is the hard part.

## The shape

```ts
{
  id: 'image',
  /** Phrases that should route here. Matched by embedding, not keywords. */
  anchors: ['photograph', 'a photo of an animal building or landscape', 'stock imagery'],
  /** Optional. Pulls the argument out of the user's sentence. */
  arg: (t) => topic(t).replace(/^(show me|find me)\s+/i, '').trim(),
  fetch: async (a) => json(`https://api.example.com/?q=${encodeURIComponent(a)}`),
  /** Body of `reduce(data)`. Runs in the QuickJS sandbox. Must return a Fact or null. */
  reducer: `…`,
}
```

`fetch` runs on the host, because it needs the network. `reducer` runs in the
wasm sandbox and is **the only thing that touches the response body**. A source
never gets to run code in the page. Keep that split; do not "simplify" a reducer
by moving it into `fetch`.

## Before you add it

Every source in the list answered a real cross-origin GET with no key, verified
by `tools/probe_endpoints.py`. The public-apis CORS column is self-reported and
often wrong. **Probe it first.** Nothing goes in that has not actually been
called from a browser context.

## Anchors

Anchors are embedded once at boot and the sentence is scored against them. Write
them as phrases a person would say, not as category labels.

Be specific enough to exclude. The ISS source is anchored on `international
space station`, `iss position`, `iss overhead` — an earlier anchor of
`astronauts orbit` swallowed "tell me about the apollo landing".

## Routing, and its two escape hatches

`route()` in `src/ground/index.ts` picks by cosine against anchors, with a
threshold. Two things bypass it, and both exist because **embedding similarity
scores topic, and some requests are about grammar rather than topic**:

- `LOOKUP_FORM` — "what is X" shapes fall through to the encyclopedia when no
  specialist claimed them. Disqualified when the sentence wants a list.
- `PICTURE_FORM` — "show me a photo of X" goes to the front outright, with no
  margin to beat.

`PICTURE_FORM` exists because "show me a photo of a lighthouse in a storm at
night with rain" routed to the weather service. The topic words really are
weather words, and the weather anchors outscored the photo anchors 0.39 to 0.36.
No amount of rewriting anchors fixes that: the sentence genuinely is about a
storm, it is just asking for a picture of one.

If you find yourself tuning anchors to fix a routing bug, first ask whether the
distinction is grammatical. If it is, it belongs in a form test, not in anchors.

## What must never happen

**Falling through from one specialist to another is not a fallback, it is a
change of subject.** "dollars to euros" scores 1.000 against the exchange-rate
anchors and 0.429 against the crypto ones. When the exchange-rate endpoint was
down, the crypto ticker answered and the screen said `64536` — a real number,
from a real host, with a real link, for a question about euros.

So `ordered` takes only the top specialist. The encyclopedia is the one
exception, because it is general-purpose: a legitimate second answer to any
question rather than the right answer to a different one.

**Nothing may be looked up when nothing was asked.** "thanks" and "i feel tired
today" must not reach an API index or a search engine, because both always have
something to return and returning it would be an answer to a question nobody
asked. The `chatter()` decline comes before any fetching at all.

## The reducer

It is a string, evaluated in the sandbox as the body of `reduce(data)`. It must
return a `Fact` or `null`.

```js
if (typeof data.altitude !== 'number') return null;
return {
  label: 'space station',
  value: String(data.altitude),
  src: 'wheretheiss.at',
  hint: 'ISS ' + Math.round(data.altitude) + 'km up',
  quantities: [
    { n: data.altitude, unit: 'km', precision: 0, path: 'altitude', raw: data.altitude }
  ]
};
```

- **Guard the shape.** `if (typeof x !== 'number') return null` at the top. A
  generic reducer inferring a field is one of the recurring failure modes in
  this codebase: a confident sentence with a real source link.
- **`quantities`** carry units, precision and a JSON path back to the raw value,
  so a number can be re-rendered and checked. Fill them in.
- **`chip` / `chipW` / `chipH`** make an image ride the baseline.
  **`candidates`** offers alternatives the reader can cycle.
- **Credit properly.** The image source uses Openverse because it returns
  creator and licence with every hit, which is the only kind of image source
  that can be shown without lying about where it came from.

## Widening a query that returns nothing

Openverse ANDs every term: "volcano" returns 240 images, "volcano erupting near
the ocean at midnight" returns zero. Every picture request was failing that way
and falling through to whichever source answered next.

The fix is a widening ladder — try the query whole, then its first three words,
then two, then one, and take the first attempt that returns anything. That keeps
a specific query specific and stops a long one being worth nothing at all. Copy
that pattern for any endpoint with conjunctive matching.

## Test

- `src/ground/__tests__/route.ts` — routing decisions. Add your case.
- `src/ground/__tests__/quantity.ts` — unit and precision handling.
- `src/ground/__tests__/leaf.ts` — that an extracted value actually occurs in
  the payload.

All three run under `bun test` and none touch the network.
