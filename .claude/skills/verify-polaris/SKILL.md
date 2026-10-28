---
name: verify-polaris
description: "Sobe o app web do Polaris de verdade (build da worktree em vite preview + workerd, PostgreSQL 18 próprio, lojas fictícias com login de teste), chega na tela certa no estado certo com Playwright e guarda a prova em ~/tasks/<id>-telas/. Use para reproduzir um bug ou um relato vago (\"a lista de produtos está estranha no celular\", uma captura), provar uma mudança de tela antes do push, tirar capturas por estado (vazio, com vendas, plano Free no limite, sem conexão, 360/320/1280, claro/escuro) ou conferir se um bug já está corrigido na origin/main (com a worktree limpa na origin/main: o launch constrói o HEAD e as mudanças locais)."
---

# verify-polaris

Prova de comportamento do app web (`apps/web`) do jeito que a pessoa usa: tela → `/rpc` → Better Auth → RLS → PostgreSQL, sem laboratório e sem `page.route`. É a pilha do e2e-real ([runbook](../../../docs/runbooks/e2e-real.md)) mantida de pé entre os passos, para você olhar, agir e olhar de novo.

Antes de dirigir uma tela, leia [features/README.md](features/README.md) e o arquivo do destino: lá estão o caminho na interface, os seletores reais e o estado de que cada receita precisa. Se a tela não está no mapa, ela é nova: mapeie-a no mesmo PR (o teste `apps/web/scripts/verify-feature-map.test.ts` reprova rota sem mapa).

**Aceite:** `DOCTOR OK` e receitas verdes não são aceite: staging e aparelho real (BrowserStack) seguem com o QA.

## Pré-requisitos

**A skill pede Linux e bash 4 ou mais**: o `verify.sh` usa `${var,,}`, o doctor lê `/proc` e a porta com `ss` (iproute2), e o cluster próprio do PostgreSQL usa os binários de Linux. No macOS o bash do sistema é o 3.2 e o `verify.sh` para na primeira linha com `PREFLIGHT FALTA bash`; nada disso foi provado fora do Linux.

O que tem de existir antes do primeiro `launch`. O `$V preflight` confere tudo isto sem criar nada (e o `launch` o roda antes de começar): uma linha `PREFLIGHT FALTA <VARIÁVEL>: o que fazer` por item que falta, sem stack trace, e `PREFLIGHT OK` quando está tudo.

| Item | Variável | Como a skill acha |
|---|---|---|
| Node 24 (`.node-version`) | `VERIFY_NODE` (caminho do binário `node`) | `VERIFY_NODE`, senão o `node` do `PATH` se for 24 |
| Binários do PostgreSQL 18 (`initdb`, `pg_ctl`) | `PG_BIN` (a pasta `bin`) | `PG_BIN`, senão o `PATH`. Dispensável com `POLARIS_E2E_DATABASE_URL` (dono de um PostgreSQL local; ver Launch) |
| `bun` | `PATH` | o do `PATH`; roda o `stack.ts` |
| `git` e `ss` (iproute2) | `PATH` | o do `PATH`; o doctor lê a porta com `ss` |
| Dependências instaladas | | `bun install --frozen-lockfile` na worktree (precisa de `apps/web/node_modules/@playwright/test`) |
| Navegador do Playwright (Chromium e o `chromium_headless_shell` da mesma versão) | `PLAYWRIGHT_BROWSERS_PATH` (padrão `~/.cache/ms-playwright`) | o cache da máquina; sem eles o preflight diz `PREFLIGHT FALTA PLAYWRIGHT_BROWSERS_PATH` e o comando (`cd apps/web && bunx playwright install chromium`) em vez de deixar o primeiro drive falhar |
| Pasta de evidência | `VERIFY_EVIDENCE_DIR` (padrão `~/tasks/<id>-telas`) | gravável ou criável (use uma pasta fora do repositório: a evidência nunca é commitada) |
| Pasta de estado | `VERIFY_STATE_DIR` (padrão `/tmp/polaris-verify/<id>`) | gravável ou criável |
| Worktree com `.git` gravável | | uma worktree sua (`git worktree add`); o git cria `index.lock` no diretório git dela |

**Fallback só desta máquina de dev:** sem `VERIFY_NODE`/`PATH` com Node 24, o `verify.sh` procura `~/tools/node-v24*/bin/node`; sem `PG_BIN` nem `initdb` no `PATH`, procura `~/pgtest/pg18/package/native/bin`. Em qualquer outra máquina, defina as variáveis.

## Comandos

Tudo passa por um script, de qualquer pasta da worktree:

```bash
V=.claude/skills/verify-polaris/scripts/verify.sh
$V preflight              # o que falta antes do launch, sem criar nada (o launch já o roda)
$V launch                 # pilha nova, loja "vazia" semeada, termina com o doctor
$V doctor                 # só leitura: vale a pena dirigir esta instância?
$V seed vendas            # outra loja (vazia | vendas | limite | pro)
$V snap /products --project celular-claro          # captura + ARIA de um endereço
$V drive <arquivo.verify.ts> --project desktop-claro  # um drive Playwright
$V sql "SELECT ..."       # efeito colateral no banco, só leitura
$V evidence               # onde está e o que tem a evidência
$V cleanup                # derruba o que o launch criou; a evidência fica
```

## Launch

`$V launch [--runtime] [--assinatura]` (de 20 s a 1 min nesta máquina; o `vite build` é a parte longa). Começa pelo `preflight` (acima); se faltar algo, para ali.

1. Cria o diretório de estado `/tmp/polaris-verify/<id>/` (o `<id>` é o nome da pasta da worktree, `~/wt/<id>`; `VERIFY_ID` muda). Se já existe uma instância desse id, recusa: use `doctor` ou `cleanup`.
2. Banco: sem `POLARIS_E2E_DATABASE_URL`, um **cluster PostgreSQL 18 próprio** no estado (`initdb` + `pg_ctl`, só `127.0.0.1`, porta livre a partir de 55400 ou `VERIFY_PG_PORT`, dono `verify_owner` com senha aleatória). Os binários vêm de `PG_BIN` ou do `PATH` (fallback desta máquina: `~/pgtest/pg18/package/native/bin`). Nunca usa o PostgreSQL compartilhado da porta 5432 nem Neon. Com `POLARIS_E2E_DATABASE_URL` (dono de um PostgreSQL local com `CREATEDB` e `CREATEROLE`, e superusuário para o papel de leitura do `sql`), usa esse, passando pela mesma guarda do e2e-real: só `localhost` ou `127.0.0.1`; Neon ou qualquer outro host é recusado antes de criar qualquer coisa.
3. Banco do run `e2e_<run>` migrado do zero (`db:migrate`) e os 7 logins dos Hyperdrive (`createRunDatabase` do e2e-real), mais o papel de leitura `verify_reader_<run>` do `sql`.
4. `node apps/web/e2e-real/serve.ts verify <porta>`: `vite build` da worktree em `apps/web/dist-e2e/verify/` e `vite preview` dele, com o ambiente fechado do e2e-real (só o segredo do run e as 7 conexões). Porta livre a partir de 4400 (ou `VERIFY_PORT`), reservada em `/tmp/polaris-verify/ports/` para duas worktrees que sobem juntas não pegarem a mesma. Roda destacado; o log fica em `/tmp/polaris-verify/<id>/preview.log`. Precisa do **Node 24** (`.node-version`): sob o Bun o miniflare não responde. O script usa `VERIFY_NODE` ou o `node` do `PATH` quando é 24 (fallback desta máquina: `~/tools/node-v24*/bin`).
5. Espera `/health` responder (até 8 min), semeia a loja `vazia` pelo `/rpc` do próprio Worker e roda o doctor.

Pronto é `DOCTOR OK http://127.0.0.1:<porta> build verify` na última linha. Qualquer `FAIL` antes dela: não dirija; leia o `preview.log` e rode `$V cleanup` antes de tentar de novo.

Opções:

- `--runtime`: build com `VITE_OFFLINE_RUNTIME_ENABLED=true` (projeto `verify-runtime`), o runtime offline e o service worker ligados, como o projeto `runtime-ligado` do e2e-real. Sem a opção, o build é o de produção hoje (runtime desligado). O ambiente fechado do e2e-real não leva as duas chaves que o Worker usa no offline, então esta opção as acrescenta só ao preview: `OFFLINE_LEASE_SECRET` (assina a concessão de offline; sem ela o `issueLease` responde 503 e até a loja Pro diz "Offline indisponível neste aparelho") e `SYNC_PAYLOAD_HASH_SECRET` (o `sync.push` falha fechado sem ela). Cada uma é um hash do segredo do run, vive no processo do preview e nunca entra no build (`closed-environment.ts`).
- `--assinatura`: liga `BILLING_SELF_SERVICE_ENABLED` só neste preview (o topo do `wrangler.jsonc` o deixa desligado, como a produção). A aba Assinatura passa a ler o plano e o uso; contratar o Pro continua indisponível (não há provedor nem chave aqui, e nem deve haver).

Lojas (`$V seed <loja>`; cada uma é um usuário dono com e-mail `qa-verify-<loja>-t<n>@e2e.invalid`, organização com o mesmo nome no fuso `America/Sao_Paulo`, e o seu `cf-connecting-ip`, então cada loja tem o seu balde de limite de taxa):

| Loja | O que tem | Para |
|---|---|---|
| `vazia` | nada (semeada no launch) | estados vazios, primeiro cadastro |
| `vendas` | Camiseta básica (59,90; 30 un.), Caneca esmaltada (35,00; 20 un.) e Vela aromática (45,00; 15 un.), custo 12,00; 8 vendas em dinheiro nos últimos 7 dias (2 hoje) | Início com números, Histórico, Detalhe, devolução, Resultado |
| `limite` | 50 produtos (`Produto 01`…`Produto 50`, 10,00): o plano Free no teto de 50 variantes ativas | avisos de limite do plano; Assinatura "50 de 50" com `--assinatura` |
| `pro` | Camiseta básica (59,90; 30 un.) e Caneca esmaltada (35,00; 20 un.), custo 12,00, sem vendas; o plano Pro: linha `organization_billing` em `active`, com o fim do acesso daqui a 365 dias | escrever offline (venda guardada no aparelho e enviada ao voltar), com `launch --runtime` |

A semeadura entra pelos comandos do Worker (`product.create`, `inventory.receiveStock`, `sale.confirm`), nunca por SQL. A única exceção é o plano da loja `pro`: não há provedor, checkout nem webhook nesta pilha (e nem deve haver), então o `seed pro` grava com o dono do banco do run o mesmo registro de cobrança que o ciclo de cobrança deixaria numa assinatura ativa (`organization_billing` com estado `active`, ciclo de 1 mês e acesso até daqui a 365 dias), que é o que o plano lê. Nada de Asaas, Woovi nem rede. Uma semeadura que falha no meio deixa o usuário criado; a próxima tentativa usa `-t<n+1>`.

## Doctor

`$V doctor` responde, só lendo, se a instância vale ser dirigida. Rode antes do primeiro drive, depois de qualquer drive que falhou de um jeito estranho e sempre que algo parecer fora do lugar. Confere:

- o processo do preview que o launch iniciou está vivo;
- **a porta é nossa**: o processo que escuta nela descende do processo do launch (`ss -ltnp` + `/proc`);
- `/health` responde `{"status":"ok"}`;
- **a build é a da worktree**: o `index.html` servido aponta os mesmos assets de `dist-e2e/<projeto>/client/index.html`, e o `HEAD` e as mudanças locais de `apps/` e `packages/` são as mesmas do momento do build. Mudou o código depois do launch? O doctor reprova: `cleanup` e `launch` de novo;
- **o login funciona**: o cookie de cada loja abre `/api/auth/get-session` com o usuário dela;
- **o banco está semeado**: a loja tem o dono como membro e o que a receita dela promete (ao menos 3 variantes e 8 vendas em `vendas`, ao menos 50 variantes em `limite`, ao menos 2 variantes e o plano `active` em `pro`: as receitas e os drives acrescentam dados, e o doctor não pode reprovar uma instância só porque foi dirigida).

## Drive

O harness é o Playwright do repo (`apps/web/node_modules/@playwright/test`), com a config `playwright.verify.config.ts` desta skill. Cada drive é um arquivo `*.verify.ts` que importa `test` e `expect` de `drive/fixture.ts`; a página já abre com a sessão da loja (`VERIFY_LOJA`, padrão `vazia`), na origem da instância, com `pt-BR` e o fuso de São Paulo.

Projetos (escolha com `--project`, repita para vários): `desktop-claro`, `desktop-escuro` (1280×800, mouse), `celular-claro`, `celular-escuro` (360×740, toque, `isMobile`), `celular-320-claro`, `celular-320-escuro` (320×640, toque). O tema é o `prefers-color-scheme` do contexto, e o app está em "Automático".

Drives prontos (`drives/`):

- `snap.verify.ts`, por `$V snap <caminho>`: abre o endereço, espera o `h1` e o fim dos "Carregando…", e guarda captura e ARIA. É o primeiro passo diante de um relato vago.
- `produtos-criar.verify.ts`: cria um produto pelo menu e o vê na lista, também depois de recarregar.
- `receitas.verify.ts` (loja `vendas`; escolha com `--grep <id>`; o `id` é o da sub-feature no mapa): `venda-confirmar`, `historico-detalhe`, `venda-devolver`, `venda-cancelar`, `estoque-receber`, `estoque-contar`, `estoque-baixar`, `cliente-criar`, `produto-importar`, `resultado-periodo`, `despesas` e `metas`. Cada um termina no estado que prova a receita, visto na tela, e roda de novo sem semear (dados com nome único, saldo lido antes, a meta existente editada em vez de criada de novo); o que se esgota é o saldo da Caneca esmaltada, que dura umas 6 rodadas (a conta está em [features/estoque.md](features/estoque.md)). A nota de cada um está no arquivo do destino no mapa.
- `offline-pro.verify.ts` (loja `pro`, instância `launch --runtime`): `venda-offline`, a venda guardada sem rede e enviada ao voltar (ver Modo offline).

```bash
VERIFY_LOJA=vendas $V drive .claude/skills/verify-polaris/drives/receitas.verify.ts --grep estoque-receber --project celular-claro
VERIFY_LOJA=pro $V drive .claude/skills/verify-polaris/drives/offline-pro.verify.ts --project desktop-claro
```

Drive novo (reprodução de bug, estado de uma tarefa): escreva em `.claude/skills/verify-polaris/drives/local/<nome>.verify.ts` (ignorado pelo git e apagado no cleanup; a fixture copia o arquivo para a evidência a cada execução). Modelo:

```ts
import { expect, test } from "../../drive/fixture";

test("lista de produtos no celular", async ({ evidence, page }) => {
  await page.goto("/products");
  await expect(page.getByRole("heading", { exact: true, level: 1, name: "Produtos" })).toBeVisible();
  await evidence.shot("produtos-lista", "lista de produtos da loja limite");
});
```

Regras do drive:

- Use os seletores do mapa: papel e nome acessível (`getByRole`, `getByLabel`), e `[data-product-id]` onde o mapa o cita. Não invente seletor; se o mapa não tem, leia o spec citado no arquivo do destino ou o ARIA de um `snap`.
- Chegue pela interface quando o caminho importa (menu lateral no desktop; barra de baixo e "Mais" no celular). `page.goto` é para o ponto de partida.
- Espere pelo estado (`expect(...).toBeVisible()`, `toHaveText`), nunca por tempo fixo. O `expect` espera até 15 s (a config): numa máquina carregada o "Carregando…" de uma lista passa dos 5 s do padrão do Playwright, e um drive que lê um saldo ou uma lista logo depois de abrir a tela caía por isso.
- Uma falha guarda o contexto do erro em `/tmp/polaris-verify/<id>/playwright/<teste>/error-context.md` (o ARIA da página na hora): leia antes de mudar o drive. Depois de uma falha estranha, `$V doctor`.

Estados que as tarefas pedem:

| Estado | Como |
|---|---|
| Loja vazia | loja `vazia` (padrão) |
| Loja com vendas | `$V seed vendas` e `VERIFY_LOJA=vendas` |
| Plano Free no limite | `$V seed limite` e `VERIFY_LOJA=limite`; "Novo produto" mostra "Seu plano chegou ao limite de variantes. Nada foi cadastrado."; a aba Assinatura só com `launch --assinatura` |
| Sem conexão (pilha real) | `launch --runtime`; no drive, abra `/` com rede, espere `navigator.serviceWorker.ready` e recarregue (a aba passa a ser controlada pelo worker), então `await context.setOffline(true)` e navegue pelo menu. Ver os Gotchas de [features/README.md](features/README.md) |
| Sem conexão com escrita (venda guardada no aparelho e enviada ao voltar) | `launch --runtime`, `$V seed pro` e `offline-pro.verify.ts` (modo offline abaixo) |
| Sem conexão (fila, Pendências, troca de versão, estados que a pilha real não produz) | harnesses de navegador, modo offline abaixo |
| Celular 360 e 320 com toque | projetos `celular-*` e `celular-320-*` |
| Desktop 1280 | projetos `desktop-*` |
| Tema claro e escuro | sufixo `-claro` / `-escuro` do projeto |

### Modo offline (`test:offline-browser`)

As lojas `vazia`, `vendas` e `limite` são Free, e o plano Free não escreve offline: na pilha real, sem rede, a barra diz "Offline indisponível neste aparelho". A escrita offline se prova na loja `pro` (plano Pro gravado no banco do seed) de uma instância `launch --runtime`, que é a pilha real inteira: `VERIFY_LOJA=pro $V drive .claude/skills/verify-polaris/drives/offline-pro.verify.ts --project celular-claro`. O drive espera o aparelho ficar "Tudo sincronizado", corta a rede, guarda uma venda, devolve a rede e vê a venda sair do cartão "Vendas guardadas neste aparelho" e entrar no Histórico; `$V sql` lê o preço enviado (a venda só é oficial depois). Sem `--runtime` a loja `pro` também diz "Offline indisponível". Os fluxos que a pilha real não produz sozinha (fila com rejeição, sincronização com falha, Pendências, troca de versão) se provam nos harnesses de navegador do repo, com API simulada e o build de produção:

```bash
cd apps/web   # Node 24 no PATH
bunx playwright test --config playwright.offline-poc.config.ts --project chromium-desktop --workers=1 e2e/offline-screens.e2e.ts
bunx playwright test --config playwright.pwa.config.ts --project chromium-desktop --workers=1 e2e-pwa/home-offline.e2e.ts
```

As telas desse modo abrem no laboratório `/offline-screens-lab?screen=<sale|history|stock|products|dashboard|expenses|home|sale-detail|payment-profiles|change-password>`, com a caixa "Rede disponível" no lugar da rede. Rode só o spec da tarefa, um projeto e um worker (a CPU desta máquina é o gargalo); a suíte inteira é do CI. Portas: `E2E_OFFLINE_POC_PORT` (4173) e `E2E_PWA_PORT` (4174), ver [testes-de-tela](../../../docs/runbooks/testes-de-tela.md).

### Admin

O Admin (`apps/admin`) é outro Worker, atrás do Cloudflare Access, sem pilha local nesta skill. A prova dele são os testes do pacote (`bunx vitest run --project node apps/admin`, e os de Worker em `vitest.admin-worker.config.ts`, que precisam de banco).

## Evidence

Tudo vai para `~/tasks/<id>-telas/` (ou `VERIFY_EVIDENCE_DIR`), que o cleanup nunca apaga:

- `evidence.shot(nome, estado)` grava `<nome>-<projeto>.png` (a tela visível) e `<nome>-<projeto>.aria.yml` (o ARIA do `body` inteiro, Dialog aberto incluído) e acrescenta uma linha ao `LEIAME.md`: arquivo, estado, endereço, loja, projeto e commit (`HEAD` curto, mais "+ mudanças locais" se `apps/` ou `packages/` têm mudança não commitada).
- Cada drive grava o traço inteiro em `traces/<drive>-<projeto>-<instante>.zip` (`npx playwright show-trace <arquivo>`), com uma linha "passou" ou "FALHOU" no `LEIAME.md`, e copia o arquivo do drive para `drives/`.
- `$V sql "<SELECT>"` roda uma consulta só (protocolo estendido: `COMMIT; …` é recusado) no banco do run, dentro de `BEGIN READ ONLY` e `ROLLBACK`, como o papel `verify_reader_<run>` (lê tudo, passa pela RLS, não é superusuário: `pg_read_file` e `COPY … TO PROGRAM` são recusados). Imprime as linhas e as guarda em `sql/<instante>.txt` com uma linha no `LEIAME.md`.
- Uma captura tirada de novo sobrescreve o arquivo e a linha dela no `LEIAME.md`.

Padrão da prova:

- Pelo caminho da pessoa: menu, botão, Dialog. Nada de setter interno, rota de teste ou `page.route`.
- A ação **e** o estado que resulta dela: uma captura antes, uma com o formulário preenchido, uma depois.
- Efeito colateral visto de um segundo jeito: recarregar e ver de novo, abrir o item em outra tela, ou `$V sql` (a linha gravada, o saldo).
- Nada de serviço externo de verdade: e-mail, Google, cobrança e mídia (R2) não rodam aqui. O que depende deles fica dito como não verificado.
- Captura de PR (AGENTS.md): os estados pedidos a 360×740 e 1280×800, claro e escuro, e 320 quando algo encosta na largura, tiradas depois do último commit. Nunca commitadas. Não anexe `traces/` nem `sql/` ao PR: o traço leva o cookie da sessão da loja e o `sql/` o resultado cru (tudo fictício, mas não é captura).

## Cleanup

`$V cleanup` desfaz só o que o launch desta worktree criou, e roda também depois de um launch que falhou no meio:

- mata o grupo de processos do preview pelo pid gravado (serve.ts, vite preview, workerd), mesmo que o serve.ts já tenha morrido, e só se algum membro do grupo ainda é o `serve.ts`/`dist-e2e/<projeto>` desta instância (pid reciclado de outra tarefa fica); nunca por nome;
- apaga o banco do run, os 7 logins e o papel de leitura; para o cluster próprio (se o `pg_ctl stop` falha, o estado fica e o erro diz por quê);
- apaga `apps/web/dist-e2e/<projeto>`, o ponteiro `apps/web/.wrangler/deploy` quando aponta para esse build, as reservas de porta e o estado em `/tmp/polaris-verify/<id>/`;
- copia os drives de `drives/local/` para `drives/` da evidência e só então apaga a pasta (um drive que não chegou a rodar não se perde);
- confere que a porta ficou livre;
- **não toca** em `~/tasks/<id>-telas/`. Depois do cleanup, `$V evidence` lista o que ficou.

Rode o cleanup ao terminar a tarefa, depois de cada tentativa de launch que falhou e **antes do `bun run check`/`bun run test`**: com a instância de pé, o bundle em `apps/web/dist-e2e/<projeto>/` entra na varredura de testes de código-fonte (o `capability-guard.test.ts` reprova com `dist-e2e/verify…/index.js` na lista). `apps/web/.wrangler/state` (estado local do miniflare, ignorado pelo git) fica, como fica depois do e2e-real.

## Helpers

| Arquivo | O que é |
|---|---|
| `scripts/verify.sh` | ponto de entrada (executável); o `preflight`; acha Node 24 e o PostgreSQL (variáveis, `PATH` e o fallback desta máquina) |
| `scripts/stack.ts` | launch, doctor, seed, sql e cleanup, sob o Bun; reaproveita `apps/web/e2e-real/` (ambiente do run, banco, `serve.ts`, sessão do `testUtils`, sementes) |
| `scripts/leiame.ts` | o `LEIAME.md` da evidência |
| `playwright.verify.config.ts` | projetos de largura e tema, sessão da loja, saída em `/tmp` |
| `drive/fixture.ts` | `test`, `expect` e `evidence` dos drives |
| `drives/*.verify.ts` | drives prontos (acima): `snap`, `produtos-criar`, `receitas`, `offline-pro` |

Duas worktrees podem ter instâncias ao mesmo tempo (ids, portas, estados e clusters diferentes). Na mesma worktree, uma instância por vez, e não rode o `test:e2e-real` junto: os dois usam `apps/web/.wrangler/deploy`.

## Onde esta skill foi provada

Provada nesta máquina (Linux arm64, Bun 1.4, Node 24.21 de `~/tools`, PostgreSQL 18 de `~/pgtest`) com o cluster próprio. Não foi provada com `POLARIS_E2E_DATABASE_URL` (um PostgreSQL de fora), nem no CI, nem em outra máquina: nesses casos, rode o `$V preflight` primeiro e resolva o que ele listar. O `preflight` foi testado com `PATH` vazio (lista os itens que faltam, sem stack trace). O typecheck de `scripts/`, `drive/`, `drives/` e da config roda no `bun run typecheck` (`tsconfig.skills.json`).

Manutenção do mapa: [`maintain-verify-polaris`](../maintain-verify-polaris/SKILL.md). Origem: adaptada de `pstack-create-verification-skill` (pstack, de Lauren Tan, licença MIT; ver `LICENSE` e `NOTICE.md` nesta pasta).
