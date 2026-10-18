#!/usr/bin/env bash
# Gate 5 em iPhone e Android reais pelo BrowserStack (Automate Mobile). Roda localmente, sem IA,
# e não faz parte do CI. As credenciais vêm do ambiente ou de um arquivo de segredos fora do
# repositório (BROWSERSTACK_ENV_FILE, padrão ~/.secrets/browserstack.env, modo 600 ou 400); só
# as duas variáveis do BrowserStack são lidas dele, e nunca são impressas.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="${BROWSERSTACK_ENV_FILE:-$HOME/.secrets/browserstack.env}"

read_variable() {
  # lê `NOME=valor` (com ou sem `export` e aspas) sem executar o arquivo
  sed -nE "s/^[[:space:]]*(export[[:space:]]+)?$1=[\"']?([^\"']*)[\"']?[[:space:]]*$/\2/p" "$env_file" | tail -n 1
}

if [[ -z "${BROWSERSTACK_USERNAME:-}" || -z "${BROWSERSTACK_ACCESS_KEY:-}" ]]; then
  if [[ -r "$env_file" ]]; then
    mode="$(stat -c %a "$env_file")"
    if [[ "$mode" != "600" && "$mode" != "400" ]]; then
      echo "O arquivo de credenciais deve ter modo 600 ou 400 (tem $mode)." >&2
      exit 2
    fi
    BROWSERSTACK_USERNAME="$(read_variable BROWSERSTACK_USERNAME)"
    BROWSERSTACK_ACCESS_KEY="$(read_variable BROWSERSTACK_ACCESS_KEY)"
    export BROWSERSTACK_USERNAME BROWSERSTACK_ACCESS_KEY
  fi
fi

cd "$root/apps/web"
exec bun real-devices/run.ts "$@"
