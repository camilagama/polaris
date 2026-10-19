---
status: accepted
---

# Adaptador Asaas: porta de saída, releitura do recurso e período pelo vencimento original

> O número deste ADR (0101) é o próximo livre na `main` e nos PRs abertos no momento da escrita (o 0100 é o último na `main`, o 0098 está no PR do Sentry no navegador e o 0099 está reservado ao backup); pode mudar se outro entrar antes.

## Contexto

O núcleo de billing está pronto: oito fatos, caixa de entrada `billing_events`, `attachProvider`, reprocessamento e a rota `POST /webhooks/billing/:provider` ([ADR 0062](0062-ciclo-de-vida-do-billing-e-caixa-de-entrada.md), [ADR 0063](0063-rota-de-webhooks-de-billing.md), [ADR 0087](0087-referencia-do-provedor-em-todo-fato.md)). Faltavam a porta de saída (criar, cancelar, reembolsar e consultar no provedor) e o primeiro adaptador. O corte da Fase 7 (PR77, PR78 e Gate 7, aprovado em 19/10/2026) começa pelo Asaas, cartão recorrente (decisão D3). O desenho t088 e os spikes t092 no sandbox foram revisados por arquitetura, segurança e QA e consolidados em 19/10/2026; este ADR registra o que vale para o primeiro PR, que não tem migration.

O token de webhook do Asaas é estático e **não assina o corpo**: quem tem o token pode mandar qualquer corpo. O Asaas também reescreve o `dueDate` de uma cobrança vencida ou editada, escreve o valor como número JSON (`49.9`) e devolve, na leitura de uma cobrança, o token reutilizável do cartão (`creditCard.creditCardToken`), URLs públicas de fatura e comprovante e os dados do cliente.

## Decisão

### 1. Porta de saída comum e lugar do código

- `packages/billing` guarda a porta (`BillingProviderPort`: `prepareSubscription`, `cancelRenewal`, `refundCurrentPeriod`, `readState` e `discardCheckout`), o cliente HTTP do Asaas com `fetch` injetado, o mapeador puro e os erros. Importa só `@polaris/domain`; não importa banco, Hono nem Cloudflare. `apps/web/src/server/billing` lê as bindings, monta o cliente e registra o adaptador `asaas` em `billingProviderAdapters`. `packages/domain` ganha só a soma de meses do período (`billing/provider-period.ts`), pura.
- Erros: `ProviderUnavailableError` (`provider_unavailable`: tempo esgotado, rede, 5xx ou 429), `ProviderRejectedError` (`provider_rejected`: 4xx, com o status), `ProviderNotFoundError` (404), `ProviderResponseMalformedError` e `ProviderNotConfiguredError` (`billing_provider_not_configured`). **Nenhum erro carrega o corpo da resposta**, nem a causa de rede (que pode ecoar a URL).
- Tempo limite por `AbortSignal.timeout`, configurado por quem monta a porta: 5 s na releitura do webhook e 8 s nos comandos do PR seguinte. O cliente não segue redirecionamento (a chave iria junto): um 3xx é recusa.
- **Trava de ambiente:** o cliente recusa rodar se o host não for `api-sandbox.asaas.com` ou `api.asaas.com`, se a URL não for HTTPS ou tiver credencial, ou se a chave não for do ambiente do host (a chave de homologação começa com `$aact_hmlg_`; o sandbox exige esse prefixo, produção o recusa).
- A porta cobre o que os comandos do PR seguinte usam (checkout, cancelamento da renovação, reembolso integral e reconciliação); nenhum comando do tenant a chama ainda.

### 2. O fato vem do recurso relido, nunca do corpo do webhook

- O adaptador confere o cabeçalho `asaas-access-token` contra `ASAAS_WEBHOOK_TOKEN` (e `ASAAS_WEBHOOK_TOKEN_NEXT` na rotação) **em tempo constante**: os dois lados viram SHA-256 e a comparação sempre lê 32 bytes. Token ausente ou errado é 401 sem motivo. O token é conferido antes do resto da configuração, e um `ASAAS_WEBHOOK_TOKEN` com menos de 32 caracteres conta como não configurado. O mesmo mínimo vale para o `ASAAS_WEBHOOK_TOKEN_NEXT` quando ele existe (vazio ou ausente é "sem rotação"): um NEXT curto torna o adaptador não configurado (503), nunca um segundo token fraco aceito.
- Do corpo só se leem o ID do evento (`evt_...`, o `providerEventId`), o nome do evento, o `dateCreated` (horário de Brasília, lido com `-03:00`; é o `occurredAt`) e o ID do recurso. O ID passa por regex (`pay_`/`sub_` e alfanuméricos; a referência `pol_<uuid v4>`) e depois por `encodeURIComponent` antes de ir para o caminho. Evento que exige recurso e não traz um ID válido é `billing_webhook_malformed`.
- O recurso é relido na API com a chave do Polaris e o fato é montado com o que **ele** mostra. A ligação com a organização sai só do recurso relido (`subscription.externalReference`). Um corpo forjado só aponta para recursos reais da conta, e o que vale é o recurso: confirmação de cobrança que não está paga, reembolso de cobrança que não está `REFUNDED`, chargeback, reversão ou falha que a cobrança não mostra agora e cancelamento de assinatura ativa não geram fato. Um corpo com o token certo não consegue tirar o acesso de uma cobrança saudável. A confirmação atrasada mantém o seu fato com o período do recurso, mesmo que a cobrança tenha sido reembolsada depois (o dinheiro passou; a ordem dos fatos é do domínio); os outros eventos atrasados cuja cobrança já mudou de estado não geram fato, e a reconciliação lê o estado que vale.
- **Allowlist de chaves:** do recurso relido o mapeador guarda só `id`, `status`, `deleted`, `subscription`, `originalDueDate`, `dateCreated`, `confirmedDate` (só o dia, ilegível vale como ausente) e `value` (cobrança) e `id`, `status`, `deleted`, `cycle` e `externalReference` (assinatura). `creditCard` (com `creditCardToken`), `customer`, `refunds`, URLs de fatura e comprovante e qualquer campo novo não saem do mapeador. O recurso relido e o link do checkout nunca vão para log, nem em erro.
- O valor (`value`) é lido pelo **texto-fonte** do JSON (reviver com `context.source`, disponível no V8 do workerd), normalizado como `money.md` manda; nunca passa por `number`. O valor enviado ao provedor é escrito a partir do texto decimal do catálogo. Em runtime sem `context.source` a leitura falha em vez de arredondar.
- **Releitura que devolve 404 (AC-48):** o evento não é descartado em silêncio. O adaptador devolve um evento `unresolved` só com IDs (tipo do evento, ID do evento, ID do recurso e instante). `CHECKOUT_PAID` cuja assinatura ainda não tem cobrança também é `unresolved` (leitura cedo demais). Neste PR, sem migration, a rota registra `billing_webhook_unresolved` com esses IDs e, **enquanto o evento tem até 30 minutos**, responde 503 sem gravar nada, para o Asaas reenviar. Depois disso responde 200 e registra `billing_webhook_unresolved_given_up` (nível erro, só IDs), para a reconciliação recuperar: assim um recurso que nunca aparece não pausa a fila do Asaas (15 falhas seguidas). Gravar a linha `unresolved` em `billing_events`, reprocessável pela manutenção horária e pelo comando de reconciliação, exige migration e entra no PR de banco seguinte.
- **Recurso relido fora da forma** (página de gateway, campo ausente, ciclo não vendido): `billing_provider_response_malformed` (nível erro, só IDs); a mesma janela de 30 minutos vale (503 e reenvio, depois 200).
- Provedor fora, sem resposta em 5 s ou que recusa o pedido: 503, para o Asaas reenviar; a recusa da chave (401 ou 403: rotacionada ou revogada) também registra `billing_provider_rejected` (nível erro, só status e ID do evento), que é o alerta antes de a fila pausar. Sem um dos segredos, 503 `billing_provider_not_configured`, nunca 200.
- **A data do corpo nunca é motivo de recusa.** O token não assina o corpo e o `dateCreated` decide a janela de reenvio de 30 minutos; uma data no futuro a manteria aberta para sempre (503 em laço, e o Asaas pausa o webhook após 15 falhas). Por isso: (a) uma data até 5 minutos à frente do relógio é desvio de relógio e vale como veio; (b) uma data mais de 5 minutos à frente é **limitada a "agora"**, o evento é aceito e o caso é registrado como `billing_webhook_date_clamped` (nível aviso, só provedor, tipo e ID do evento: sem data, sem corpo); (c) um evento assim nunca conta como recente: se a releitura der 404 ou vier fora da forma, a rota responde 200 com o log de desistência/erro (a reconciliação recupera), nunca 503 por causa da data, porque a cada reenvio o "agora" seria outro e a janela nunca fecharia; (d) o `occurredAt` do fato de confirmação (`charge_succeeded`) usa o **dia do recurso relido** (`confirmedDate`, dia de São Paulo) quando ele existe: o horário do corpo vale se cai nesse dia, e fora dele é mantido dentro do dia (antes do início vale o início, depois do fim vale o último instante: um webhook logo após a meia-noite de uma cobrança confirmada logo antes dela não passa para antes de uma falha do mesmo dia); nunca depois de "agora" (inclusive na faixa de tolerância de 5 minutos). O `PAYMENT_RECEIVED` do cartão, que chega cerca de 30 dias depois, fica no dia da confirmação, o que o domínio trata como fato atrasado (`overtaken`: estende o acesso, não desfaz o que veio depois). Cobrança sem `confirmedDate` (ausente, nulo ou ilegível) mantém o horário do corpo, já limitado: **risco aceito**, pois quem tem o token escolhe "agora" nesse caso. Os demais fatos (`charge_failed`, reembolso, contestação, reversão e cancelamento) não têm data no recurso permitido pela allowlist e usam o horário do corpo, já limitado: **risco aceito** de reenvio de um evento antigo com ID novo datado de "agora", que o domínio não distingue de um recente (a reconciliação e o reenvio real do Asaas corrigem o estado; datar `charge_failed` pelo vencimento da cobrança fica para o PR de banco, com o `amount`). O domínio já limita `lastFactAt` a "agora" ([facts.ts](../../packages/domain/src/billing/facts.ts)).
- Como o corpo não é assinado, o critério "corpo reordenado invalida" do AC-1 não se aplica ao Asaas: o teste equivalente prova que reordenar ou alterar o corpo não muda o fato (AC-1c).

### 3. Tabela evento → fato (AC-4)

| Evento Asaas | Recurso relido | Fato | Condição no recurso |
|---|---|---|---|
| `CHECKOUT_PAID` | assinaturas com o `externalReference` do checkout e as cobranças dela | `trial_method_ready` (ciclo da assinatura) | a 1ª cobrança foi criada para vencer depois do dia da criação (`originalDueDate` > `dateCreated`); sem trial, nenhum fato (o fato é a cobrança) |
| `PAYMENT_CONFIRMED`, `PAYMENT_RECEIVED` | cobrança e assinatura dela | `charge_succeeded` (o segundo é duplicata por valor) | cobrança paga em algum momento (`CONFIRMED`, `RECEIVED`, `REFUND_*`, `REFUNDED`, `CHARGEBACK_*`, `AWAITING_CHARGEBACK_REVERSAL`) |
| `PAYMENT_CREDIT_CARD_CAPTURE_REFUSED`, `PAYMENT_REPROVED_BY_RISK_ANALYSIS`, `PAYMENT_OVERDUE` | cobrança e assinatura | `charge_failed` | cobrança nunca paga (status fora da lista de pagas acima) |
| `PAYMENT_REFUNDED` | cobrança e assinatura | `charge_refunded` | `status = REFUNDED` (reembolso parcial não é fato, ADR 0066) |
| `PAYMENT_CHARGEBACK_REQUESTED` | cobrança e assinatura | `charge_disputed` | `CHARGEBACK_REQUESTED`, `CHARGEBACK_DISPUTE` ou `AWAITING_CHARGEBACK_REVERSAL` |
| `PAYMENT_AWAITING_CHARGEBACK_REVERSAL` | cobrança e assinatura | `dispute_reversed` | `AWAITING_CHARGEBACK_REVERSAL` |
| `SUBSCRIPTION_DELETED`, `SUBSCRIPTION_INACTIVATED` | assinatura | `subscription_cancelled` | `deleted = true` ou `status` diferente de `ACTIVE` |
| `PAYMENT_PARTIALLY_REFUNDED`, `PAYMENT_REFUND_IN_PROGRESS`, `PAYMENT_CHARGEBACK_DISPUTE`, `PAYMENT_CREATED`, `PAYMENT_UPDATED`, `PAYMENT_DELETED`, `PAYMENT_RESTORED`, `PAYMENT_AUTHORIZED`, análise de risco que não reprova, `CHECKOUT_VIEWED`, `CHECKOUT_CANCELED`, `CHECKOUT_EXPIRED`, `SUBSCRIPTION_CREATED`, `SUBSCRIPTION_UPDATED` e qualquer outro | nenhum | lista vazia | — |

Cobrança sem assinatura, cobrança com `deleted = true` (inclusive a `PENDING` apagada pelo cancelamento no trial) e assinatura sem `externalReference` no formato `pol_<uuid>` viram lista vazia. Ciclo fora de `MONTHLY`, `SEMIANNUALLY` e `YEARLY` numa assinatura do Polaris é recurso malformado.

`charge_disputed` e `dispute_reversed` não foram gerados no sandbox; as linhas seguem a documentação do Asaas (AC-17, limitação aceita), e o Gate 7 confere a entrega real.

### 4. `periodEndsAt` = `originalDueDate` + ciclo (AC-5)

- O campo de vencimento, por fato, é o **`originalDueDate` da cobrança** (para `charge_succeeded`, `charge_refunded`, `charge_disputed` e `dispute_reversed`), somado ao ciclo da **assinatura** (`MONTHLY` 1, `SEMIANNUALLY` 6, `YEARLY` 12). Nunca `dueDate`, que o Asaas reescreve no vencido e na edição, nem `subscription.nextDueDate`, que já avança na criação, nem "agora". O AC-5 foi lido assim.
- A soma de meses é do domínio (`paidPeriodEndsAt`): dia que o mês de destino não tem vira o último dia dele (31/01 + 1 mês = 28/02; a renovação que vence 28/02 termina 28/03), e o período vai até o **fim do dia** em São Paulo (sem horário de verão desde 2019, `-03:00`), porque a renovação é cobrada durante o dia do vencimento. Pagamento atrasado perde os dias de atraso.
- Reembolso, chargeback e reversão carregam o período da cobrança **deles**, não o da assinatura.
- O AC-27b do Gate 7 usa `sandbox/confirm` antes do vencimento, não "mover o vencimento" (a data movida não estende nada).

### 5. `providerRef` e checkout (D-A)

- O checkout hospedado (`POST /v3/checkouts`, `RECURRENT`, `CREDIT_CARD`, `subscription.cycle` e `nextDueDate` como `AAAA-MM-DD 00:00:00` no dia de São Paulo) manda `externalReference = pol_<uuid v4>`, gerado pelo servidor por checkout, e a porta devolve também o **ID do checkout**, para o comando guardar e cancelar o checkout se o `attachProvider` falhar.
- O `providerRef` é o `pol_<uuid>`, e o mapeador o lê de `subscription.externalReference`. A passagem do `externalReference` do checkout para a assinatura **ainda não foi provada** (S1.3, que exige uma pessoa por causa do reCAPTCHA) e é condição do merge. Se não passar, vale a 2ª opção do desenho: o ID do checkout (`checkoutSession` da assinatura e das cobranças), o que muda o campo lido pelo mapeador. O `cus_` por organização só com decisão do usuário, porque exige coletar telefone e endereço.
- `returnUrl`, `successUrl` e `cancelUrl` são montados no servidor a partir de `BETTER_AUTH_BASE_URL` (HTTPS); o cliente nunca os informa. O link devolvido pelo Asaas só é aceito em HTTPS num host `asaas.com`.
- **Dados enviados:** o checkout do cartão não manda nome, e-mail nem CPF/CNPJ do pagador (B7: o mínimo); o pagador digita tudo na página do Asaas. A porta recusa um `taxId` no cartão.

### 6. Reconciliação (`readState`)

`readState` lista as assinaturas com aquele `externalReference` (incluindo apagadas) e as cobranças de cada uma e aplica a mesma leitura do webhook, com `occurredAt` = agora e IDs `reconcile:<id>:<status>` (`CONFIRMED`, `REFUNDED`, `CHARGEBACK_REQUESTED`, `AWAITING_CHARGEBACK_REVERSAL`, `OVERDUE`; `CHECKOUT_PAID` e `DELETED` com o ID da assinatura). Ler duas vezes o mesmo estado grava uma vez; o fato do webhook tem outro ID e é absorvido por valor (`not_applicable`), nos dois sentidos, para os quatro fatos de dinheiro. Só cobranças cujo período ainda não acabou são lidas, e uma assinatura já apagada não gera `trial_method_ready`. O comando e o job ficam para depois (o job ligado é condição do go-live, AC-49).

`refundCurrentPeriod(ref, now)` relê antes de pedir (o 400 do Asaas para cobrança não paga não serve para decidir) e reembolsa por inteiro só a cobrança do período em vigor: a última já vencida (no dia de São Paulo), se estiver `CONFIRMED` ou `RECEIVED` e o período dela não tiver acabado. Cobrança já em reembolso, reembolsada, contestada ou não paga dá `nothing_to_refund`: repetir o pedido nunca reembolsa a cobrança anterior; `cancelRenewal` apaga a assinatura viva (o `DELETE` é idempotente no Asaas) e devolve `already_cancelled` ou `nothing_to_cancel` sem chamar nada.

### 7. Segredos, rotação e redação

| Nome | Tipo | Staging | Produção |
|---|---|---|---|
| `ASAAS_API_KEY` | secret | homologação (`$aact_hmlg_...`) | produção |
| `ASAAS_BASE_URL` | var | `https://api-sandbox.asaas.com/v3` | `https://api.asaas.com/v3` |
| `ASAAS_WEBHOOK_TOKEN` | secret | gerado pelo Polaris, 32 a 255 caracteres | outro valor |
| `ASAAS_WEBHOOK_TOKEN_NEXT` | secret, só na rotação | | |

O procedimento está no [runbook dos provedores de cobrança](../runbooks/billing-providers.md). A redação do logger ([ADR 0089](0089-evlog-e-logger-tipado-no-backend.md)) passa a mascarar `taxID`/`taxId`, `pixKey`, `emv`, `creditCardHolderInfo` e `creditCardToken` pelo nome da chave.

## Consequências

- O Asaas responde na rota; a Woovi continua 404 até o seu adaptador (PR78).
- Cada entrega custa uma ou duas leituras na API do Asaas; com a API fora, a rota responde 503 e o Asaas reenvia (a releitura foi consistente na 1ª tentativa no sandbox, sem espera).
- Até o PR de banco seguinte, o 404 na releitura não fica em `billing_events`: depende do reenvio do Asaas nos primeiros 30 minutos e, depois, do log de erro e da reconciliação.
- O `amount` nos fatos de dinheiro (decisão V2) entra com a migration do PR de banco; o mapeador já lê o valor exato.

## Limites

- S1.3 (checkout concluído por uma pessoa) decide o campo do `providerRef`; o merge espera essa prova.
- `CHECKOUT_PAID` depende de o corpo do evento trazer `checkout.externalReference`; sem ele o evento é registrado como malformado e o trial só começa pela reconciliação ou pela 1ª cobrança.
- O `occurredAt` dos fatos que não são confirmação vem do `dateCreated` do evento (limitado a "agora"): um corpo com token válido pode deslocar a ordem desses fatos para o passado, não o seu conteúdo nem para o futuro.
- Os fixtures de teste seguem a **forma** do sandbox (nomes e tipos dos campos), com valores inventados; a comparação com entregas reais é do Gate 7.
