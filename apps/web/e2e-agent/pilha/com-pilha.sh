#!/usr/bin/env bash
# Sobe o preview da pilha do e2e-real (build próprio em dist-e2e/agente, porta 4321), roda o comando dado e derruba
# o preview. O build, o preview e o preparar.ts rodam SEM a chave do modelo (env -i / env -u); só o comando dado a
# recebe, com a telemetria do e2e desligada e sem a URL do dono do banco.
#
#   E2E_AGENT_STATE=/tmp/... POLARIS_E2E_DATABASE_URL=postgres://dono@127.0.0.1:5442/postgres \
#     e2e-agent/pilha/com-pilha.sh -- <comando...>
set -euo pipefail

: "${E2E_AGENT_STATE:?diretório de estado fora do repositório}"
: "${POLARIS_E2E_DATABASE_URL:?URL do dono do PostgreSQL local}"
app_root="$(cd "$(dirname "$0")/../.." && pwd)"
repo_root="$(git -C "$app_root" rev-parse --show-toplevel)"
port="${E2E_AGENT_PORT:-4321}"
vite="$app_root/node_modules/vite/bin/vite.js"
out="dist-e2e/agente"

# o estado guarda o segredo do run, as senhas dos logins e os cookies: nunca dentro do repositório
mkdir -p -m 700 "$E2E_AGENT_STATE"
state="$(cd "$E2E_AGENT_STATE" && pwd -P)"
case "$state/" in "$(cd "$repo_root" && pwd -P)/"*)
  echo "E2E_AGENT_STATE não pode ficar dentro do repositório." >&2
  exit 2
  ;;
esac
chmod 700 "$state"

[ "${1:-}" = "--" ] && shift

cd "$app_root"
sem_chave() { env -u E2E_ANTHROPIC_API_KEY CI=true "$@"; }

sem_chave bun e2e-agent/pilha/preparar.ts ambiente "$port"
mapfile -t closed < "$state/preview.env"

# sempre o build do piloto: o `vite preview` segue o ponteiro .wrangler/deploy, que o último build reescreve
# (docs/runbooks/e2e-real.md, "Uma saída compartilhada"). O build não recebe segredo nem conexão, como no serve.ts
build_env=()
for pair in "${closed[@]}"; do
  case "$pair" in BETTER_AUTH_SECRET=* | CLOUDFLARE_*) ;; *) build_env+=("$pair") ;; esac
done
env -i "${build_env[@]}" node "$vite" build --outDir "$out" > "$state/build.log" 2>&1

env -i "${closed[@]}" node "$vite" preview --outDir "$out" --host 127.0.0.1 --port "$port" --strictPort \
  > "$state/preview.log" 2>&1 &
preview=$!
parar() {
  kill "$preview" 2> /dev/null || true
  wait "$preview" 2> /dev/null || true
  # como o global-teardown do e2e-real: um `wrangler deploy` sem build não segue o build do piloto
  rm -rf "$app_root/.wrangler/deploy" "$app_root/$out"
}
trap parar EXIT

for _ in $(seq 1 90); do
  kill -0 "$preview" 2> /dev/null || break
  if curl -fs -o /dev/null "http://127.0.0.1:$port/health" 2> /dev/null; then
    break
  fi
  sleep 1
done
kill -0 "$preview"
curl -fsS -o /dev/null "http://127.0.0.1:$port/health"

if [ -n "${E2E_AGENT_LOJAS:-}" ]; then
  # shellcheck disable=SC2086
  E2E_AGENT_ORIGIN="http://127.0.0.1:$port" sem_chave bun e2e-agent/pilha/preparar.ts semear $E2E_AGENT_LOJAS
fi

env -u POLARIS_E2E_DATABASE_URL E2E_TELEMETRY_DISABLED=1 "$@"
