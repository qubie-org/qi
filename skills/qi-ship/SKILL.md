---
name: qi-ship
description: Build, sign, notarise, package and release qi — the Swift app bundle, the dylib closure rewrite, Sparkle updates and the appcast, the weights release, and publishing @qi-ui/cli to npm. Use when asked to make a build, produce a DMG, sign or notarise the Mac app, cut a release, publish converted adapters, ship an update, or explain the licence and the notices the app carries.
license: AGPL-3.0-or-later
compatibility: macOS with Xcode command line tools and Swift 6.2. Notarisation needs a Developer ID certificate and an App Store Connect key.
metadata:
  org.qubie.qi.role: ship
---

# Shipping qi

## Build

```sh
npx vite build              # the page, into dist/
bash native/build.sh        # → native/Qi.app
bash native/build.sh run    # …and launch it
```

SwiftPM builds an executable and stops there: no Info.plist, no bundle layout,
no signature. All three are `native/build.sh`'s job, and skipping any one
produces something that runs from a terminal and does nothing when
double-clicked.

There is no `.pbxproj` and there will not be one. A pbxproj is a file no one
should be editing by hand and every tool corrupts differently.

What `build.sh` assembles, in order:

1. `swift build -c release`, then copy the binary and `Info.plist`.
2. The icon. `CFBundleIconFile` names it **without the extension** and the file
   must be in `Resources/` — a missing or misnamed one gets the blank white
   placeholder, silently, with no build error.
3. **Lightpanda** into `Contents/MacOS/`, not `Resources/` — macOS expects
   anything runnable there and code signing treats the two differently. Its
   AGPL notice is written alongside it.
4. **`llama-server`** and its whole dylib closure, rewritten to `@rpath`, so the
   app carries its own model server rather than depending on a Homebrew tree.
5. The built page from `dist/`. Skipped when `dist/` is absent, which leaves a
   build that still runs against `bun run dev` — the developer case, and it
   should keep working.
6. **Sparkle**, as a framework with its own XPC services rather than a static
   library, plus the rpath. Without that the app links fine and dies at launch
   naming a path that was never going to exist.
7. The weights, if `QI_BUNDLE_PACKS=1`.
8. The signature.

## Signing

Ad-hoc by default, because that is what a local build wants and it needs no
certificate:

```sh
codesign --force --sign - --timestamp=none
```

For something notarizable:

```sh
QI_SIGN_ID="Developer ID Application: … (TEAMID)" bash native/build.sh
```

which switches to `--force --sign "$id" --options runtime --timestamp`. Both
extra flags are **mandatory** for notarisation: `--options runtime` is the
hardened runtime, without which Apple rejects the submission; `--timestamp` is a
secure timestamp from Apple's server, and a signature without one cannot be
verified once the certificate expires. The ad-hoc path passes
`--timestamp=none`, which is correct there and fatal here.

**Inside-out, never `--deep`.** Every nested binary carries its own signature
before the bundle is sealed around it, deepest first — a dylib signed after the
app that contains it invalidates the outer seal. `--deep` produces something
that notarizes and then refuses to launch. Sparkle's nested `.xpc` and `.app`
helpers are one level deeper again and each must be signed before the framework
is sealed.

**Ad-hoc is only enough while the app asks for no permissions.** The moment it
wants Screen Recording, the microphone, or anything else behind TCC, it needs a
stable Developer ID — re-signing ad-hoc silently revokes those grants on every
rebuild, which is a genuinely baffling failure to debug from the far end.

## Notarisation — the current gap

**Nothing in this repository submits the app for notarisation.** `build.sh` will
produce a notarizable bundle when `QI_SIGN_ID` is set, and that is where it
stops. Gatekeeper will complain on any machine that did not build it.

The missing steps, once a Developer ID build exists:

```sh
ditto -c -k --keepParent native/Qi.app /tmp/Qi.zip
xcrun notarytool submit /tmp/Qi.zip --keychain-profile "<profile>" --wait
xcrun stapler staple native/Qi.app
xcrun stapler validate native/Qi.app
```

Staple the DMG too if you ship one — a stapled app inside an unstapled disk
image still triggers a network check on first launch.

Do not describe qi as notarised until this exists in `build.sh` and has been
run. See the README's "what does not work yet".

## Weights, and why the app is small

The weights left the bundle deliberately. Inside, the app worked the moment it
was copied and never touched the network; outside, every Sparkle update is the
app rather than the app plus 2.5 GB of model files that did not change. The
second property is worth more because it is paid every release and the first is
paid once.

What it costs is that a fresh install needs the network exactly once — which is
why `Install.swift` is careful, and why `QI_BUNDLE_PACKS=1` remains supported
rather than a path that quietly rots.

## Updates

Sparkle, checking daily.

- Signed with an **EdDSA key whose private half is in the Keychain and in
  Cloudflare's Secrets Store, and nowhere near this repository.** The public
  half is in `Info.plist`, which is what makes it safe to serve updates from a
  URL anyone could serve: the transport is not the thing being trusted.
- The **appcast is an asset on the latest GitHub release**, so releases and the
  document describing releases are the same artefact and cannot drift. No second
  server to forget, and rolling back a release rolls back the feed with it.

## Releasing

Full checklist: [release.md](references/release.md). The shape:

1. Tests green (`bun test`), and the domain eval run if the research process
   changed.
2. Version bumps: `native/Info.plist`, `cli/package.json`, `plugin.json`.
3. Build, sign, notarise, staple.
4. DMG.
5. GitHub release, with the appcast as an asset.
6. Converted adapters go to the **`weights-v1`** tag, not the app release —
   installs already point at it, and moving them breaks every one.
7. `npm publish` from `cli/`, which is `@qi-ui/cli`, public access.

## Licence, stated correctly

Two halves, and both matter:

- **qi is AGPL-3.0**, and that is the licence Lightpanda already obliges. qi
  bundles it; it is AGPL-3.0. The choice follows from that rather than being an
  incidental consequence. The notice travels with the binary:
  `Contents/Resources/LIGHTPANDA-LICENSE.txt`.
- **The Granite weights are Apache-2.0 and IBM's**, not covered by qi's licence.

Never state one half without the other.
