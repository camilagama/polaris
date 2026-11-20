# Lista protegida de testes

Alguns testes são a prova de que um risco não voltou: autorização, privacidade, migração, concorrência, sessão, cobrança com assinatura, limite de taxa, CSP, mídia, LGPD e sync offline. Um teste de guarda de segurança passa verde por desenho; o dia em que falha é o incidente evitado. Por isso "nunca detectou defeito" não tira um teste da proteção, e o que toca capacidade, papel, RLS, tenant, sessão, assinatura, PII, lease ou migração e não está listado fica protegido até o Rodrigo ler (na dúvida, protegido).

## A lista

[`tests/protegidos.txt`](../../tests/protegidos.txt) tem um caminho ou glob por linha, agrupado pelas 4 classes (autorização, privacidade, migração, concorrência), pelos 7 grupos (sessão e senha, cobrança, limites de taxa, CSP e cabeçalhos, mídia, LGPD, sync offline e catálogo público), pela cadeia de suprimentos e por `packages/db/scripts/**`, que é protegido inteiro como classe. `**` atravessa pastas, `*` e `?` ficam numa pasta, `{a,b}` escolhe. Cada glob tem de casar com ao menos um arquivo. A lista só cresce: acrescentar linha é livre.

## A checagem

`bun run protegidos:check` (`scripts/check-protegidos.ts`) compara a base do PR (merge-base com `origin/main`) com o head, lendo as árvores dos commits, e reprova quando:

- um arquivo protegido é apagado, ou renomeado para um caminho que a lista não cobre (renomear para lugar coberto passa, e o conteúdo é comparado com o do nome antigo; trocar o tipo, como `x.test.ts` para `x.ts` ou `gate.ts` para `gate.ts.off`, reprova, porque o runner deixa de achar o arquivo);
- um arquivo protegido ganha `.skip`, `.only`, `.todo`, `.fixme` ou `.fail` (também `xit`, `xdescribe`, `testInfo.skip()`, `ctx.skip()` ou `skip()` no corpo do teste e `{ skip: true }`, `{ todo: true }` ou `{ fails: true }` em qualquer objeto literal, por não saber de quem é o objeto: um campo `skip`, `todo` ou `fails` de dado novo num arquivo protegido também pede o aceite), ganha `retry`/`retries` acima de zero, ganha marca de quarentena, perde chamadas `expect`/`assert*` ou perde casos `it`/`test`; a contagem é feita no código sem comentários nem strings;
- a lista perde uma linha ou um glob deixa de casar com arquivo;
- uma config de Vitest ou Playwright (`vitest*config*`, `playwright*config*`) deixa de incluir um arquivo protegido (`include`, `testMatch`, lidos contra o `testDir` quando há), ganha um filtro (`exclude`, `testIgnore`, qualquer glob de teste novo) que o alcança, sobe o `retries` ou ganha `grepInvert` num config que roda arquivo protegido.

Refatorar que junta duas asserções numa só também derruba a contagem: a checagem não sabe se a nova é mais forte, quem sabe é o Rodrigo, e é ele que aceita.

## O aceite

O commit no PR com o trailer `Protegido-Aceito-Por: Rodrigo` (última linha da mensagem, depois de uma linha em branco) libera o PR, e a saída diz o que foi liberado e em qual commit. Só vale o trailer de commit que está no head e não está na base (`origin/main..HEAD`): os commits da `main` não entram; num PR empilhado sobre outro ainda aberto, entram os do PR de baixo. O trailer é texto: quem o escreve afirma o aceite, e o Rodrigo é o revisor obrigatório do PR que o carrega.

## O que a checagem não prova

Está em `NOT_CHECKED` no script e no corpo do PR que o criou: matriz de shards e `--shard`, `--project` e `paths:` dos workflows, os filtros de job do `scripts/ci-changed.mjs`, lista de arquivos montada fora de literal, mover teste protegido para o workflow noturno, gate de banco tirado do `run-gates.ts` sem apagar o arquivo e troca de uma asserção, de um caso ou de um `.skip` por outro mais fraco ou de lugar, e pulo que o texto não mostra (`if (cond) return`). Quando um PR muda `.github/workflows/`, `scripts/ci-changed.mjs`, o script ou a lista, a saída traz um aviso para o Rodrigo ler.

## No CI

Um job leve, com `fetch-depth: 0`, executa o script **da base** (não o do PR), para que um PR não enfraqueça a checagem que o julga; no PR que a cria, a base ainda não tem o script e roda o do próprio PR. O trecho vai em `.github/workflows/ci.yml` (job irmão dos demais, em `jobs:`), e o job deve entrar entre os checks exigidos da `main`. Enquanto ele não entrar, a checagem só roda local (`bun run check`) e o `check-protegidos.test.mjs` roda no CI pelo `bun run test`.

```yaml
  protected-tests:
    name: Protected tests
    if: ${{ github.event_name == 'pull_request' }}
    runs-on: ubuntu-24.04
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0
          persist-credentials: false
      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0
        with:
          bun-version-file: .bun-version
      - name: Guard the protected tests with the script of the base
        env:
          BASE_REF: ${{ github.base_ref }}
        run: |
          base="origin/$BASE_REF"
          if git cat-file -e "$base:scripts/check-protegidos.ts" 2>/dev/null; then
            git checkout "$base" -- scripts/check-protegidos.ts packages/db/scripts/gate-clock-scan.ts
          fi
          bun scripts/check-protegidos.ts --base "$base" --head HEAD
```
