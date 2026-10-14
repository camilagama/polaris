# Revisão completa até o checkpoint Gate 4 (PR01–PR47)

Data: 13 de outubro de 2026. Head revisado: `codex/pr47-sale-dates` (`9780433`).

Método: nove revisores independentes e somente leitura, cada um com uma fatia do plano (`doc/plano-inicial.md`), mais a leitura do plano e verificação direta, por mim, dos achados mais consequentes. Nenhum gate PostgreSQL foi reexecutado nesta revisão: os resultados dos gates vêm de `doc/status-implementacao.md` e das execuções feitas durante a implementação. Os revisores rodaram apenas testes unitários, typecheck, Knip e format check locais (616 testes verdes).

Achados que **eu mesmo confirmei no código**: I-A1 (média na reposição), I-B1 (erro sem mapeamento), I-D2 (sem checagem de Origin), a ausência de tela de login e estoque, e a ausência de fechamento do Gate 3. Os demais são relatos dos revisores com evidência `arquivo:linha` e estão marcados como "reportado".

---

## 1. Veredito

**Seguimos o plano em sequência, escopo e gates de cada etapa, e a base de backend (domínio, banco, RLS, venda) é de qualidade alta. Não há achado Crítico de código nem vazamento entre tenants.** Mas a revisão encontrou:

1. **Um bug real de valoração de estoque** que eu introduzi no PR45 (média de custo na reposição, I-A1).
2. **Um bug real de mapeamento de erro** (500 em vez de 409, I-B1).
3. **Um gate formalmente ausente** (Gate 3 nunca foi fechado, e o plano manda seguir as fases estritamente).
4. **Uma lacuna estrutural de prova**: nenhum SQL, RLS nem trigger roda em CI; tudo depende de gates manuais em Neon.
5. **Uma lacuna de produto**: pela interface, ainda não é possível vender de ponta a ponta (não existe tela de estoque, e a organização vem do `localStorage`).
6. **Decisões de domínio que precisam de você** (seção 5), em especial o que fazer com produto removido (tombstone) e com `timestamp` sem fuso.
7. **Dívida de documentação e de processo**: plano reescrito sem ADR, regras duplicadas, 22 PRs empilhados sem integração.

Nada disso impede o checkpoint, mas vários itens devem ser resolvidos **antes da Fase 5** (marcados abaixo como "antes da Fase 5") e outros **antes de qualquer exposição pública** ("antes do go-live").

---

## 2. Aderência ao plano, por fase

| Fase | Seguiu o plano? | Observação |
| --- | --- | --- |
| 0 — PR01–PR06, Gate 0 | Sim, em substância | Faltam: verificação de dependência circular (o plano pede "zero dependência circular"), `format:check` no CI, template de PR (§1 do plano), política de dependências em texto. |
| 1 — PR07–PR12, Gate Foundation | Sim | Prova de RLS/Hyperdrive é forte. Edge e Android real adiados (o plano pedia). Runtime (PR07–09) só tem aceite manual. |
| 2 — PR13–PR23, Gate Auth, Gate 2 | Sim | Desvios justificados e documentados (onboarding via `SECURITY DEFINER`, ADR 0007; outbox adiado). Login UI é pré-go-live por decisão do próprio plano (linha 1444). |
| 3 — PR24–PR35 | Sim nas etapas; **Gate 3 não foi fechado** | Não existe seção "Gate 3" no status nem script/runbook, enquanto Gate 0/2/4 têm. As provas existem espalhadas pelos gates por PR, mas "mídia privada" nunca foi provada ponta a ponta (rota + banco + R2 reais). |
| 4 — PR36–PR47 | Sim | Todas as etapas e o Gate 4 entregues; decisões onde o plano era omisso estão documentadas. |

Desvios de **processo** relevantes (não de ordem): branches `codex/…` em vez de `feat/…`; cadeia de PRs empilhados sem integração (o plano diz "não desenvolver semanas numa branch"); PRs grandes (PR43 com cerca de 13,9 mil linhas, boa parte snapshots); plano reescrito em cerca de 685 linhas sem ADR nem changelog.

---

## 3. Achados priorizados

Legenda de prazo: **A5** = antes da Fase 5; **GL** = antes do go-live; **BL** = backlog. "Reportado" = relato de revisor com evidência; "Confirmado" = verifiquei no código.

### A. Bugs e correções de código

| ID | Severidade | Achado | Prazo |
| --- | --- | --- | --- |
| I-A1 | **Importante** (confirmado; erro meu, PR45) | `restockMovingAverageCost` (`inventory-cost.ts:148-150`) devolve a média antiga quando o custo do snapshot é desconhecido, **mesmo com saldo zero**. Cenário: vende-se todo o estoque, a média X permanece, cancela-se uma venda cujo item tinha custo desconhecido, e as unidades voltam com média X (custo inventado). Um recebimento nunca faz isso. Correção: com saldo zero e custo desconhecido, a média vira `null`; com saldo positivo, decidir entre manter ou marcar desconhecida (ver decisão D-2). | A5 |
| I-B1 | **Importante** (confirmado) | `ProductDefaultVariantStockHistoryConflictError` não é mapeado em `toRpcError` (nenhuma referência em `apps/web/src`): `product.configureVariants` em produto com histórico responde 500 em vez de 409, sem mensagem de UI. Correção: mapear, testar o router e tratar na UI. | A5 |
| I-B2 | Importante (reportado, executado pelo revisor) | `Percentage` não tem teto: `Percentage.from("99999999999999999999999999")` é aceito; taxa de 250% (digitou 250 em vez de 2,50) é gravada sem alerta e distorce o resultado; valores absurdos estouram `Money` e viram 400 genérico. Sem teto também em parcelas (até cerca de 2,1 bilhões) e prazo. Correção: teto de domínio e CHECK no banco (por exemplo taxa ≤ 100, parcelas ≤ 99 configurável, prazo ≤ 3650). | A5 |
| M-B3 | Menor (reportado, executado) | Regex morto em `money.ts:13` (`/^0+(?=\d)$/` nunca casa): `Money.from("000000000000000000001.00")` lança `money_limit` embora valha 1. | BL |
| M-B4 | Menor (reportado) | Reuso de `commandId` numa devolução sem reposição vira erro 23514 no commit (500) em vez de `sale_return_command_conflict`; parâmetros `productId`/`assetId` inválidos nas rotas de mídia viram 500 (cast do Postgres) em vez de 400. | BL |
| M-B5 | Menor (reportado) | `getSale`/`listSales` fazem várias leituras em READ COMMITTED (podem ficar inconsistentes entre si) e `listSales` pagina por `offset` ordenado por `confirmed_at`, podendo pular ou repetir linhas sob concorrência. | BL |
| M-B6 | Menor (reportado) | Erros 500/503 não são logados em nenhum lugar (`app.onError`, `errorResponse` de mídia); sem logs, causas como o HTTP 1042 do PR34 são indiagnosticáveis. | A5 |
| M-B7 | Menor (reportado) | `occurredOn` de recebimento/baixa/contagem sem limite superior; `lower()` depende da collation do banco (regra "sem distinção de caixa"); `getProductVariants` usa `FOR SHARE` em leitura; helper `isValidCalendarDate` triplicado; `recordStockMovement` exportado como superfície genérica; `InventoryQuantityLimitError` como 409. | BL |

### B. Integridade de dados e banco

| ID | Severidade | Achado | Prazo |
| --- | --- | --- | --- |
| I-C1 | Importante (reportado por 3 revisores) | **Todas as colunas de tempo são `timestamp` sem fuso**, com `DEFAULT now()`/`clock_timestamp()` que dependem do `TimeZone` da sessão; o `doc-inicial.md:1207` manda "UTC / timestamptz". Se o fuso da sessão ou do role mudar (Hyperdrive, novo role), instantes defasam em silêncio; o ledger é evidência imutável. Já apareceu na prática (leitura direta com `pg` interpretou no fuso da máquina). Barato agora, reescrita de tabela depois. Correção: migrar para `timestamptz` ou, no mínimo, `ALTER ROLE … SET timezone='UTC'` e teste com outro fuso. | **A5** (decisão D-3) |
| I-C2 | Importante (reportado) | O banco não liga saldo a movimento: o runtime tem `UPDATE(quantity, …)` em `inventory_balances` e nenhum constraint impõe `quantity = Σ quantity_delta`. O plano diz "não permitir mutation direta do balance" e o Gate 3 exige "ledger consistente". Hoje só o repositório e o oráculo do gate garantem. Correção: trigger deferido de reconciliação ou writer `SECURITY DEFINER` único; no mínimo uma reconciliação ledger×saldo em gate. | A5 |
| I-C3 | Importante (reportado) | A ordem do ledger é ambígua: `created_at` é o início da transação, então a transação que esperou o lock pode ter `created_at` anterior a um movimento confirmado antes. A regra do plano é "a média muda na ordem de confirmação do servidor". Correção: gravar `balance_version_after` (ou sequência por variante) sob o lock e ordenar por ela. | A5 |
| I-C4 | Importante (reportado) | A mesma role `polaris_pr11_runtime` serve auth e tenant, com DML sem RLS em `user`, `account`, `session`, `verification`. Qualquer SQL arbitrário na role de tenant lê todos os usuários, forja `app.user_id`/`app.organization_id` e passa pelas policies. Documentado nos ADRs 0002/0006, mas a exploração é concreta. Correção: separar duas roles (e dois Hyperdrives): auth com DML nas 4 tabelas; tenant sem acesso a elas. O padrão já existe para o onboarding. | GL |
| M-C5 | Menor (reportado) | UPDATE de tabela inteira em `products`, `categories`, `customers`, `payment_profiles`, `payment_profile_rules` (permite alterar `id`, `version`, `created_at`); sem limites de tamanho em nomes, e-mail, telefone, notas; `media_assets.storage_key` sem CHECK de formato; CHECKs `NOT VALID` nunca validados; funções de trigger com `search_path` irregular. Correção: `GRANT UPDATE (colunas)` e limites de texto na próxima migration. | BL |
| M-C6 | Menor (reportado) | A tabela e a rota PoC (`db_poc_operations`, `/api/poc/database`, `rls-poc`, `wrangler.pr11/12.jsonc`) continuam no repositório e no bundle; o Hyperdrive real do PR11 ainda aparece em `wrangler.pr11.jsonc` e o role se chama `polaris_pr11_runtime` (128 ocorrências). Confirmar que os Workers e o Hyperdrive PoC foram removidos e que a credencial owner do PR11 foi rotacionada (o status pede, sem registro de conclusão). | GL |

### C. Provas, gates e CI

| ID | Severidade | Achado | Prazo |
| --- | --- | --- | --- |
| I-D1 | **Importante** (confirmado) | **Gate 3 nunca foi fechado formalmente** (sem seção no status, sem `poc:gate3:verify`, sem runbook); o plano manda seguir fases estritamente. Falta provar "mídia privada" ponta a ponta e "ledger consistente" no nível do banco. Correção: seção "Gate 3" com mapa propriedade → evidência e um gate que combine catálogo + estoque + mídia. | A5 |
| I-D2 | **Importante** (confirmado; reportado por 2 revisores) | `/rpc/*` não tem defesa CSRF própria (nenhuma checagem de `Origin`/`Sec-Fetch-Site` em `app.ts`); o parser do oRPC aceita requisições "simples" (multipart, urlencoded, text/plain). Protege apenas o `SameSite=Lax` padrão do Better Auth, que nem está fixado explicitamente. Correção: middleware exigindo `Origin` igual à base URL em mutações e atributos de cookie fixados. | GL (A5 se houver UI pública) |
| I-D3 | **Importante** (reportado por 4 revisores) | **O CI não executa nada de banco**: sem Postgres, sem replay de migrations, sem `db:generate` (drift), sem `format:check`. O plano exige suíte PostgreSQL em PRs de banco (§2.3); o PR122 está a cerca de 75 PRs. Hoje são cerca de 19 gates e 39 migrations só verificados à mão em Neon. Os gates também têm travas de host/branch que impedem rodar num Postgres de serviço. Correção: job com `postgres:18`, replay de migrations, `poc:gate4:verify` com travas parametrizadas, `format:check` e `db:generate` com checagem de diff. | **A5** |
| I-D4 | Importante (reportado) | O cenário Gate 4 prova dinheiro só no caminho sem taxa e com desconto de 10% sobre 369,70 (= 36,97 exato; não exercita half-up); a auditoria não entra nos digests; a conservação do estoque ignora recebimentos tardios. Os gates não provam: caminho Hyperdrive/Worker (pooling, `set_config` e triggers deferidos via pooler), concorrência mista (recebimento/baixa/contagem × venda), papéis além de `owner`, sessão com fuso ≠ UTC, replay após envelhecimento natural. | A5 (parte) |
| M-D5 | Menor (reportado) | Falsos positivos nos gates: asserção `count >= N` de migrations com N obsoleto; oráculo `cents()` diz "half-up" mas trunca; property tests com `try/catch` que aceitam qualquer erro esperado; sem property tests de estoque (LCG artesanal em vez de fast-check, como o plano pediu para PR29); testes de roteador mockam o repositório; nenhum teste de componente ou de página; UI de venda (`sale-page.tsx`, 1403 linhas) só testada como funções puras. | BL |
| M-D6 | Menor (reportado) | Orientação EXIF e remoção de metadata do upload (plano PR34) nunca foram provadas no provedor real nem com mock; memória do Worker por upload (pico de cerca de 60 MB com 20 MB); reconciliador sem teste de falha de banco e sem quarentena de marker malformado. | A5 (orientação), BL |

### D. Segurança de borda

| ID | Severidade | Achado | Prazo |
| --- | --- | --- | --- |
| I-E1 | Importante (reportado por 3 revisores) | A casca da SPA (`index.html`, JS) sai do Static Assets sem passar pelo Worker (`run_worker_first` só cobre `/health`, `/ready`, `/rpc/*`, `/api/*`); não há `_headers` nem CSP. Clickjacking e sem mitigação de XSS. Correção: `public/_headers` com CSP, `frame-ancestors 'none'`, `nosniff`, `Referrer-Policy` e HSTS no edge. | GL |
| I-E2 | Importante (reportado) | Sem rate limit nem quota em endpoints autenticados caros (upload dispara Images e R2; cada miss de derivado paga uma transformação) e sem `statement_timeout`/`lock_timeout`/`idle_in_transaction_session_timeout`; um `FOR UPDATE` travado bloqueia o produto inteiro. Free = 1 imagem por produto, mas não existe remover/substituir/reordenar (runtime só tem SELECT+INSERT). | GL (comando de substituir antes da Fase 7) |
| I-E3 | Importante (reportado) | Limite absoluto de 30 dias de sessão: só o trigger do banco (`0004`) e o handler de `/api/auth/*` o impõem; o contexto autenticado de `/rpc` não confere `createdAt`, e nenhum gate repetível prova o trigger. | A5 |
| I-E4 | Importante (reportado) | Cache desabilitado do Hyperdrive não é verificável no repositório (`id: "local-only"`); a prova remota do PR11 cobre só a tabela sintética, nunca `withAuthorizedTenantTransaction` com pooling real. Correção: rodar o runner do PR11 contra uma rota tenant real em staging e registrar checklist de go-live. | GL |
| M-E5 | Menor (reportado) | `X-Forwarded-For` é aceito como IP de sessão (usar `cf-connecting-ip`); possível enumeração por timing no signup/reset (envio de e-mail aguardado); auditoria de segurança cobre só Google e logout; `change-password`/`verify-password` sem rate limit; sem limpeza de sessões/verificações vencidas; scrypt abaixo da recomendação OWASP; `X-Request-Id` do cliente aceito. | antes de ligar e-mail/senha |

### E. Produto e interface

| ID | Severidade | Achado | Prazo |
| --- | --- | --- | --- |
| I-F1 | **Importante** (confirmado) | **Não existe UI de estoque**: nenhuma tela chama `receiveStock`, `inventoryCount` ou `writeOffStock`; a UI de produtos diz "O estoque será definido em uma etapa própria". Sem saldo, a venda é bloqueada. O plano não tem nenhum PR de UI de estoque; o E2E do PR125 depende de telas que nenhum PR cria. Login UI está explicitamente adiada para pré-go-live (plano linha 1444), mas a organização vem de `localStorage["polaris.organizationId"]`, gravado só pelo onboarding. Correção: incluir no plano, antes do Gate 5, PRs de UI de estoque e de resolução da organização pela sessão. | A5 |
| I-F2 | Importante (reportado) | Navegação incoerente: cinco barras superiores copiadas, só o shell de vendas lista tudo; "/" abre Categorias; `/sales/customer` pede UUID digitado e é beco sem saída. Venda lenta para o dia a dia: catálogo sem preço (decisão consciente), `<select>` sem busca, N+1 de leituras (variantes por produto e saldo por variante); o histórico não tem filtro nem busca. O plano de offline (PR55–57) pressupõe `listedUnitPrice`/`catalogVersion`; decidir antes do PR55 se a variante ganha preço de tabela. | A5 (decisão D-6) |
| M-F3 | Menor (reportado) | DESIGN.md só documenta Categorias e Variantes; CSS compartilhado vive em `categories-page.css`; alvos de toque de 38 px na devolução; sem `ErrorBoundary`, lazy por rota nem 404; `theme-color` fixo claro; controle de recorte da mídia sem `aria-valuetext` e com `touch-action:none`; nenhuma tela verificada em navegador ou 360 px (PR45–PR47 sem qualquer clique). | A5 (verificação 360 px) |

### F. Domínio da venda (decisões e lacunas)

| ID | Severidade | Achado | Prazo |
| --- | --- | --- | --- |
| I-G1 | Importante (reportado) | Produto removido (tombstone, ADR 0012) bloqueia cancelamento (`sale_product_unavailable`) e devolução com reposição; a saída é devolver tudo com `restocked=0`, o que exclui o cancelamento. Uma devolução legítima de venda antiga pode ficar impossível. | decisão D-1 |
| I-G2 | Importante (reportado) | Venda retroativa captura o custo médio **de hoje** e consome o estoque de hoje, não o da data comercial; o CMV sai com custo atual e o saldo "na data D" reconstruído por `occurred_on` pode ficar negativo. O `inventory.md` só fala de recebimento retroativo. Documentar ou decidir antes da Fase 5 (vendas offline antigas). | A5 (decisão D-4) |
| I-G3 | Importante (reportado) | Devolução sem valor nem regra de rateio: desconto, frete e sobretaxa de nível de venda não têm regra para ratear por unidade devolvida; recalcular depois pode divergir do que a loja realmente reembolsou (`doc-inicial` §33 permite `refunded amount`, §47 calcula vendas líquidas). | antes da Fase 6 |
| I-G4 | Importante (reportado) | O estado de uma tentativa de venda vive só em `useRef`: recarregar a página durante um "resultado desconhecido" perde o `commandId` e refazer a venda pode duplicá-la. É assunto do outbox local (PR52), mas o risco existe hoje. Além disso, a janela de 30 dias mede `occurredAt` contra a confirmação: uma venda offline legítima com mais de 30 dias de dispositivo desconectado seria rejeitada; alinhar com a duração do lease offline. | A5 |
| M-G5 | Menor (reportado) | Omissões frente ao `doc-inicial`: `linked_by`/`source` no vínculo de cliente (§36), `buyer_label_snapshot` (§37, relevante para venda avulsa), campos de reembolso (§33). 200 itens por venda geram cerca de 1.600 round-trips sem teste de desempenho. `GRANT` de leitura de perfis exige `organization:manage`, o que quebrará com um papel de vendedor. Percentual de teto e telefone como duplicado só por texto exato. | BL |

### G. Documentação e processo

| ID | Severidade | Achado | Prazo |
| --- | --- | --- | --- |
| I-H1 | Importante (reportado por 3 revisores) | **Plano reescrito em cerca de 685 linhas sem ADR nem changelog**; faltam ADRs para: persistência offline escolhida (ADR 0003 e overview ainda dizem "candidato" mesmo com o gate aprovado com `@tanstack/db` alpha), ordem de fases e inserção do Gate 2, política de sessão/conta, mídia (Images/WebP/R2), venda atômica por triggers deferidos, cancelamento total + devolução sem valor, janela retroativa, capabilities finas apenas com `owner`, estratégia de integração da cadeia, `timestamptz`. ADRs 0010 e 0011 seguem `proposed` embora o código dependa delas. | A5 |
| I-H2 | Importante (reportado) | Documentação canônica duplicada e virando changelog: a janela de 30 dias está em cinco arquivos; `sales.md` mistura invariantes, comportamento de UI e referências a PR; `overview.md` ganhou parágrafos por PR; `CONTEXT.md` traz nomes de coluna e valores; `organization-and-access.md` lista 10 capabilities e o código tem 15; o status mistura numeração PRnn com `#nn-1`, tem seções fora de ordem e afirmações antigas ("fundação ainda em andamento", "TypeScript 6"). | A5 |
| I-H3 | Importante (reportado) | 22 PRs empilhados (#25–#46) sem integração: qualquer conflito na base se propaga pela cadeia; a branch do PR31 foi aberta contra `main` enquanto as vizinhas são empilhadas; o dossiê subestima a contagem. Precisa de estratégia (merge sequencial, squash por fase, ou rebase) antes de crescer mais. | A5 |
| M-H4 | Menor (reportado) | E-mails pessoais e IDs do projeto Neon versionados em `cli-profile-policy.md` e no status (privacidade se o repositório for público); `.codex-worktrees/` fora do `.gitignore`; `vitest --passWithNoTests` mascara suíte vazia; o script de boundaries escreve fixtures dentro de `packages/*/src` em paralelo; `bun install` altera `AGENTS.md` (tratar na raiz, não reverter à mão); sem fixtures negativos para hono/drizzle/cloudflare; sem verificação de ciclos de dependência. | BL |

### H. Manutenibilidade

Arquivos grandes demais: `sale-form-model.ts` (2283 linhas), `router.ts` (1584), `sale-page.tsx` (1403), `contracts/src/index.ts` (1055), e nove scripts de gate entre 1000 e 2700 linhas. Duplicação de suporte de gate (`requiredEnvironment` ×8, `expectSqlState` ×7, `createTenantFixture` ×5, `shiftDay` ×3), de `requireCapability` (×6), de `organizationIdStorageKey` (×5 telas). Pacotes scaffold vazios (`admin`, `catalog`, `billing`, `ui`). Sugestão: um `gate-support.ts` comum, `AppShell` único, dividir `sale-form-model` e `router` por agregado.

---

## 4. Julgamento das decisões de domínio tomadas pelo projeto

| Decisão | Juízo da revisão |
| --- | --- |
| `sale.confirm` único, sem rascunho, triggers deferidos | Concordo; coerente com `doc-inicial` §24 |
| Custo e rótulo do item vindos do servidor sob lock; perfil explícito; taxa desconhecida nunca vira zero | Concordo |
| `data.reason` só em 400/404/409 | Concordo |
| Vínculo de cliente versionado e só de acréscimo | Concordo; falta `linked_by`/`source` (menor) |
| Cancelamento total e irreversível; motivos V1 | Concordo |
| Reposição ao custo do snapshot do item | Concordo |
| **Regra da média com custo desconhecido** | **Discordo em parte** (I-A1): com saldo zero deve virar desconhecida |
| **Produto removido bloqueia cancelamento/devolução** | **Você decide** (D-1) |
| Várias devoluções; só as unidades repostas movem estoque | Concordo |
| Exclusão mútua cancelamento × devolução (lock + trigger) | Concordo; solução robusta |
| Devolução sem valor monetário | Concordo em adiar; falta regra de rateio ou snapshot (I-G3) |
| `recorded_at`, `occurred_on`, janela de 30 dias de calendário, 5 minutos de futuro, replay antes da janela | Concordo |
| `timestamp` sem fuso | Recomendo migrar (D-3) |

Nenhuma decisão contradiz o `doc-inicial.md`; os desvios são omissões, não contradições.

---

## 5. Decisões que dependem de você

- **D-1. Produto removido (tombstone) e compensações.** Opções: (a) permitir cancelamento e devolução sem movimento de estoque para produto removido, registrando a compensação financeira; (b) bloquear o tombstone enquanto houver venda dentro de uma janela de devolução; (c) manter como está e documentar a rota "devolver tudo sem repor". Minha recomendação: (a).
- **D-2. Reposição com custo do snapshot desconhecido e saldo positivo com média conhecida.** Manter a média (hoje) ou marcá-la como desconhecida (mais conservador). Com saldo zero, a média deve ser `null` em qualquer caso. Recomendação: marcar desconhecida apenas quando o saldo for zero; manter a média quando houver saldo positivo.
- **D-3. `timestamptz`.** Migrar todas as colunas de instante agora (barato, ainda não há dado real) ou fixar o fuso da sessão em UTC por role e testar. Recomendação: migrar agora.
- **D-4. Custo e estoque de venda retroativa.** Aceitar custo médio de hoje (documentando que CMV de venda retroativa usa custo atual) ou capturar a média vigente na data. Recomendação: aceitar e documentar; a alternativa exige um razão por data.
- **D-5. Estratégia de integração da cadeia de PRs.** Merge sequencial em `main`, squash por fase, ou manter empilhado até a Fase 5. Recomendação: integrar por fase (Gate 0–Gate 4) antes de começar a Fase 5.
- **D-6. Preço de tabela na variante.** Hoje o operador digita preço de tabela e cobrado em cada item. Decidir antes do PR55 se a variante ganha preço de tabela (impacta o contrato offline).
- **D-7. Quando introduzir UI de estoque e resolução da organização pela sessão** (antes do Gate 5, como recomendo, ou dentro da Fase 5).

---

## 6. O que foi bem feito

- **Transação e consistência:** venda em uma transação com triggers deferidos como cinto de segurança; idempotência por `commandId`; ordem de locks consistente (produto, depois saldo; lock advisory por venda reentrante com o trigger); sem ciclo possível entre venda, cancelamento, devolução e recebimento.
- **Banco:** FORCE RLS nas 25 tabelas de domínio, policies simétricas (USING/WITH CHECK) por role com `NULLIF(current_setting(…, true), '')`, FKs compostas por organização, ledger append-only por grant e trigger, atores não forjáveis onde existem, funções `SECURITY DEFINER` estreitas e trancadas, nenhum segredo versionado.
- **Dinheiro:** `Money`/`Percentage`/`DecimalAmount` em BigInt, half-up com empate afastando de zero, sem composição de percentuais, um arredondamento por custo, custo desconhecido separado de zero em todas as camadas.
- **Replay antes da janela** não é burlável; colisão de `commandId` entre namespaces cai em conflito 409 com rollback.
- **Auth:** tenant separado de autenticação (ADR 0004), `organizationId` do cliente só como contexto solicitado, vínculo implícito desligado, tokens OAuth cifrados, HIBP fail-closed, auditoria sem PII.
- **Mídia:** original nunca persistido, só a saída re-codificada; chaves R2 por UUID; marker antes do master; reconciliação com claim e lock.
- **Testes:** 616 testes verdes, robustos a fuso, fast-check em money/ajustes/pagamento/datas/devolução, modelos de visão sem jsdom.

---

## 7. Plano de ação sugerido

**Bloco 1 — antes da Fase 5 (correções pequenas e baratas)**
1. I-A1 (média na reposição) e I-B1 (mapeamento do erro): corrigir com teste.
2. I-B2: tetos de percentual, parcelas e prazo (domínio, contrato, CHECK).
3. D-3 `timestamptz` e I-C2/I-C3 (reconciliação ledger × saldo e ordem do ledger): uma migration única.
4. I-D1: fechar o Gate 3 (seção, runbook e gate combinado), incluindo mídia privada ponta a ponta.
5. I-D3: CI com Postgres 18, replay de migrations, `db:generate`, `format:check` e `poc:gate4:verify` parametrizado.
6. I-H1/I-H2/I-H3: ADRs que faltam, limpeza de duplicação em `docs/`, atualização do status e decisão D-5.

**Bloco 2 — decisões suas (seção 5)** D-1, D-2, D-4, D-6, D-7.

**Bloco 3 — fundação de produto, antes do Gate 5:** PRs de UI de estoque (recebimento, contagem, baixa), resolução da organização pela sessão, `AppShell` único e verificação das telas em 360 px.

**Bloco 4 — antes do go-live:** I-E1 (headers/CSP), I-D2 (CSRF), I-C4 (separar roles de auth e tenant), I-E2 (rate limit, quotas e timeouts), I-E4 (prova de Hyperdrive remoto com código tenant), remoção das superfícies PoC e rotação da credencial do PR11.

---

## 8. Limites desta revisão

- Análise estática; nenhum gate foi reexecutado. Os resultados dos gates e o conteúdo remoto (Cloudflare, Neon, GitHub Actions) não foram verificados de forma independente.
- Não verificado: atributos reais das roles (`NOBYPASSRLS`, ownership, `TimeZone`), cache do Hyperdrive, atributos reais dos cookies, CVEs das dependências, equivalência exata entre cada snapshot do Drizzle e o SQL, comportamento de `Intl` e de imagem EXIF no provedor, e qualquer tela em navegador ou em 360 px.
- Parte dos achados é relato de um revisor sem confirmação minha; eles estão marcados como "reportado".
- Eu implementei a maior parte do código revisado; por isso usei revisores independentes e verifiquei pessoalmente os achados que apontam erro meu.
