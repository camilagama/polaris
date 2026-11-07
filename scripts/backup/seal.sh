#!/usr/bin/env bash
# Seals what dump.sh wrote: one tar (manifest.json, roles.sql, dump) encrypted with age to the reviewed public keys,
# then the plaintext directory is removed (docs/runbooks/backup.md).
#
#   seal.sh <plaintext directory> <recipients file> <sealed file>
#
# The recipients file holds age public keys (age1...), one per line, and comments; anything else refuses, and so does
# a file without a key. Prints the SHA-256 and the size of the sealed file, nothing of its content.
set -euo pipefail
umask 077

fail() {
  echo "backup: $*" >&2
  exit 1
}

work=${1:-}
recipients=${2:-}
sealed=${3:-}
[ -n "$work" ] && [ -n "$recipients" ] && [ -n "$sealed" ] || fail "usage: seal.sh <plaintext directory> <recipients file> <sealed file>"
[ -d "$work" ] || fail "the plaintext directory does not exist"
[ -f "$recipients" ] || fail "the recipients file does not exist"
[ ! -e "$sealed" ] || fail "the sealed file already exists"

keys=0
while IFS= read -r line || [ -n "$line" ]; do
  line=${line%$'\r'}
  case "$line" in
    '' | '#'*) continue ;;
  esac
  [[ "$line" =~ ^age1[02-9ac-hj-np-z]{58}$ ]] || fail "the recipients file has a line that is not an age public key"
  keys=$((keys + 1))
done < "$recipients"
[ "$keys" -gt 0 ] || fail "the recipients file has no age public key"

expected=$'dump\nmanifest.json\nroles.sql'
present=$(cd "$work" && find . -mindepth 1 -maxdepth 1 -printf '%P\n' | LC_ALL=C sort)
[ "$present" = "$expected" ] || fail "the plaintext directory must hold exactly dump, manifest.json and roles.sql"

tar --create --file=- --directory="$work" --owner=0 --group=0 --numeric-owner manifest.json roles.sql dump |
  age --encrypt --recipients-file="$recipients" --output="$sealed"
rm -rf -- "$work"

size=$(stat -c %s "$sealed")
sha=$(sha256sum "$sealed" | cut -d' ' -f1)
echo "ok: sealed for $keys key(s), $(( (size + 1048575) / 1048576 )) MB, sha256 $sha"
