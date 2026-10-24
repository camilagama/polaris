---
status: accepted
---

# Autosserviço de cobrança do dono: leitura do plano, cancelar, desistir e pagar a pendente

> O número deste ADR (0104) é o próximo livre na `main` e nos PRs abertos no momento da escrita (o 0103 é o último na `main`); pode mudar se outro entrar antes. As migrations citadas (0100, no PR B, e 0101, no PR F) também são provisórias.

## Contexto

O Polaris cobra por Asaas (cartão) e Woovi (Pix Automático) pelo checkout do [ADR 0101](0101-adaptador-asaas-porta-de-saida-e-releitura-do-recurso.md), mas o dono da loja não consegue ler o próprio plano, cancelar a renovação, desistir dentro do prazo de arrependimento nem regularizar um pagamento recusado. Cancelar e reembolsar existem só como comandos de operador ([ADR 0066](0066-reembolso-e-chargeback.md)). Os e-mails do ciclo de cobrança não existem.

O desenho t268 (v2 de 23/10/2026, revisado por Filipe, Rodrigo, Petković, Diego e Everton, com a decisão do Arrascaeta) cobre os cortes `assinatura-e-cancelar` (AS-1 a AS-44) e `emails-ciclo-cobranca` (EM-1 a EM-37). Este ADR fixa as decisões estruturais antes do código (PR H0 da sequência do F1). O desenho completo e o plano de teste ficam no corpo de cada PR.

Dois fatos do sandbox do Asaas (23/10/2026, dados fictícios) moldam a decisão:

- **O reembolso não cancela a renovação.** Depois do `REFUNDED`, a assinatura seguiu `ACTIVE`; com o vencimento movido para hoje, nasceu uma cobrança `PENDING` no cartão guardado. A emenda de 23/10/2026 do ADR 0066 já corrige isso no comando de operador.
- **Cancelar e depois reembolsar funciona.** Com a assinatura apagada, a cobrança confirmada segue listada e o reembolso dá `REFUNDED`.

Não foram provados: pagar a cobrança vencida com outro cartão na página do Asaas (S-R1) e o reembolso de parcela do Pix (S3.2). A Woovi não foi testada.

## Decisão

### 1. Autosserviço só do dono, atrás de uma flag

Ler o plano, cancelar a renovação, pedir o reembolso e abrir a cobrança vencida são ações do dono, com a capacidade `billing:manage` e a organização definida pelo servidor (a do cliente é só contexto solicitado). Tudo liga com `BILLING_SELF_SERVICE_ENABLED` (texto `true`, desligada em todos os ambientes): o item "Assinatura" do menu, `billing.readPlan`, os comandos do dono e o envio dos oito e-mails de cobrança, que também exigem `RESEND_API_KEY` e `AUTH_EMAIL_FROM`. Desligada, a leitura responde `NOT_FOUND` com `reason: "billing_self_service_off"` e os avisos saem `skipped: email_not_configured`.

**A flag só liga com os PRs E (tela), E2 (cancelar, desistir, pagar a pendente) e G (consumidor dos e-mails) na `main`.** Em produção, só depois do Gate 7 e da P48 completa (domínio de e-mail com SPF, DKIM e DMARC publicado **em modo de aplicação**, `p=quarantine` ou `reject`; razão social e CNPJ do rodapé; caixa de suporte).

### 2. Leitura: `billing.readPlan`

Comando de leitura no grupo `billing` (não em `plan`, que qualquer membro lê), só para o dono. A entrada é `{ organizationId }` e a saída é um objeto `.strict()` com: `state` (`free`, `free_over_limit`, `trial_setup`, `trialing`, `active`, `grace`), `renewalCancelled`, `accessEndsAt`, `cycleMonths`, `method` (`card` ou `pix_automatic`, derivado do provedor), `nextCharge`, `resubscribeFrom`, `trialAvailable`, `refund`, `refundPending`, `recovery`, `offer` (preços e métodos), `limits`, `usage` e `kept`.

- **Nada pessoal nem do provedor sai** (AS-2): nem referência, nem ID de assinatura, de evento ou de pagador, nem payload. Um teste compara as chaves com uma lista fechada, e o `.strict()` reprova o que vier a mais.
- **Como lê.** Na transação do tenant, com `billing:manage`: preços ativos, entitlements efetivos, contagens de uso pelas mesmas consultas do `assertRoomFor` e as de `kept`. Fora dela, no papel de billing (`BILLING_HYPERDRIVE`): o registro com as colunas novas e os `billing_trial_claims` da pessoa. O tenant não ganha grant novo, e as colunas novas nascem invisíveis para ele (RN:32 de [billing-and-entitlements](../business-rules/billing-and-entitlements.md)).
- **Domínio puro** (`packages/domain/src/billing/plan-view.ts`), com testes de relógio: `nextChargeOf` (em `trialing`, a data da 1ª cobrança marcada no provedor; em `active` sem cancelar, o fim do pago; nula com a renovação cancelada, em `grace` e no Free), `refundWindowOf` e `resubscribeFromOf` (a mesma condição do `openCheckout`; nula depois de reembolso concluído).
- **Janela do arrependimento.** Termina às **23:59:59 (America/Sao_Paulo) do 7º dia de calendário depois do dia de `first_charge_at`**, e `first_charge_at` é a **hora do fato do provedor** (`fact.occurredAt`), não a do processamento: um webhook atrasado não empurra a janela. A janela vale pela hora do **primeiro pedido** (decisão 4), não pela da repetição.
- **`refund`** é `{ until, amount, via: "app" | "suporte" } | null`. `via: "app"` é o cartão com `port.refundsEnabled`. `via: "suporte"` é o Pix sem `WOOVI_REFUND_ENABLED` (R-1, decisão 8). `null` é janela fechada, sem 1ª cobrança ou já reembolsado. As duas vias leem a mesma `refundWindowOf`. `refundPending` indica renovação cancelada pelo pedido com o reembolso ainda não concluído.
- **`recovery`** é `"provider_page"` (só em `grace` com cartão) ou `null`. O valor `"provider_retries"` **não existe** na V1: entra por emenda quando o Gate 7 provar o calendário real das novas tentativas da Woovi.
- **Recusas.** Sem a capacidade: `FORBIDDEN` com `data.reason: "billing_manage_required"`. Quem não é membro e uma loja que não existe recebem exatamente a mesma resposta (`NOT_FOUND`, comparada byte a byte em teste). Todo `FORBIDDEN` e `CONFLICT` novo tem `data.reason` próprio antes de cair em `isSessionRefusal`.
- **Sem `billing.syncPlan` na V1 (R-5).** Em `trial_setup` ou na volta do checkout, o cliente relê a cada 5 s por até 2 minutos e depois mostra "Atualizar". O comando volta depois do Gate 7 se o AS-38i medir webhook atrasado acima de 2 minutos.

### 3. Comandos do dono

Os três seguem o molde do `startCheckout`: a transação do tenant autoriza, valida o `requestId` (UUID gerado pelo cliente) e grava a auditoria do pedido; depois, **fora dela**, o papel de billing executa sob a trava da loja.

- **`billing.cancelRenewal({ organizationId, requestId, reason? })`** → `cancelled` ou `already_cancelled`. Sob a trava lê o registro: renovação já cancelada responde `already_cancelled` sem chamar o provedor e sem e-mail; sem vínculo ou fora de `trialing`, `active` e `grace`, `CONFLICT nothing_to_cancel`. Não encerra a loja, não reembolsa e não mexe em `access_ends_at`. Em `grace`, cancelar encerra as novas tentativas. Provedor fora do ar: `SERVICE_UNAVAILABLE billing_provider_unavailable`, nada gravado, repetir é seguro. **Cancelar a renovação não pode ser desfeito** (decisão do usuário de 23/10/2026, Q-AS1): quem quiser voltar assina de novo pelo checkout depois do fim do acesso (`resubscribeFrom`), sem nenhum botão de "reativar".
- **`billing.requestRefund({ organizationId, requestId })`** → `refund_requested` ou `refund_pending`, com `amount` e `until`. Sob a trava e o relógio do servidor: (1) se o vínculo já tem `refund_requested_at`, a janela é avaliada nesse instante, não em `now`; senão, avalia em `now` e, aberta, grava `refund_requested_at` antes de chamar o provedor (fechada: `CONFLICT nothing_to_refund`, sem efeito); (2) **cancela antes, decidindo pelo estado**: se `cancel_at_period_end` já é verdadeiro, pula o passo (outro `requestId` nunca grava um segundo `subscription_cancelled`); senão, `port.cancelRenewal` e o fato `command:refund_cancel:<requestId>:<digest>`, o mesmo código do comando de operador (emenda do ADR 0066); (3) `port.refundCurrentPeriod`. Se o reembolso falha depois do cancelamento, a resposta é `refund_pending` (HTTP 200): a tela diz que a renovação foi cancelada e o reembolso não foi concluído, e oferece "Desistir" de novo. A repetição depois do sucesso responde igual, lendo `revoked.reason = 'refund'`. O valor devolvido é o `first_charge_amount` gravado, não o do catálogo. Sem `refundsEnabled` (Pix até o S3.2), `CONFLICT refund_via_support` antes de qualquer passo.
- **`billing.openOverduePayment({ organizationId })`** → `{ handoff: { kind: "redirect", url } }`. Só em `grace` e com Asaas. A porta nova `overduePaymentPage` relê e devolve o `invoiceUrl` da cobrança vencida do período. O host é conferido **por igualdade exata**: `https:` e host `www.asaas.com`, `asaas.com` ou `sandbox.asaas.com` (este só fora de produção), sem credencial nem porta, nunca `endsWith`. O endereço nunca vai para log nem e-mail, e o cliente abre com `noopener`. A tela diz, antes do clique e na volta, que isto **paga a cobrança que falhou e não troca o cartão** (AS-43): trocar o cartão da assinatura exigiria passá-lo pelo Polaris (B7, ADR 0101) e fica fora da V1.
- **Motivo do cancelamento (opcional, até 500 caracteres).** Grava só depois de `cancelled`, na tabela `billing_cancellation_feedback`, **sem loja e sem pessoa**, com `recorded_on` (só o dia), o estado e o ciclo. Nunca vai para `billing_events`, log, Sentry ou auditoria; o logger ganha `reason` na redação. Retenção de **12 meses** (aprovada), apagada pela manutenção diária de privacidade, e registrada em `privacy.md` e em `retention.ts`. Fica fora do purge da loja (não tem `organization_id`) e fora da exportação e do atendimento ao titular, porque é texto livre sem vínculo. A tela avisa "Não escreva dados pessoais".
- **Auditoria do tenant** (migration 0100, CHECK de `event_type` e `tenant-audit-events.ts`; só `entityType` e o ID da loja, sem payload): `billing.checkout_started`, `billing.renewal_cancel_requested` e `billing.refund_requested` na classe `security` (12 meses); `billing.overdue_payment_opened` na classe `operational`.

### 4. Trava por organização e limite

- **Trava sem fila.** `withOrganizationLock` (já na `main`, emenda do ADR 0066) usa `pg_try_advisory_xact_lock` numa conexão própria. Ocupada, o comando responde `CONFLICT` com `reason: "command_in_progress"` na hora, sem nada feito; repetir com o mesmo `requestId` é seguro. Os três comandos do dono passam a pegá-la. O webhook e a manutenção **nunca** a pegam: a caixa de entrada já ordena os fatos.
- **Limite por loja** nos comandos que chamam o provedor: **1 a cada 30 s e 10 por hora**, contado no registro, sob a trava, por `provider_command_at`, `provider_commands_hour_start` e `provider_commands_hour`. Acima, `CONFLICT` com `reason: "billing_command_rate_limited"`, sem chamar o provedor. (A binding de limite da Cloudflare só aceita períodos de 10 s e 60 s, e não serve.)
- **Pool.** O papel de billing tem `max: 3` por isolate, e a trava segura uma conexão enquanto o provedor responde. O store recusa abrir **mais de uma trava de comando por isolate** ao mesmo tempo (contador no processo; também `command_in_progress`). Um comando usa no máximo duas conexões, e a terceira fica livre para webhook e manutenção. A transação ociosa cai em 60 s, e repetir é seguro.
- **Prova.** Gate no PostgreSQL 18: com a trava presa, `recordEvent` e `processEvent` do mesmo registro terminam; duas chamadas da mesma loja, a segunda responde em menos de 1 s; um laço de 20 comandos de lojas diferentes não esgota o pool (o webhook de uma terceira loja é aplicado durante o laço).

### 5. O que passa a ser gravado (migration 0100, só expand, [ADR 0096](0096-migrations-compativeis-com-a-versao-anterior-do-worker.md))

`organization_billing` ganha colunas anuláveis, gravadas só pelo papel de billing (`GRANT UPDATE` a `polaris_billing_runtime`, nenhum grant ao tenant, nenhum `SELECT` ao `polaris_admin_owner` até uma função do Admin usá-las):

- `price_amount` (escala 2, > 0) e `price_id`: o preço que o `startCheckout` mandou ao provedor (valor da próxima cobrança);
- `first_charge_on`: a data da 1ª cobrança marcada no provedor, no `attachProvider`. O fim do teste no registro conta da aprovação do método e, no Pix aprovado tarde, cai depois da cobrança; **tela e e-mails só falam da data da cobrança**, nunca "o teste termina";
- `first_charge_at` (= `fact.occurredAt`), `first_charge_amount` e `first_charge_event_id`: gravados no `processEvent` quando o `charge_succeeded` leva de `trial_setup`, `trialing` ou Free a `active` sob o vínculo atual. O `refundCurrentPeriod` do dono confere que a cobrança a reembolsar é a 1ª e recusa se o provedor reordenar;
- `refund_requested_at`: no primeiro pedido aceito do vínculo;
- as três do limite (decisão 4) e `refund_rearm_attempts` e `refund_rearm_at` (decisão 6).

O CHECK exige coerência (`first_charge_amount` e `first_charge_event_id` só com `first_charge_at`). **Cada nova assinatura abre uma nova janela de 7 dias de arrependimento** (decisão do usuário de 23/10/2026): o `attachProvider` de um vínculo novo limpa as colunas da 1ª cobrança, `refund_requested_at` e as do rearme. A taxa de pedidos segue vigiada pela métrica M12. A migration também cria `billing_cancellation_feedback` (RLS forçada; `INSERT` só a `polaris_billing_runtime`, `SELECT` só a `polaris_admin_owner`, `DELETE` ao papel da manutenção de privacidade) e os quatro tipos de auditoria.

### 6. O reembolso cancela a renovação, e a rede de segurança

A ordem "cancelar, depois reembolsar" (emenda do ADR 0066) vale também para o comando do dono: uma falha no meio deixa "Pro até D/M" e repetir termina; na ordem inversa a renovação ficaria viva e a cobrança seguinte devolveria o Pro. A **rede horária** (PR B, porque precisa do estado de recuo) cancela a renovação de lojas com `revoked_reason IN ('refund', 'chargeback')` (**nunca `won`**), vínculo atual vivo e `cancel_at_period_end` falso. O `attachProvider` zera os `revoked_*`, então uma assinatura nova não é tocada. Limite de 20 lojas por passada; por loja, recuo de 1 h, 2 h, 4 h e assim até 24 h, e parada em 10 tentativas com o log `billing_refund_rearm_exhausted` (incidente). Fato `command:revoked_cancel:<loja>:<digest>:<n>` e log `billing_refund_renewal_rearmed` com `reason`.

### 7. Avisos por e-mail e `noticeStillTrue`

- **Marcar na transição.** A função pura `noticesFor({ before, after, fact, transition, eventId })` (`packages/domain/src/billing/notices.ts`) diz quais avisos uma transição aplicada gera. `processEvent` e `sweepDue` inserem os avisos (`ON CONFLICT DO NOTHING`) e o evento do outbox **na mesma transação**; um fato duplicado ou ignorado não gera aviso. São oito de cobrança, mais o aviso anual abaixo (E-A `trial_started`, E-B `trial_charge_eve`, E-C1 `first_charge_failed`, E-C2 `renewal_failed`, E-D `access_ended`, E4 `charge_receipt`, E7 `renewal_cancelled`, E-R `refund_confirmed`) e o E1 `welcome`.
- **Aviso da renovação anual 7 dias antes (Q-E1, decisão do usuário de 23/10/2026).** Só para o ciclo anual: a loja recebe um aviso 7 dias antes da cobrança da renovação, com o texto do E-B ajustado (valor, data e método), para reduzir reembolso e disputa de quem esqueceu que assinou o anual. Como o E-B, é de varredura horária e passa pelo `noticeStillTrue` (não sai com a renovação cancelada, fora de `active` ou depois de reembolso). O nome do `kind`, a chave de deduplicação e a linha da tabela ficam para o PR F; a primeira renovação anual real só ocorre 12 meses depois do lançamento, então o aviso precisa estar na `main` antes dela, não do Gate 7.
- **Atraso deliberado.** E4 e E7 saem 10 min depois da transição (o `SUBSCRIPTION_DELETED` do Asaas pode chegar antes do fato do comando, e o reembolso logo depois); o E7 de um pedido de reembolso espera **24 h**: se o reembolso conclui, é suprimido; se não, sai e diz a verdade.
- **`noticeStillTrue(kind, record, notice, now)`.** O consumidor de `billing.notice` relê o aviso e o registro no papel de billing e chama essa função pura; se ela devolve um motivo, o aviso fica `skipped` com ele. Regras comuns, de cima para baixo: flag desligada (`email_not_configured`); aviso de cobrança com loja encerrada (`organization_closed`); aviso de cobrança com `provider_ref` mudado (`link_replaced`). Depois, uma linha por `kind` (a tabela completa fica no desenho e vira teste, uma linha por teste). Pontos que valem como regra: E4, E7, E-A e E-D são suprimidos depois de reembolso (`refunded`); o E7 não sai se o período atual tem `revoked_reason = 'refund'`, **também quando o `SUBSCRIPTION_DELETED` do Asaas chega antes do fato do comando**; o E-B não sai se o E-A saiu há menos de 24 h e só sai das 08:00 às 20:00 locais; o E-C2 nunca sai duas vezes no mesmo dia local (o d0 sai sempre). Na verificação por remoção, tirar cada linha de E-B, E-C2, E4 e E7 deixa o teste vermelho.
- **E1 fora do onboarding.** Varredura horária do PR F (lojas criadas nas últimas 24 h cujo dono mais antigo não tem `welcome`); `create_initial_organization` **não muda**. Liga própria, `WELCOME_EMAIL_ENABLED`, desligada por padrão, independente da flag da decisão 1; com ela desligada a varredura nem cria a linha (ligar depois não manda boas-vindas atrasadas). Só informativo, **sem rastreador** (sem `img` e sem parâmetro de campanha); base legal: LGPD, art. 7º, V. Nunca é suprimido por estado de cobrança.
- **Destinatário e conexões (migration 0101, PR F).** `billing_notices` (`UNIQUE (organization_id, kind, dedupe_key)`; `welcome` com `UNIQUE (user_id) WHERE kind = 'welcome'`; RLS forçada, sem política para o tenant; `user_id` com FK `ON DELETE CASCADE` para o apagamento de não verificados). A função `billing_notice_recipient(p_organization, p_notice)` segue o molde inteiro da `closure_notice_recipient`: devolve só o e-mail, só se o aviso ainda é devido, o destinatário segue dono ativo e o e-mail está verificado; dono próprio sem login, `search_path` fixo, `EXECUTE` só ao papel de auth, nos gates `definer-hardening` e `definer-owners`. O papel de billing ganha `INSERT` **por coluna** em `event_outbox`, com `WITH CHECK` completo (`type = 'billing.notice'`, `status = 'pending'`, `attempts = 0`, chave igual a `type || ':' || noticeId` e o aviso existe na mesma loja). O consumidor roda no Worker `polaris-web` (fila `default`) e abre duas conexões: `BILLING_HYPERDRIVE` para ler e marcar o aviso e a de auth para o destinatário. O e-mail do pagador do Pix nunca é usado.
- **Falhas.** Sem destinatário (loja purgada, pessoa apagada): `skipped: no_recipient`, sem erro e sem dead-letter. Resend 2xx marca `sent`; 4xx de endereço, `failed` sem nova tentativa; 5xx ou rede, a fila tenta de novo e o dead-letter vira incidente. O log leva só `kind`, a classe e o ID opaco da loja.
- **Purge.** `billing_notices` entra em `purge-datasets.ts` e `purge_organization_data` é recriada na 0101: exige o gate `purge-functions` verde e conferir no merge se outro PR recria a mesma função. Efeito aceito: depois do purge da loja, o `welcome` some, e a mesma pessoa que abrir outra loja recebe boas-vindas de novo.
- **Texto.** O E-B fala da 1ª cobrança ("A primeira cobrança da loja {loja} é amanhã"), nunca do fim do teste. `{loja}` no assunto vai até 24 caracteres mais "…". A frase "Nenhuma nova cobrança será feita" do E-R só entra depois de o AS-32 passar no Gate 7 (EM-33).

### 8. Pix: o reembolso vai ao suporte até a prova (R-1), sem QR (R-4), sem `syncPlan` (R-5)

- **R-1.** O reembolso de parcela do Pix não tem prova (S3.2) e `WOOVI_REFUND_ENABLED` segue desligada. A flag de autosserviço pode ligar assim mesmo: no Pix, `refund.via` é `"suporte"`, a tela mostra "Para desistir, escreva para {suporte} até D/M." com a mesma janela do cartão, e o comando responde `refund_via_support`. A caixa vem da configuração `BILLING_SUPPORT_EMAIL` (também o `reply-to`), nunca fixa no código (AS-44). **No staging, o e-mail de suporte é `contato.juniordiniz@gmail.com`** (decisão do usuário de 23/10/2026, Q-AS2), configurado no ambiente, não no repositório. **Em produção a caixa depende da P48 e fica como pendência.** Se o S3.2 ficar bloqueado, a rota de suporte vale com três exigências: caixa monitorada, roteiro do operador com `charge_refunded` e E-R do caso. Os critérios do Pix vão como BLOQUEADO, não como falha, até a prova.
- **R-4.** Sem biblioteca de QR na V1 (risco de QR de outro código sem teste que note, e bytes). No desktop, "Abrir a página de pagamento" (Woovi) é o botão principal e o "copia e cola" o segundo; no celular, a ordem inversa. A biblioteca só volta com o teste de decodificação do Rodrigo, como dependência nova (`ui-supply-chain.ts` e revisão de segurança).
- **R-5.** `billing.syncPlan` fica fora da V1 (decisão 2).

### 9. Pagamento recusado

Cartão: `openOverduePayment` (decisão 3), só com `recovery = "provider_page"`; pagar a cobrança confirma a mesma `pay_` e `charge_succeeded` leva de `grace` a `active`. O S-R1 (pagar com outro cartão nessa página) é do Gate 7: se falhar, `recovery` sai `null` e a tela diz só "Seu Pro vai até D/M". Pix Automático: a Woovi tenta de novo (`THREE_RETRIES_7_DAYS`), mas o calendário não foi provado, então a tela e o E-C2 dizem só "Seu Pro vai até D/M". Depois do prazo extra, a loja vai ao Free e o `startCheckout` assina de novo, sem teste. Checkout novo em `grace` fica descartado (cobrança dupla). A métrica `billing_grace_recovered` leva `via`: `provider_page`, `provider_retry` ou `new_subscription`.

### 10. Sequência, números e provas

A sequência do desenho (§12) vale: A (mesclado) → **H0 (este ADR)** → B (db, migration 0100) → C (`readPlan`) → D (comandos) → E (tela, depois dos wireframes do Petković) e E2 → F (db, migration 0101, depois do merge do B) → G (consumidor e modelos, depois dos oito e-mails aprovados a 360 px) → H (docs: `privacy.md`, `email-auth.md`, Termos v1, status) → Gate 7. Um PR de banco por vez. A revisão de segurança é obrigatória em A, B, D, F e G. A matriz critério → prova (AS-n e EM-n) vai no corpo de cada PR, com verificação por remoção. O Gate 7 usa as sete contas `qa-`, a semeadura `qa-`, o script de recuo de datas (só lojas `qa-`, só banco de staging, só sandbox) e uma caixa de recebimento no domínio de teste; sem a caixa, EM-23 e EM-35 ficam BLOQUEADO.

## Consequências

- O dono lê o plano e age sem o operador. A leitura da cobrança é só do dono, com esquema estrito.
- O reembolso, do operador ou do dono, nunca deixa a renovação viva; chargeback é coberto pela rede horária.
- Pix não reembolsa pelo app até o S3.2: quem paga por Pix escreve ao suporte, com a mesma janela.
- Cada nova assinatura reabre os 7 dias de arrependimento, o que pode ser explorado repetindo assinaturas; o M12 vigia, e a mudança, se vier, é só a limpeza no `attachProvider` e um teste.
- A flag liga em produção só com P48 completa, Gate 7 e os PRs E, E2 e G na `main`.
- O texto livre do motivo do cancelamento fica 12 meses, sem vínculo com loja ou pessoa.
- Pontos de pergunta abertos, sem trava para os PRs A a F: prazo de resposta do suporte do Pix se a rota virar definitiva; retenção dos logs da métrica M8; caixa de suporte de produção (P48).

## Alternativas consideradas

- **`plan.status` no grupo `plan`:** esse grupo é lido por qualquer membro, e a leitura da cobrança é do dono.
- **O tenant lendo as colunas novas:** contraria o RN:32.
- **Varrer `billing_events` a cada leitura para achar a janela:** uma consulta por leitura e regra no SQL. A coluna é mais simples de provar.
- **Fila na trava (`pg_advisory_xact_lock`):** um laço de comandos prenderia o pool de 3 conexões.
- **Janela avaliada em `now` na repetição:** recusaria o reembolso de quem pediu a tempo.
- **Suprimir o E7 só pelo prefixo do ID `command:refund_cancel:`:** perde a corrida com o webhook do Asaas.
- **Motivo do cancelamento com a loja:** obrigaria recriar o purge e guardaria texto livre ligado a uma pessoa.
- **Varredura horária para todos os e-mails:** atrasaria E-A, E4 e E7 e repetiria as transições. Só o E1, os marcos do E-C2, o E-B e o aviso anual são de varredura.
- **E1 no `create_initial_organization`:** mexeria numa função SECURITY DEFINER recente e abriria uma terceira migration.
- **QR por biblioteca na V1** e **`syncPlan` na V1:** ver a decisão 8.
- **Checkout novo em `grace`** e **trocar o cartão pela API do Asaas:** cobrança dupla, e o cartão passaria pelo Polaris (B7, ADR 0101).
- **Desfazer o cancelamento da renovação:** descartado pelo usuário (Q-AS1); reativar exigiria reabrir cobrança no provedor, com os mesmos riscos de `grace`.
