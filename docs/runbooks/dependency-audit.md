# Auditoria de dependências

Procedimento e registro de exceções do job "Dependency audit" do CI, que roda `bun audit --audit-level=high` quando uma dependência muda (e sob demanda). O job é consultivo (`continue-on-error`), mas não deve ter aviso sem destino: cada aviso é corrigido ou entra na tabela de exceções abaixo, com justificativa e prazo.

## Gatilho

- O job falhou no CI, ou alguém mudou `package.json`/`bun.lock`.
- Passou o prazo de revisão de uma exceção.

## Procedimento

1. `bun install --frozen-lockfile`.
2. `bun audit --audit-level=high` e anotar pacote, severidade e caminho (`bun pm why <pacote>` mostra quem depende).
3. Se existe versão corrigida: atualizar a dependência direta; se a dependência transitiva fixa a versão vulnerável com versão exata, usar `overrides` no `package.json` raiz, rodar `bun install` e conferir no `bun.lock` que só mudaram o pacote esperado (e os pacotes que ele traz, como `@img/*` no caso do `sharp`) e o bloco `overrides`. Rodar `bun run check`, `bun run build` e os gates do pacote afetado.
4. Se não existe versão corrigida e o pacote só roda em ferramenta de desenvolvimento ou build (nada no bundle dos Workers nem no navegador; conferir com `bun pm why <pacote>`, que deve mostrar só ancestrais `dev`, e com uma busca de import do pacote em `apps/`, `packages/` e `scripts/`), registrar a exceção na tabela abaixo. Se o pacote chega ao runtime, não há exceção: tratar como bloqueio e escalar ao responsável.
5. Conferir com `bun audit --audit-level=high --ignore=<GHSA>` (repetível) que as exceções documentadas são os únicos avisos restantes.

O `bun audit` não lê arquivo de exceções; o `--ignore` só vale na linha de comando. Por isso o workflow `.github/workflows/ci.yml` passa um `--ignore` para cada exceção vigente da tabela abaixo, com a data de revisão em comentário, e o job volta a ficar vermelho só com aviso novo. Ao remover uma exceção, remover também o `--ignore` correspondente.

## Atraso de 7 dias para versões novas (`minimumReleaseAge`)

O Renovate (`minimumReleaseAge: "7 days"`, com `internalChecksFilter: "strict"`) não cria o branch antes dos 7 dias, e o Bun (`minimumReleaseAge = 604800` na tabela `[install]` do `bunfig.toml`) recusa resolver versão publicada há menos de 7 dias. O `.bun-version` é 1.4.3 ou mais novo (um teste confere; provado em 20/10/2026 com `bun add` de um pacote de 1 dia, recusado com `blocked by minimum-release-age`), e o CI escolhe o Bun por esse arquivo. A ADR 0103 (condição 4) explica o porquê.

- **Com `--frozen-lockfile`, o atraso só vale quando o `bun.lock` muda.** O `bun install --frozen-lockfile` instala o que o lock já fixa, sem resolver nada: uma versão com menos de 7 dias que já esteja no lock é instalada sem recusa. O controle está em quem muda o lock (`bun add`, `bun update`, Renovate), e por isso o PR que muda `bun.lock` é o ponto de revisão: conferir a data de publicação das versões novas (`bun pm view <pacote> time`).
- **Atualização de segurança urgente (versão corrigida com menos de 7 dias):**
  1. Em um PR só para isso, acrescentar ao `bunfig.toml`, na tabela `[install]` (em qualquer ordem em relação ao `minimumReleaseAge`), `minimumReleaseAgeExcludes = ["<pacote>"]`, **uma entrada por pacote** (nunca curinga), e rodar `bun add <pacote>@<versão exata>` (ou `bun update <pacote>`).
  2. Explicar no PR o aviso (GHSA ou CVE), a versão escolhida, a data de publicação e a conferência do conteúdo (changelog e diff do pacote publicado). O Arrascaeta (merge) e a revisão de segurança aprovam o PR.
  3. Depois dos 7 dias, abrir PR removendo a entrada. O teste de `apps/web/scripts/ui-supply-chain.test.ts` só aceita no `bunfig.toml` os pacotes da lista `URGENT_EXCLUDES` dele (vazia por padrão, sem curinga): o PR urgente inclui o pacote nas duas e o PR de remoção esvazia as duas.
  4. O Renovate continua com os 7 dias: a atualização urgente é manual.

## Rollback ou forward-fix

Se um override ou atualização quebrar `bun run build`, `bun run check` ou um gate, reverter o `package.json` e o `bun.lock` do commit e registrar o aviso como exceção (só se for de ferramenta de desenvolvimento) até haver versão compatível. Não há dado nem recurso de produção envolvido.

## Escalonamento

O responsável pelo CI decide aceitar uma exceção que dure além do prazo (o `--ignore` no workflow não expira sozinho: na data de revisão, remover ou renovar explicitamente) e tratar qualquer aviso que chegue ao runtime.

## Exceções vigentes

| Aviso | Pacote | Caminho | Runtime? | Por que não há correção | Revisar até |
| --- | --- | --- | --- | --- | --- |
| [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) (high, DoS por esgotamento de pilha com padrões aninhados em excesso, afeta `<=3.0.3`) | `braces@3.0.3` | `ultracite > find-workspaces > fast-glob > micromatch > braces` | Não: só ferramenta de desenvolvimento (`ultracite`, usada por `bun run fix`) | A 3.0.3 é a última versão publicada de `braces`; não há versão corrigida para o `override` ou para `bun audit fix`. | 2026-11-18 |
| [GHSA-965c-763c-88jm](https://github.com/advisories/GHSA-965c-763c-88jm) (critical, estado do OAuth usado como Magic Link, afeta `< 1.7.7`) | `better-auth@1.6.23` | `apps/web` (direta) | Sim, mas o caminho exige o plugin Magic Link, que nenhum código de produção carrega | Nenhuma versão 1.6 corrige; a correção está na 1.7.7 ou mais nova, cuja subida exige migration na tabela `account` (tarefa própria). | 2026-11-10 |
| [GHSA-r4xp-prcw-77qf](https://github.com/advisories/GHSA-r4xp-prcw-77qf) (high, afeta `< 1.7.7`) | `better-auth@1.6.23` | `apps/web` (direta) | Sim, mas exige o plugin OAuth Proxy, que não é carregado | Idem. | 2026-11-10 |
| [GHSA-q84f-53jg-9ppm](https://github.com/advisories/GHSA-q84f-53jg-9ppm) (high, aprovação do login de dispositivo, afeta `>=1.3.8-beta.3 <1.7.0-rc.3`) | `better-auth@1.6.23` | `apps/web` (direta) | Sim, mas exige o plugin `deviceAuthorization()` (e o bearer), que não são carregados | Idem. | 2026-11-10 |

Justificativa dos três avisos do `better-auth` (parecer do Rodrigo, 27/10/2026): nenhum é explorável hoje, porque cada um exige um plugin que o Polaris não usa (Magic Link, OAuth Proxy, `deviceAuthorization`). O `bun audit` acusa pela versão do pacote, não pelo uso. O `better-auth` chega ao runtime, o que o passo 4 do procedimento não aceita como exceção; ela existe por decisão do Arrascaeta (t434), com o parecer do Rodrigo, só por causa do teste de guarda abaixo e do prazo curto. **Condição de validade: nenhum plugin do Better Auth em produção.** O teste `apps/web/src/server/auth/no-plugins-in-production.test.ts` falha se o `createAuth` de produção receber qualquer plugin (o `testUtils` dos testes fica fora); a mensagem avisa que o Magic Link por e-mail tornaria explorável o aviso crítico GHSA-965c. Quem propuser um plugin (por exemplo, entrar por link no e-mail) sobe antes o `better-auth` para a 1.7.7 ou mais nova, remove estas três exceções e pede revisão de segurança.

**Revisão em 2026-11-10, ou antes, quando a tarefa de subida do `better-auth` para a 1.7.x for mesclada** (ela remove as três linhas e os três `--ignore`). A subida é maior que um bump: o 1.7 torna `issuer` obrigatório na tabela `account` e exige migration expand-only, ajuste do adaptador e revisão de RLS.

Justificativa do risco: `braces` só expande os padrões de glob que o `ultracite` monta a partir de arquivos do próprio repositório, na máquina de quem desenvolve; não há entrada de rede ou de usuário, e o pacote não entra em nenhum Worker nem no navegador. O pior efeito é a ferramenta local travar.

Na revisão do `braces`: rodar `bun pm view braces versions`; reavaliar também os overrides (tabela seguinte); se houver versão acima da 3.0.3, aplicar o passo 3 e remover a linha da tabela. Se o `ultracite` deixar de depender de `braces`, remover também.

## Overrides vigentes

Todo override ativo do `package.json` raiz fica nesta tabela, com motivo, data e condição de remoção. Override novo ou removido muda a tabela no mesmo PR; na revisão de cada exceção acima, conferir também se a condição de remoção destas linhas já vale (`bun pm why <pacote>` mostra quem ainda fixa a versão antiga).

| Override | Desde | Motivo | Remover quando |
| --- | --- | --- | --- |
| `sharp: 0.35.5` | 18/10/2026 (#136) | Advisory: `miniflare` (via `wrangler` e `@cloudflare/vite-plugin`) fixa `sharp@0.35.4`, afetado por [GHSA-wq5f-xc86-pv6w](https://github.com/advisories/GHSA-wq5f-xc86-pv6w) (falha na dependência `librsvg`, corrigida na 0.35.5). `sharp` só roda no emulador local (`miniflare`), não no Worker implantado. | Todos os `miniflare` do lock (`bun pm why miniflare`; há mais de uma versão) dependerem de `sharp >= 0.35.5`. |
| `zod: 4.6.7` (raiz) | 23/10/2026 (#272) | Advisory e incompatibilidade: `@polaris/contracts` pede `^4.6.6` por causa de [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5), mas `@cloudflare/vitest-plugin` pina o zod em versão exata (4.6.5, vulnerável). O override raiz põe todos na 4.6.7. Custa cerca de 194 B gzip no precache (ADR 0103). | Quando `@cloudflare/vitest-plugin` deixar de pinar versão exata do zod (conferir com `bun pm why zod`: a linha do plugin deve pedir faixa que inclua a 4.6.7 ou mais nova). |
| `undici: 7.30.1` só sob `miniflare` | 24/10/2026 (#278) | Advisory: `miniflare` fixa `undici@7.29.1` (exato), afetado por [GHSA-xjj6-f33q-929c](https://github.com/advisories/GHSA-xjj6-f33q-929c), corrigida na 7.30.1. Só roda no emulador local e nos testes (`@cloudflare/vitest-plugin`, `@cloudflare/vite-plugin`, `wrangler`), nunca no Worker implantado. O override é por pai para não mexer no `undici@8` do `webdriver`. | Todos os `miniflare` do lock (`bun pm why miniflare`; há mais de uma versão) dependerem de `undici >= 7.30.1`. |
| `undici: 7.30.1` só sob `cheerio` | 24/10/2026 (#278) | Advisory: `cheerio` (via `webdriverio`, ferramenta de teste em dispositivo real) pede `undici@^7.19.0`, e o lock o mantinha em versão afetada por [GHSA-xjj6-f33q-929c](https://github.com/advisories/GHSA-xjj6-f33q-929c). Só roda em ferramenta de desenvolvimento. | O `bun.lock` resolver o `undici` do `cheerio` para `>= 7.30.1` sem o override (testar removendo o override e rodando `bun install`; o `cheerio` instalado pode também já pedir `undici >= 7.30.1`). |
