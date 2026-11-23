#!/usr/bin/env bash
# Instala o Chromium do Playwright com as dependências do sistema, sem deixar um espelho do apt
# parado consumir o job inteiro: o apt desiste de conexão parada em 30 s e tenta 3 vezes, e cada
# tentativa de instalação tem um teto de tempo. Uso: scripts/playwright-install.sh <diretório do app>
# (o diretório decide qual Playwright do lockfile instala o navegador).
set -euo pipefail

app_dir="${1:?uso: scripts/playwright-install.sh <diretório do app>}"
attempts="${PLAYWRIGHT_INSTALL_ATTEMPTS:-2}"
attempt_timeout="${PLAYWRIGHT_INSTALL_ATTEMPT_TIMEOUT:-450}"
first_attempt_timeout="${PLAYWRIGHT_INSTALL_FIRST_ATTEMPT_TIMEOUT:-$attempt_timeout}"

if command -v apt-get >/dev/null 2>&1; then
  sudo tee /etc/apt/apt.conf.d/99-playwright-install-timeouts >/dev/null <<'APT'
Acquire::Retries "3";
Acquire::http::Timeout "30";
Acquire::https::Timeout "30";
APT
fi

cd "$app_dir"

if command -v bunx >/dev/null 2>&1; then
  runner=(bunx playwright)
else
  runner=(npx playwright)
fi

for ((attempt = 1; attempt <= attempts; attempt++)); do
  limit="$attempt_timeout"
  if ((attempt == 1)); then
    limit="$first_attempt_timeout"
  fi
  started="$(date +%s)"
  echo "playwright install: tentativa $attempt de $attempts (limite ${limit}s)"
  if timeout --kill-after=10 "$limit" "${runner[@]}" install --with-deps chromium; then
    echo "playwright install: tentativa $attempt passou em $(($(date +%s) - started))s"
    exit 0
  fi
  echo "playwright install: tentativa $attempt falhou ou estourou ${limit}s (levou $(($(date +%s) - started))s)" >&2
  if ((attempt < attempts)); then
    sleep $((attempt * 5))
  fi
done

echo "playwright install: $attempts tentativas falharam" >&2
exit 1
