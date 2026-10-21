# Matriz de concorrência

Este arquivo é a fonte de verdade para **quais corridas o sistema tem, o que protege cada uma e qual gate a prova**. Ele não define a proteção: lock, constraint e idempotência vivem no código e nas migrations, e as regras de negócio em [docs/business-rules/](../business-rules/). Quando uma proteção nova entra, a corrida ganha uma linha aqui no mesmo pull request. O plano ([PR 123](../../doc/plano-inicial.md)) pede a cobertura de venda dupla, corrida de estoque, comando duplicado, webhook duplicado, reconciliação de cliente e transição de cobrança; a matriz diz onde cada uma está provada e o que ainda falta.

Estado em 20/10/2026, no PR que introduz a suíte ([#191](https://github.com/camilagama/polaris/pull/191), com a `main` no #189). Quando entrarem as etapas seguintes (T-123b e T-123c) ou uma corrida mudar, a data e a referência mudam com elas.

## Como uma corrida é provada

Um `Promise.all` de N comandos prova pouco: os comandos podem rodar um depois do outro e o gate passa sem que nada tenha disputado. Todo gate da suíte `concurrency` segue as quatro regras abaixo. O suporte comum é [`packages/db/scripts/concurrency-support.ts`](../../packages/db/scripts/concurrency-support.ts).

1. **Largada real.** Uma transação "segurador" toma antes de tudo o lock disputado (a linha do produto, a chave advisory do comando, a chave única ainda não confirmada). Os competidores são criados e liberados juntos por uma única barreira de largada; o segurador só solta depois.
2. **Houve disputa.** O gate espera o próprio banco dizer que os competidores estão bloqueados pelo segurador, direto ou na fila atrás de um que está (`pg_stat_activity` e `pg_blocking_pids`, recursivo), e **falha** se eles nunca bloqueiam (`the race did not compete`). Uma corrida que não competiu é falha, não sucesso. Quando o pool do código sob teste tem menos conexões que competidores (a loja de cobrança tem 3), o gate declara quantos bloqueios espera.
3. **N rodadas.** `POLARIS_CONCURRENCY_REPEAT` define quantas vezes cada corrida se repete com dados novos (padrão 1 na suíte `ci`, 3 em `gates:concurrency`, no máximo 10: o `inventory` mantém uma organização Free de 50 variantes para todas as rodadas). O CI roda 1 rodada; **quando as 3 rodadas são obrigatórias** está em [Quando rodar `gates:concurrency`](#quando-rodar-gatesconcurrency).
4. **Prova por remoção da proteção.** Feita localmente e descartada (nada disso é commitado): tira-se a proteção e o gate precisa ficar vermelho. A tabela [Provas por remoção](#provas-por-remoção) guarda o resultado.

Um segundo aviso, que a prova por remoção ensinou: **muitas corridas têm mais de uma camada** (um lock e um índice único, ou um lock de produto e um de saldo). Tirar só uma camada deixa o gate verde, e isso é o esperado. A prova só vale quando tira as camadas que seguram aquela corrida; a tabela diz quais.

## Como rodar

    # PostgreSQL 18 descartável e vazio (as variáveis POLARIS_GATE_* do runbook do Gate 4)
    CI=true bun run --filter @polaris/db gates:concurrency
    POLARIS_CONCURRENCY_REPEAT=10 CI=true bun run --filter @polaris/db gates:concurrency   # mais rodadas

`gates:concurrency` é uma suíte nomeada de `packages/db/scripts/run-gates.ts`: ela só **escolhe** gates que já estão em `gates:ci`, sem duplicar nenhum e sem job novo. Rode-a num banco novo; os gates não são reexecutáveis num banco que já os rodou (ver o [runbook do Gate 4](../runbooks/gate-4-sales-core.md#passos)).

### Quando rodar `gates:concurrency`

O job `PostgreSQL 18 gates` do CI roda `gates:ci` com 1 rodada por corrida, e corrida intermitente é o que 1 rodada não pega. Sem job novo no CI (custo 0), a suíte com **N = 3 rodadas** (o padrão de `gates:concurrency`) é obrigatória:

- **em todo PR que mexa numa proteção desta matriz** (lock, índice único, ordem de lock, gatilho ou função que uma linha abaixo prova): o autor roda e registra o resultado em "Verificação" do PR;
- **antes de cada prova de release**, num PostgreSQL 18 descartável e novo, a partir do SHA candidato ([item 4 do checklist de release](../runbooks/release-checklist.md#4-gates-de-banco-em-neon-descartável-block)).

`POLARIS_CONCURRENCY_REPEAT=10` (o máximo) serve para investigar uma corrida que falhou de vez em quando. O texto do procedimento está no [runbook do Gate 4](../runbooks/gate-4-sales-core.md#corridas-quando-o-gatesconcurrency-é-obrigatório).

## Corridas da suíte

A coluna **Estado** diz duas coisas. **Provado** quer dizer: barreira de largada, disputa afirmada e N rodadas, nos 14 gates da suíte (o `billing-trial-claims` §3 já tinha a sua própria barreira, por lock advisory, e a mantém). **Remoção** diz se a **própria corrida** ficou vermelha quando a proteção saiu: **sim**; **parcial** quando o gate ficou vermelho numa corrida anterior do mesmo gate, com a mesma proteção, antes de chegar a esta, ou quando a corrida tem outra camada que a segura (a corrida em si não foi vista sem a proteção); **não** quando a proteção não se remove sem reescrever o código. Só "Provado · remoção: sim" é uma corrida cuja proteção foi vista falhar; as demais linhas dizem "Barreira provada" e ficam em [O que falta](#o-que-falta). A coluna Gate aponta a seção do arquivo em `packages/db/scripts/`.

### Vendas e estoque

| # | Corrida | Atores | Recurso disputado | Proteção | Gate | Estado |
| --- | --- | --- | --- | --- | --- | --- |
| V1 | Venda dupla e corrida de estoque: 8 vendas de 1 unidade sobre 3 unidades vendem exatamente 3 | Várias vendas do mesmo produto | Saldo do produto/variante | `FOR UPDATE` do produto (em ordem de id), `FOR UPDATE` do saldo e saldo nunca negativo | `verify-sale-transaction-gate.ts` §8 | Provado · remoção: sim |
| V2 | Duas vendas de 2 unidades sobre 3 vendem 1 | Duas vendas | Saldo | Os mesmos locks | `verify-sale-transaction-gate.ts` §8 | Barreira provada · remoção: parcial |
| V3 | Comando duplicado: 6 entregas do mesmo `commandId` criam 1 venda e 1 conjunto de movimentos | Reenvio do mesmo comando | Chave do comando | Índice único `(organization_id, command_id)` da venda, mais os locks do produto; o resto é replay | `verify-sale-transaction-gate.ts` §8 | Barreira provada · remoção: parcial |
| V4 | Vendas com produtos em ordem oposta não travam uma à outra | 6 vendas, 3 por ordem | Linhas de dois produtos | Locks de produto sempre em ordem de id | `verify-sale-transaction-gate.ts` §8 | Barreira provada · remoção: não (ordem de lock; ver abaixo) |
| V5 | Reconciliação de cliente: 6 associações sobre a mesma versão geram 1 versão nova | Seis operadores | Versão do vínculo da venda | Índice único `(organization_id, sale_id, version)` e gatilho de sequência (migration 0035); perdedoras viram conflito | `verify-sale-customer-link-gate.ts` §5 | Provado · remoção: sim |
| V6 | Cancelamento duplo: 6 cancelamentos da mesma venda, 1 vence e o estoque volta uma vez | Seis cancelamentos | A venda | Lock advisory de compensação da venda (`sale-locks.ts`) e índices únicos por venda e por comando (migration 0036) | `verify-sale-cancellation-gate.ts` §6 | Provado · remoção: sim |
| V7 | 5 entregas do mesmo comando de cancelamento criam 1 cancelamento | Reenvio | Comando de cancelamento | Os mesmos | `verify-sale-cancellation-gate.ts` §6 | Barreira provada · remoção: parcial |
| V8 | Cancelamento × vendas novas do mesmo produto, sem deadlock | 1 cancelamento e 5 vendas | Linhas do produto | Locks de produto em ordem de id | `verify-sale-cancellation-gate.ts` §6 | Barreira provada · remoção: não (ordem de lock; ver abaixo) |
| V9 | Devolução: 8 devoluções de 3 unidades sobre 10 vendidas aceitam 3 | Oito devoluções | Quantidade devolvível do item | Lock advisory de compensação da venda; disponibilidade checada sob o lock | `verify-sale-return-gate.ts` §9 | Provado · remoção: sim |
| V10 | 5 entregas do mesmo comando de devolução criam 1 devolução | Reenvio | Comando de devolução | Lock advisory e idempotência por comando | `verify-sale-return-gate.ts` §9 | Barreira provada · remoção: parcial |
| V11 | Devolução × cancelamento da mesma venda: só um vence, nunca os dois | Uma devolução e um cancelamento | A venda | Lock advisory de compensação da venda | `verify-sale-return-gate.ts` §9 | Barreira provada · remoção: parcial |
| V12 | Devolução × vendas novas, sem deadlock | 1 devolução e 5 vendas | Linhas do produto | Locks de produto em ordem de id | `verify-sale-return-gate.ts` §9 | Barreira provada · remoção: não (ordem de lock; ver abaixo) |
| V13 | Devolução crua, sem o repositório: dois escritores inserem 2 de 3 vendidas e só um commita | Dois escritores que pulam o repositório | A venda | Gatilho `check_sale_return_complete` (migration 0037), que toma no commit o mesmo lock advisory de compensação da venda | `verify-sale-return-gate.ts` §11 (`duel`) | Provado · remoção: sim |
| E1 | Duas contagens sobre a mesma versão do saldo: uma vence, a outra é conflito de versão | Dois operadores | Versão do saldo | `expectedVersion` sob o lock do produto e do saldo | `verify-inventory-gate.ts` | Provado · remoção: sim |
| E2 | 8 entradas concorrentes no mesmo saldo somam 8 | Oito entradas | Saldo | Lock do produto e do saldo | `verify-inventory-gate.ts` | Barreira provada · remoção: parcial |
| E3 | 2 baixas de 6 sobre 8 unidades: uma passa, a outra é estoque insuficiente | Duas baixas | Saldo | Lock do saldo e saldo nunca negativo | `verify-inventory-gate.ts` | Barreira provada · remoção: parcial |
| E4 | Exclusão (tombstone) do produto × entrada de estoque: um vence | Uma exclusão e uma entrada | Linha do produto | `FOR UPDATE` do produto e gatilho que recusa tombstone com saldo positivo | `verify-inventory-gate.ts` | Barreira provada · remoção: parcial |
| E5 | Offline: duas contagens do mesmo saldo e duas baixas que não cabem juntas | Dois aparelhos | Saldo | Lock do produto e do saldo, `expectedVersion` | `verify-offline-stock-gate.ts` §6–7 | Provado · remoção: sim |
| E6 | Offline: duas vendas disputam as últimas unidades | Dois aparelhos | Saldo | Os locks da venda | `verify-offline-sale-gate.ts` §6 | Provado · remoção: sim |
| E7 | Comando offline duplicado: 8 envios do mesmo comando executam 1 vez | Reenvio do aparelho | Chave do comando | Lock advisory `sync-command:<organização>:<comando>` e comando gravado | `verify-sync-push-gate.ts` §8 | Provado · remoção: sim |

### Cobrança e planos

| # | Corrida | Atores | Recurso disputado | Proteção | Gate | Estado |
| --- | --- | --- | --- | --- | --- | --- |
| C1 | Webhook duplicado (banco): 8 entregas do mesmo evento do provedor gravam 1 linha; processar duas vezes é um resultado | Entregas repetidas | Chave `(provider, provider_event_id)` e a linha do evento | Índice único com `ON CONFLICT DO NOTHING`; `FOR UPDATE` da linha do evento | `verify-billing-lifecycle-gate.ts` §2 | Provado · remoção: sim |
| C2 | Transição de cobrança: cancelamento e troca de ciclo simultâneos, nenhuma atualização perdida | Dois fatos do provedor | Linha de cobrança da organização | `FOR UPDATE` da linha `organization_billing` (versão +2) | `verify-billing-lifecycle-gate.ts` §8 | Provado · remoção: sim |
| C3 | Teste grátis por pessoa ([#184](https://github.com/camilagama/polaris/pull/184)): duas organizações da mesma pessoa começam o teste no mesmo instante, uma reserva | Dois `startTrial` | Reserva da pessoa (`billing_trial_claims`) | Reserva única por usuário, `FOR UPDATE` da reserva e da linha de cada organização | `verify-billing-trial-claims-gate.ts` §3 (barreira por lock advisory e prova de que os dois esperam) | Barreira provada · remoção: parcial |
| C4 | Descarte do checkout ([#184](https://github.com/camilagama/polaris/pull/184)): a reserva muda de organização enquanto o checkout abandonado é pago; ou a reserva muda, ou o pagamento a consome, nunca os dois | `startTrial` da outra organização e o pagamento do checkout descartado | Reserva da pessoa | `FOR UPDATE` da reserva (`lockTrialClaim`, `reserveTrial`) e guarda `organization_id` no consumo | `verify-billing-trial-claims-gate.ts` §10 (corrida) | Provado · remoção: sim |
| C5 | Cota: 8 adições nos últimos 4 lugares de uma organização Free commitam exatamente 4 | Oito criações de produto | Contador do limite `variants.active.max` | Lock advisory `polaris.entitlement:<limite>:<organização>` e contagem sob o lock | `verify-entitlements-gate.ts` §5 | Provado · remoção: sim |

### Aparelhos, sessões e suspensão

| # | Corrida | Atores | Recurso disputado | Proteção | Gate | Estado |
| --- | --- | --- | --- | --- | --- | --- |
| A1 | Suspensão × emissão de lease: o lease emitido logo antes é revogado, o outro vínculo do usuário não muda | Admin e o aparelho do usuário | Chave `authorization-epoch:<usuário>` | Lock advisory que a emissão e a suspensão tomam. O gate simula a emissão com um `INSERT` em `offline_grants` sob a mesma chave: prova que a **suspensão** espera e revoga, não que a emissão real toma a chave (isso é do `offline-lease`, fora da suíte) | `verify-admin-suspension-gate.ts` §2b | Provado · remoção: sim |
| A2 | Duas abas verificam o mesmo aparelho sem deadlock | Duas sessões | Linha do aparelho | `touchDevice` faz o `UPDATE` da linha **antes** do `FOR SHARE` de `lockLiveDeviceForSession`: duas verificações entram em fila, não em deadlock. O `FOR SHARE` sozinho não segura esta corrida | `verify-device-sessions-gate.ts` §7 | Provado · remoção: sim |
| A3 | Sync × revogação do aparelho: a sessão não fica ligada a aparelho revogado | A sessão que sincroniza e quem revoga | Linha do aparelho | `FOR SHARE` na sessão e `UPDATE` na revogação (`lockLiveDeviceForSession`) | `verify-device-sessions-gate.ts` §7 | Provado · remoção: sim |

### Lojas por pessoa

| # | Corrida | Atores | Recurso disputado | Proteção | Gate | Estado |
| --- | --- | --- | --- | --- | --- | --- |
| T1 | Teto de lojas e criar × desfazer ([#188](https://github.com/camilagama/polaris/pull/188)): abrir outra organização e desfazer o encerramento de uma, ao mesmo tempo, nunca vencem as duas; no fim há uma organização aberta | O pedido de nova organização e o pedido de desfazer o encerramento da mesma pessoa | A chave por usuário que conta as organizações abertas | Lock advisory `(1347374145, hashtext(<usuário>))` em `create_initial_organization` e `recover_organization_closure` e conferência do teto sob o lock (migration 0085) | `verify-organization-closure-gate.ts` §6 | Provado · remoção: sim |

## Corridas provadas fora da suíte

Estas têm prova de concorrência em `gates:ci`, mas o gate ainda não tem a barreira de largada, a asserção de disputa e a prova por remoção. Entram na suíte quando forem revisados.

| Corrida | Proteção | Gate | Estado |
| --- | --- | --- | --- |
| Registro de acesso: a mesma requisição por várias conexões é um registro | Lock advisory `auth_access_log:<usuário>` | `verify-access-log-gate.ts` | Provado, barreira não revisada |
| Bloqueio de login: rajada de 12 tentativas faz 5 verificações | Lock advisory `auth_login_lock:<chave>` (migration 0082) | `verify-login-lock-gate.ts` | Provado, barreira não revisada |
| Apagar o usuário nunca verificado: duas execuções ao mesmo tempo apagam cada usuário uma vez; linha que outra transação segura é pulada | `FOR UPDATE SKIP LOCKED` nos candidatos e as condições conferidas de novo no `DELETE` (migration 0093) | `verify-unverified-user-purge-gate.ts` | Provado, barreira não revisada |
| Aceite legal: 8 pedidos iguais são uma linha | `ON CONFLICT DO NOTHING` na chave única (migration 0083) | `verify-legal-acceptance-gate.ts` | Provado, barreira não revisada |
| Limite de aparelhos por usuário (8 registros) | Lock advisory `device:<usuário>` | `verify-offline-devices-gate.ts` | Provado, barreira não revisada |
| Redefinição de senha × emissão de lease | Lock advisory `authorization-epoch:<usuário>` | `verify-offline-lease-gate.ts` | Provado, barreira não revisada |
| Encerramento da organização × lease; dois pedidos de encerramento ao mesmo tempo | Lock `authorization-epoch` e upsert (migration 0065) | `verify-organization-closure-gate.ts` (fora a corrida T1) | Provado, barreira não revisada |
| Seleção operacional: o padrão é gravado uma vez sob primeiros usos concorrentes | Lock advisory `polaris.operational-selection:<organização>` | `verify-operational-selection-gate.ts` | Provado, barreira não revisada |
| Mídia: 6 remoções do mesmo item removem 1; duas reordenações | `FOR UPDATE` do produto e do vínculo | `verify-media-commands-gate.ts` §7 | Provado, barreira não revisada |
| Despesas: categorias padrão semeadas uma vez; duas edições da mesma despesa | `ON CONFLICT DO NOTHING` no semeio; `FOR UPDATE` da linha e versão esperada na edição | `verify-expenses-gate.ts` | Provado, barreira não revisada |
| Recorrência de despesas: duas gerações e uma leitura ao mesmo tempo | `FOR UPDATE` da regra, em ordem de id | `verify-expense-recurrence-gate.ts` | Provado, barreira não revisada |
| Metas: 3 liquidações da mesma meta, uma vence | `FOR UPDATE` da meta, em ordem de id, e versão esperada | `verify-goals-gate.ts` | Provado, barreira não revisada |
| Catálogo público: dois primeiros salvamentos com o mesmo endereço | Índice único do endereço (migration 0060) | `verify-public-catalog-gate.ts` | Provado, barreira não revisada |
| Despachante da outbox: duas execuções nunca pegam o mesmo evento | `FOR UPDATE SKIP LOCKED` (migration 0071) | `verify-outbox-dispatcher-gate.ts` | Provado, barreira não revisada |
| Fila morta: 20 registros da mesma causa contam 1 incidente; execuções de `record_exhausted`; duas tentativas de reenvio | Upsert por `(tipo, causa, assunto)`, lock advisory da execução, `FOR UPDATE` do item (migration 0072) | `verify-dead-letter-gate.ts` | Provado, barreira não revisada |
| Jobs agendados: dois ticks tomam o lease uma vez | `FOR UPDATE` do estado do job (migration 0073) | `verify-scheduled-jobs-gate.ts` §8 | Provado, barreira não revisada |
| Log de sincronização: escritores concorrentes dão sequência contígua, na ordem do commit | Linha do contador `sync_cursors` travada até o commit (migration 0045) | `verify-sync-log-gate.ts` | Provado, barreira não revisada |
| Tenants A e B concorrentes com conexões reutilizadas não cruzam dados | RLS forçado e contexto local à transação | `verify-rls-gate.ts` (`rls`), `verify-tenant-context-gate.ts` | Provado, barreira não revisada |
| Onboarding: dois pedidos do mesmo usuário criam uma organização | Lock transacional por usuário | `verify-gate2-runtime.ts` (só em Neon, fora do CI) | Provado só em Neon |

## O que falta

| Corrida | Por que falta | Onde entra |
| --- | --- | --- |
| Webhook duplicado **pela rota HTTP** (`routes/billing-webhooks.ts`) | A prova de banco é por `apply` do domínio; a rota tem só teste unitário e o registro de adaptadores está vazio. Precisa de um adaptador fake de teste; a prova real vem depois dos PRs do Asaas e da Woovi | T-123b (área app) |
| Reordenação de eventos de cobrança **em paralelo** | Existe em sequência (`verify-billing-lifecycle-gate.ts` §6), não em paralelo | Acompanhamento de T-123b |
| Dois pedidos de criar organização ao mesmo tempo (teto de lojas, sem desfazer) | A prova do onboarding concorrente é a do `gate2-runtime`, só em Neon; o teto sob o lock está provado em T1, mas só contra o desfazer | Acompanhamento de T-123a, na área db |
| Duas requisições HTTP simultâneas ao mesmo `commandId` **sob o Worker** (rota, Hyperdrive, PostgreSQL) | Só o harness de Worker ([workers-test-harness.md](../runbooks/workers-test-harness.md)) chega perto, e ele não prova Hyperdrive nem pooler | T-123c: smoke contra o staging, por `workflow_dispatch`, nunca em PR; depende do staging |
| Remoção própria das corridas com remoção parcial (V2, V3, V7, V10, V11, E2, E3, E4, C3), começando pelo comando duplicado da venda online (V3, V7, V10) | A prova por remoção foi uma por gate; nestas, a corrida em si não foi vista sem a proteção | Acompanhamento de T-123a, na área db |
| Espera por tempo em `verify-sale-customer-link-gate.ts` §5b (`pause(400)`, linhas das interleavings de vínculo × vínculo e vínculo × arquivo) | Os dois seguradores são transações do próprio gate no pool da aplicação, sem o pid que `raceBehindLock` precisa; é a única decisão por tempo que sobra na suíte além do `organization-closure` §3 (1,5 s) | Acompanhamento de T-123a, junto da revisão do `organization-closure` §3 |
| Barreira revisada nos gates [fora da suíte](#corridas-provadas-fora-da-suíte) | Foram escritos antes desta matriz | Um PR por grupo, junto da prova por remoção |

## Provas por remoção

Rodadas em 20/10/2026 num PostgreSQL 18 local descartável, uma cópia de trabalho a cada vez, tudo descartado depois (nada commitado). "Camadas" quer dizer que a corrida tem mais de uma proteção e tirar só uma deixa o gate verde.

| Gate | Remoção | Resultado |
| --- | --- | --- |
| `sale-transaction` | `FOR UPDATE` do produto na venda e no inventário e `FOR UPDATE` do saldo | Vermelho: `exactly the available units are sold` (1 em vez de 3). O produto e o saldo seguram sozinhos; tirar só um deixa verde (camadas) |
| `sale-customer-link` | Índice único `sale_customer_links_organization_sale_version_unique` | Vermelho: 6 vencedores em vez de 1 |
| `sale-cancellation` | Lock advisory da venda sozinho | Verde (os índices únicos seguram: camadas) |
| `sale-cancellation` | Lock advisory da venda mais os dois índices únicos trocados por checagem sem atomicidade | Vermelho: 6 cancelamentos em vez de 1 |
| `sale-return` | Lock advisory da venda | Vermelho: o perdedor falha com erro de banco, não com `SaleReturnExceedsAvailableError` |
| `inventory` | `FOR UPDATE` do produto e do saldo | Vermelho na corrida de contagens: a perdedora deixa de ser `InventoryVersionConflictError` |
| `offline-stock` | `FOR UPDATE` do produto e do saldo | Vermelho: erro cru do banco no `insert` do movimento na corrida de contagens |
| `offline-sale` | Locks de produto e de saldo | Vermelho: erro cru do banco na corrida das duas vendas |
| `sync-push` | Lock advisory do comando (`lockCommand`) | Vermelho: `the race did not compete` (0 de 8 bloqueados) |
| `billing-lifecycle` (transição) | `FOR UPDATE` da linha `organization_billing` | Vermelho: `cancelAtPeriodEnd` perdido (atualização perdida) |
| `billing-lifecycle` (evento duplicado) | Índice único do evento trocado por checagem sem atomicidade | Vermelho: `the race did not compete` (a chave deixou de competir) |
| `billing-trial-claims` §10 (descarte) | `FOR UPDATE` da reserva (`lockTrialClaim` e `reserveTrial`) e a guarda `organization_id` do consumo | Vermelho: reserva consumida depois de mudar de organização |
| `billing-trial-claims` §4 | `FOR UPDATE` da reserva em `reserveTrial`, sozinho | Vermelho em §4 (`trial_already_used` esperado). §3 e §10 ficam verdes: o consumo e o índice da reserva também seguram (camadas) |
| `entitlements` | Lock advisory do limite (`lockLimit`) | Vermelho: `the race did not compete` (0 de 8 bloqueados pelo segurador); com a asserção de disputa afrouxada, vermelho também no resultado (8 adições em vez de 4) |
| `admin-suspension` | Lock advisory `authorization-epoch` da função `admin_suspend_organization` (migration 0064, só na cópia local) | Vermelho: `the race did not compete` |
| `device-sessions` (A3) | `FOR SHARE` da linha do aparelho em `lockLiveDeviceForSession` (`packages/db/src/device-repository.ts`, a cláusula `FOR SHARE` do CTE `live`), com as asserções das seções (a) e (b) do §7 neutralizadas só na cópia, porque (a) já fica vermelha antes de chegar às corridas (a segunda conexão nunca esperou o lock do aparelho) | Vermelho na corrida da seção (c): `a sync that went first is ended by the revocation` (a sessão não foi encerrada pela revogação) |
| `device-sessions` (A2) | Em `touchDevice` (`packages/db/src/device-repository.ts`), chamar `lockLiveDeviceForSession` (`FOR SHARE`) **antes** do `UPDATE` da linha, o que reintroduz o deadlock de duas verificações | Vermelho na corrida das duas abas: `concurrent checks of one device never deadlock` (um `rejected`). Tirar só o `FOR SHARE` deixa A2 verde: a ordem do `UPDATE` primeiro é que segura |
| `sale-return` (V13, `duel`) | No banco local, `CREATE OR REPLACE` de `check_sale_return_complete` sem o `PERFORM pg_advisory_xact_lock(...)` | Vermelho: `two raw returns of 2 over 3 sold: the race did not compete` (0 de 2 bloqueados). Sem o segurador os dois escritores já não esperam o lock no commit. É a asserção de disputa que derruba; sem o lock os dois commitariam 4 de 3 vendidas, e a asserção de resultado (`exactly one … commits`) também ficaria vermelha, mas não foi vista sozinha |
| `organization-closure` (T1) | Os dois locks `(1347374145, hashtext(<usuário>))` das funções da migration 0085 (só na cópia local) | Vermelho: `the race did not compete` (0 de 2 bloqueados). Com a asserção de disputa afrouxada o resultado continua verde: sem o segurador a janela da corrida é estreita e outras travas seguram, então só a asserção de disputa derruba |

Sem prova por remoção: V4, V8 e V12 (ordem de lock sem deadlock: inverter a ordem em todos os caminhos é uma reescrita, não uma remoção). Elas seguem com a barreira e a asserção de disputa, e o `deadlock detected` do PostgreSQL derrubaria o gate.

Com remoção **parcial** (estado "Barreira provada · remoção: parcial"): V2, V3, V7, V10, V11, E2, E3, E4 e C3. Nelas o gate ficou vermelho numa corrida anterior do mesmo gate, com a mesma proteção, ou outra camada as segura; a própria corrida não foi vista sem a proteção. Isso inclui o comando duplicado da venda online (V3, V7 e V10, um dos seis itens do PR 123): hoje só o `sync-push` (E7) tem a remoção própria de um comando duplicado. Uma remoção por corrida, não por gate, fica como acompanhamento em [O que falta](#o-que-falta).

## Limites

- Os gates rodam em PostgreSQL 18 local ou do CI, com conexões diretas. Não provam o pool do Hyperdrive nem o pooler do Neon (T-123c).
- A asserção de disputa prova que os competidores ficaram **bloqueados pelo segurador** (direto ou na fila atrás de um que está), medido por `pg_blocking_pids`. Ela não prova que a proteção é a única: o resultado final continua sendo conferido pelas asserções de cada gate (quantos vencem, saldo, linhas gravadas). O observador lê `pg_stat_activity` de outros papéis e por isso roda com o dono do banco descartável (superusuário local ou membro de `pg_read_all_stats`); sem isso o gate falha cedo, antes de largar os competidores, com a mensagem de que o dono não consegue observar (visto no Neon só na próxima prova de release: [pendência do PR 191](../runbooks/release-checklist.md#4-gates-de-banco-em-neon-descartável-block)), nunca passa em falso.
- O PostgreSQL local do desenvolvedor e o do CI têm agendamento diferente; por isso há N rodadas e a barreira, e o gate nunca depende de um temporizador para saber que houve disputa.
