#!/usr/bin/env bash
# Compile and assemble Qi.app.
#
# SwiftPM builds an executable and stops there: no Info.plist, no bundle layout,
# no signature. All three are this script's job, and skipping any one of them
# produces something that runs from a terminal and does nothing when
# double-clicked.
#
#   native/build.sh          build, assemble, sign
#   native/build.sh run      …and launch it
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
app="$here/Qi.app"
conf="${QI_CONFIG:-release}"

echo "── swift build ($conf)"
swift build -c "$conf" --package-path "$here"
binary="$(swift build -c "$conf" --package-path "$here" --show-bin-path)/qi"

echo "── assemble $(basename "$app")"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$binary" "$app/Contents/MacOS/qi"
cp "$here/Info.plist" "$app/Contents/Info.plist"

# ── the browser ─────────────────────────────────────────────────────────────
# Lightpanda renders pages whose content only exists after their own JavaScript
# has run. It is a helper *executable*, so it goes in Contents/MacOS rather than
# Resources — macOS expects anything runnable to live there, and code signing
# treats the two directories differently.
#
# It is AGPL-3.0. Qi is too, so shipping them together is consistent, but the
# licence travels with the binary and the notice below travels with it.
lp="${QI_LIGHTPANDA_SRC:-$(command -v lightpanda || true)}"
if [ -n "$lp" ] && [ -x "$lp" ]; then
  cp "$lp" "$app/Contents/MacOS/lightpanda"
  cat > "$app/Contents/Resources/LIGHTPANDA-LICENSE.txt" <<'NOTICE'
This application bundles Lightpanda (https://lightpanda.io), a headless browser
licensed under the GNU Affero General Public License v3.0.

Source: https://github.com/lightpanda-io/browser
NOTICE
  echo "── bundled lightpanda ($(du -h "$lp" | cut -f1))"
else
  echo "── no lightpanda on PATH; the app will fall back to a plain fetch" >&2
fi

# ── the page ────────────────────────────────────────────────────────────────
# A shipped app has no dev server, so it carries the built page and serves it
# itself — see Serve.swift for why that is an HTTP server and not file://.
# Skipped when dist/ is absent, which leaves a build that still runs against
# `bun run dev`; that is the developer case and it should keep working.
root="$(cd "$here/.." && pwd)"
if [ -d "$root/dist" ]; then
  cp -R "$root/dist" "$app/Contents/Resources/web"
  echo "── bundled page ($(du -sh "$root/dist" | cut -f1))"
else
  echo "── no dist/; app will use the dev server (run: npx vite build)" >&2
fi

# The catalogue travels with the app: it is what the downloader reads to know
# which weights exist, where they come from and what they should hash to. One
# document, three readers (installer, page, app) — a second copy would be a
# second thing to forget.
cp "$root/src/model/catalog.json" "$app/Contents/Resources/catalog.json"

# ── the model server ────────────────────────────────────────────────────────
# llama-server is a Homebrew binary with a chain of dylibs behind it, half of
# them referenced by absolute path. Copied as-is it runs only on a machine with
# the identical Homebrew tree, which is to say only on this one. So the closure
# is copied into Frameworks/ and every install name is rewritten to @rpath.
#
# The Metal shaders need no handling: ggml embeds them, which the log confirms
# with "using embedded metal library".
if [ "${QI_BUNDLE_LLAMA:-1}" = "1" ] && command -v llama-server > /dev/null; then
  real="$(readlink -f "$(command -v llama-server)")"
  mkdir -p "$app/Contents/Frameworks"
  cp "$real" "$app/Contents/MacOS/llama-server"

  # Walk the closure rather than listing it: a version bump changes the names,
  # and a hard-coded list would keep building until the day it silently missed
  # one and shipped an app that cannot start its own model.
  python3 - "$real" "$app/Contents/Frameworks" <<'CLOSURE'
import os, subprocess, shutil, sys
binary, out = sys.argv[1], sys.argv[2]
libdir = os.path.join(os.path.dirname(os.path.dirname(binary)), 'lib')
seen, queue = set(), [binary]
def deps(p):
    r = subprocess.run(['otool', '-L', p], capture_output=True, text=True).stdout
    return [l.split(' (')[0].strip() for l in r.splitlines()[1:]]
while queue:
    p = queue.pop()
    rp = os.path.realpath(p.replace('@rpath', libdir).replace('@loader_path/../lib', libdir))
    if rp in seen or not os.path.exists(rp): continue
    seen.add(rp)
    if rp.startswith('/usr/lib') or rp.startswith('/System'): continue
    if rp != os.path.realpath(binary):
        shutil.copy2(rp, os.path.join(out, os.path.basename(rp)))
    queue.extend(deps(rp))
# The soname each binary actually asks for is often a symlink to the versioned
# file. Recreate those, or the loader looks for a name nothing provides.
for name in os.listdir(out):
    parts = name.split('.')
    if len(parts) > 3 and parts[-1] == 'dylib':
        short = '.'.join(parts[:2]) + '.dylib'
        link = os.path.join(out, short)
        if not os.path.exists(link):
            os.symlink(name, link)
CLOSURE

  chmod u+w "$app/Contents/Frameworks/"*.dylib "$app/Contents/MacOS/llama-server"
  for lib in "$app/Contents/Frameworks/"*.dylib; do
    [ -L "$lib" ] && continue
    install_name_tool -id "@rpath/$(basename "$lib")" "$lib" 2>/dev/null || true
    # `|| true` on the whole pipeline, not on the body. A dylib with no
    # Homebrew references makes grep exit 1, the while loop inherits it, and
    # `set -e` ends the build there — silently, three lines into a loop that had
    # nothing to do. libcrypto is the one that has nothing to do.
    otool -L "$lib" | tail -n +2 | awk '{print $1}' | grep "^/opt/homebrew" | while read -r dep; do
      install_name_tool -change "$dep" "@rpath/$(basename "$dep")" "$lib" 2>/dev/null || true
    done || true
  done
  otool -L "$app/Contents/MacOS/llama-server" | tail -n +2 | awk '{print $1}' \
    | grep "^/opt/homebrew" | while read -r dep; do
    install_name_tool -change "$dep" "@rpath/$(basename "$dep")" "$app/Contents/MacOS/llama-server" 2>/dev/null || true
  done || true
  install_name_tool -delete_rpath "@loader_path/../lib" "$app/Contents/MacOS/llama-server" 2>/dev/null || true
  install_name_tool -add_rpath "@loader_path/../Frameworks" "$app/Contents/MacOS/llama-server" 2>/dev/null || true
  echo "── bundled llama-server + $(ls "$app/Contents/Frameworks" | grep -c dylib) dylibs ($(du -sh "$app/Contents/Frameworks" | cut -f1))"
fi

# ── the weights ─────────────────────────────────────────────────────────────
# Everything, in the bundle. No runtime downloads: an app that fetches two and a
# half gigabytes the first time it is opened is an app that does not work on the
# aeroplane where someone finally has time to try it.
if [ "${QI_BUNDLE_PACKS:-1}" = "1" ] && [ -d "$root/packs" ]; then
  mkdir -p "$app/Contents/Resources/packs"
  for pack in core rag embed; do
    [ -d "$root/packs/$pack" ] && cp -R "$root/packs/$pack" "$app/Contents/Resources/packs/"
  done
  echo "── bundled packs ($(du -sh "$app/Contents/Resources/packs" | cut -f1))"
fi

# Ad-hoc is enough for something that asks for no permissions. The moment this
# app wants Screen Recording, the microphone, or anything else behind TCC, it
# needs a stable Developer ID identity instead — re-signing ad-hoc silently
# revokes those grants on every rebuild, which is a genuinely baffling failure
# to debug from the far end.
# Inside-out, never --deep. A nested executable must carry its own signature
# before the bundle is sealed around it; --deep produces something that
# notarizes and then refuses to launch.
echo "── sign (ad-hoc, inside-out)"
# Every nested binary carries its own signature before the bundle is sealed
# around it. Deepest first: a dylib signed after the app that contains it
# invalidates the outer seal.
for lib in "$app/Contents/Frameworks/"*.dylib; do
  [ -e "$lib" ] || continue
  [ -L "$lib" ] && continue
  codesign --force --sign - --timestamp=none "$lib" >/dev/null 2>&1
done
for exe in lightpanda llama-server; do
  [ -f "$app/Contents/MacOS/$exe" ] && codesign --force --sign - --timestamp=none "$app/Contents/MacOS/$exe" >/dev/null 2>&1
done
codesign --force --sign - --timestamp=none "$app" >/dev/null 2>&1

echo "── $(du -sh "$app" | cut -f1)  $app"

if [ "${1:-}" = "run" ]; then
  # The page has to be being served by something. Say so plainly rather than
  # opening a window onto a connection error.
  url="${QI_URL:-http://localhost:8322}"
  if ! curl -sf --max-time 2 "$url" >/dev/null; then
    echo
    echo "   nothing is serving $url — start it with: bun run dev" >&2
    echo "   (and tools/serve.sh for the model)" >&2
  fi
  # `open` launches through LaunchServices, which does not carry this shell's
  # environment — so QI_CONTROL would be silently dropped and the debug port
  # would never open. Exec the binary directly when it is asked for.
  if [ -n "${QI_CONTROL:-}" ]; then
    echo "── running with control port ${QI_CONTROL_PORT:-8777}"
    exec "$app/Contents/MacOS/qi"
  fi
  open "$app"
fi
