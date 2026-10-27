#!/usr/bin/env bash
# Sobe o preview da pilha do e2e-real (build `online`, porta 4321), roda o comando dado e derruba o preview.
# O preview e o preparar.ts rodam SEM a chave do modelo (env -i / env -u); só o comando dado a recebe.
#
#   E2E_AGENT_STATE=/tmp/... POLARIS_E2E_DATABASE_URL=postgres://dono@127.0.0.1:5442/postgres \
#     e2e-agent/pilha/com-pilha.sh [--construir] -- <comando...>
set -euo pipefail

: "${E2E_AGENT_STATE:?diretório de estado fora do repositório}"
: "${POLARIS_E2E_DATABASE_URL:?URL do dono do PostgreSQL local}"
app_root="$(cd "$(dirname "$0")/../.." && pwd)"
port="${E2E_AGENT_PORT:-4321}"
vite="$app_root/node_modules/vite/bin/vite.js"
out="dist-e2e/agente"

construir=0
if [ "${1:-}" = "--construir" ]; then
  construir=1
  shift
fi
[ "${1:-}" = "--" ] && shift

cd "$app_root"
sem_chave() { env -u E2E_ANTHROPIC_API_KEY CI=true "$@"; }

sem_chave bun e2e-agent/pilha/preparar.ts ambiente "$port"
mapfile -t closed < "$E2E_AGENT_STATE/preview.env"

if [ "$construir" = 1 ] || [ ! -d "$out" ]; then
  # o build não recebe segredo nem conexão (como o serve.ts): só as variáveis que não são da Cloudflare
  build_env=()
  for pair in "${closed[@]}"; do
    case "$pair" in BETTER_AUTH_SECRET=* | CLOUDFLARE_*) ;; *) build_env+=("$pair") ;; esac
  done
  env -i "${build_env[@]}" node "$vite" build --outDir "$out" > "$E2E_AGENT_STATE/build.log" 2>&1
fi

env -i "${closed[@]}" node "$vite" preview --outDir "$out" --host 127.0.0.1 --port "$port" --strictPort \
  > "$E2E_AGENT_STATE/preview.log" 2>&1 &
preview=$!
parar() {
  kill "$preview" 2> /dev/null || true
  wait "$preview" 2> /dev/null || true
}
trap parar EXIT

for _ in $(seq 1 90); do
  if curl -fs -o /dev/null "http://127.0.0.1:$port/health" 2> /dev/null; then
    break
  fi
  sleep 1
done
curl -fsS -o /dev/null "http://127.0.0.1:$port/health"

if [ -n "${E2E_AGENT_LOJAS:-}" ]; then
  # shellcheck disable=SC2086
  E2E_AGENT_ORIGIN="http://127.0.0.1:$port" sem_chave bun e2e-agent/pilha/preparar.ts semear $E2E_AGENT_LOJAS
fi

"$@"
