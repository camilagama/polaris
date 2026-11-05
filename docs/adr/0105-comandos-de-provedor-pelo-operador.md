---
status: accepted
---

# Comandos de provedor pelo operador: cancelar a renovação e reembolsar pelo Admin

> Número provisório até o merge (pode mudar se outro ADR entrar antes). Emenda o [ADR 0073](0073-admin-suspensao-e-comandos-de-cobranca.md) (os comandos de provedor entram no Admin) e o [ADR 0104](0104-autosservico-de-cobranca-do-dono.md) (o reembolso fora da janela do dono, que era "trabalho do operador" por script, passa a ter tela de operador); cita o [ADR 0066](0066-reembolso-e-chargeback.md) e o [ADR 0101](0101-adaptador-asaas-porta-de-saida-e-releitura-do-recurso.md).

> **Emenda (tela da Parte 10, migration 0116, número provisório).** A leitura da janela de reembolso (`admin_read_refund_window`, ADR 0104, decisão 8) passa a devolver, da mesma linha de `organization_billing`, `accessEndsAt`, `cancelAtPeriodEnd`, `revokedThrough` e `revokedReason`: com elas o domínio monta o mesmo `PlanViewRecord` da tela do dono e a resposta da rota ganha `renewal` (`renewing`, `cancelled` ou `none`, com `accessUntil`, `renewsOn` e `resubscribeFrom` pelas mesmas `nextChargeOf` e `resubscribeFromOf` do produto) e `refundsHere`, que vem de `refundsEnabledFor(env, provedor)`, a regra que o comando de reembolso também usa (Asaas sempre; Woovi só com `WOOVI_REFUND_ENABLED` igual a `"true"`). O provedor bruto não sai na resposta, a leitura continua sem chamar o provedor e a recusa `refund_not_supported` do servidor segue valendo se a variável mudar entre a leitura e o clique. Só acrescenta (ADR 0096): o Worker anterior ignora as chaves novas. O preço de cada cobrança do vínculo é o da primeira (`price_amount` não é lido): um vínculo anterior à 0100, sem primeira cobrança registrada, diz que a renovação está viva mas não nomeia a data. O valor mostrado e enviado como `expectedAmount` é o `firstChargeAmount` do registro: se o provedor tiver uma cobrança em vigor de valor diferente, o servidor recusa com `amount_changed` e nada é feito.

## Contexto

O ADR 0073 deixou fora do Admin os comandos que dependem de provedor "até haver adaptador". O adaptador do Asaas (ADR 0101) e o da Woovi existem, e os comandos do operador `cancelRenewal` e `refundCurrentPeriod` já rodavam, mas só pelo script do Gate 7, executado por quem tem o ambiente na máquina. O suporte que recebe um pedido de reembolso fora dos 7 dias do dono, ou de cancelamento por e-mail, não tinha como agir sem esse script. O desenho da Parte 10 do Admin v2 (Filipe, com as condições do Rodrigo e a conta do Juan, 04/11/2026) fecha como levar esses dois comandos ao operador.

## Decisão

1. **Um código só.** `cancelRenewal`, `refundCurrentPeriod` e a montagem das portas (`provider-ports.ts`) saem de `apps/web` e vão para `packages/billing` (`operator-commands.ts`, `provider-ports.ts`). O web (o consumidor do encerramento), o script do Gate 7 e o Admin importam o mesmo código. O Admin importa de `@polaris/billing` só esses dois módulos e os tipos e erros da porta (`provider-port`); webhook, assinatura e cliente direto continuam proibidos pela regra de fronteira (`biome.jsonc`, `verify-import-boundaries.mjs`).
2. **O segredo mora no Worker do Admin** (D-A do Rodrigo), e não numa chamada ao web por service binding:
    - no Workers Free, o comando no isolate do web arriscaria o 1102 do Worker do produto;
    - o Admin fica atrás do Access, sem `workers.dev` nem previews, e verifica o token;
    - o desenho exige uma implementação só (item 1).

    As condições:
    - `ASAAS_API_KEY` e `WOOVI_APP_ID` são *secrets* do Worker por ambiente, nunca variáveis. `ASAAS_BASE_URL`, `WOOVI_BASE_URL` e `WOOVI_REFUND_ENABLED` são variáveis literais por ambiente. O `verify-staging-isolation` exige os sandboxes no Admin do staging e os hosts de produção na produção, e reprova segredo de provedor escrito como variável em qualquer Worker.
    - O que só recebe chamadas do provedor (`ASAAS_WEBHOOK_TOKEN` e `_NEXT`, `WOOVI_WEBHOOK_PUBLIC_KEYS`, `BILLING_PAYER_KEY`) nunca vai ao Admin: a guarda estática `provider-secret-confinement.test.ts` e o `verify-staging-isolation` reprovam.
    - A porta do provedor só é montada dentro dos dois comandos (`withProviderPorts` em `apps/admin/src/worker.ts`, com `operatorProviderPortOf`, que não abre checkout). Não há rota genérica e nada vai ao `/health`.
    - Não há *fallback* de segredo entre ambientes: sem o segredo, a rota responde 503 `admin_not_configured` e nada é feito.
3. **Rotas e capacidades.** Cada rota exige caso aberto, e a loja vem sempre do caso.

    | Rota | Capacidade |
    |---|---|
    | `POST /api/support-cases/:caseId/billing/cancel-renewal` | `billing:operate` |
    | `POST /api/support-cases/:caseId/billing/refund` | `billing:refund`, nova (D-B), conferida antes de ler o corpo; `billing:operate` sozinha dá 403 |

    - Caso fechado ou desconhecido dá 404, e nada é gravado.
    - O corpo traz o `commandId` (UUID gerado ao abrir a confirmação, que é o `requestId` do comando), o motivo (1 a 300 caracteres, sem caractere de controle) e, no reembolso, `expectedAmount` (o valor que a tela mostrou).

    Os resultados:

    | Comando | 200 | 409 | 503 |
    |---|---|---|---|
    | Cancelar | `cancelled`, `already_cancelled`, `nothing_to_cancel` | `not_linked`, `command_in_progress` | `provider_unavailable` |
    | Reembolsar | `refund_requested`, `nothing_to_refund` | `not_linked`, `refund_not_supported`, `amount_changed`, `command_in_progress` | `provider_unavailable` |

    O limite de reembolsos por hora responde 429 `rate_limited`.
4. **A ordem do reembolso, sob a trava da loja** (pedido do Rodrigo):
    1. ler a cobrança em vigor;
    2. comparar com `expectedAmount`, em centavos: se for diferente, a resposta é `amount_changed`, e nada é cancelado, estornado ou gravado no ledger;
    3. gravar a decisão do operador no ledger;
    4. cancelar a renovação, a menos que o registro já a mostre cancelada;
    5. estornar **a mesma cobrança lida**.

    A porta ganhou o gancho opcional `beforeRefund(charge)`, que os adaptadores chamam depois de achar a cobrança e antes de pedir o estorno. Cobrança nenhuma a reembolsar (`nothing_to_refund`) não cancela nada; o cancelamento é o outro comando. O script do Gate 7 passa o valor lido com `--amount`, e sem ele não confere (só o script).
5. **Não estornar duas vezes vem do estado da cobrança, não do `commandId`.**
    - O adaptador do Asaas só oferece a cobrança em vigor se ela está `CONFIRMED` ou `RECEIVED`. `REFUND_REQUESTED`, `REFUND_IN_PROGRESS` e `REFUNDED` são `nothing_to_refund`, e o adaptador não volta a uma cobrança anterior.
    - Por isso, repetir com outro `commandId`, repetir com o mesmo depois de um 503 em que o provedor aceitou, e repetir durante o estorno estornam uma vez só (gate `billing-operator-commands`, testes do adaptador).
    - O cancelamento do operador passa a pegar a trava da loja (`operatorCancelRenewal`), de modo que o dono e o operador nunca agem juntos. O cancelamento do encerramento continua sem trava (ADR 0074).
6. **Resultado desconhecido.** Timeout, 5xx, 4xx, resposta malformada ou falha depois de o provedor ter sido chamado dão `provider_unavailable` (503): a auditoria fica com o pedido e sem resultado, e repetir com o **mesmo** `commandId` é seguro (item 5). Cada chamada ao provedor espera até 8 s (o cliente), e o comando inteiro, até 45 s. Não há lote nem repetição automática.
7. **Auditoria e ledger.** O padrão é o do ADR 0073: registrar, fazer, registrar.
    - Os tipos são `billing.operator_renewal_cancel_requested`/`…_recorded` e `billing.operator_refund_requested`/`…_recorded` (migration 0111, número provisório). Eles evitam `billing.renewal_cancel_requested`, que é tipo do outbox.
    - O `entityId` é o `commandId`, exigido como UUID minúsculo pela função. O detalhe é `result=<código>` e, no reembolso, `;amount=<valor>`.
    - O motivo digitado vai para o **ledger de cobrança**, com o ator `admin:<principalId>`, numa linha `command` (`command:operator_<tipo>:<commandId>`, uma por comando), e não para a auditoria.
    - O purge tira o motivo do fato, porque `reason` não é uma das chaves que ele guarda (ADR 0081, 6a): a função de purge não muda, e o gate `organization-purge` prova o caso.
8. **Freios no lugar da segunda pessoa.**
    - **Alerta:** cada comando que chegou ao provedor emite `billing_operator_command`, sinal `comando-de-cobranca-do-operador` (acorda, limiar 1), para a outra pessoa do Access ver na hora.
    - **Limite:** cada operador tem no máximo **3 reembolsos distintos por hora**, contados pela auditoria na própria função, com trava por operador. Repetir o mesmo `commandId` no mesmo caso (e, portanto, na mesma loja) não conta de novo; o mesmo `commandId` em outro caso ou loja conta como outro reembolso, porque o ID é escolhido pelo cliente. Um pedido recusado por `amount_changed` já consumiu uma das 3 vagas da hora, porque a auditoria do pedido vem antes da conferência do valor: de propósito, erra para o lado seguro.

## Consequências

- O suporte resolve cancelamento e reembolso pela tela, com caso, motivo, auditoria antes e depois, e sem o script.
- **Risco novo:** uma sessão de operador comprometida passa a poder gastar a chave do provedor, e não só ler dados. Compensam:
    - o caso aberto e o `expectedAmount`;
    - o limite por hora e o alerta;
    - a porta montada só nos dois comandos;
    - nada do provedor na resposta nem no log (teste com o código real e um provedor falso que devolve dados marcados).
- O segredo do provedor passa a existir em dois Workers por ambiente. A rotação gira os dois no mesmo passo e, na suspeita de vazamento, revoga primeiro no provedor ([billing-providers](../runbooks/billing-providers.md)).
- A tela (aba Cobrança da loja no Admin v2, `ui/views/refund-window.ts` e `billing-actions.ts`) lê a cobrança com caso aberto e só então oferece as duas ações, cada uma com a sua confirmação; o texto de cada resultado do servidor está em `ui/refund-words.ts`.

## Limites aceitos

- **Sem segunda pessoa em produção** (D-D). Uma pessoa só pode reembolsar em produção, sem aprovação. Compensam o `expectedAmount`, o caso aberto, o motivo, a auditoria antes, o alerta e o limite por hora. A decisão de levar isso ao usuário é do Arrascaeta.
- **A auditoria não é atômica com a ação** (papéis diferentes, como no ADR 0073). O risco é um pedido sem resultado, nunca uma ação sem pedido.
- **A garantia do item 5 depende de o Asaas mostrar a cobrança fora de `CONFIRMED`/`RECEIVED` logo depois de aceitar o estorno.** A ordem da leitura logo após o `POST /refund` não foi medida no sandbox: é a prova do gate da Parte 10 no staging, antes de liberar em produção.
- **O CPU dos comandos no Free não foi medido.** O Admin gasta de 4 a 10 ms por rota no staging, e o limite é 10 ms. A medida de 3 comandos reais no staging fica para depois do deploy (Juan, D-C). Um 1102 no meio do comando cai no item 6: repetir com o mesmo `commandId`. A tela da Cobrança no Admin e a liberação em produção esperam essa medida: 3 comandos reais no staging, com 0 `exceededCpu`.
- **A chave do Admin:** o Asaas permite até 10 chaves de API por conta, revogáveis uma a uma, sem escopo por chave. Uma chave própria do Admin dá revogação separada, mas o Asaas desabilita a chave depois de 3 meses sem uso e a expira de vez aos 6. Uma chave usada raramente, como a do Admin, pode estar desabilitada quando for preciso: o runbook diz como conferir. A escolha entre chave própria e a mesma do web é do Arrascaeta ao cadastrar.
- **Limite e alerta no lugar de aprovação.** O valor 3 por hora é provisório, sem medida de uso real.

## Alternativas rejeitadas

- **Service binding para um `WorkerEntrypoint` do web:** evita duplicar o segredo, mas põe o comando do operador no isolate do web (o risco do 1102 para os lojistas) e cria uma porta interna que precisa de autorização própria.
- **Idempotência pelo `commandId` no reembolso** (lembrar o comando e não chamar o provedor de novo): não protege de um segundo comando com outro ID. O estado da cobrança protege dos dois casos.
- **Cancelar antes de conferir o valor** (a ordem antiga): cancelaria a renovação de um reembolso que o operador não confirmaria.
- **Motivo na auditoria administrativa:** a auditoria sobrevive ao purge (ADR 0081), e o motivo é texto livre com possível dado pessoal.
