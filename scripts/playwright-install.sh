#!/usr/bin/env bash
# Instala o Chromium do Playwright do lockfile sem passar pelo apt no caminho normal: o runner
# ubuntu-24.04 já tem as bibliotecas do Chrome, e o navegador vem da CDN do Playwright (ou do
# cache ~/.cache/ms-playwright). Só se faltar biblioteca (ldd "not found") o apt entra, uma vez,
# com os tetos de antes. Uso: scripts/playwright-install.sh <diretório do app>
set -euo pipefail
app_dir="${1:?uso: scripts/playwright-install.sh <diretório do app>}"
cd "$app_dir"
if command -v bunx >/dev/null 2>&1; then runner=(bunx playwright); else runner=(npx playwright); fi

started="$(date +%s)"
timeout --kill-after=10 "${PLAYWRIGHT_DOWNLOAD_TIMEOUT:-180}" "${runner[@]}" install chromium
echo "playwright install: navegador pronto em $(($(date +%s) - started))s"

cache="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"
missing="$(find "$cache" -type f \( -name chrome -o -name chrome-headless-shell \) -perm -u+x -print0 \
  | xargs -0 -r ldd 2>/dev/null | awk '/not found/ {print $1}' | sort -u || true)"
if [ -z "$missing" ]; then
  echo "playwright install: nenhuma biblioteca faltando; apt não usado"
  exit 0
fi
echo "playwright install: faltam bibliotecas ($missing); instalando dependências pelo apt (uma vez)" >&2
sudo tee /etc/apt/apt.conf.d/99-playwright-install-timeouts >/dev/null <<'APT'
Acquire::Retries "3";
Acquire::http::Timeout "30";
Acquire::https::Timeout "30";
APT
timeout --kill-after=10 "${PLAYWRIGHT_INSTALL_ATTEMPT_TIMEOUT:-450}" "${runner[@]}" install-deps chromium
