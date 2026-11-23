#!/usr/bin/env bash
# Instala o Chromium do Playwright com as dependências do sistema, sem deixar um espelho do apt
# parado consumir o job inteiro: o apt desiste de conexão parada em 30 s e tenta 3 vezes, e cada
# tentativa de instalação tem um teto de tempo. O teto mata o Playwright, mas não o apt-get que ele
# lançou como root: antes de repetir, o script espera esse apt-get sair e o encerra se demorar (o
# dpkg nunca é morto, para não deixar o banco interrompido); sem isso a nova tentativa cai em "Could
# not get lock /var/lib/apt/lists/lock". Uso: scripts/playwright-install.sh <diretório do app>
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

apt_orphan_grace="${PLAYWRIGHT_INSTALL_APT_ORPHAN_GRACE:-45}"

apt_running() {
  pgrep -x 'apt-get|apt|dpkg' >/dev/null 2>&1
}

wait_for_apt() {
  command -v apt-get >/dev/null 2>&1 || return 0
  local waited=0
  while apt_running && ((waited < apt_orphan_grace)); do
    sleep 2
    waited=$((waited + 2))
  done
  if apt_running; then
    echo "playwright install: apt ainda ativo depois de ${apt_orphan_grace}s; enviando SIGTERM" >&2
    sudo pkill -TERM -x 'apt-get|apt' || true
    waited=0
    while apt_running && ((waited < 15)); do
      sleep 2
      waited=$((waited + 2))
    done
    if apt_running; then
      echo "playwright install: apt não saiu depois do SIGTERM; a próxima tentativa pode cair no lock" >&2
    fi
  fi
}

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
    wait_for_apt
    sleep $((attempt * 5))
  fi
done

echo "playwright install: $attempts tentativas falharam" >&2
exit 1
