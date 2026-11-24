#!/usr/bin/env bash
# Instala o Chromium do Playwright sem pôr o apt no caminho comum. O download vem do CDN do
# Playwright; o runner ubuntu-24.04 já traz as bibliotecas do Chromium, então o script confere com
# ldd os binários baixados e só chama o apt (`playwright install-deps`) se faltar alguma. Nesse caso
# o apt desiste de conexão parada em 30 s e tenta 3 vezes, e cada tentativa tem um teto de tempo. O
# teto mata o Playwright, mas não o apt-get que ele lançou como root: antes de repetir, o script
# espera esse apt-get sair e o encerra se demorar (o dpkg nunca é morto, para não deixar o banco
# interrompido); sem isso a nova tentativa cai em "Could not get lock /var/lib/apt/lists/lock".
# Fontes (CJK, unifont, freefont) não são biblioteca do Chromium e não puxam o apt.
# Uso: scripts/playwright-install.sh <diretório do app> (o diretório decide qual Playwright do
# lockfile instala o navegador).
# Variáveis: PLAYWRIGHT_INSTALL_ATTEMPTS (download, 2), PLAYWRIGHT_INSTALL_DOWNLOAD_TIMEOUT (120 s),
# PLAYWRIGHT_INSTALL_APT_ATTEMPTS (como o download), PLAYWRIGHT_INSTALL_ATTEMPT_TIMEOUT (apt, 450 s),
# PLAYWRIGHT_INSTALL_FIRST_ATTEMPT_TIMEOUT (1ª tentativa do apt), PLAYWRIGHT_INSTALL_APT_ORPHAN_GRACE
# (espera pelo apt-get que sobrou, 45 s), PLAYWRIGHT_INSTALL_FORCE_DEPS=1
# (chama o apt mesmo sem biblioteca faltando), PLAYWRIGHT_INSTALL_RETRY_PAUSE (pausa entre tentativas, 5 s).
set -euo pipefail

app_dir="${1:?uso: scripts/playwright-install.sh <diretório do app>}"
attempts="${PLAYWRIGHT_INSTALL_ATTEMPTS:-2}"
download_timeout="${PLAYWRIGHT_INSTALL_DOWNLOAD_TIMEOUT:-120}"
apt_attempts="${PLAYWRIGHT_INSTALL_APT_ATTEMPTS:-$attempts}"
attempt_timeout="${PLAYWRIGHT_INSTALL_ATTEMPT_TIMEOUT:-450}"
first_attempt_timeout="${PLAYWRIGHT_INSTALL_FIRST_ATTEMPT_TIMEOUT:-$attempt_timeout}"
apt_orphan_grace="${PLAYWRIGHT_INSTALL_APT_ORPHAN_GRACE:-45}"
retry_pause="${PLAYWRIGHT_INSTALL_RETRY_PAUSE:-5}"

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

download_browser() {
  local attempt started
  for ((attempt = 1; attempt <= attempts; attempt++)); do
    started="$(date +%s)"
    echo "playwright install: download do Chromium, tentativa $attempt de $attempts (limite ${download_timeout}s)"
    if timeout --kill-after=10 "$download_timeout" "${runner[@]}" install chromium; then
      echo "playwright install: download passou em $(($(date +%s) - started))s"
      return 0
    fi
    echo "playwright install: download falhou ou estourou ${download_timeout}s (levou $(($(date +%s) - started))s)" >&2
    if ((attempt < attempts)); then
      sleep $((attempt * retry_pause))
    fi
  done
  return 1
}

# Imprime uma linha por biblioteca que os binários do Chromium não encontram; sem saída, nada falta.
missing_libraries() {
  local locations dir binary found=0 output
  if ! command -v ldd >/dev/null 2>&1; then
    echo "ldd: não está instalado"
    return 0
  fi
  locations="$(timeout 60 "${runner[@]}" install --dry-run chromium | sed -n 's/^ *Install location: *//p')" || {
    echo "binário do Chromium: não consegui listar o local de instalação"
    return 0
  }
  while IFS= read -r dir; do
    [[ -d "$dir" ]] || continue
    while IFS= read -r binary; do
      found=1
      output="$(ldd "$binary" 2>&1 || true)"
      grep 'not found' <<<"$output" | sed "s|^|$(basename "$binary"): |" || true
    done < <(find "$dir" -type f \( -name chrome -o -name chrome-headless-shell \))
  done <<<"$locations"
  if ((found == 0)); then
    echo "binário do Chromium: nenhum encontrado depois do download"
  fi
}

install_dependencies_with_apt() {
  local attempt limit started
  sudo tee /etc/apt/apt.conf.d/99-playwright-install-timeouts >/dev/null <<'APT'
Acquire::Retries "3";
Acquire::http::Timeout "30";
Acquire::https::Timeout "30";
APT
  for ((attempt = 1; attempt <= apt_attempts; attempt++)); do
    limit="$attempt_timeout"
    if ((attempt == 1)); then
      limit="$first_attempt_timeout"
    fi
    started="$(date +%s)"
    echo "playwright install: apt, tentativa $attempt de $apt_attempts (limite ${limit}s)"
    if timeout --kill-after=10 "$limit" "${runner[@]}" install-deps chromium; then
      echo "playwright install: apt passou em $(($(date +%s) - started))s"
      return 0
    fi
    echo "playwright install: apt falhou ou estourou ${limit}s (levou $(($(date +%s) - started))s)" >&2
    if ((attempt < apt_attempts)); then
      wait_for_apt
      sleep $((attempt * retry_pause))
    fi
  done
  return 1
}

if ! download_browser; then
  echo "playwright install: $attempts tentativas de download falharam" >&2
  exit 1
fi

missing="$(missing_libraries)"
if [[ -z "$missing" && "${PLAYWRIGHT_INSTALL_FORCE_DEPS:-}" != "1" ]]; then
  echo "playwright install: o ldd não achou biblioteca faltando nos binários do Chromium; o apt não foi chamado"
  exit 0
fi

if [[ -n "$missing" ]]; then
  echo "playwright install: chamando o apt, o que o Chromium não achou:"
  echo "$missing"
fi
if ! install_dependencies_with_apt; then
  echo "playwright install: $apt_attempts tentativas do apt falharam" >&2
  exit 1
fi
