#!/usr/bin/env bash
# verify-polaris: launch, doctor, seed, drive, snap, evidence and cleanup of the local Polaris stack.
# Usage (from anywhere inside the worktree):
#   .claude/skills/verify-polaris/scripts/verify.sh preflight
#   .claude/skills/verify-polaris/scripts/verify.sh launch [--runtime] [--assinatura]
#   .claude/skills/verify-polaris/scripts/verify.sh doctor
#   .claude/skills/verify-polaris/scripts/verify.sh seed vazia|vendas|limite|pro
#   .claude/skills/verify-polaris/scripts/verify.sh sql "SELECT ..."   (só leitura)
#   .claude/skills/verify-polaris/scripts/verify.sh drive <arquivo.verify.ts> [--project desktop-claro ...]
#   .claude/skills/verify-polaris/scripts/verify.sh snap <caminho> [--project celular-escuro ...]
#   .claude/skills/verify-polaris/scripts/verify.sh evidence
#   .claude/skills/verify-polaris/scripts/verify.sh cleanup
set -euo pipefail

# the script uses ${var,,} (bash 4); the bash 3.2 of macOS stops here, with the same line format as the preflight
if [ "${BASH_VERSINFO[0]:-0}" -lt 4 ]; then
  echo "PREFLIGHT FALTA bash: a skill pede bash 4 ou mais (este é ${BASH_VERSION:-desconhecido}) e Linux; instale um bash 4+ e rode com ele"
  echo "PREFLIGHT FALHOU: 1 item(ns) faltando; resolva e rode \"verify.sh preflight\" de novo"
  exit 1
fi

# only builtins until preflight has run: it must work (and say what is missing) even with an empty PATH
skill_dir="$(cd "${BASH_SOURCE[0]%/*}/.." && pwd)"
repo_root="$(cd "$skill_dir/../../.." && pwd)"
web_root="$repo_root/apps/web"

# one instance per worktree: the id is the worktree's directory name (~/wt/<id>) unless VERIFY_ID says otherwise
worktree_name="${repo_root##*/}"
worktree_name="${worktree_name,,}"
export VERIFY_ID="${VERIFY_ID:-${worktree_name//_/-}}"
export VERIFY_STATE_DIR="${VERIFY_STATE_DIR:-/tmp/polaris-verify/$VERIFY_ID}"
export VERIFY_EVIDENCE_DIR="${VERIFY_EVIDENCE_DIR:-$HOME/tasks/$VERIFY_ID-telas}"

is_node_24() {
  local version
  version="$("$1" --version 2>/dev/null)" || return 1
  [[ "$version" == v24.* ]]
}

# Node 24 (.node-version) for vite preview and Playwright: VERIFY_NODE, else the one on PATH,
# else (fallback of the dev machine) the one kept in ~/tools
if [ -z "${VERIFY_NODE:-}" ]; then
  candidate="$(command -v node 2>/dev/null || true)"
  if [ -z "$candidate" ] || ! is_node_24 "$candidate"; then
    candidate=""
    for dir in "$HOME"/tools/node-v24*/bin; do
      [ -x "$dir/node" ] && candidate="$dir/node"
    done
  fi
  VERIFY_NODE="$candidate"
fi
export VERIFY_NODE
if [ -n "$VERIFY_NODE" ] && [ -x "$VERIFY_NODE" ]; then
  export PATH="${VERIFY_NODE%/*}${PATH:+:$PATH}"
fi

# PostgreSQL 18 binaries for the own cluster (initdb, pg_ctl): PG_BIN, else PATH, else (fallback of the dev machine) ~/pgtest
if [ -z "${PG_BIN:-}" ] && ! command -v initdb >/dev/null 2>&1 && [ -x "$HOME/pgtest/pg18/package/native/bin/initdb" ]; then
  export PG_BIN="$HOME/pgtest/pg18/package/native/bin"
  export LD_LIBRARY_PATH="$HOME/pgtest/pg18/package/native/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi

# nearest existing ancestor of a path that is meant to be created: it has to be writable
writable_or_creatable() {
  local path="$1"
  [[ "$path" == /* ]] || path="$PWD/$path"
  while [ ! -e "$path" ] && [ "$path" != "/" ] && [ -n "$path" ]; do
    path="${path%/*}"
  done
  [ -d "${path:-/}" ] && [ -w "${path:-/}" ]
}

# Chromium and its headless shell (what headless runs use) of the Playwright version in apps/web, in the cache of the
# machine (PLAYWRIGHT_BROWSERS_PATH or ~/.cache/ms-playwright)
playwright_browsers_installed() {
  (cd "$web_root" && NODE_PATH="$web_root/node_modules" "$VERIFY_NODE" -e '
    const { existsSync } = require("node:fs");
    const { basename, dirname, join } = require("node:path");
    const executable = require("@playwright/test").chromium.executablePath();
    const revision = basename(dirname(dirname(executable))).replace("chromium-", "");
    const shell = join(dirname(dirname(dirname(executable))), `chromium_headless_shell-${revision}`);
    process.exit(existsSync(executable) && existsSync(shell) ? 0 : 1);
  ' >/dev/null 2>&1)
}

# What the launch needs, one line per missing item with the name of the variable that points at it; nothing is created.
preflight() {
  local missing=0
  lacks() {
    echo "PREFLIGHT FALTA $1: $2"
    missing=$((missing + 1))
  }

  if [ -z "$VERIFY_NODE" ] || [ ! -x "$VERIFY_NODE" ] || ! is_node_24 "$VERIFY_NODE"; then
    lacks VERIFY_NODE "Node 24 (.node-version) não achado${VERIFY_NODE:+ em $VERIFY_NODE}; aponte VERIFY_NODE para o binário node v24"
  fi
  command -v bun >/dev/null 2>&1 || lacks PATH "bun não está no PATH (roda o stack.ts)"
  command -v git >/dev/null 2>&1 || lacks PATH "git não está no PATH"
  command -v ss >/dev/null 2>&1 || lacks PATH "ss (iproute2) não está no PATH; o doctor confere a porta com ele"

  if [ -n "${POLARIS_E2E_DATABASE_URL:-}" ]; then
    :
  else
    local binary found version
    for binary in initdb pg_ctl; do
      if [ -n "${PG_BIN:-}" ]; then
        found="$PG_BIN/$binary"
        [ -x "$found" ] || found=""
      else
        found="$(command -v "$binary" 2>/dev/null || true)"
      fi
      if [ -z "$found" ]; then
        lacks PG_BIN "$binary do PostgreSQL 18 não achado${PG_BIN:+ em $PG_BIN}; aponte PG_BIN para a pasta bin (ou POLARIS_E2E_DATABASE_URL para o dono de um PostgreSQL local)"
      elif ! version="$("$found" --version 2>/dev/null)"; then
        lacks PG_BIN "$found não executa (biblioteca ou arquitetura errada?)"
      elif [[ "$version" != *"(PostgreSQL) 18"* ]]; then
        lacks PG_BIN "$found não é o PostgreSQL 18 ($version)"
      fi
    done
  fi

  if [ ! -d "$web_root/node_modules/@playwright/test" ]; then
    lacks node_modules "dependências não instaladas em $repo_root: bun install --frozen-lockfile"
  elif [ -n "$VERIFY_NODE" ] && [ -x "$VERIFY_NODE" ] && ! playwright_browsers_installed; then
    lacks PLAYWRIGHT_BROWSERS_PATH "navegador do Playwright não instalado (chromium e chromium_headless_shell): (cd apps/web && bunx playwright install chromium)"
  fi
  writable_or_creatable "$VERIFY_EVIDENCE_DIR" || lacks VERIFY_EVIDENCE_DIR "$VERIFY_EVIDENCE_DIR não é gravável nem criável; aponte VERIFY_EVIDENCE_DIR para uma pasta fora do repositório"
  writable_or_creatable "$VERIFY_STATE_DIR" || lacks VERIFY_STATE_DIR "$VERIFY_STATE_DIR não é gravável nem criável"

  local gitdir="$repo_root/.git" pointer
  if [ -f "$gitdir" ]; then
    read -r pointer <"$gitdir" || true
    gitdir="${pointer#gitdir: }"
    [[ "$gitdir" == /* ]] || gitdir="$repo_root/$gitdir"
  fi
  if [ ! -e "$gitdir" ]; then
    lacks "worktree" "$repo_root não é um worktree git (sem .git)"
  elif [ ! -w "$gitdir" ]; then
    lacks "worktree" "$gitdir não é gravável: o git precisa criar index.lock; use um worktree seu (git worktree add)"
  fi

  if [ "$missing" -gt 0 ]; then
    echo "PREFLIGHT FALHOU: $missing item(ns) faltando; resolva e rode \"verify.sh preflight\" de novo"
    return 1
  fi
  local pg_source="${PG_BIN:-PATH}"
  [ -z "${POLARIS_E2E_DATABASE_URL:-}" ] || pg_source="POLARIS_E2E_DATABASE_URL"
  echo "PREFLIGHT OK node=$VERIFY_NODE pg=$pg_source evidência=$VERIFY_EVIDENCE_DIR"
}

playwright() {
  # the drives live outside apps/web: NODE_PATH lets them and the config resolve @playwright/test from there
  (cd "$web_root" && NODE_PATH="$web_root/node_modules" "$VERIFY_NODE" node_modules/@playwright/test/cli.js test \
    --config "$skill_dir/playwright.verify.config.ts" "$@")
}

command="${1:-}"
shift || true
case "$command" in
  preflight)
    preflight
    ;;
  launch)
    preflight
    (cd "$web_root" && bun "$skill_dir/scripts/stack.ts" launch "$@")
    ;;
  doctor | seed | sql | cleanup)
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
    sed -n '2,12p' "${BASH_SOURCE[0]}"
    exit 2
    ;;
esac
