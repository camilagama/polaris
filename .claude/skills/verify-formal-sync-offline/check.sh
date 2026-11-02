#!/bin/sh
# Roda o TLC em cada cenário de cenarios/ e compara com o resultado esperado.
# Sai 0 só quando todos batem. Uso: .claude/skills/verify-formal-sync-offline/check.sh
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cache=${POLARIS_TLA_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/polaris-tla}
out=${POLARIS_TLA_OUT:-$(mktemp -d "${TMPDIR:-/tmp}/verify-formal-sync-offline.XXXXXX")}
mkdir -p "$cache" "$out"

tla_version=1.7.4
tla_sha=936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88
jre_tag=jdk-21.0.13%2B9
jre_file_version=21.0.13_9

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

fetch() {
  url=$1 dest=$2 sum=$3
  if [ -f "$dest" ] && [ "$(sha256 "$dest")" = "$sum" ]; then return 0; fi
  curl -fsSL --retry 3 --max-time 600 -o "$dest.part" "$url" || {
    rm -f "$dest.part"
    echo "falha ao baixar $url" >&2
    exit 2
  }
  if [ "$(sha256 "$dest.part")" != "$sum" ]; then
    rm -f "$dest.part"
    echo "checksum diferente para $url" >&2
    exit 2
  fi
  mv "$dest.part" "$dest"
}

jar=$cache/tla2tools-$tla_version.jar
fetch "https://github.com/tlaplus/tlaplus/releases/download/v$tla_version/tla2tools.jar" "$jar" "$tla_sha"

java_ok() {
  "$1" -version 2>&1 | grep -m 1 'version "' | sed 's/.*version "\([0-9]*\).*/\1/' |
    awk '{ v = $1 } END { exit !(v != "" && v + 0 >= 11) }'
}

java=${JAVA:-}
if [ -n "$java" ] && ! java_ok "$java"; then
  echo "JAVA=$java não é um Java 11 ou mais novo" >&2
  exit 2
fi
if [ -z "$java" ] && command -v java >/dev/null 2>&1 && java_ok java; then java=java; fi
if [ -z "$java" ]; then
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64) platform=x64_linux sum=a535a1df9c6284d9618872984e026ae0352d1f7e9e0605425c0e6114f47351dd ;;
    Linux-aarch64 | Linux-arm64) platform=aarch64_linux sum=b1734db7ade49c3f6acc6ae06233b8c2dd90e3e2f00f67000ae1c972aaa64d8c ;;
    Darwin-arm64) platform=aarch64_mac sum=225bab0a09491ef06835488cd942f5d2befa9a0410a2484f0c8bbcf7506ec09a ;;
    Darwin-x86_64) platform=x64_mac sum=c909674b1c10c261b9a3fb7e9c0efebd303e33f88a4fe84be7135b5e2d711f89 ;;
    *) echo "sem Java 11+ e sem JRE fixado para $(uname -s)-$(uname -m): defina JAVA" >&2; exit 2 ;;
  esac
  archive=$cache/jre-$jre_file_version-$platform.tar.gz
  fetch "https://github.com/adoptium/temurin21-binaries/releases/download/$jre_tag/OpenJDK21U-jre_${platform}_hotspot_$jre_file_version.tar.gz" "$archive" "$sum"
  jre=$cache/jre-$jre_file_version-$platform
  if [ ! -d "$jre" ]; then
    mkdir -p "$jre.part"
    tar xzf "$archive" -C "$jre.part" --strip-components=1
    mv "$jre.part" "$jre"
  fi
  java=$jre/bin/java
  [ -x "$java" ] || java=$jre/Contents/Home/bin/java
fi

# cenário|resultado esperado: "ok", ou o invariante violado e o número de estados
# do contraexemplo mínimo (Invariante@N), que o TLC acha em largura
expected='atual|NoLostSale@6
atual-so-duplicidade|ok
uma-aba|ok
duas-abas-sem-limpeza|ok
quebrada-sem-idempotencia|NoDoubleSale@9
quebrada-recuperacao-apaga|NoLostSale@4
sanidade-caminho-feliz|HappyPathUnreachable@6'

failed=0
printf '%-28s %-22s %-22s %s\n' cenario esperado obtido estados
for line in $expected; do
  name=${line%%|*}
  want=${line#*|}
  log=$out/$name.out
  "$java" -XX:+UseParallelGC -Xss4m -cp "$jar" tlc2.TLC -workers 1 -cleanup \
    -metadir "$out/meta-$name" -config "$here/cenarios/$name.cfg" "$here/SyncOffline.tla" >"$log" 2>&1 || true
  if grep -q "Model checking completed. No error has been found." "$log"; then
    got=ok
  else
    got=$(sed -n 's/^Error: Invariant \([A-Za-z0-9_]*\) is violated\.$/\1/p' "$log" | head -n 1)
    if [ -n "$got" ]; then
      got=$got@$(grep -c '^State [0-9]*:' "$log" || true)
    else
      got=erro
    fi
  fi
  states=$(sed -n 's/.* \([0-9,]*\) distinct states found.*/\1/p' "$log" | tail -n 1)
  mark=""
  if [ "$got" != "$want" ]; then mark=" <- DIFERENTE ($log)"; failed=1; fi
  printf '%-28s %-22s %-22s %s%s\n' "$name" "$want" "$got" "${states:-?}" "$mark"
done
echo "saídas do TLC em $out"
exit $failed
