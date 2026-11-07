#!/usr/bin/env bash
# Logical backup of one environment's database, run inside the postgres:18 image (docs/runbooks/backup.md).
#
#   dump.sh <output directory>
#
# Connection only through the libpq variables (PGHOST, PGUSER, PGDATABASE, PGPASSWORD, PGSSLMODE...), never a URL in
# an argument. BACKUP_ENVIRONMENT names the environment the database must declare (its exact marker comment, ADR 0097).
# Writes three files: dump (pg_dump -Fc), roles.sql (roles and memberships, no password) and manifest.json (row counts
# and catalog readings of sql/reference.sql, taken in the same snapshot as the dump). Prints only "ok" lines, sizes and failure names: no
# value of the database, no variable, no URL.
set -euo pipefail
umask 077

fail() {
  echo "backup: $*" >&2
  exit 1
}

out=${1:-}
[ -n "$out" ] && [ -d "$out" ] || fail "usage: dump.sh <existing output directory>"
here=$(cd "$(dirname "$0")" && pwd)

for name in PGHOST PGUSER PGDATABASE BACKUP_ENVIRONMENT; do
  [ -n "${!name:-}" ] || fail "$name is not set"
done
case "$BACKUP_ENVIRONMENT" in
  staging | production) ;;
  *) fail "BACKUP_ENVIRONMENT must be staging or production" ;;
esac
# the pooler would hand the exported snapshot to another server connection
case "$PGHOST" in
  *-pooler.* | *-pooler) fail "use the direct host, not the pooler" ;;
esac
case "$PGDATABASE" in
  *=* | *://*) fail "PGDATABASE must be a database name, not a connection string" ;;
esac
[ "${PGSSLMODE:-}" = "verify-full" ] || fail "PGSSLMODE must be verify-full"
[ -z "${PGOPTIONS:-}" ] || fail "PGOPTIONS must be empty"

expected_user=polaris_backup_reader
major() { sed -E 's/^[^0-9]*([0-9]+).*/\1/'; }
dump_major=$(pg_dump --version | major)
[ "$dump_major" -ge 18 ] || fail "pg_dump $dump_major is older than 18"

psql_ro() {
  psql --no-psqlrc --quiet --no-align --tuples-only --set=ON_ERROR_STOP=1 "$@"
}

failures=$(psql_ro --set=environment="$BACKUP_ENVIRONMENT" --set=expected_user="$expected_user" --file="$here/sql/preflight.sql")
if [ -n "$failures" ]; then
  printf 'backup: refused: %s\n' "$failures" >&2
  exit 1
fi
echo "ok: marker $BACKUP_ENVIRONMENT and login $expected_user"

# One session holds a repeatable-read snapshot: pg_dump reads it through --snapshot and the reference is read in it,
# so the counts are exactly the rows of the dump.
# stdbuf: answers must reach the pipe line by line, not when a stdio buffer fills
coproc SNAPSHOT { stdbuf -oL psql --no-psqlrc --quiet --no-align --tuples-only --set=ON_ERROR_STOP=1 2>&1; }
session_in=${SNAPSHOT[1]}
session_out=${SNAPSHOT[0]}
session_pid=$SNAPSHOT_PID
close_session() {
  if kill -0 "$session_pid" 2>/dev/null; then
    kill "$session_pid" 2>/dev/null || true
  fi
}
trap close_session EXIT

ask() {
  printf '%s\n' "$1" >&"$session_in"
  local line
  IFS= read -r -t "${2:-120}" -u "$session_out" line || fail "the snapshot session did not answer"
  printf '%s' "$line"
}

ask_quiet() {
  printf '%s\n' "$1" >&"$session_in"
}

ask_quiet "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;"
snapshot=$(ask "SELECT pg_catalog.pg_export_snapshot();")
[[ "$snapshot" =~ ^[0-9A-F]+-[0-9A-F]+-[0-9]+$ ]] || fail "unexpected answer when exporting the snapshot"
taken_at=$(ask "SELECT pg_catalog.to_char(pg_catalog.now() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"');")
[[ "$taken_at" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || fail "unexpected snapshot instant"
server_version=$(ask "SELECT pg_catalog.current_setting('server_version_num');")
[[ "$server_version" =~ ^[0-9]+$ ]] || fail "unexpected server version"

# -Fc keeps pg_restore -l, -L and the selective restore; no -v, which would print object names
pg_dump --format=custom --compress=zstd:6 --lock-wait-timeout=30s --no-sync \
  --snapshot="$snapshot" --file="$out/dump"
echo "ok: pg_dump"

reference=$(ask "\\i $here/sql/reference.sql" 600)
[[ "$reference" == '{'*'}' ]] || fail "the reference reading failed"
ask_quiet "COMMIT;"
ask_quiet "\\q"
wait "$session_pid" || fail "the snapshot session ended with an error"
trap - EXIT

# pg_dump takes no roles; --no-role-passwords reads pg_roles, which a login without superuser can read
pg_dumpall --roles-only --no-role-passwords --database="$PGDATABASE" --file="$out/roles.sql"
echo "ok: roles"

# the archive must be readable and complete before it is sealed
entries=$(pg_restore --list "$out/dump" | grep -c -E '^[0-9]+;' || true)
[ "$entries" -gt 0 ] || fail "pg_restore lists no entry in the dump"

dump_bytes=$(stat -c %s "$out/dump")
{
  printf '{"format":1,"environment":"%s","snapshot_at":"%s","server_version_num":%s,' \
    "$BACKUP_ENVIRONMENT" "$taken_at" "$server_version"
  printf '"pg_dump_major":%s,"dump_bytes":%s,"toc_entries":%s,"reference":%s}\n' \
    "$dump_major" "$dump_bytes" "$entries" "$reference"
} > "$out/manifest.json"
echo "ok: manifest ($entries entries, $(( (dump_bytes + 1048575) / 1048576 )) MB)"
