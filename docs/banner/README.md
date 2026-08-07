# The banner

`docs/banner.gif`, rendered from Remotion.

```bash
npm install
npx remotion studio                                  # to work on it
npm run gif                                          # → out/banner.gif
```

It is a rebuild of the interface rather than a recording of it, and that is the
point rather than a shortcut. A screenshot of a text river is the one thing that
cannot show what a text river is — the whole idea is that the answer arrives in
the line you typed into, and a still frame just shows a line with text in it,
which is what every app looks like. The behaviour is the product, so the banner
had to move.

The first attempt was three real screenshots warped into perspective. It looked
like a product page for something else.

Everything is driven by `useCurrentFrame`, so it renders deterministically and
loops: the thread fades out over the last 24 frames onto the same empty river it
opens on.
