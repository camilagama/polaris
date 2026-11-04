#!/usr/bin/env bash
# Sends a sealed backup to the environment's R2 bucket, confirms it, and only then applies the retention
# (scripts/backup/retention.mjs; docs/runbooks/backup.md).
#
#   upload.sh <sealed file> <stamp AAAAMMDDTHHMMSSZ>
#
# Needs R2_BACKUP_BUCKET, R2_BACKUP_ENDPOINT and the AWS_* credentials of the bucket's token in the environment.
# Without --query, the aws CLI merges every page of list-objects-v2 into one answer, so the retention sees every object
# of the prefix, past 1000.
set -euo pipefail

fail() {
  echo "backup: $*" >&2
  exit 1
}

sealed=${1:-}
stamp=${2:-}
[ -f "$sealed" ] || fail "usage: upload.sh <sealed file> <stamp>"
[[ "$stamp" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || fail "the stamp must be AAAAMMDDTHHMMSSZ (UTC)"
for name in R2_BACKUP_BUCKET R2_BACKUP_ENDPOINT AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY; do
  [ -n "${!name:-}" ] || fail "$name is not set"
done
[[ "$R2_BACKUP_ENDPOINT" =~ ^https://[0-9a-f]{32}\.r2\.cloudflarestorage\.com$ ]] || fail "R2_BACKUP_ENDPOINT is not an R2 account endpoint"
here=$(cd "$(dirname "$0")" && pwd)

# recent aws CLIs send checksum headers that R2 may refuse
export AWS_REQUEST_CHECKSUM_CALCULATION=when_required
export AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
export AWS_DEFAULT_REGION=auto
export AWS_PAGER=""
s3() {
  aws s3api "$@" --bucket "$R2_BACKUP_BUCKET" --endpoint-url "$R2_BACKUP_ENDPOINT"
}

key="daily/$stamp.tar.age"
size=$(stat -c %s "$sealed")
sha=$(sha256sum "$sealed" | cut -d' ' -f1)
sha_base64=$(openssl dgst -sha256 -binary "$sealed" | base64 -w0)

# a backup is never overwritten: the same stamp twice is a mistake to look at
if s3 head-object --key "$key" > /dev/null 2>&1; then
  fail "an object with this stamp already exists"
fi
# the checksum header makes R2 verify the bytes it received and refuse the PUT when they differ
s3 put-object --key "$key" --body "$sealed" --content-type application/octet-stream \
  --checksum-sha256 "$sha_base64" --metadata "sha256=$sha" > /dev/null
stored=$(s3 head-object --key "$key" --query '[ContentLength, Metadata.sha256]' --output text) || fail "could not read the stored object back"
read -r stored_size stored_sha <<< "$stored"
[ "$stored_size" = "$size" ] && [ "$stored_sha" = "$sha" ] || fail "the stored object does not match the sealed file: retention skipped"
echo "ok: uploaded $key"

# retention only after this run's backup is confirmed: a failed run never deletes anything
listing=$(s3 list-objects-v2 --prefix daily/ --output json)
expired=$(printf '%s' "$listing" | node "$here/retention.mjs" --now "$stamp" --keep "$key")
removed=0
while IFS= read -r old; do
  [ -n "$old" ] || continue
  s3 delete-object --key "$old" > /dev/null
  removed=$((removed + 1))
done <<< "$expired"
echo "ok: retention removed $removed object(s)"
