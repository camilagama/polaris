#!/usr/bin/env bash
# verify-polaris: launch, doctor, seed, drive, snap, evidence and cleanup of the local Polaris stack.
# Usage (from anywhere inside the worktree):
#   .claude/skills/verify-polaris/scripts/verify.sh launch [--runtime] [--assinatura]
#   .claude/skills/verify-polaris/scripts/verify.sh doctor
#   .claude/skills/verify-polaris/scripts/verify.sh seed vazia|vendas|limite
#   .claude/skills/verify-polaris/scripts/verify.sh sql "SELECT ..."   (só leitura)
#   .claude/skills/verify-polaris/scripts/verify.sh drive <arquivo.verify.ts> [--project desktop-claro ...]
#   .claude/skills/verify-polaris/scripts/verify.sh snap <caminho> [--project celular-escuro ...]
#   .claude/skills/verify-polaris/scripts/verify.sh evidence
#   .claude/skills/verify-polaris/scripts/verify.sh cleanup
set -euo pipefail

skill_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_root="$(cd "$skill_dir/../../.." && pwd)"
web_root="$repo_root/apps/web"

# one instance per worktree: the id is the worktree's directory name (~/wt/<id>) unless VERIFY_ID says otherwise
export VERIFY_ID="${VERIFY_ID:-$(basename "$repo_root" | tr 'A-Z_' 'a-z-')}"
export VERIFY_STATE_DIR="${VERIFY_STATE_DIR:-/tmp/polaris-verify/$VERIFY_ID}"
export VERIFY_EVIDENCE_DIR="${VERIFY_EVIDENCE_DIR:-$HOME/tasks/$VERIFY_ID-telas}"

# Node 24 (.node-version) for vite preview and Playwright: the one on PATH, or the one this machine keeps in ~/tools
if ! node --version 2>/dev/null | grep -q '^v24\.'; then
  for candidate in "$HOME"/tools/node-v24*/bin; do
    [ -x "$candidate/node" ] && export PATH="$candidate:$PATH"
  done
fi
export VERIFY_NODE="${VERIFY_NODE:-$(command -v node || true)}"

# PostgreSQL 18 binaries for the own cluster (initdb, pg_ctl): PG_BIN, else PATH, else this machine's ~/pgtest
if [ -z "${PG_BIN:-}" ] && ! command -v initdb >/dev/null 2>&1 && [ -x "$HOME/pgtest/pg18/package/native/bin/initdb" ]; then
  export PG_BIN="$HOME/pgtest/pg18/package/native/bin"
  export LD_LIBRARY_PATH="$HOME/pgtest/pg18/package/native/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi

playwright() {
  # the drives live outside apps/web: NODE_PATH lets them and the config resolve @playwright/test from there
  (cd "$web_root" && NODE_PATH="$web_root/node_modules" "$VERIFY_NODE" node_modules/@playwright/test/cli.js test \
    --config "$skill_dir/playwright.verify.config.ts" "$@")
}

command="${1:-}"
shift || true
case "$command" in
  launch | doctor | seed | sql | cleanup)
    (cd "$web_root" && bun "$skill_dir/scripts/stack.ts" "$command" "$@")
    ;;
  drive)
    file="${1:?usage: verify.sh drive <arquivo.verify.ts> [opções do playwright]}"
    shift
    VERIFY_DRIVE="$(realpath "$file")" playwright "$@"
    ;;
  snap)
    VERIFY_URL="${1:?usage: verify.sh snap <caminho> [opções do playwright]}"
    shift
    VERIFY_URL="$VERIFY_URL" VERIFY_DRIVE="$skill_dir/drives/snap.verify.ts" playwright "$@"
    ;;
  evidence)
    echo "$VERIFY_EVIDENCE_DIR"
    ls -la "$VERIFY_EVIDENCE_DIR" 2>/dev/null || echo "(sem evidência ainda)"
    ;;
  *)
    sed -n '2,11p' "${BASH_SOURCE[0]}"
    exit 2
    ;;
esac
