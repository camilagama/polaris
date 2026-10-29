# Auditoria de dependências

Procedimento e registro de exceções do job "Dependency audit" do CI, que roda `bun audit --audit-level=high` quando uma dependência muda (e sob demanda). O job é consultivo (`continue-on-error`), mas não deve ter aviso sem destino: cada aviso é corrigido ou entra na tabela de exceções abaixo, com justificativa e prazo.

## Gatilho

- O job falhou no CI, ou alguém mudou `package.json`/`bun.lock` (o job também roda quando o próprio `.github/workflows/ci.yml` muda, para exercitar os `--ignore`).
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

Nenhuma.

Histórico: de 27/10/2026 (t434) até a subida do `better-auth` para a 1.7.12 (t435), o CI passava `--ignore` para GHSA-965c-763c-88jm (crítico), GHSA-r4xp-prcw-77qf e GHSA-q84f-53jg-9ppm, os três do `better-auth@1.6.23`, cada um num plugin que o Polaris não carrega (Magic Link, OAuth Proxy, `deviceAuthorization`), com o parecer do Rodrigo. A 1.7.12 corrige os três: as linhas saíram desta tabela, e os três `--ignore` do workflow, que já não têm efeito, saem também (o agente não altera workflow: a remoção vai como patch para o responsável pelo CI aplicar). Fica a regra que sustentava a exceção: **nenhum plugin do Better Auth em produção sem revisão de segurança antes.** O teste `apps/web/src/server/auth/no-plugins-in-production.test.ts` falha se o `createBetterAuth` de produção receber qualquer plugin (o `testUtils` dos testes fica fora), se algum arquivo de produção importar `better-auth/plugins` ou `@better-auth/*` (em `auth.ts` só passa a linha que repassa a chave `plugins`) e se surgir um arquivo novo que construa a instância sem entrar na lista do teste. Quem propuser um plugin (por exemplo, entrar por link no e-mail) pede a revisão de segurança e muda o teste e este runbook no mesmo PR.

## Overrides vigentes

Todo override ativo do `package.json` raiz fica nesta tabela, com motivo, data e condição de remoção. Override novo ou removido muda a tabela no mesmo PR; na revisão de cada exceção acima, conferir também se a condição de remoção destas linhas já vale (`bun pm why <pacote>` mostra quem ainda fixa a versão antiga).

| Override | Desde | Motivo | Remover quando |
| --- | --- | --- | --- |
| `sharp: 0.35.5` | 18/10/2026 (#136) | Advisory: `miniflare` (via `wrangler` e `@cloudflare/vite-plugin`) fixa `sharp@0.35.4`, afetado por [GHSA-wq5f-xc86-pv6w](https://github.com/advisories/GHSA-wq5f-xc86-pv6w) (falha na dependência `librsvg`, corrigida na 0.35.5). `sharp` só roda no emulador local (`miniflare`), não no Worker implantado. | Todos os `miniflare` do lock (`bun pm why miniflare`; há mais de uma versão) dependerem de `sharp >= 0.35.5`. |
| `zod: 4.6.7` (raiz) | 23/10/2026 (#272) | Advisory e incompatibilidade: `@polaris/contracts` pede `^4.6.6` por causa de [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5), mas `@cloudflare/vitest-plugin` pina o zod em versão exata (4.6.5, vulnerável). O override raiz põe todos na 4.6.7. Custa cerca de 194 B gzip no precache (ADR 0103). | Quando `@cloudflare/vitest-plugin` deixar de pinar versão exata do zod (conferir com `bun pm why zod`: a linha do plugin deve pedir faixa que inclua a 4.6.7 ou mais nova). |
| `undici: 7.30.1` só sob `miniflare` | 24/10/2026 (#278) | Advisory: `miniflare` fixa `undici@7.29.1` (exato), afetado por [GHSA-xjj6-f33q-929c](https://github.com/advisories/GHSA-xjj6-f33q-929c), corrigida na 7.30.1. Só roda no emulador local e nos testes (`@cloudflare/vitest-plugin`, `@cloudflare/vite-plugin`, `wrangler`), nunca no Worker implantado. O override é por pai para não mexer no `undici@8` do `webdriver`. | Todos os `miniflare` do lock (`bun pm why miniflare`; há mais de uma versão) dependerem de `undici >= 7.30.1`. |
| `undici: 7.30.1` só sob `cheerio` | 24/10/2026 (#278) | Advisory: `cheerio` (via `webdriverio`, ferramenta de teste em dispositivo real) pede `undici@^7.19.0`, e o lock o mantinha em versão afetada por [GHSA-xjj6-f33q-929c](https://github.com/advisories/GHSA-xjj6-f33q-929c). Só roda em ferramenta de desenvolvimento. | O `bun.lock` resolver o `undici` do `cheerio` para `>= 7.30.1` sem o override (testar removendo o override e rodando `bun install`; o `cheerio` instalado pode também já pedir `undici >= 7.30.1`). |
| `basic-ftp: 6.2.3` (raiz) | 28/10/2026 (#389) | Advisory: `get-uri` (via `proxy-agent`, do `@lhci/cli`) pede `basic-ftp@^5.0.2`, afetado por [GHSA-c475-qrg2-pj4r](https://github.com/advisories/GHSA-c475-qrg2-pj4r) (custo quadrático no `Client.list()`, corrigido na 6.2.1). Só é carregado para resolver um script de proxy (PAC) por `ftp:`, o que o fluxo não faz. | O `get-uri` pedir `basic-ftp >= 6.2.1` (conferir com `bun pm why basic-ftp`). |
| `body-parser: 1.20.9` (raiz) | 28/10/2026 (#389) | Advisory: `express@4` (do `@lhci/cli`; o `evlog` só o lista como peer opcional) pede `body-parser@~1.20.5` e o lock caía na 1.20.8, afetada por [GHSA-27r3-jxmh-p828](https://github.com/advisories/GHSA-27r3-jxmh-p828) (negação de serviço por bytes depois de um corpo comprimido; corrigida na 1.20.9). A 1.20.9 é de 22/10/2026, então entra pelo caminho de atualização urgente (`minimumReleaseAgeExcludes` no `bunfig.toml` e em `URGENT_EXCLUDES` de `ui-supply-chain.test.ts`). Conferido o pacote publicado: diferença de 1.20.8 para 1.20.9 é o `lib/read.js` (a checagem do charset antes de criar o decodificador) e o `HISTORY.md`, mesmas dependências, publicado por OIDC do GitHub (`trustedPublisher`). No `@lhci/cli` 0.15.1 o `express` vem de `src/collect/fallback-server.js`, cujo servidor só sobe com `collect --staticDistDir`; o `lighthouserc.json` não usa essa opção (nem `startServerCommand`, vetada por cautela), e `apps/web/scripts/lighthouse-config.test.ts` reprova se algum dos dois entrar. | Depois de 29/10/2026 (7 dias): PR que tira `body-parser` do `minimumReleaseAgeExcludes` e de `URGENT_EXCLUDES` (o override pode ficar até o `express` pedir `body-parser >= 1.20.9`: `bun pm why body-parser`). |
| `@puppeteer/browsers: 3.2.5` só sob `puppeteer-core` | 28/10/2026 (#389) | Advisory: `puppeteer-core@24.43.1` (do `lighthouse`, do `@lhci/cli`) fixa `@puppeteer/browsers@2.13.2`, que depende de `extract-zip@2.0.1`, afetado por [GHSA-jmr9-qjv8-65gv](https://github.com/advisories/GHSA-jmr9-qjv8-65gv) e [GHSA-7pqw-9j4j-h8q3](https://github.com/advisories/GHSA-7pqw-9j4j-h8q3) (links simbólicos ao extrair; sem versão corrigida). A 3.2.5 é a que o `webdriverio` já usa (extrai com `modern-tar`). O fluxo não baixa navegador (o Chromium é o do Playwright, entregue ao `lhci` por `CHROME_PATH`), e o `test:lighthouse` mede igual com ela. | O `puppeteer-core` pedir `@puppeteer/browsers >= 3` ou o `extract-zip` ter versão corrigida (conferir com `bun pm why extract-zip`). |
| `tmp: 0.2.7` (raiz) | 28/10/2026 (#389) | Advisory: `@lhci/cli` (Lighthouse CI, ferramenta de desenvolvimento de `apps/web`) pede `tmp@^0.1.0` e, pelo `inquirer`, `tmp@^0.0.33` (via `external-editor`), os dois afetados por [GHSA-ph9p-34f9-6g65](https://github.com/advisories/GHSA-ph9p-34f9-6g65) (travessia de caminho no prefixo ou sufixo; a 0.2.6 ainda tem [GHSA-7c78-jf6q-g5cm](https://github.com/advisories/GHSA-7c78-jf6q-g5cm), corrigida na 0.2.7). O `lhci` só usa `tmp` para a pasta de trabalho local; roda em desenvolvimento e no CI do `test:lighthouse`, nunca no Worker. | O `@lhci/cli` pedir `tmp >= 0.2.7` (conferir com `bun pm why tmp`) ou sair do projeto. |
