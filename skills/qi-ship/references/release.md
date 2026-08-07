# Release checklist

Three artefacts are released independently and on their own schedules. Do not
conflate them.

| Artefact | Where | Cadence |
|---|---|---|
| The Mac app | GitHub release + `appcast.xml` asset | whenever the app changes |
| Converted adapters | the **`weights-v1`** tag, permanently | only when new conversions exist |
| `@qi-ui/cli` | npm | whenever the CLI or `models.mjs` changes |

## Before anything

```sh
bun test                      # the twelve suites. Green, or stop.
bash tools/check.sh           # four claims, against a running server
node skills/qi-models/scripts/cards.mjs   # no "unverified" in a plan you ship
```

If the research process changed, run the domain evaluation and record the
numbers. See `qi-research`. A release that changes research behaviour without
comparable numbers is not a release anyone can reason about afterwards.

## 1 · The Mac app

### Versions

| File | Key |
|---|---|
| `native/Info.plist` | `CFBundleShortVersionString`, and the build number |
| `cli/package.json` | `version` |
| `plugin.json` | `version` |

Sparkle compares the build number. Bump it every release, including a rebuild of
the same version — a feed whose newest entry is not newer than the installed
build is an update that silently never offers itself.

### Build and sign

```sh
npx vite build
QI_SIGN_ID="Developer ID Application: … (TEAMID)" bash native/build.sh
```

Confirm before going further:

```sh
codesign -dv --verbose=4 native/Qi.app
codesign --verify --strict --verbose=2 native/Qi.app
spctl -a -t exec -vv native/Qi.app
```

The last one will fail until the app is notarised. That is expected, and it is
the point of the next step.

### Notarise

**This is not automated in the repository.** There is no `notarytool` call in
`build.sh`. Do it by hand, and consider adding it:

```sh
ditto -c -k --keepParent native/Qi.app /tmp/Qi.zip
xcrun notarytool submit /tmp/Qi.zip --keychain-profile "<profile>" --wait
xcrun stapler staple native/Qi.app
xcrun stapler validate native/Qi.app
spctl -a -t exec -vv native/Qi.app     # should now accept
```

If the submission is rejected, `xcrun notarytool log <id>` names the offending
binary. The usual causes here are a nested helper signed after its container,
or a missing `--options runtime`.

### DMG

**Also not scripted.** `dist-dmg/Qi-0.1.dmg` was produced by hand. If you make
one, staple it as well — a stapled app inside an unstapled disk image still
triggers a network check on first launch.

Two builds are worth distinguishing:

| | Size | Needs network on first run |
|---|---|---|
| default | ~140 MB | yes, once — weights to Application Support |
| `QI_BUNDLE_PACKS=1` | ~2.3 GB | no |

The bundled build exists so that an app opened on a plane works. Keep it
buildable.

### Publish

Create the GitHub release, attach the DMG, and attach **`appcast.xml`**.

The appcast being an asset on the latest release is deliberate: releases and the
document describing releases are then the same artefact and cannot drift. There
is no second server to forget, and rolling back a release rolls back the feed
with it. `SUFeedURL` points at
`https://github.com/qubie-org/qi/releases/latest/download/appcast.xml`.

Sign the update with the EdDSA private key. **It lives in the Keychain and in
Cloudflare's Secrets Store, and nowhere near this repository.** Sparkle refuses
anything the public half in `Info.plist` does not verify, which is what makes it
safe to serve updates from a URL anyone could serve — the transport is not the
thing being trusted.

## 2 · Converted adapters

Adapters go to the **`weights-v1`** tag and stay there. Do not move them onto an
app release: `RELEASES` in `cli/models.mjs` and `Install.releaseTag` in
`Install.swift` both point at that tag, and every existing install resolves
through it.

Naming, from `assetName()`:

```
3b      rag-alora-<name>.gguf          unprefixed — the exception
others  rag-<size>-alora-<name>.gguf
```

3b was converted first and its assets carry no size in the name. Renaming them
would break every install already pointing at them.

After uploading, edit `cli/models.mjs`: the hash into `activatedSha`, the name
into `activated`. That second edit is what changes what `qiui setup` tells a
person they are getting.

Full procedure in `qi-train`.

## 3 · `@qi-ui/cli`

```sh
cd cli
npm publish            # publishConfig.access is already "public"
```

`files` is `qiui.mjs`, `models.mjs`, `README.md`. Nothing else ships, and there
are no dependencies to audit.

Before publishing, run the thing you are about to release against a clean home:

```sh
QI_HOME=/tmp/qi-test node cli/qiui.mjs setup --model 3b --yes
QI_HOME=/tmp/qi-test node cli/qiui.mjs status
```

Two failures have already been caught this way and both are the kind that only
appear on a fresh machine:

- Running with no arguments in a pipe downloaded 2.5 GB, because no TTY was
  read as "assume yes".
- `qiui run` died with `ERR_INVALID_STATE` **after** spawning the model server,
  because an open `FileHandle` was garbage-collected — since Node 22 that is an
  error rather than a warning.

## After

- Update the README if a size, a requirement, or an item in "what does not work
  yet" changed. Notarisation and the 8b never-run status are both in that list;
  if you fix one, remove it.
- If a fact in `src/model/catalog.json` or `cli/models.mjs` changed, nothing
  else needs editing — the cards script reads them. That is the design; do not
  transcribe them into a changelog.
- Write the commit message in the repository's voice: what changed, what it was
  measured against, and what failed on the way. Read `git log` first.
