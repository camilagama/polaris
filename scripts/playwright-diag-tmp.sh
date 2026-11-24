#!/usr/bin/env bash
# diagnostico temporario: uso t1776-diag.sh <app_dir>
set -uo pipefail
cd "$1"
if command -v bunx >/dev/null 2>&1; then runner=(bunx playwright); else runner=(npx playwright); fi
echo "::group::diag"
echo "diag: so $(. /etc/os-release; echo "$PRETTY_NAME") $(uname -m)"
t0=$(date +%s)
timeout 300 "${runner[@]}" install chromium; echo "diag: install chromium rc=$? em $(($(date +%s)-t0))s"
t0=$(date +%s)
timeout 120 "${runner[@]}" install-deps --dry-run chromium; echo "diag: install-deps --dry-run rc=$? em $(($(date +%s)-t0))s"
echo "diag: lists do apt: $(ls /var/lib/apt/lists | wc -l) arquivos"
base="${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"
find "$base" -type f \( -name chrome -o -name chrome-headless-shell -o -name headless_shell \) | while read -r b; do
  echo "diag: ldd $b"; ldd "$b" | grep -c "not found" || true; ldd "$b" | grep "not found" || true
done
for p in libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 libatspi2.0-0t64 libcairo2 libcups2t64 libdbus-1-3 libdrm2 libgbm1 libglib2.0-0t64 libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 xvfb fonts-noto-color-emoji fonts-unifont libfontconfig1 libfreetype6 xfonts-cyrillic xfonts-scalable fonts-liberation fonts-ipafont-gothic fonts-wqy-zenhei fonts-tlwg-loma-otf fonts-freefont-ttf; do
  s=$(dpkg-query -W -f='${Status}' "$p" 2>/dev/null || echo ausente); echo "diag: pkg $p: $s"
done
echo "::endgroup::"
