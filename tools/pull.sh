#!/usr/bin/env bash
# One way in for every weight qi runs.
#
#   tools/pull.sh              install everything marked required
#   tools/pull.sh see embed    install named packs
#   tools/pull.sh --list       what exists, what is here, what it costs
#
# Weights land in packs/<id>/ and nowhere else, so "what is installed" is a
# directory listing rather than a database. Removing a pack is `rm -rf`.
#
# Three things here were learned the hard way and are the reason this is not a
# one-line curl:
#
#  - The Xet client stalls at zero bytes against this CDN often enough that a
#    download either finishes or hangs forever with no way to tell which.
#    Measured at 5 KB/s where plain HTTPS did 2 MB/s. So: curl, always.
#
#  - A model's official repository is not always its fastest one. IBM's own
#    GGUF served at 50 KB/s while two community mirrors of the same weights
#    served at 2 MB/s — a four-minute download against a twenty-three-hour one.
#    Every source is probed before anything large is committed to.
#
#  - Mirrors are not byte-identical. A different llama.cpp version writes
#    different GGUF metadata, so the file differs even when the weights do not.
#    Each source therefore carries its own pinned hash, and the hash checked is
#    the one belonging to the source actually used.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
catalog="$root/src/model/catalog.json"
dest="$root/packs"

q() { python3 -c "
import json
packs=json.load(open('$catalog'))['packs']
$1
"; }

human() { python3 -c "
n=$1
for u in ['B','KB','MB','GB']:
    if n < 1024 or u == 'GB':
        print(f'{n:.0f} {u}' if u == 'B' else f'{n:.1f} {u}'); break
    n /= 1024
"; }

# Every declared file for a pack, as "remote-path<TAB>local-name".
#
# A file is usually just a path. It is {from, to} when the repo's own name
# would collide on the way down — granitelib calls all five of its adapters
# Lora-bf16.gguf, and they differ only by the directory they sit in.
plan_files() { q "
p=[x for x in packs if x['id']=='$1'][0]
for f in p['files']:
    print('\t'.join([f['from'], f['to']] if isinstance(f, dict) else [f, f.split('/')[-1]]))
"; }

if [ "${1:-}" = "--list" ]; then
  printf '%-8s %-20s %-9s %-10s %s\n' PACK TITLE SIZE STATE WHAT
  while IFS=$'\t' read -r id title bytes required; do
    # Installed means every declared file is on disk. An empty directory is a
    # pull that died, and calling that "installed" is how you get a server that
    # starts and then cannot find its weights.
    files=$(plan_files "$id")
    state=optional
    [ "$required" = "True" ] && state=needed
    if [ -n "$files" ]; then
      have=1
      while IFS=$'\t' read -r _ name; do
        [ -n "$name" ] && { [ -s "$dest/$id/$name" ] || have=0; }
      done <<< "$files"
      [ "$have" = 1 ] && state=installed
    fi
    what=$(q "print([p['what'] for p in packs if p['id']=='$id'][0][:48])")
    printf '%-8s %-20s %-9s %-10s %s…\n' "$id" "$title" "$(human "$bytes")" "$state" "$what"
  done < <(q "[print('\t'.join([p['id'],p['title'],str(p['bytes']),str(p.get('required',False))])) for p in packs]")
  exit 0
fi

# No argument means "make this thing runnable": the required packs and nothing
# else. Optional weight is always an explicit decision.
if [ $# -eq 0 ]; then
  set -- $(q "[print(p['id']) for p in packs if p.get('required')]")
fi

# Bytes per second from a short ranged read. 12 MB is enough to get past TCP
# slow start and cheap enough to spend on every candidate.
probe() {
  curl -sL --http1.1 --max-time 10 -w '%{speed_download}' -o /dev/null -r 0-12000000 "$1" 2>/dev/null || echo 0
}

for id in "$@"; do
  exists=$(q "print(int(any(p['id']=='$id' for p in packs)))")
  if [ "$exists" = 0 ]; then echo "no pack called '$id' — try --list" >&2; exit 1; fi

  files=$(plan_files "$id")
  if [ -z "$files" ]; then
    echo "── $id: declared but has no files pinned yet; skipping" >&2
    continue
  fi

  # Every source for this pack, official first, as "repo<TAB>sha-json".
  sources=$(q "
p=[x for x in packs if x['id']=='$id'][0]
rows=[(p['repo'], json.dumps(p.get('sha256',{})))]
for m in p.get('mirrors',[]):
    rows.append((m['repo'], json.dumps(m.get('sha256',{}))))
[print('\t'.join(r)) for r in rows]
")

  mkdir -p "$dest/$id"
  first=$(echo "$files" | head -1 | cut -f1)

  # Probe only when there is something substantial left to fetch; for a pack
  # already on disk the probes would cost more than the download.
  need=0
  while IFS=$'\t' read -r _ name; do
    [ -n "$name" ] && { [ -s "$dest/$id/$name" ] || need=1; }
  done <<< "$files"
  if [ "$need" = 0 ]; then echo "have $id"; continue; fi

  best_repo=""
  best_sha=""
  best_rate=0
  while IFS=$'\t' read -r repo shas; do
    [ -z "$repo" ] && continue
    rate=$(probe "https://huggingface.co/$repo/resolve/main/$first")
    rate=${rate%%.*}
    printf '   %-52s %6.2f MB/s\n' "$repo" "$(echo "$rate" | awk '{print $1/1048576}')"
    if [ "${rate:-0}" -gt "$best_rate" ]; then
      best_rate=$rate
      best_repo=$repo
      best_sha=$shas
    fi
  done <<< "$sources"

  [ -z "$best_repo" ] && { echo "no source reachable for $id" >&2; exit 1; }
  echo "── $id ← $best_repo"

  while IFS=$'\t' read -r f name; do
    [ -z "$name" ] && continue
    out="$dest/$id/$name"
    if [ -s "$out" ]; then echo "have $id/$name"; continue; fi
    # --http1.1 is not a preference. Over HTTP/2 this CDN drops long transfers
    # with "stream was not closed cleanly: CANCEL", and curl treats a cancelled
    # stream as a completed one, so a 4 GB download ends at 13 MB and reports
    # success. --speed-limit turns a stall into a failure, which -C - then
    # resumes from; without it a wedged connection hangs forever.
    curl -fL --http1.1 --retry 20 --retry-delay 2 --retry-all-errors -C - \
      --speed-limit 51200 --speed-time 20 --progress-bar \
      -o "$out.part" "https://huggingface.co/$best_repo/resolve/main/$f"

    want=$(python3 -c "
import json
print(json.loads('''$best_sha''').get('$name',''))
")
    if [ -n "$want" ]; then
      got=$(shasum -a 256 "$out.part" | awk '{print $1}')
      if [ "$got" != "$want" ]; then
        echo "checksum mismatch for $name" >&2
        echo "  want $want" >&2
        echo "  got  $got" >&2
        rm -f "$out.part"
        exit 1
      fi
      echo "   sha256 ok"
    else
      echo "   no hash pinned for $name — not verified" >&2
    fi
    # The .part rename is what makes an interrupted or corrupt pull impossible
    # to mistake for a finished one.
    mv "$out.part" "$out"
  done <<< "$files"
done

echo
"$0" --list
