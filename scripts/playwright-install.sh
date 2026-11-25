#!/usr/bin/env bash
# Instala o Chromium do Playwright do lockfile sem passar pelo apt no caminho normal: o runner
# ubuntu-24.04 já tem as bibliotecas do Chrome, e o navegador vem da CDN do Playwright (ou do
# cache ~/.cache/ms-playwright). O download tem duas tentativas que dividem o mesmo teto total.
# Só se faltar biblioteca (ldd "not found") o apt entra, também com duas tentativas dividindo o
# teto total: o teto mata o Playwright, mas não o apt-get que ele lançou como root, então antes da
# segunda tentativa o script espera esse apt-get sair (wait_for_apt) e o encerra se demorar; sem
# isso a nova tentativa cai em "Could not get lock /var/lib/apt/lists/lock". O dpkg nunca é morto,
# para não deixar o banco de pacotes interrompido.
# Uso: scripts/playwright-install.sh <diretório do app>
# Variáveis: PLAYWRIGHT_DOWNLOAD_TIMEOUT (teto total do download, 180 s),
# PLAYWRIGHT_INSTALL_ATTEMPT_TIMEOUT (teto total do apt, 450 s), PLAYWRIGHT_INSTALL_ATTEMPTS
# (tentativas de cada etapa, 2), PLAYWRIGHT_INSTALL_APT_ORPHAN_GRACE (espera pelo apt-get que
# sobrou, 45 s), PLAYWRIGHT_INSTALL_RETRY_PAUSE (pausa entre tentativas, 5 s).
set -euo pipefail
app_dir="${1:?uso: scripts/playwright-install.sh <diretório do app>}"
attempts="${PLAYWRIGHT_INSTALL_ATTEMPTS:-2}"
download_total="${PLAYWRIGHT_DOWNLOAD_TIMEOUT:-180}"
apt_total="${PLAYWRIGHT_INSTALL_ATTEMPT_TIMEOUT:-450}"
apt_orphan_grace="${PLAYWRIGHT_INSTALL_APT_ORPHAN_GRACE:-45}"
retry_pause="${PLAYWRIGHT_INSTALL_RETRY_PAUSE:-5}"
cd "$app_dir"
if command -v bunx >/dev/null 2>&1; then runner=(bunx playwright); else runner=(npx playwright); fi

apt_running() {
  pgrep -x 'apt-get|apt|dpkg' >/dev/null 2>&1
}

wait_for_apt() {
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

# Roda "playwright <args>" em até $attempts tentativas, cada uma com total/attempts segundos.
run_attempts() {
  local label="$1" total="$2" between="$3"
  shift 3
  local limit=$((total / attempts)) attempt started
  ((limit >= 1)) || limit=1
  for ((attempt = 1; attempt <= attempts; attempt++)); do
    started="$(date +%s)"
    echo "playwright install: $label, tentativa $attempt de $attempts (limite ${limit}s)"
    if timeout --kill-after=10 "$limit" "${runner[@]}" "$@"; then
      echo "playwright install: $label pronto em $(($(date +%s) - started))s"
      return 0
    fi
    echo "playwright install: $label falhou ou estourou ${limit}s (levou $(($(date +%s) - started))s)" >&2
    if ((attempt < attempts)); then
      "$between"
      sleep $((attempt * retry_pause))
    fi
  done
  echo "playwright install: $attempts tentativas de $label falharam" >&2
  return 1
}

nothing() { :; }

run_attempts "download do Chromium" "$download_total" nothing install chromium

cache="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"
missing="$(find "$cache" -type f \( -name chrome -o -name chrome-headless-shell \) -perm -u+x -print0 \
  | xargs -0 -r ldd 2>/dev/null | awk '/not found/ {print $1}' | sort -u || true)"
if [ -z "$missing" ]; then
  echo "playwright install: nenhuma biblioteca faltando; apt não usado"
  exit 0
fi
echo "playwright install: faltam bibliotecas ($missing); instalando dependências pelo apt" >&2
sudo tee /etc/apt/apt.conf.d/99-playwright-install-timeouts >/dev/null <<'APT'
Acquire::Retries "3";
Acquire::http::Timeout "30";
Acquire::https::Timeout "30";
APT
run_attempts "apt" "$apt_total" wait_for_apt install-deps chromium
