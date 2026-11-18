# Alertas operacionais

**Gatilho:** um alerta disparou (e-mail de alerta ou resumo diário), ou antes de ligar um deploy ao tráfego real. A definição de cada sinal é código: o registro `alertSignals` de [`packages/observability/src/alerts.ts`](../../packages/observability/src/alerts.ts); este runbook diz o que cada um significa, como confirmar e o que fazer ([ADR 0095](../adr/0095-onde-os-alertas-operacionais-vao-rodar.md), plano PR 119).

> **Nada disto roda ainda, com uma exceção no staging:** políticas `custom_analytics` da Cloudflare, agrupadas porque a conta aceita no máximo 5 (as políticas 2 a 5 criadas pelo Arrascaeta em 17/11/2026, anotação dele; a primeira é o monitor V14, com a data na tabela de políticas; este runbook não as verifica), cobrem os sinais que a seção [Monitores no staging](#monitores-no-staging) marca como `coberto pela política N`, e as seções de `apagamento-automatico` e `loja-encerrada-parada` dizem o que viram no staging; para os outros, a tabela de lá é a fonte. Para os demais sinais (`pendente`) não há alerta, cron, token nem conta em serviço externo criados por este runbook. Hoje o runbook é lido à mão: as consultas abaixo funcionam no Workers Logs de um ambiente que exista (Fase 14). Se um limiar e o registro divergirem, vale o registro; ajuste os dois no mesmo PR (um teste exige que cada sinal tenha a seção abaixo e que ela cite cada evento dele, e que cada evento exista no código; outro confere a seção Monitores no staging com o registro).

## Como ler

- **Severidade e quem acorda:** `critical` acorda alguém (e-mail imediato, no máximo um por sinal a cada 6 horas); `warning` só aparece no resumo diário. É o campo `notify` do registro (`wake` ou `report`).
- **Janela e limiar:** a contagem é de eventos na janela (não de requisições); `absence` quer dizer "nenhum evento na janela".
- **Consultas:** no painel Workers Logs do Worker `polaris-web` (Observability, Query), filtre pelo campo `event` (o nome do evento) e pelos campos canônicos do [ADR 0091](../adr/0091-esquema-canonico-de-eventos-largos.md) (`outcome`, `route`, `httpStatus`, `durationMs`, `reason`, `errorClass`, `errorCode`, `sqlState`, `requestId`). Eventos não trazem dado de cliente: para cruzar com um caso, use o `requestId`. Os Workers Logs guardam poucos dias (3 no plano Free até a cobrança nova de 1º/12/2026, depois 7); incidente mais antigo só se confirma pelo banco.
- **Banco:** as consultas SQL são só de leitura, com o papel de leitura que o responsável autorizar (as tabelas citadas são agregadas ou sem dado de cliente; o dono do banco ignora o RLS e não deve ser o padrão), em ambiente autorizado, seguindo a [política de perfis de CLI](./cli-profile-policy.md). Não cole resultado com dado de cliente em PR nem chat.
- **Admin:** o painel do Admin mostra os incidentes da DLQ e os casos de cobrança sem dar acesso ao tenant.

## Sinais

| Sinal | Evento de origem | Janela | Limiar | Severidade | Acorda |
| --- | --- | --- | --- | --- | --- |
| [`http-5xx`](#http-5xx) | `server_error` (`httpStatus >= 500`) e outros | 15 min | 5 | critical | sim |
| [`latencia-p95`](#latencia-p95) | `http_request_timed` | 30 min | p95 acima do limite da rota (20 requisições, no mínimo) | warning | não |
| [`dlq`](#dlq) | `queue_dead_letter_recorded` e outros | 60 min | 3 | warning | não |
| [`outbox-parado`](#outbox-parado) | `scheduled_job_run` do `outbox.dispatch` | 180 min | ausência | critical | sim |
| [`outbox-falhando`](#outbox-falhando) | `outbox_send_failed`, `outbox_event_unsendable` | 120 min | 1 | warning | não |
| [`cobranca-reconcile`](#cobranca-reconcile) | `billing_maintenance_incomplete` e outros | 180 min | 3 | critical | sim |
| [`cobranca-provedor-nao-confirmou`](#cobranca-provedor-nao-confirmou) | `billing_unavailable_refused` (`reason` dos dois motivos) | 180 min | 3 | warning | não |
| [`pix-cadastros-por-loja`](#pix-cadastros-por-loja) | `billing_payer_customer_created` | 60 min | 5 | warning | não |
| [`erros-de-banco`](#erros-de-banco) | `server_error` com `sqlState` e outros | 15 min | 3 | critical | sim |
| [`agendador-falhando`](#agendador-falhando) | `scheduled_job_claim_failed` e outros | 180 min | 2 | warning | não |
| [`r2-e-midia`](#r2-e-midia) | `media_removed_asset_failed` e outros | 60 min | 1 | warning | não |
| [`cota-de-transformacao`](#cota-de-transformacao) | `media_transform_quota_exceeded` | 60 min | 1 | warning | não |
| [`rejeicao-no-sync`](#rejeicao-no-sync) | `sync_push_command_rejected` | 15 min | 10 | warning | não |
| [`registro-de-acesso`](#registro-de-acesso) | `auth_access_log_write_failed` | 15 min | 3 | critical | sim |
| [`aceite-no-cadastro`](#aceite-no-cadastro) | `legal_acceptance_signup_record_failed` | 24 h | 1 | warning | não |
| [`link-de-verificacao`](#link-de-verificacao) | `auth_verification_link_record_failed` | 24 h | 1 | warning | não |
| [`apagamento-automatico`](#apagamento-automatico) | `closure_auto_purge_volume_high` | 24 h | 1 | critical | sim |
| [`loja-encerrada-parada`](#loja-encerrada-parada) | `closure_purge_overdue` | 24 h | 1 | warning | não |
| [`purge-parado`](#purge-parado) | `organization_purge_stalled` | 24 h | 1 | warning | não |
| [`aviso-de-encerramento-falhando`](#aviso-de-encerramento-falhando) | `closure_notice_email_failed` | 24 h | 1 | warning | não |
| [`checkout-pago-no-encerramento`](#checkout-pago-no-encerramento) | `billing_closure_paid_checkout_refund_pending` | 24 h | 1 | warning | não |
| [`rede-de-reembolso-parada`](#rede-de-reembolso-parada) | `billing_refund_rearm_exhausted` | 60 min | 1 | critical | sim |
| [`incidente-de-reembolso-nao-gravado`](#incidente-de-reembolso-nao-gravado) | `billing_refund_pending_incident_failed` (Worker `polaris-web`), `billing_amount_mismatch_incident_failed` (Worker `polaris-admin`) | 60 min | 1 | critical | sim |
| [`pix-revogacao-nao-mostrada`](#pix-revogacao-nao-mostrada) | `billing_woovi_revocation_not_shown` | 24 h | 1 | warning | não |
| [`comando-de-cobranca-do-operador`](#comando-de-cobranca-do-operador) | `billing_operator_command` (Worker `polaris-admin`) | 15 min | 1 | critical | sim |
| [`revelacoes-por-hora`](#revelacoes-por-hora) | `admin_reveal_rate_limited` (Worker `polaris-admin`) | 60 min | 1 | warning | não |
| [`serie-parada`](#serie-parada) | `activation_series_stopped` (`stopped = true`) | 24 h | 1 | warning | não |
| [`incidente-de-reembolso-aberto`](#incidente-de-reembolso-aberto) | `billing_refund_pending_incident` | 60 min | 1 | critical | sim |
| [`chave-do-provedor-recusada`](#chave-do-provedor-recusada) | `billing_provider_rejected` | 60 min | 1 | critical | sim |
| [`webhook-de-cobranca-abandonado`](#webhook-de-cobranca-abandonado) | `billing_webhook_unresolved_given_up` | 60 min | 1 | critical | sim |
| [`serie-falhando`](#serie-falhando) | `activation_notice_email_misconfigured`, `activation_notice_failed`, `activation_sweep_failed` | 60 min | 1 | critical | sim |
| [`email-de-acesso-falhando`](#email-de-acesso-falhando) | `auth_email_delivery_failed` | 60 min | 1 | critical | sim |
| [`aviso-nao-entregue`](#aviso-nao-entregue) | `activation_notice_delivery_window_passed`, `billing_notice_delivery_window_passed`, `billing_notice_failed` | 24 h | 1 | warning | não |
| [`cobranca-fato-estranho`](#cobranca-fato-estranho) | `billing_trial_fact_without_claim` e outros | 24 h | 1 | warning | não |
| [`limitador-indisponivel`](#limitador-indisponivel) | `rate_limit_unavailable` | 24 h | 1 | warning | não |

Os limiares são um primeiro chute, sem medida de tráfego real; a Fase 14 os revê. A taxa de 5xx é uma contagem por janela, sem denominador (só as rotas críticas emitem um evento por requisição).

**Todo evento emitido com `logger.error` tem destino.** Ou está num sinal acima, ou está em `errorEventsWithoutSignal` (em `alerts.ts`) com o motivo, e um teste de `alerts.test.ts` reprova o evento de erro novo que não esteja em nenhum dos dois, dizendo o nome. O teste lê o `logger.error("<nome>")` direto e o `report("<nome>")` dos apps cujo `report` está ligado a `logger.error` no código (hoje o catálogo; o do Admin escreve em `warn`, fora da regra), então os eventos de erro do catálogo também têm de ter destino. Fica de fora o evento cujo nome não é um literal na chamada. Hoje não têm sinal: `queue_ledger_not_recorded` (o trabalho foi feito e a entrega seguinte acha o tratador idempotente: ninguém precisa agir), `billing_woovi_reconcile_failed` e `billing_woovi_reconcile_incomplete` (falham de hora em hora até o sandbox da Woovi voltar, no Gate 7; entram em [cobranca-reconcile](#cobranca-reconcile), e na política 4 do staging, quando ele voltar) e, por fim, `organization_purge_step_failed` (cada falha de passo do purge que não é recusa sai em `error`; da 3ª tentativa em diante o job emite junto o `organization_purge_stalled`, que entra em [purge-parado](#purge-parado): contar os dois dobraria o aviso). Os demais seguem a classificação do Filipe de 17/11/2026: os que acordam estão em [`serie-falhando`](#serie-falhando), [`email-de-acesso-falhando`](#email-de-acesso-falhando), [`incidente-de-reembolso-aberto`](#incidente-de-reembolso-aberto), [`chave-do-provedor-recusada`](#chave-do-provedor-recusada), [`webhook-de-cobranca-abandonado`](#webhook-de-cobranca-abandonado) e nos sinais de cobrança, 5xx e banco que já existiam; os que só vão ao resumo diário, em [`aviso-nao-entregue`](#aviso-nao-entregue), [`cobranca-fato-estranho`](#cobranca-fato-estranho), [`limitador-indisponivel`](#limitador-indisponivel), [`dlq`](#dlq) e [`purge-parado`](#purge-parado).

## Monitores no staging

O que existe e o que falta no painel (Observability, Alertas, Monitores). A conta da Cloudflare aceita no máximo 5 políticas `custom_analytics` (erro 17204, "this account can have at most 5 custom analytics policies"), então uma política vale por vários sinais. A primeira tabela diz o que cada política consulta e quais sinais cobre; a segunda, por sinal, a política que o cobre ou `pendente`. Na segunda, a consulta, a janela, o limiar e o "acorda" são os do registro `alertSignals`; um teste (`packages/observability/src/alerts.test.ts`) exige uma linha por sinal do registro, nem uma a mais nem a menos, e reprova, dizendo o id, quando um desses campos diverge do registro, quando os eventos da consulta não são exatamente os do sinal, ou quando as políticas não batem com os sinais. Os sinais que acordam vêm primeiro.

- **Estado da política** é só `criada em <data> por <quem>` ou, na primeira, `V14, provada em <data> (anotação do <quem>)`. **Estado do sinal** é só `coberto pela política N` ou `pendente`. Quem cria ou muda uma política anota o estado aqui no mesmo PR; este texto não verifica o painel.
- **Política 1 (V14):** a anotação do Arrascaeta diz que ela consulta `auth_access_log_write_failed` (sinal `registro-de-acesso`) e foi provada em 09/11/2026; este texto não a verificou no painel.
- **As políticas 3 e 4 foram ampliadas em 17/11/2026 (anotação do Arrascaeta, pela classificação do Filipe):** a 3 passou de 3 para 11 eventos (entraram os da série, `legal_acceptance_unavailable`, `auth_database_not_configured`, `auth_password_pepper_missing`, `better_auth_internal_error` e `catalog_read_failed`) e, em 17/11/2026 às 23:56 (anotação do operador), para 12, com `auth_email_delivery_failed` (sinal `email-de-acesso-falhando`) e a 4 de 9 para 19 (entraram os 7 de `cobranca-reconcile` que faltavam e os três sinais novos de cobrança). A consulta delas filtra só pela conta, então pega os eventos de todos os Workers (web, catálogo e Admin). A anotação diz que nenhum desses eventos novos ocorreu nas 24 horas anteriores à consulta; este texto não a repetiu.
- **O que a Cloudflare conta é menos que o registro.** A anotação do Arrascaeta descreve as políticas 2 a 4 como 1 ou mais evento em 1 minuto, sem os filtros do registro (como `httpStatus >= 500, or the event is not server_error`) e sem as janelas e limiares dele; a política 5 é a ausência do registro (menos de 1 em 3 h, avaliada a cada 10 min). Pela anotação, a política 1 tem limiar de 1 ou mais evento, avaliada a cada 1 min (não verificado no painel). Quem lê o e-mail de uma política agrupada olha o evento no Workers Logs para saber qual sinal disparou. Nenhum desses eventos, fora o V14, foi provocado ainda para provar o disparo.
- **A política 4 deixa de fora `billing_woovi_reconcile_failed` e `billing_woovi_reconcile_incomplete`,** que falham de hora em hora até a Woovi voltar a responder, no Gate 7 (conferir AppID e disponibilidade, como em [billing-providers.md](./billing-providers.md)); nenhum sinal do registro os cita: estão em `errorEventsWithoutSignal`, com o motivo, e entram em `cobranca-reconcile` e na política 4 quando o Gate 7 voltar.
- **A conta está no limite de políticas.** Os sinais `pendente` não ganham política própria: criar monitor para eles pede agrupar numa política existente ou mudar o limite da conta, escolha que não é deste texto.
- **Worker:** as consultas valem para o Worker `polaris-web`, salvo o que a linha do sinal atribui a `polaris-admin`; a anotação do Arrascaeta não cita filtro de Worker nas políticas, e a consulta das políticas 3 e 4 filtra só pela conta. `catalog_media_authorization_failed`, `catalog_media_object_missing` e `catalog_media_read_failed`, de `r2-e-midia`, e `catalog_read_failed`, de `http-5xx`, só são emitidos em `apps/catalog` (o Worker do catálogo); o nome do Worker no painel do staging não foi conferido aqui.
- Nenhum monitor, token ou conta é criado por este texto.

| Política | Consulta (Workers Logs) | Limiar na Cloudflare | Sinais que cobre | Estado |
| --- | --- | --- | --- | --- |
| 1 | `event = "auth_access_log_write_failed"` | não verificado (anotação: 1 ou mais em 1 min) | `registro-de-acesso` | V14, provada em 09/11/2026 (anotação do Arrascaeta) |
| 2 | `event in ("closure_auto_purge_volume_high", "closure_purge_overdue")` | 1 ou mais em 1 min | `apagamento-automatico`, `loja-encerrada-parada` | criada em 17/11/2026 por Arrascaeta |
| 3 | `event in ("server_error", "scheduler_state_unavailable", "queue_ledger_unavailable", "legal_acceptance_unavailable", "auth_database_not_configured", "auth_password_pepper_missing", "better_auth_internal_error", "catalog_read_failed", "activation_notice_email_misconfigured", "activation_notice_failed", "activation_sweep_failed", "auth_email_delivery_failed")` | 1 ou mais em 1 min | `http-5xx`, `erros-de-banco`, `serie-falhando`, `email-de-acesso-falhando` | criada em 17/11/2026 por Arrascaeta |
| 4 | `event in ("billing_maintenance_incomplete", "billing_sweep_failed", "billing_event_retry_failed", "billing_grant_sweep_failed", "billing_webhook_processing_failed", "billing_notice_handover_failed", "billing_notice_record_failed", "billing_notice_sweep_failed", "billing_trial_setup_sweep_failed", "billing_unclaimed_trial_settle_failed", "billing_unclaimed_trials_incomplete", "billing_refund_safety_net_incomplete", "billing_refund_rearm_exhausted", "billing_refund_pending_incident_failed", "billing_amount_mismatch_incident_failed", "billing_operator_command", "billing_refund_pending_incident", "billing_provider_rejected", "billing_webhook_unresolved_given_up")` | 1 ou mais em 1 min | `cobranca-reconcile`, `rede-de-reembolso-parada`, `incidente-de-reembolso-nao-gravado`, `comando-de-cobranca-do-operador`, `incidente-de-reembolso-aberto`, `chave-do-provedor-recusada`, `webhook-de-cobranca-abandonado` | criada em 17/11/2026 por Arrascaeta |
| 5 | `event = "scheduled_job_run"`; `job = "outbox.dispatch" and outcome = "success"` | ausência: menos de 1 em 3 h, avaliada a cada 10 min | `outbox-parado` | criada em 17/11/2026 por Arrascaeta |

| Sinal | Consulta (Workers Logs) | Janela | Limiar | Acorda | Estado |
| --- | --- | --- | --- | --- | --- |
| [`http-5xx`](#http-5xx) | `event in ("server_error", "auth_database_not_configured", "auth_password_pepper_missing", "better_auth_internal_error", "catalog_read_failed")`; `httpStatus >= 500, or the event is not server_error` | 15 min | 5 | sim | coberto pela política 3 |
| [`outbox-parado`](#outbox-parado) | `event = "scheduled_job_run"`; `job = "outbox.dispatch" and outcome = "success"` | 180 min | ausência | sim | coberto pela política 5 |
| [`cobranca-reconcile`](#cobranca-reconcile) | `event in ("billing_maintenance_incomplete", "billing_sweep_failed", "billing_event_retry_failed", "billing_grant_sweep_failed", "billing_webhook_processing_failed", "billing_notice_handover_failed", "billing_notice_record_failed", "billing_notice_sweep_failed", "billing_trial_setup_sweep_failed", "billing_unclaimed_trial_settle_failed", "billing_unclaimed_trials_incomplete", "billing_refund_safety_net_incomplete")` | 180 min | 3 | sim | coberto pela política 4 |
| [`erros-de-banco`](#erros-de-banco) | `event in ("server_error", "scheduler_state_unavailable", "queue_ledger_unavailable", "legal_acceptance_unavailable")`; `sqlState exists, or the event is not server_error` | 15 min | 3 | sim | coberto pela política 3 |
| [`registro-de-acesso`](#registro-de-acesso) | `event = "auth_access_log_write_failed"` | 15 min | 3 | sim | coberto pela política 1 |
| [`apagamento-automatico`](#apagamento-automatico) | `event = "closure_auto_purge_volume_high"` | 24 h | 1 | sim | coberto pela política 2 |
| [`rede-de-reembolso-parada`](#rede-de-reembolso-parada) | `event = "billing_refund_rearm_exhausted"` | 60 min | 1 | sim | coberto pela política 4 |
| [`incidente-de-reembolso-nao-gravado`](#incidente-de-reembolso-nao-gravado) | `event in ("billing_refund_pending_incident_failed", "billing_amount_mismatch_incident_failed")`; `billing_refund_pending_incident_failed` no Worker `polaris-web` e `billing_amount_mismatch_incident_failed` no Worker `polaris-admin` | 60 min | 1 | sim | coberto pela política 4 |
| [`comando-de-cobranca-do-operador`](#comando-de-cobranca-do-operador) | `event = "billing_operator_command"`; Worker `polaris-admin` | 15 min | 1 | sim | coberto pela política 4 |
| [`incidente-de-reembolso-aberto`](#incidente-de-reembolso-aberto) | `event = "billing_refund_pending_incident"` | 60 min | 1 | sim | coberto pela política 4 |
| [`chave-do-provedor-recusada`](#chave-do-provedor-recusada) | `event = "billing_provider_rejected"` | 60 min | 1 | sim | coberto pela política 4 |
| [`webhook-de-cobranca-abandonado`](#webhook-de-cobranca-abandonado) | `event = "billing_webhook_unresolved_given_up"` | 60 min | 1 | sim | coberto pela política 4 |
| [`serie-falhando`](#serie-falhando) | `event in ("activation_notice_email_misconfigured", "activation_notice_failed", "activation_sweep_failed")` | 60 min | 1 | sim | coberto pela política 3 |
| [`email-de-acesso-falhando`](#email-de-acesso-falhando) | `event = "auth_email_delivery_failed"` | 60 min | 1 | sim | coberto pela política 3 |
| [`latencia-p95`](#latencia-p95) | `event = "http_request_timed"`; `route in criticalRoutes and outcome != "rejected"` | 30 min | p95 acima do limite da rota (20 requisições, no mínimo) | não | pendente |
| [`dlq`](#dlq) | `event in ("queue_dead_letter_recorded", "queue_dead_letter_not_recorded", "queue_dead_letter_send_failed", "outbox_events_exhausted", "queue_message_failed")` | 60 min | 3 | não | pendente |
| [`outbox-falhando`](#outbox-falhando) | `event in ("outbox_send_failed", "outbox_event_unsendable")` | 120 min | 1 | não | pendente |
| [`cobranca-provedor-nao-confirmou`](#cobranca-provedor-nao-confirmou) | `event = "billing_unavailable_refused"`; `reason in ("previous_checkout_unverified", "previous_renewal_cancel_unverified")` | 180 min | 3 | não | pendente |
| [`pix-cadastros-por-loja`](#pix-cadastros-por-loja) | `event = "billing_payer_customer_created"` | 60 min | 5 | não | pendente |
| [`agendador-falhando`](#agendador-falhando) | `event in ("scheduled_job_claim_failed", "scheduled_job_record_failed", "scheduled_job_handler_missing", "scheduled_job_run")`; `outcome = "failure"` | 180 min | 2 | não | pendente |
| [`r2-e-midia`](#r2-e-midia) | `event in ("media_removed_asset_failed", "media_removed_asset_not_finalized", "media_removed_reconciliation_incomplete", "catalog_media_authorization_failed", "catalog_media_object_missing", "catalog_media_read_failed")` | 60 min | 1 | não | pendente |
| [`cota-de-transformacao`](#cota-de-transformacao) | `event = "media_transform_quota_exceeded"`; `errorCode = "9422"` | 60 min | 1 | não | pendente |
| [`rejeicao-no-sync`](#rejeicao-no-sync) | `event = "sync_push_command_rejected"`; `reason in ("session_changed", "lease_invalid", "authorization_revoked")` | 15 min | 10 | não | pendente |
| [`aceite-no-cadastro`](#aceite-no-cadastro) | `event = "legal_acceptance_signup_record_failed"` | 24 h | 1 | não | pendente |
| [`link-de-verificacao`](#link-de-verificacao) | `event = "auth_verification_link_record_failed"` | 24 h | 1 | não | pendente |
| [`loja-encerrada-parada`](#loja-encerrada-parada) | `event = "closure_purge_overdue"` | 24 h | 1 | não | coberto pela política 2 |
| [`purge-parado`](#purge-parado) | `event in ("organization_purge_stalled", "organization_purge_failure_not_recorded")` | 24 h | 1 | não | pendente |
| [`aviso-de-encerramento-falhando`](#aviso-de-encerramento-falhando) | `event = "closure_notice_email_failed"` | 24 h | 1 | não | pendente |
| [`checkout-pago-no-encerramento`](#checkout-pago-no-encerramento) | `event = "billing_closure_paid_checkout_refund_pending"` | 24 h | 1 | não | pendente |
| [`pix-revogacao-nao-mostrada`](#pix-revogacao-nao-mostrada) | `event = "billing_woovi_revocation_not_shown"` | 24 h | 1 | não | pendente |
| [`revelacoes-por-hora`](#revelacoes-por-hora) | `event = "admin_reveal_rate_limited"`; Worker `polaris-admin` | 60 min | 1 | não | pendente |
| [`serie-parada`](#serie-parada) | `event = "activation_series_stopped"`; `stopped = true` | 24 h | 1 | não | pendente |
| [`aviso-nao-entregue`](#aviso-nao-entregue) | `event in ("activation_notice_delivery_window_passed", "billing_notice_delivery_window_passed", "billing_notice_failed")` | 24 h | 1 | não | pendente |
| [`cobranca-fato-estranho`](#cobranca-fato-estranho) | `event in ("billing_trial_fact_without_claim", "billing_webhook_state_not_shown", "billing_webhook_fact_event_malformed", "billing_provider_response_malformed")` | 24 h | 1 | não | pendente |
| [`limitador-indisponivel`](#limitador-indisponivel) | `event = "rate_limit_unavailable"` | 24 h | 1 | não | pendente |

<a id="http-5xx"></a>

### http-5xx — respostas 5xx

**O que significa.** O Worker respondeu 500 ou mais: uma exceção que ninguém tratou ou uma falha de dependência. O evento é `server_error` (nível `error`), com `route` (o padrão), `method`, `httpStatus`, `errorClass`, `errorCode`, `requestId` e a cadeia de causas (`causes`), nunca a mensagem. 4xx não conta. Entram também quatro eventos de erro que não trazem `httpStatus`: `auth_database_not_configured` e `auth_password_pepper_missing` (configuração ausente: toda requisição autenticada, ou o login por senha, falha) e `better_auth_internal_error` (erro que o Better Auth registra, com só o nível do log), do Worker `polaris-web`, e `catalog_read_failed` (a leitura pública do catálogo falhou e a rota devolve erro), do Worker do catálogo; o filtro de `httpStatus` vale só para `server_error`, e cada ocorrência dos outros conta para o limiar. **Lacuna:** um 503 que o código devolve de propósito, sem exceção (configuração do Better Auth ausente, `auth_unavailable`, e as respostas `auth_*_unavailable` da proteção contra abuso), não gera `server_error`; nas rotas críticas ele aparece como `http_request_timed` com `outcome = "failure"`, que a contagem do sinal não soma (somar os dois contaria a mesma falha duas vezes).

**Como confirmar.** Workers Logs: `event = "server_error"` e `httpStatus >= 500`, agrupe por `route` e por `errorClass`/`errorCode`; os outros quatro eventos pelo próprio nome (o `auth_*` e o `better_auth_internal_error` no `polaris-web`, o `catalog_read_failed` no Worker do catálogo). Uma só rota ou um só `errorCode` aponta para a causa; vários indicam dependência (banco, R2). Veja também `http_request_timed` com `outcome = "failure"` nas rotas críticas. Cruze com um deploy recente.

**O que fazer.** Mitigue primeiro: se começou com um deploy, desfaça-o (o responsável faz o deploy). Se o `sqlState` aparece, siga [erros-de-banco](#erros-de-banco). Se é uma rota de cobrança ou de mídia, siga o sinal dela. Registre a causa e abra a correção por PR.

<a id="latencia-p95"></a>

### latencia-p95 — latência p95 por rota crítica

**O que significa.** O p95 de `durationMs` (tempo de parede, não de CPU) de uma rota de `criticalRoutes` passou do limite dela, com pelo menos 20 requisições na janela. As rotas e os limites (provisórios) estão no registro: `/rpc/sale/confirm`, `/rpc/sync/push`, `/rpc/sync/pull`, `/rpc/sync/bootstrapPage`, `/api/auth/*` e `/api/products/:productId/media`. O evento é `http_request_timed`, só dessas rotas. Ele sai uma vez por requisição, inclusive as de `/api/auth/*` que a sessão faz sozinha; se o volume pesar na cota dos Workers Logs, a emissão passa a ser só de falha ou de requisição lenta ([ADR 0095](../adr/0095-onde-os-alertas-operacionais-vao-rodar.md)).

**Como confirmar.** Workers Logs: `event = "http_request_timed"`, agrupe por `route`, calcule o p95 de `durationMs` e compare com o limite. Os 4xx (`outcome = "rejected"`: origem recusada, limite de taxa, sessão ausente) ficam de fora do cálculo, porque respondem rápido e baixariam o p95; separe também por `method` (a lista de produtos e o envio de imagem dividem a rota). Nos Workers Traces (5% das requisições, [ADR 0094](../adr/0094-tracing-e-amostragem-do-workers-observability.md)) abra um trace lento da rota e veja onde o tempo foi (consulta ao banco, R2, Images). Para saber se a requisição lenta abriu um isolate novo, o evento traz `isolate.id` (aleatório, um por isolate) e `isolate.seq` (a ordem da invocação no isolate, de qualquer tipo: requisição, cron ou fila; 1 é a fria) e se liga ao `cpu_time_ms` da invocação pelo `requestId` (o `X-Request-Id`); `isolate.closedByUs` é o total acumulado no isolate das conexões que o próprio Worker fechou e cuja leitura pendente o driver rejeitou, sem log (os pools de uma requisição fecham depois do evento dela e entram no da seguinte) ([pool-errors.ts](../../packages/db/src/pool-errors.ts)).

**O que fazer.** Latência de banco em geral é compute do Neon acordando do repouso (primeira requisição depois de minutos parado, no plano Free): se só a primeira é lenta, não é regressão. Se é constante, procure consulta nova sem índice (plano da consulta, em ambiente descartável), lote grande no `sync.push` ou imagem pesada no upload. Se o limite for irreal para o tráfego, ajuste `criticalRoutes` no registro, com a medida no PR.

<a id="dlq"></a>

### dlq — DLQ crescendo

**O que significa.** Mensagens esgotaram as tentativas ou foram recusadas e foram para a fila de mensagens mortas ([filas](./queues.md), [ADR 0085](../adr/0085-dlq-incidente-operacional-e-retry-no-admin.md)). Eventos: `queue_dead_letter_recorded` (a DLQ gravou o incidente), `queue_dead_letter_not_recorded` e `queue_dead_letter_send_failed` (a DLQ não conseguiu gravar ou o envio a ela falhou; a mensagem é retentada) e `outbox_events_exhausted` (um evento do outbox passou do teto de tentativas). O `queue_message_failed` (o tratador falhou numa mensagem, com `permanent` e `eventId`) também conta: cada falha isolada não pede sinal próprio, porque a mensagem que esgota as tentativas vai à DLQ, e é o volume dos dois juntos que o limiar mede.

**Como confirmar.** Workers Logs: os cinco eventos, agrupados por `reason` e `queue`. No banco: `SELECT kind, cause, occurrence_count, first_seen_at, last_seen_at FROM operational_incidents ORDER BY last_seen_at DESC LIMIT 20` (uma linha por causa, sem corpo da mensagem). No Admin, a lista de incidentes mostra o mesmo e permite reenviar.

**O que fazer.** A causa diz o caminho: `retries_exhausted` (o handler falhou: ache o `queue_message_failed` do mesmo `eventId` e corrija, depois reenvie pelo Admin, com a regra do `Origin` do [runbook das filas](./queues.md)), `unknown_type` (o consumidor está mais velho que o produtor: faça o deploy do consumidor), `wrong_queue` (nome de fila com prefixo em vez de sufixo de ambiente), `invalid_envelope` (investigue quem escreveu na fila). Só reenvie depois de corrigir a causa; a retenção da fila é de 24 horas no Free.

<a id="outbox-parado"></a>

### outbox-parado — o despachante do outbox não conclui

**O que significa.** O job `outbox.dispatch` (cron horário `19 * * * *`, [agendador](./scheduled-jobs.md)) não terminou com sucesso em 3 horas (três ticks): os eventos do outbox (exportações, avisos) ficam `pending`. O sinal é a ausência de `scheduled_job_run` com `job = "outbox.dispatch"` e `outcome = "success"`. Não existe hoje um evento com a idade do evento pendente mais antigo (o banco não a expõe sem uma função nova); a consulta abaixo a dá à mão.

**Como confirmar.** Workers Logs: `event = "scheduled_job_run"` e `job = "outbox.dispatch"` nas últimas horas (veja o `outcome`), e `outbox_dispatch_not_configured` (o binding `OUTBOX_HYPERDRIVE` não existe) ou `scheduled_job_claim_failed` (login do outbox falhando). No banco: `SELECT count(*) AS pendentes, min(created_at) AS mais_antigo, min(available_at) AS proxima_tentativa FROM event_outbox WHERE status = 'pending'`; e `SELECT job_id, last_success_at, consecutive_failures, last_failure_at FROM scheduled_job_state WHERE job_id = 'outbox.dispatch'`. Um `mais_antigo` de horas com `proxima_tentativa` já passada confirma parada (um evento com `available_at` no futuro está só em recuo).

**Em produção, até o passo 7, ele dispara por desenho.** O `env.production` do web sai no primeiro deploy sem o `OUTBOX_HYPERDRIVE` ([produção](./production.md), primeiro deploy): o despachante só registra `outbox_dispatch_not_configured`, o job `outbox.dispatch` termina em `skipped`, nunca em `success`, e em 3 horas o sinal vira um `critical` falso. Não existe silêncio no mecanismo de alertas (este documento define só o sinal, a janela e o limite): **ignore o `outbox-parado` de produção até o passo 7 do [checklist das filas](./queues.md#checklist-de-go-live-do-despachante-responsável)** e não cadastre o alerta para produção antes dele (hoje o sinal só aparece no Workers Logs, porque o cron de alertas ainda não existe, [ADR 0095](../adr/0095-onde-os-alertas-operacionais-vao-rodar.md)). Se disparar antes, confirme que o log traz `outbox_dispatch_not_configured` e que o `env.production` ainda não tem o binding: é o esperado, não ligue o binding por causa do alerta (o passo 7 exige os passos 1 a 6, a medida de CPU inclusive). Se o log trouxer `scheduled_job_claim_failed`, ou o binding já estiver ligado, não é o caso esperado: siga o texto abaixo. Em staging o binding existe e o sinal vale desde já.

**O que fazer.** Cron fora do ar ou sem binding: veja o passo 7 do [checklist das filas](./queues.md). Login falhando (senha rotacionada, Hyperdrive fora, migration ausente): siga [agendador-falhando](#agendador-falhando). Para forçar uma execução depois de corrigir: [scheduled-jobs.md](./scheduled-jobs.md), "Forçar uma execução". Os eventos não se perdem (o outbox é transacional); o risco é o atraso do que depende deles.

<a id="outbox-falhando"></a>

### outbox-falhando — envio do outbox à fila falhando

**O que significa.** O despachante rodou, mas não conseguiu enviar um lote: `outbox_send_failed` (a fila recusou ou não está ligada; no Free, a cota de 10.000 operações por dia da conta pode ter acabado) ou `outbox_event_unsendable` (este deploy não sabe montar o envelope do evento: tipo ou versão desconhecidos). Os eventos ficam `pending` e voltam com recuo.

**Como confirmar.** Workers Logs: os dois eventos, por `queue` e `errorClass`/`errorCode`. Compare a hora com o início do dia UTC (a cota diária volta às 00:00 UTC).

**O que fazer.** Cota: espere a virada, ou reduza o consumo; subir de plano é decisão do responsável ([ADR 0076](../adr/0076-teto-de-custo-e-free-tier-primeiro.md)). Fila não criada ou mal nomeada: [filas](./queues.md). `unsendable`: o produtor é mais novo que o despachante; faça o deploy do consumidor e do despachante antes do produtor.

<a id="cobranca-reconcile"></a>

### cobranca-reconcile — falha de reconcile da cobrança

**O que significa.** A manutenção horária da cobrança (nova tentativa de eventos pendentes e varredura de assinaturas e concessões vencidas) falhou, ou um webhook do provedor não foi processado. Eventos: `billing_maintenance_incomplete` (o job termina em falha), `billing_sweep_failed`, `billing_event_retry_failed`, `billing_grant_sweep_failed` (um item falhou), `billing_webhook_processing_failed` (o provedor tentará de novo) e, da mesma manutenção, `billing_notice_handover_failed` (a passagem horária de avisos falhou), `billing_notice_record_failed` (um aviso não foi gravado na transação do fato), `billing_notice_sweep_failed` (a varredura de avisos falhou), `billing_trial_setup_sweep_failed` (a varredura de testes presos em `trial_setup` falhou), `billing_unclaimed_trial_settle_failed` (cancelar o teste sem dono falhou: a assinatura pode cobrar), `billing_unclaimed_trials_incomplete` (o mesmo, parcial) e `billing_refund_safety_net_incomplete` (a rede de reembolso saiu incompleta). O job `billing.provider_reconcile` (consulta ao Asaas e à Woovi) está desligado até o Gate 7; quando ligar, a falha dele aparece como `scheduled_job_run` com `outcome = "failure"` e deve entrar neste sinal, junto com `billing_woovi_reconcile_failed` e `billing_woovi_reconcile_incomplete`, que hoje ficam fora do sinal e do monitor do staging porque falham de hora em hora até a Woovi voltar.
A rede de reembolso da manutenção grava outros eventos: `billing_refund_renewal_rearmed`, `billing_refund_rearm_failed`, `billing_refund_rearm_exhausted`, `billing_refund_pending_incident` e `billing_refund_pending_incident_failed`. Este sinal não os conta (só o `billing_refund_safety_net_incomplete`, acima): a parada da rede, o incidente aberto e a falha ao gravar o incidente têm sinal próprio ([rede-de-reembolso-parada](#rede-de-reembolso-parada), [incidente-de-reembolso-aberto](#incidente-de-reembolso-aberto) e [incidente-de-reembolso-nao-gravado](#incidente-de-reembolso-nao-gravado)); os outros o operador olha pelo significado e pela ação em [reembolso pendente e rede de segurança do reembolso](./billing-providers.md#reembolso-pendente).

**Como confirmar.** Workers Logs: os doze eventos, por `errorClass`/`errorCode`, `provider` e `sqlState`; veja também o `scheduled_job_run` de `billing.maintenance`. Uma só falha é retentada no tick seguinte; três em três horas é falha persistente (é o limiar).

**O que fazer.** Com `sqlState` ou erro de conexão, siga [erros-de-banco](#erros-de-banco). Com erro de provedor, confira o painel de homologação ou produção do provedor (o responsável) e a assinatura do webhook. Não reprocesse pagamento à mão sem registrar: o efeito é de dinheiro e de acesso (use os comandos de cobrança do Admin). Nunca cole segredo do provedor em log ou chat.

<a id="cobranca-provedor-nao-confirmou"></a>

### cobranca-provedor-nao-confirmou — o provedor não confirmou o checkout ou o cancelamento antigo

**O que significa.** O checkout de um dono foi recusado com 503 porque o Asaas ou a Woovi não respondeu ao que o Polaris precisa saber antes de abrir outro: se o checkout anterior foi pago (`previous_checkout_unverified`) ou se a renovação anterior foi cancelada (`previous_renewal_cancel_unverified`). Evento: `billing_unavailable_refused` (nível `warn`), um por 503 que vem de erro do provedor ou da checagem do checkout anterior (o 503 de `billing_not_configured` e o de `billing_audit_unavailable` não entram), com `reason` (o motivo que o cliente lê, de um conjunto fechado) e `errorCode` (o código do erro do Polaris), sem dado do provedor, id de loja nem dado pessoal. O limiar (3 em 180 min) é o do sinal vizinho mais parecido, [cobranca-reconcile](#cobranca-reconcile), mas só vai ao resumo diário: o 503 é o cliente tentando de novo, e o `http-5xx` já acorda no volume. O mesmo evento carrega também `billing_provider_unavailable` (provedor fora, não configurado ou resposta recusada), que o filtro deixa de fora: tire o filtro para ver todos.

**Como confirmar.** Workers Logs: `event = "billing_unavailable_refused"`, agrupe por `reason` e `errorCode`. Um pico de um dos dois motivos com o `http-5xx` quieto é o provedor lento ou fora só na consulta que o motivo nomeia; compare com o painel de status do provedor e com `billing_provider_*` do [runbook de provedores](./billing-providers.md).

**O que fazer.** Confira o provedor (o responsável vê o painel). Não libere checkout nem cancele renovação à mão sem confirmar no provedor: o efeito é cobrança em dobro. Quando o provedor voltar, o dono tenta de novo sozinho; se a loja insistir por horas, siga [cobranca-reconcile](#cobranca-reconcile) e o [runbook dos provedores](./billing-providers.md).

<a id="pix-cadastros-por-loja"></a>

### pix-cadastros-por-loja — muitos documentos novos no Pix (olhar por loja)

**O que significa.** O evento `billing_payer_customer_created` (nível info, só `organizationId` opaco e `provider`) sai a cada documento novo que um checkout Pix cadastra na Woovi. Uma loja que cadastra muitos documentos distintos em pouco tempo pode estar pré-cadastrando CPFs de terceiros com nome e e-mail seus, o que trava o Pix dessas pessoas até o suporte corrigir (ADR 0101, emenda do PR 6). Sem limite de taxa próprio do checkout (condição do Gate 7), este é o único sinal.

**Como confirmar.** Workers Logs: `event = "billing_payer_customer_created"`, agrupe por `organizationId`. **O sinal é global** (o registro não agrupa por loja: conta os eventos da plataforma, 5 em 60 min, e aparece só no resumo diário); o corte por loja é à mão, nesta consulta. O que importa é uma só loja: **3 ou mais numa hora, ou 10 ou mais em 24 horas, de uma mesma `organizationId`**, é padrão suspeito (uma loja legítima tem um pagador, raramente dois). Veja também `billing_pix_checkout_refused` da mesma loja. O evento não guarda documento, nome nem e-mail. **Limite conhecido:** o evento sai depois de o cliente e a assinatura serem ligados; um cliente criado na Woovi e seguido de falha antes disso não gera o evento (o `billing_pix_checkout_refused` e os erros do checkout cobrem esse caso em parte).

**O que fazer.** Avise o responsável com o `organizationId`; a decisão de bloquear a loja ou de limitar o Pix é dele (Admin, sem entrar no tenant). Não procure o documento: o Polaris não o guarda. Quem pedir correção de um cliente da Woovi passa pela confirmação do titular do documento do [runbook de provedores](./billing-providers.md).

<a id="erros-de-banco"></a>

### erros-de-banco — erros de banco

**O que significa.** O banco recusou ou não respondeu: `server_error` com `sqlState` (o SQLSTATE do erro, achado na cadeia de causas, por exemplo `08006` conexão, `40001` serialização, `53300` conexões demais, `57P01` desligamento), `scheduler_state_unavailable` (o estado do agendador não abriu) , `queue_ledger_unavailable` (o consumidor de fila não alcançou o registro de processamento) e `legal_acceptance_unavailable` (a leitura do aceite dos termos falhou; a requisição é recusada em vez de passar, e o log traz só `errorClass`, sem `sqlState`). Não conta erro de regra de negócio traduzido para 4xx. **Lacuna:** um erro de banco sem SQLSTATE (conexão derrubada ou timeout do driver, como `ECONNRESET`) não tem `sqlState`; ele só aparece em [http-5xx](#http-5xx), com o `errorCode` do driver.

**Como confirmar.** Workers Logs: `server_error` com `sqlState` existente, agrupado por `sqlState` e `route`; o `errorCode` de `08*` e `53*` é infraestrutura, `23*` (violação de restrição) e `42*` (permissão ou SQL) são bugs de código ou de migration. No console do Neon: se o compute está ativo, o uso do mês (60% de armazenamento ou 70% de computação é o gatilho do ADR 0076) e incidentes do provedor.

**O que fazer.** Infraestrutura (`08*`, `53*`, `57*`): confirme o Neon e o Hyperdrive (binding, query caching desligado); no Free, o compute acorda sozinho e a primeira consulta pode falhar uma vez. `42501` (permissão negada): provável papel sem a concessão de uma migration recém-aplicada, ou migration não aplicada antes do Worker; aplique antes de qualquer deploy. `23*`: bug; abra a correção. Se o limite do plano foi atingido, a decisão é do responsável.

<a id="agendador-falhando"></a>

### agendador-falhando — jobs agendados falhando

**O que significa.** Os crons rodam, mas o job falha: `scheduled_job_claim_failed` (não conseguiu tomar o *lease*: login do outbox, Hyperdrive ou migration do agendador), `scheduled_job_record_failed` (rodou mas não gravou o resultado), `scheduled_job_handler_missing` (job habilitado sem handler neste deploy) e `scheduled_job_run` com `outcome = "failure"`. É o alerta que o [runbook das filas](./queues.md) pede antes de ligar o `OUTBOX_HYPERDRIVE`.

**Como confirmar.** Workers Logs: os quatro por `job`, `lane` e `errorClass`/`errorCode`. No banco: `SELECT job_id, covered_at, last_success_at, consecutive_failures, last_failure_at FROM scheduled_job_state ORDER BY job_id`; `consecutive_failures` crescente é um job que falha a cada tick.

**O que fazer.** `claim_failed`: para tudo o que depende do agendador (encerramento de organização, expiração de exportação, varredura de cobrança), então trate como urgente: confira o login, o Hyperdrive e as migrations (passos 1 a 3 do checklist das filas). Falha de um job só: veja o `errorClass`, corrija e force a execução ([scheduled-jobs.md](./scheduled-jobs.md)). Se a parada for longa, retirar o binding `OUTBOX_HYPERDRIVE` devolve o comportamento anterior.

<a id="r2-e-midia"></a>

### r2-e-midia — falha do R2 ou da mídia

**O que significa.** A limpeza de imagens removidas falhou ou o catálogo público não leu um arquivo do R2: `media_removed_asset_failed` (apagar objetos ou finalizar o ativo), `media_removed_asset_not_finalized` (o ativo ganhou vínculo depois de seus objetos serem apagados; **uma imagem pode ter perdido arquivos**), `media_removed_reconciliation_incomplete` (a execução terminou com falhas) e, no Worker do catálogo, `catalog_media_authorization_failed` (a consulta que autoriza a imagem falhou, por exemplo com o banco do catálogo fora: a imagem responde 503), `catalog_media_object_missing` (a imagem está autorizada mas o objeto não está no R2: 404) e `catalog_media_read_failed` (leitura de objeto no catálogo: 503). Os três são de nível `error` e aqui só vão ao resumo diário: a falha de autorização do catálogo não acorda ninguém, ao contrário do `catalog_read_failed` das páginas, em [http-5xx](#http-5xx). Falhas de rota de mídia do app aparecem como `server_error` nas rotas `/api/products/:productId/media`, `/api/media/thumbs` e `/api/media/:assetId`, e entram no sinal [http-5xx](#http-5xx).

O lote de miniaturas (`/api/media/thumbs`) lê com um `get` por id e responde inteiro: uma falha do R2 dá 503 `media_processing_unavailable` e entra no sinal acima; um derivado que sumiu entre a consulta e a leitura volta como `missing`, sem evento.

**Como confirmar.** Workers Logs: os seis eventos do alerta por `errorClass`/`errorCode` (o `catalog_media_object_missing` não traz nenhum dos dois); confira o status do R2 e do binding `MEDIA_BUCKET` no console. O procedimento de reconciliação está em [media-storage-reconciliation.md](./media-storage-reconciliation.md).

**O que fazer.** `not_finalized` é prioridade: o ativo e o produto afetados precisam de conferência (o evento traz o `assetId` do ativo, id opaco). Falha repetida de um ativo: ele sai do resto da execução e volta na seguinte; corrija a causa (chave inválida, permissão do binding) e espere o tick. R2 fora do ar: aguarde; as imagens servidas dependem dele, e os derivados de 320 e 640 px vêm do mesmo bucket.

<a id="cota-de-transformacao"></a>

### cota-de-transformacao — cota de transformações do Images esgotada (9422)

**O que significa.** O Cloudflare Images recusou uma transformação com o código **9422** (a cota gratuita de transformações únicas do mês acabou, [ADR 0018](../adr/0018-midia-privada-cloudflare-images-r2.md), emenda). O produto degrada com segurança: serve o original ou adia o derivado, sem cobrar. Evento: `media_transform_quota_exceeded` (`operation`: `media.delivery`, `media.derivative` ou `media.upload`; `outcome`: `partial` quando serviu o original, `rejected` quando recusou o envio; `errorCode = "9422"`). Os avisos de entrega são limitados a um por minuto e trazem `suppressed` com o que foi omitido; `media_derivative_deferred` registra o derivado adiado.

**Como confirmar.** Workers Logs: `event = "media_transform_quota_exceeded"`, por `operation` e `outcome`. No painel do Cloudflare Images, o uso do mês (o gatilho de revisão do ADR 0076 é 50% das 5.000 transformações únicas).

**O que fazer.** Nada de cobrança: o teto de US$ 10 não permite subir de plano sem decisão do responsável. Escolha: esperar a virada do mês (telas com imagens originais, mais pesadas), reduzir variantes, ou o responsável decidir pagar. Envios de imagem recusados (`rejected`) mantêm o arquivo na fila do aparelho para nova tentativa.

<a id="rejeicao-no-sync"></a>

### rejeicao-no-sync — pico de rejeição no sync offline

**O que significa.** O servidor está recusando comandos que aparelhos enviaram do modo offline ([ADR 0003](../adr/0003-offline-command-protocol.md)). Evento: `sync_push_command_rejected` (nível `warn`, `outcome = "rejected"`), um por comando recusado (um lote para no primeiro), com o código estável em `reason`, sem payload nem ids de aparelho ou organização. A repetição de uma rejeição **já gravada** (`replayed`) não é contada de novo; um código que o servidor não grava (como `session_changed`) conta cada reenvio, então um único aparelho que insiste pode somar sozinho o limiar: confira o `requestId` e a distribuição no tempo antes de concluir que é geral. Os códigos que o sinal filtra no registro: `session_changed` (a sessão no envio não é a do lease: troca de usuário no aparelho), `lease_invalid` (lease com assinatura inválida: chave rotacionada ou adulteração) e `authorization_revoked` (o papel perdeu a capacidade depois do lease). Os outros códigos (`capability_not_in_lease`, `unsupported_command_type`, `invalid_payload`, `entitlement_changed`, `command_too_old`, `command_id_reused`, `invalid_creation_time`, `wrong_device`) saem no mesmo evento: agrupe por `reason` sem o filtro para ver todos.

**Como confirmar.** Workers Logs: `event = "sync_push_command_rejected"`, agrupado por `reason`. Um código dominante diz a causa: `lease_invalid` em massa depois de um deploy costuma ser rotação da chave do lease sem manter a anterior; `authorization_revoked` em massa, uma mudança de papel ou de plano; `session_changed`, aparelhos compartilhados. Poucos casos esparsos são uso normal (trabalho rejeitado é preservado no aparelho para correção).

**O que fazer.** Chave de lease: confira os segredos do Worker (nunca os imprima) e o último deploy; reverta se foi ele. Papel ou plano: confirme a mudança e avise quem usa o aparelho. O trabalho recusado fica no aparelho, e a pessoa corrige na tela de pendências; não apague comandos no servidor.

<a id="registro-de-acesso"></a>

### registro-de-acesso — falha ao gravar o registro de acesso

**O que significa.** O registro de acesso à aplicação exigido pelo Marco Civil (login, [ADR 0092](../adr/0092-registro-de-acesso-a-aplicacao.md)) não foi gravado. O evento é `auth_access_log_write_failed` (nível `error`), com `accessEvent`, `reason`, `errorClass`, `sqlState` (quando é do banco) e `requestId`. É obrigação legal: a gravação tem um tempo-limite curto e o login segue sem o registro, então a falha é silenciosa para a pessoa.

**Como confirmar.** Workers Logs: o evento, por `reason` e `sqlState`. Leitura do `reason` (detalhe no [runbook do registro de acesso](./registro-de-acesso.md)): `error` é falha do banco (confira o `sqlState`; `42501` é privilégio revogado, trate como incidente); `timeout` é o banco que não respondeu em cerca de 300 ms (lento ou acordando; a linha pode ter entrado depois); `writer_threw` (o gravador lançou exceção), `unexpected_result` (resposta que o código não conhece), `invalid_event`, `invalid_user`, `invalid_ip` e `invalid_request` são defeito de código. A requisição sem IP é outro evento, `auth_access_log_skipped`, descrito no mesmo runbook.

**O que fazer.** Siga [erros-de-banco](#erros-de-banco) se o banco está com problema; depois registre a janela da lacuna (início e fim, quantidade de eventos) conforme o runbook do registro de acesso, porque o período sem registro precisa ser conhecido. Não tente refazer o registro à mão; a correção de um defeito de código é um commit, não uma alteração na tabela.

<a id="aceite-no-cadastro"></a>

### aceite-no-cadastro — aceite dos termos não gravado no cadastro

**O que significa.** A conta foi criada pelo cadastro com e-mail, mas a gravação do aceite dos Termos de Uso e da Política de Privacidade falhou ([ADR 0100](../adr/0100-tela-de-entrada-senha-atras-de-flag-bloqueio-e-aceite-legal.md)). O evento é `legal_acceptance_signup_record_failed` (nível `error`), com `errorClass`, `sqlState` (quando é do banco) e `requestId`; nunca o usuário nem o e-mail. O cadastro não falha: a pessoa entra normalmente.

**Como confirmar.** Workers Logs: o evento, por `sqlState` e `errorClass`. `42501` é privilégio revogado nas funções de aceite (trate como incidente de banco); `57014` ou timeout é banco lento; sem `sqlState`, com `LegalAcceptanceRecordError`, a função recusou a linha (defeito de código).

**O que fazer.** Com a flag `LEGAL_ACCEPTANCE_ENFORCED` ligada, nada se perde: o controle pede o aceite no primeiro acesso autenticado da pessoa. Com a flag desligada, a pessoa fica sem prova de aceite até a flag ligar, então corrija a causa (siga [erros-de-banco](#erros-de-banco) se for do banco) antes de ligar a flag. Não grave o aceite à mão: a pessoa o dá na tela `/aceite`.

<a id="link-de-verificacao"></a>

### link-de-verificacao — cadastro sem e-mail de verificação

**O que significa.** Antes de cada e-mail de verificação o Worker grava em `user.verification_link_expires_at` o fim do link ([ADR 0100](../adr/0100-tela-de-entrada-senha-atras-de-flag-bloqueio-e-aceite-legal.md), [e-mail de autenticação](./email-auth.md#ordem-de-implantação-da-gravação-do-link-e-alerta-antes-da-flag-da-senha)). Se a gravação falha, o e-mail não sai, a tela responde como sempre e o Worker registra `auth_verification_link_record_failed` (nível `error`, só `errorClass` e `sqlState`, nunca o e-mail nem o ID). Cada evento é um cadastro que não recebe o e-mail e não consegue confirmar, e a causa costuma atingir todos os cadastros (migration atrasada, privilégio revogado); por isso um evento em 24 horas já dispara, como no `aceite-no-cadastro`. O reenvio fora do teto de 72 horas não é falha e não gera o evento.

**Como confirmar.** Workers Logs: o evento, por `sqlState` e `errorClass`. `42703` é a coluna que não existe: o Worker subiu antes da migration 0094, aplique-a no banco do ambiente. `42501` é privilégio revogado (incidente de banco). `57014` ou timeout é banco lento: siga [erros-de-banco](#erros-de-banco).

**O que fazer.** Corrija a causa; quem não recebeu o e-mail pede o reenvio na tela (o teto é de 72 horas de `created_at`). Não grave a data à mão.

<a id="apagamento-automatico"></a>

### apagamento-automatico — muitas lojas encerradas entrando no apagamento automático

**O que significa.** Com `CLOSURE_AUTO_PURGE_ENABLED` ligado, a varredura horária de privacidade agenda sozinha o purge de cada loja encerrada que chegou a D menos 7 dias ([ADR 0102](../adr/0102-apagamento-automatico-da-loja-encerrada.md)). O evento `closure_auto_purge_volume_high` (nível `warn`) sai quando, nas últimas 24 horas (janela móvel, não o dia do calendário), **mais de 5** lojas entraram no purge por esse caminho (campo `scheduledPurgesLastDay`, só a contagem, sem ID). O aviso vem depois do agendamento, não antes: o freio real são os 7 dias até a execução e o cancelamento pelo Admin. A função não tem teto diário próprio, e quem tem a conexão do papel de privacidade a executa com a chave desligada: a chave só controla o Worker. É o freio do apagamento automático: um volume acima do esperado pode ser um defeito de datas (fuso, relógio, migration) que apagaria lojas antes da hora. Nenhum dado sai no agendamento: o purge só roda a partir do maior entre D mais 48 horas e o agendamento mais 7 dias.

**Como confirmar.** Workers Logs: `event = "closure_auto_purge_volume_high"` e o `privacy_maintenance_complete` da mesma execução (`scheduledPurges`, `scheduledPurgesLastDay`). Banco, só leitura, seguindo a [política de perfis de CLI](./cli-profile-policy.md): `SELECT organization_id, scheduled_at, not_before FROM organization_purges WHERE trigger = 'closure_period' AND scheduled_at > now() - interval '24 hours'`, e para cada uma confira `organization_closures.requested_at` e o fuso da organização (`closure_deadlines`): o agendamento só é legítimo a partir de D menos 7 dias locais.

**Antes de ligar a chave.** `CLOSURE_AUTO_PURGE_ENABLED` só liga em produção com `CLOSURE_NOTICE_EMAIL_ENABLED` ligado e os avisos sendo entregues, e com o ato de suporte disponível no Admin (reemitir ou dispensar um aviso, capacidade `organization:purge`, [runbook dos avisos](./avisos-de-encerramento.md#ato-de-suporte)). Sem o aviso de D menos 7 dias entregue há pelo menos 7 dias nenhuma loja é agendada sozinha nem apagada (`closure_notice_not_delivered`), e as lojas esperam no alerta de [loja-encerrada-parada](#loja-encerrada-parada).

**Quem recebe.** O sinal é `critical` com `notify = wake`: quando o cron de alertas existir (Fase 14, [ADR 0095](../adr/0095-onde-os-alertas-operacionais-vao-rodar.md)), vai um e-mail imediato ao endereço de alertas que o responsável cadastrar, no máximo um a cada 6 horas, só com o nome do sinal, a contagem e a janela. Quem age é um operador do Admin com a capability `organization:purge`, porque o cancelamento exige caso e motivo; o deploy que desliga a chave é do responsável. **Até o cron existir, ninguém é acordado:** o evento fica só no Workers Logs. Enquanto isso, quem liga a chave em um ambiente confere o `privacy_maintenance_complete` de cada hora nos primeiros dias.

**No staging.** `CLOSURE_AUTO_PURGE_ENABLED` está `"true"` no `env.staging` desde 17/11/2026 (a produção segue `"false"`), e as lojas sintéticas encerradas seguem o ciclo e são apagadas de verdade 90 dias depois. O alerta foi criado na Cloudflare pelo Arrascaeta em 17/11/2026, agrupado com o de `loja-encerrada-parada` na política 2 (`closure_auto_purge_volume_high` ou `closure_purge_overdue`, `custom_analytics`, limiar de 1 ou mais evento em 1 minuto, e-mail ao dono). O monitor da Cloudflare avalia a cada 1 minuto, não na janela de 24 horas do sinal; a janela de 24 horas é a do registro e a da contagem do `scheduledPurgesLastDay`. O e-mail é o que acorda, e a confirmação é a deste runbook. A prova da fiação com datas retroagidas é o [roteiro do operador](./prova-do-apagamento-automatico.md).

**O que fazer.** Se as datas estão certas (um lote real de encerramentos de 90 dias atrás), registre e siga. Se não estão, cancele em lote:

1. **Pare os agendamentos novos.** O responsável põe `CLOSURE_AUTO_PURGE_ENABLED` = `false` e faz o deploy. Os purges já agendados continuam valendo até serem cancelados.
2. **Liste o que ainda pode ser cancelado.** É só leitura, seguindo a [política de perfis de CLI](./cli-profile-policy.md): `SELECT organization_id, scheduled_at, not_before, locked_until FROM organization_purges WHERE trigger = 'closure_period' AND purged_at IS NULL AND storage_touched_at IS NULL ORDER BY not_before`. Um purge com `storage_touched_at` preenchido já começou a apagar o armazenamento e não pode mais ser cancelado. Registre esses no incidente.
3. **Cancele um por um, pelo menor `not_before`.** Para cada organização da lista, o operador abre no Admin um caso de suporte da organização e cancela o purge com motivo (`POST /support-cases/:caseId/purge/cancel`, função `admin_cancel_organization_purge`). Toda escrita no Admin manda `Origin: https://<host do Admin>`; sem ela, 403 ([ADR 0070](../adr/0070-admin-acesso-identidade-e-capacidades.md), emenda de 28/10). O cancelamento devolve a loja a `closed`, fica na auditoria e pausa o caminho automático dela neste encerramento. O primeiro `not_before` de um agendamento é, no mínimo, 7 dias depois dele. Um cancelamento recusado com `purge_in_progress` quer dizer que uma execução segura o purge agora: tente de novo depois de `locked_until` (até 15 minutos).
4. **Se não der tempo de cancelar todos antes do `not_before`,** o último recurso é o responsável retirar o binding `PRIVACY_HYPERDRIVE` do Worker e fazer o deploy. Isso para o job inteiro de privacidade: nenhum purge, encerramento, aviso ou exportação roda, e nada é apagado. As exportações pedidas nesse intervalo esperam a volta do binding, quando o reenvio horário as manda de novo. Depois, termine os cancelamentos e devolva o binding.
5. **Depois.** Cada loja cancelada é uma decisão: pôr a trava legal, agendar de novo pelo Admin sob o caso de exclusão (toda escrita no Admin manda `Origin`, como no passo 3) ou deixá-la esperar a correção. O dono continua recebendo os avisos pelas datas (o de D diz "a partir de", que segue verdadeiro). Abra a correção por PR antes de religar a chave.

<a id="loja-encerrada-parada"></a>

### loja-encerrada-parada — loja encerrada parada: sem apagamento, purge preso ou aviso sem entregar

**O que significa.** O evento `closure_purge_overdue` (nível `warn`) traz três contagens, `overduePurges`, `purgesHeldBack` e `closureNoticesOverdue` ([ADR 0102](../adr/0102-apagamento-automatico-da-loja-encerrada.md)), e sai quando uma delas passa de zero.

- `overduePurges` (só com `CLOSURE_AUTO_PURGE_ENABLED` ligado, porque com a chave desligada nenhuma loja seria apagada sozinha): as lojas que continuam `closed` 30 dias depois de D sem trava legal vigente. O apagamento prometido ao lojista não aconteceu por um destes motivos: um cancelamento do Admin neste encerramento (que pausa o caminho automático até alguém decidir), a renovação da assinatura ainda viva num provedor (o cancelamento do encerramento falhou, ou o provedor não tem a porta de saída e a pessoa não cancelou), um acesso temporário do Admin esquecido, ou o aviso de D menos 7 dias que não foi entregue, ou foi entregue há menos de 7 dias (`closure_notice_not_delivered`, por exemplo enquanto o e-mail não está configurado). Sem o aviso entregue, ninguém é apagado: a loja espera até o suporte resolver.
- `purgesHeldBack` (com a chave ligada ou desligada, porque o purge do Admin espera do mesmo jeito): os purges já agendados (`purge_pending`, do período ou do Admin) com o `not_before` vencido que a reconferência na execução segura por um acesso temporário do Admin vigente, uma renovação viva ou o aviso não entregue. A trava legal não conta: ela responde antes, e a decisão é do caso.
- `closureNoticesOverdue` (com a chave ligada ou desligada): os avisos de uma loja ainda em encerramento que seguem **não resolvidos** (nem enviados, nem falhos, nem pulados) há mais de **3 dias** (`CLOSURE_NOTICE_OVERDUE_DAYS`) depois da data do marco. O caso comum é o e-mail não configurado: o consumidor deixa o aviso como está para o envio poder acontecer depois.

**Fora da contagem.** O purge segurado pela trava legal (ela responde antes das outras razões, e a decisão sobre ela é do caso) e a loja `closed` sob trava legal. Um aviso pulado, enviado ou falho com código definitivo (um endereço recusado) não é "não resolvido": o falho segura o apagamento do mesmo jeito, porque não é um aviso entregue, e cai em `overduePurges` ou em `purgesHeldBack`. **Há ato de suporte para o aviso pulado ou falho:** o operador o reemite (um aviso novo do mesmo ciclo, para o dono atual) ou o dispensa com motivo (`owner_account_deleted`, `email_not_verified` ou `email_undeliverable`), a reemissão sob um caso de privacidade aberto da organização, a dispensa sob o caso de exclusão do dono aceito e com o motivo que bate com os fatos. As duas ações são rotas do Admin com a capacidade `organization:purge`, com as condições do [runbook dos avisos](./avisos-de-encerramento.md#ato-de-suporte). Nenhum ato edita um aviso: cada um grava uma linha nova. Dispensar conta como entrega, e o purge ainda espera 7 dias depois dela ([ADR 0102](../adr/0102-apagamento-automatico-da-loja-encerrada.md), emenda do PR E).

**Como confirmar.** Banco, só leitura, seguindo a [política de perfis de CLI](./cli-profile-policy.md): as organizações `closed` cujo `closure_deadlines(requested_at, timezone).deletable_from` mais 30 dias já passou e sem linha em `organization_legal_holds` com `released_at` nulo; para cada uma, veja `organization_purge_cancellations` (depois do `requested_at`), `organization_billing` (provedor, estado e `cancel_at_period_end`) e `tenant_access_grants` vigentes, e os `closure_notices` do ciclo atual (`closure_requested_at = organization_closures.requested_at`): sem um `d7` ou `rescheduled` com `sent_at` ou `dismissed_at` preenchido há 7 dias a loja espera. Para um purge já agendado (`purgesHeldBack`): `SELECT organization_id, trigger, not_before FROM organization_purges WHERE purged_at IS NULL AND not_before < now()`, e para cada um veja a trava legal, os acessos vigentes, a cobrança e esses avisos. Para os avisos parados: `SELECT organization_id, milestone, due_at FROM closure_notices WHERE NOT skipped AND sent_at IS NULL AND failed_at IS NULL AND dismissed_at IS NULL AND due_at < now() - interval '3 days'`.

**O que fazer.** Cada loja é uma decisão: pôr a trava legal (se há motivo para guardar), agendar o purge pelo Admin sob o caso de exclusão (toda escrita no Admin manda `Origin: https://<host do Admin>`; sem ela, 403, [ADR 0070](../adr/0070-admin-acesso-identidade-e-capacidades.md)), revogar o acesso temporário esquecido ou resolver a renovação no provedor (siga [cobranca-reconcile](#cobranca-reconcile) e o [runbook dos provedores](./billing-providers.md)) ou, se o aviso não foi entregue, corrigir o envio (o e-mail não configurado, um endereço recusado) para o aviso sair; não se grava `sent_at` à mão. Registre a decisão no caso.

**Com o e-mail desligado, nenhum purge sai**, nem o do Admin por caso de privacidade: nenhum aviso fica entregue, então o caso pode agendar o purge e a execução espera. Com o e-mail ligado, os avisos saem, e o repasse horário envia o mais recente de cada ciclo devido. O ato de suporte resolve o que sobra (aviso pulado, falho ou de dono sem conta). O prazo de resposta do caso (`PRIVACY_CASE_RESPONSE_DAYS`, 15 dias, provisório) segue valendo: responda ao titular dentro dele, dizendo que a exclusão está aceita e só ocorre depois do aviso, e registre o motivo da espera no caso.

**No staging.** Com a chave ligada lá desde 17/11/2026, o `closure_purge_overdue` conta lojas sintéticas encerradas e é lido como acima. O alerta foi criado na Cloudflare pelo Arrascaeta em 17/11/2026, agrupado com o de `apagamento-automatico` na política 2 (`custom_analytics`, limiar de 1 ou mais evento em 1 minuto, e-mail ao dono; o monitor da Cloudflare avalia a cada 1 minuto, não na janela de 24 horas do sinal), não só o resumo diário: um e-mail dele é uma loja parada a decidir, não um incidente. O roteiro com datas retroagidas, [prova do apagamento automático](./prova-do-apagamento-automatico.md), faz esse sinal ficar ausente quando tudo corre bem.

<a id="purge-parado"></a>

### purge-parado — purge de loja encerrada que não avança

**O que significa.** O job do purge ([ADR 0081](../adr/0081-purge-completo-da-organizacao-encerrada.md)) tentou o mesmo purge pela 3ª vez ou mais e o passo falhou de novo, por um erro que o banco não nomeia como espera de propósito. O evento é `organization_purge_stalled` (nível `error`), com `organizationId` opaco, `attempt`, `phase` (`purge` ou `sweep`), `operation` (`organization_purge.<passo>`: `mark_storage`, `exports_storage`, `media_storage`, `database` ou `second_sweep`) e `reason` (o código gravado em `organization_purges.last_error_code`, como `purge_media_storage_failed`). Sai junto do `organization_purge_step_failed` da mesma tentativa, que não conta neste sinal (a 1ª e a 2ª falha de um passo ficam de fora, e a 3ª em diante já traz o `organization_purge_stalled`: contar os dois dobraria o aviso). Conta com ele o `organization_purge_failure_not_recorded` (a gravação da falha do passo falhou também: o purge fica preso até a concessão vencer, sem o `last_error_code`). Cada hora em que o purge falha de novo traz outro evento. **Sem log:** o mesmo evento também sai com `source = "no_log"` (nível `warn`) e `stalledPurges` (só a contagem, sem `organizationId`, `attempt`, `phase` nem `reason`), uma vez por varredura horária de privacidade, quando há purge com 3 tentativas ou mais, ainda não terminado, tomado pelo job nas últimas 24 horas e sem passo registrado nesse prazo (`storage_touched_at` ou `purged_at`). É o caso da execução que o Worker mata antes de logar.

**Fora do sinal.** Um purge segurado de propósito (`legal_hold_active`, `closure_period_not_elapsed`, `closure_notice_not_delivered`, `renewal_alive`, `tenant_access_active`) sai como `organization_purge_step_failed` com `outcome = "rejected"` (nível `warn`) e o sinal não lê esse evento: ele aparece em [loja-encerrada-parada](#loja-encerrada-parada) (`purgesHeldBack`) e na trava legal pendente de revisão (`GET /legal-holds`). **Limite:** a contagem sem log só enxerga o purge que o job ainda toma (`locked_until` nas últimas 24 horas) e usa `storage_touched_at` e `purged_at` como passos concluídos: um purge que avançou há menos de 24 horas e morreu de novo só entra no dia seguinte. A consulta abaixo continua sendo como achar qual é a loja.

**Como confirmar.** Workers Logs: `event = "organization_purge_stalled"`, agrupado por `operation` e `reason` (o de `source = "no_log"` não traz os dois: ache a loja pela consulta abaixo); o `organization_purge_step_failed` da mesma `organizationId` mostra a sequência. Banco, só leitura, seguindo a [política de perfis de CLI](./cli-profile-policy.md): `SELECT organization_id, attempts, last_error_code, storage_touched_at, locked_until FROM organization_purges WHERE purged_at IS NULL AND attempts >= 3 ORDER BY attempts DESC`. Com `storage_touched_at` preenchido o armazenamento já perdeu objetos e o cancelamento é recusado para sempre: o purge precisa terminar.

**O que fazer.** O passo diz onde olhar: `exports_storage` e `media_storage` (R2 fora do ar, cota ou chave de mídia fora do prefixo da organização: veja [r2-e-midia](#r2-e-midia)), `database` (a transação do purge falhou; o log do job não traz a mensagem do erro, então ache a causa em [erros-de-banco](#erros-de-banco), pelo horário da tentativa) e `second_sweep` (objetos que apareceram depois). O purge é reexecutável de ponta a ponta: corrigida a causa, o cron horário o pega de novo, sem ato manual, depois que o `locked_until` passa (até 15 minutos). Se a causa não é de infraestrutura, não force o purge: abra a correção por PR e deixe o caso de exclusão do dono com a nota do atraso.

<a id="aviso-de-encerramento-falhando"></a>

### aviso-de-encerramento-falhando — falha no envio do e-mail de aviso do encerramento

**O que significa.** O consumidor do aviso de encerramento tentou enviar o e-mail, e o provedor (Resend) recusou ou não respondeu. O evento é `closure_notice_email_failed` (nível `error`), com `outcome`: `rejected` quando o provedor recusou a mensagem de forma definitiva (400 ou 422 com o nome de erro `validation_error` sobre o campo `to`, o endereço; o aviso fica falho com o código `email_rejected`, sem nova tentativa), e `failure` em todo o resto (401, 403, 409, 429, 5xx, um `validation_error` sobre outro campo, um 422 com outro nome, como `invalid_from_address`, ou falha de rede; a fila tenta de novo, e o aviso segue devido). Traz `httpStatus` quando houve resposta, `errorCode` (o nome de erro do provedor, só quando é um código curto), `milestone` e `noticeId` (id opaco). Nunca traz endereço nem nome.

**Como confirmar.** Workers Logs: `event = "closure_notice_email_failed"`, agrupado por `outcome`, `httpStatus` e `milestone`. Muitos `failure` com 401 ou 403, ou com `errorCode = "invalid_from_address"`, apontam para a chave ou o remetente (`AUTH_EMAIL_FROM`, domínio verificado no provedor); 5xx ou 429, para o provedor. Banco, só leitura, seguindo a [política de perfis de CLI](./cli-profile-policy.md): `SELECT organization_id, milestone, due_at, failed_at FROM closure_notices WHERE failure_code = 'email_rejected' AND failed_at > now() - interval '24 hours'`.

**O que fazer.** `outcome = "failure"`: o problema é do provedor ou da configuração. Confira o estado do Resend, o segredo `RESEND_API_KEY` e o remetente `AUTH_EMAIL_FROM` do Worker (sem imprimir valores). Não é preciso reenviar à mão: a fila tenta de novo, e o repasse horário envia o devido. Se a mensagem cair na DLQ, o incidente aparece em [dlq](#dlq). `outcome = "rejected"`: o provedor recusou o endereço, e não há reenvio automático. O dono corrige o endereço da conta, e o suporte, com um caso de privacidade aberto, reemite o aviso ([runbook dos avisos](./avisos-de-encerramento.md#ato-de-suporte)). Se o endereço não puder ser entregue, o responsável dispensa o aviso com o motivo `email_undeliverable`, sob o caso de exclusão do dono aceito. Nunca grave `sent_at` nem `failed_at` à mão.

<a id="checkout-pago-no-encerramento"></a>

### checkout-pago-no-encerramento — checkout aprovado e pago durante o descarte do encerramento

**O que significa.** O encerramento de uma loja descartou no Pix Automático o checkout ainda aberto, e a aprovação do pagador caiu entre a leitura e o cancelamento: o provedor já tinha uma assinatura, o cancelamento a encerrou, e a 1ª parcela foi paga na aprovação. O pagador pagou por uma loja que está encerrada e o Polaris não reembolsa sozinho (`WOOVI_REFUND_ENABLED` desligado). O evento é `billing_closure_paid_checkout_refund_pending` (erro, só `eventId` do outbox, `organizationId` opaco e `provider`). Na mesma hora abre-se uma ocorrência do incidente operacional `billing_refund_pending` com a causa `refund_not_completed`, uma por pedido de encerramento e checkout (repetir a entrega não soma). Se o banco falha ao gravar o incidente, o consumidor lança: a fila tenta de novo e, esgotadas as tentativas, a DLQ abre o incidente ([dlq](#dlq)); o incidente é gravado antes de qualquer fato ser aplicado, então a nova entrega ainda encontra o checkout aberto e o abre mesmo que o provedor já responda `already_closed` (assinatura vista como cancelada).

**Como confirmar.** Workers Logs: `event = "billing_closure_paid_checkout_refund_pending"`, e o `billing_checkout_approved_during_closure_discard` logo antes, com o mesmo `eventId`. Admin: o incidente `billing_refund_pending` / `refund_not_completed` na lista de incidentes.

**O que fazer.** Reembolse a 1ª parcela pelo painel do provedor, pelo caminho de [reembolso pendente](./billing-providers.md#reembolso-pendente), e registre no caso de suporte da loja. A assinatura já está cancelada: não há renovação a cancelar.

<a id="rede-de-reembolso-parada"></a>

### rede-de-reembolso-parada — rede do reembolso parada numa loja

**O que significa.** A rede horária do reembolso (ADR 0104, decisão 6) tentou 10 vezes cancelar a renovação de uma loja cujo pagamento foi devolvido (reembolso ou chargeback) e a 10ª falhou: a rede para nessa loja, e a renovação pode cobrar de novo. O evento é `billing_refund_rearm_exhausted` (erro, com `organizationId` opaco, `provider`, `reason` e `attempt`; quando o incidente só sai na varredura seguinte, porque o banco falhou na passada, o evento sai de novo com `source = "sweep"`). Na mesma passada abre-se o incidente operacional `billing_refund_pending` com a causa `refund_rearm_exhausted`, uma ocorrência por loja e vínculo (repetir a passada não soma).

**Como confirmar.** Workers Logs: `event = "billing_refund_rearm_exhausted"` e as `billing_refund_rearm_failed` da mesma loja nos dias anteriores (o `errorClass`/`errorCode` diz se é chave, provedor fora ou recusa). Admin: o incidente `billing_refund_pending` / `refund_rearm_exhausted` na lista de incidentes.

**O que fazer.** Siga [reembolso pendente e rede de segurança do reembolso](./billing-providers.md#reembolso-pendente): conferir no painel do provedor se a renovação está viva (a 10ª tentativa pode ter cancelado e falhado só ao gravar no banco), cancelá-la à mão se estiver e registrar no caso de suporte da loja. Não zere `refund_rearm_attempts` à mão para a rede tentar de novo.

<a id="incidente-de-reembolso-nao-gravado"></a>

### incidente-de-reembolso-nao-gravado — incidente do reembolso não gravado

**O que significa.** O banco falhou ao gravar o incidente de um reembolso pendente há 24 h (`refund_not_completed`) ou de uma rede parada (`refund_rearm_exhausted`, campo `cause`). O evento é `billing_refund_pending_incident_failed` (erro, com `organizationId` opaco e o erro). Sem o incidente, o operador não vê o caso pela lista do Admin; a passada seguinte tenta de novo. O mesmo sinal conta `billing_amount_mismatch_incident_failed` (erro, no Worker `polaris-admin`, com `organizationId` opaco, `provider` e o erro): o reembolso do operador foi recusado porque o valor registrado da cobrança em vigor não é o do provedor, e o incidente `billing_amount_mismatch` não foi gravado; nenhuma passada grava depois.

**Como confirmar.** Workers Logs: `event = "billing_refund_pending_incident_failed"`, por `cause` e `sqlState`. Com `sqlState`, veja também [erros-de-banco](#erros-de-banco).

**O que fazer.** Corrija a causa do banco; a próxima passada horária grava o incidente (uma vez só). Enquanto isso, trate a loja pelo log, como se o incidente existisse ([reembolso pendente](./billing-providers.md#reembolso-pendente)). Para `billing_amount_mismatch_incident_failed`, o `billing_refund_amount_mismatch` logo antes no mesmo Worker nomeia a loja (ID opaco): trate como o incidente de divergência ([billing-providers](./billing-providers.md)).

<a id="pix-revogacao-nao-mostrada"></a>

### pix-revogacao-nao-mostrada — revogação do Pix Automático que a releitura não mostra

**O que significa.** Chegou um `PIX_AUTOMATIC_REJECTED` assinado de uma assinatura do Polaris, e a releitura com o AppID do Polaris ainda a mostra `ACTIVE` e sem `pixRecurring.status` (a forma do sandbox). Pode ser uma revogação pelo pagador que a Woovi não reflete na assinatura, e então o Pro segue até a próxima cobrança falhar (até cerca de 7 dias, mais a carência). Não há débito sem autorização. Também pode ser um corpo antigo repetido (a assinatura RSA não tem carimbo de tempo) ou a recusa de um checkout que nunca foi aprovado, que no sandbox também aparece `ACTIVE` sem status: o evento não é prova de revogação. O evento é `billing_woovi_revocation_not_shown` (erro, Worker `polaris-web`, só `eventType`, `provider` e o `resourceId` decodificado da assinatura). Ao lado sai o `billing_webhook_state_not_shown` da mesma entrega, com `pixStatus = "absent"`. O webhook só lê: ele nunca cancela na Woovi ([ADR 0101](../adr/0101-adaptador-asaas-porta-de-saida-e-releitura-do-recurso.md), emenda da regra única).

**Como confirmar.** Workers Logs: `event = "billing_woovi_revocation_not_shown"`, com o `resourceId` (`PaymentSubscription:<hex>`). O `providerRef` da loja é esse texto em base64. No painel da Woovi, abra a assinatura e veja se a autorização do Pix foi revogada ou recusada. A loja é a dona do `providerRef` na seção Cobrança do Admin.

**O que fazer.** Se o painel mostra a autorização revogada e a assinatura viva, cancele a renovação da loja pelo comando "Cancelar renovação" da seção Cobrança do Admin ([comandos do operador](./billing-providers.md#comandos-do-operador-no-admin-cancelar-renovação-e-reembolsar)), com caso aberto. Se o painel mostra a assinatura `INACTIVE`, nada a fazer: a reconciliação horária grava o cancelamento. Se a autorização está em vigor, é corpo repetido: nada a fazer. Anote no caso o que a releitura mostrava: a primeira revogação real decide se a Woovi inativa a assinatura (item 29 do [release-checklist](./release-checklist.md)).

<a id="revelacoes-por-hora"></a>

### revelacoes-por-hora — operador chegou ao limite de revelações de dado pessoal

**O que significa.** Um operador pediu a 31ª revelação de campo de cliente na mesma hora e a função do banco recusou ([ADR 0072](../adr/0072-admin-casos-acesso-temporario-e-revelacao.md), limite de 30 por hora por operador, somando casos e lojas). O evento é `admin_reveal_rate_limited` (aviso, no Worker `polaris-admin`), com `principal` (o ID opaco do operador); não leva campo, cliente nem loja, e a recusa não grava na auditoria. Nada foi mostrado.

**Como confirmar.** Workers Logs do `polaris-admin`: `event = "admin.admin_reveal_rate_limited"` (o Worker do Admin põe o prefixo `admin.` em todo evento; o registro de alertas usa o nome sem ele, como o código o escreve). As 30 revelações aceitas estão na auditoria (`pii.revealed`, por operador, com o campo e o cliente) e no caso de cada loja.

**O que fazer.** Veja na auditoria quais clientes e lojas o operador abriu na última hora. Se foi um atendimento de verdade com muitos clientes, nada a fazer: a próxima hora libera. Se ninguém reconhece a leitura, trate como sessão de operador comprometida: desligue o operador (`platform_principals.status`) e revogue a sessão no Access.

<a id="comando-de-cobranca-do-operador"></a>

### comando-de-cobranca-do-operador — operador cancelou uma renovação ou reembolsou pelo Admin

**O que significa.** Uma pessoa do Access cancelou a renovação ou pediu o reembolso de uma loja pela seção Cobrança do Admin, e o comando chegou ao provedor ([ADR 0105](../adr/0105-comandos-de-provedor-pelo-operador.md)). O evento é `billing_operator_command` (aviso, no Worker `polaris-admin`, não no `polaris-web`), com `operation` (`billing.cancel_renewal` ou `billing.refund`), `reason` (o resultado: `cancelled`, `already_cancelled`, `nothing_to_cancel`, `refund_requested`, `nothing_to_refund`), `provider` e `organizationId` opaco. Não há segunda aprovação no Admin: o alerta existe para a **outra** pessoa do Access ver cada comando na hora. O e-mail do alerta tem de chegar às duas pessoas do Access.

**Como confirmar.** Workers Logs do `polaris-admin`: `event = "billing_operator_command"`. No Admin, o caso da loja mostra a auditoria `billing.operator_*_requested` e `…_recorded`, com o ID do comando; o motivo digitado está no ledger de cobrança (`billing_events`, `provider_event_id = command:operator_<tipo>:<commandId>`).

**O que fazer.** Se foi a outra pessoa, confira o caso e o motivo; nada a fazer. Se ninguém reconhece o comando, trate como sessão de operador comprometida: desligue o operador (`platform_principals.status`), revogue a sessão no Access e siga [suspeita de vazamento da chave](./billing-providers.md#suspeita-de-vazamento-da-chave). Um `admin.operator_refund_rate_limited` no mesmo Worker diz que alguém passou do limite de 3 reembolsos por hora.

<a id="serie-parada"></a>

### serie-parada — a série de dicas parou depois de uma reclamação de spam

**O que significa.** O webhook do Resend entregou uma reclamação (`email.complained`) e o banco abriu uma parada da série "Dicas para começar" ([ADR 0106](../adr/0106-avisos-de-ativacao-e-medida-de-comportamento.md), D7). O evento é `activation_series_stopped` (aviso, no Worker `polaris-web`), com `stopped: true`, o `eventId` opaco da entrega e o `requestId`; nunca o endereço, o HMAC nem o corpo. Só a reclamação que **abre** uma parada gera o evento: uma segunda, com a parada já ativa, e a reentrega do mesmo evento não. A parada vale para todas as lojas e não sai sozinha.

**Como confirmar.** Workers Logs do `polaris-web`: `event = "activation_series_stopped"`. No banco, pelo dono, `SELECT id, stopped_at FROM activation_series_stops WHERE released_at IS NULL` (o [runbook da parada](./ativacao-parada-da-serie.md) tem os passos e a foto).

**O que fazer.** Olhe a origem no painel do Resend no mesmo dia: a reclamação veio de uma dica da série ou de um e-mail da conta (login, verificação, cobrança, encerramento). A conta é uma só, e quem se cadastra com uma caixa que é dele pode marcar o e-mail de verificação como spam e parar a série de todas as lojas: o risco foi aceito no ADR. Quem decide liberar é o usuário; o passo está em [Parada da série e liberação](./ativacao-parada-da-serie.md). Enquanto o cron de alertas não existe (Fase 14), este sinal é lido à mão: o Arrascaeta consulta o evento (ou a parada ativa) ao menos uma vez por dia com a série ligada.

<a id="incidente-de-reembolso-aberto"></a>

### incidente-de-reembolso-aberto — reembolso não concluído virou incidente

**O que significa.** Um pedido de reembolso do dono, no vínculo atual, ainda não estava concluído 24 horas depois e a manutenção da cobrança abriu o incidente `billing_refund_pending`. O evento é `billing_refund_pending_incident` (nível `error`, só o ID opaco da loja e o provedor, no `polaris-web`): uma ocorrência por loja e pedido, então uma só já é o dinheiro de um cliente parado e basta para acordar (limiar 1 em 60 min). Não confunda com `billing_refund_pending_incident_failed`, que é o incidente que **não** foi gravado e tem sinal próprio ([incidente-de-reembolso-nao-gravado](#incidente-de-reembolso-nao-gravado)).

**Como confirmar.** Workers Logs do `polaris-web`: `event = "billing_refund_pending_incident"`. O caso aparece na lista de incidentes do Admin com a causa `refund_not_completed` ou, vindo da rede parada, `refund_rearm_exhausted` ([rede-de-reembolso-parada](#rede-de-reembolso-parada)).

**O que fazer.** Siga [reembolso pendente e rede de segurança do reembolso](./billing-providers.md#reembolso-pendente): o operador confere o pedido no painel do provedor e conclui o reembolso pelos comandos de cobrança do Admin (cada comando acorda a outra pessoa do Access, [comando-de-cobranca-do-operador](#comando-de-cobranca-do-operador)). Não reembolse por fora do Admin: o efeito é de dinheiro e precisa de registro.

<a id="chave-do-provedor-recusada"></a>

### chave-do-provedor-recusada — o provedor recusou a chave do Polaris

**O que significa.** A API do Asaas (ou o AppID da Woovi) recusou a credencial do Polaris, com 401 ou 403: a chave foi rotacionada ou revogada antes da hora, ou é de outro ambiente. O evento é `billing_provider_rejected` (nível `error`, com `httpStatus`, uma vez por entrega), e só o Worker `polaris-web` o emite, nos adaptadores de webhook do Asaas e da Woovi. O `polaris-admin` tem a mesma chave e não emite este evento: a recusa num comando do operador cai em `admin.billing_operator_command_unknown` (`warn`, não é sinal do registro), e a da manutenção do `polaris-web`, no evento de falha da própria rotina (como `billing_unclaimed_trial_settle_failed`). Chave errada só no Admin, portanto, não dispara este sinal. Toda entrega passa a falhar com 503 e o Asaas pausa a fila do webhook depois de 15 falhas seguidas, então o primeiro evento já acorda (limiar 1 em 60 min).

**Como confirmar.** Workers Logs: `event = "billing_provider_rejected"`, por `provider` e `httpStatus` (o evento só vem do `polaris-web`). Compare com a última rotação de chave em [billing-providers.md](./billing-providers.md) (a ordem certa é gravar a nova no Worker antes de revogar a antiga).

**O que fazer.** O responsável confere a chave do ambiente no painel do provedor e regrava o segredo certo (`ASAAS_API_KEY` ou `WOOVI_APP_ID`) nos dois Workers do ambiente, `polaris-web` e `polaris-admin`, juntos, como em [billing-providers.md](./billing-providers.md#comandos-do-operador-no-admin-cancelar-renovação-e-reembolsar): a chave é a mesma e regravar só uma deixa o Admin com a velha; sem rotação em curso e com sinal de uso indevido, trate como [suspeita de vazamento da chave](./billing-providers.md#suspeita-de-vazamento-da-chave). Depois de corrigir, confira que uma entrega responde 200 e que a fila do webhook do Asaas não ficou pausada; se ficou, reative-a no painel. Nunca cole a chave em log, chat ou PR.

<a id="webhook-de-cobranca-abandonado"></a>

### webhook-de-cobranca-abandonado — evento de cobrança abandonado sem organização

**O que significa.** O webhook trazia uma assinatura válida, mas a releitura não achou o recurso que ele cita, e o prazo de nova tentativa (30 minutos) acabou ou a data veio mais de 5 minutos à frente. O Polaris o aceita com 200 e o provedor não o reenvia: o fato de cobrança se perde (não entra em `billing_events`) até alguém reconciliar. O evento é `billing_webhook_unresolved_given_up` (nível `error`, só IDs; `reason` é `stale` ou `future`, ausente quando o adaptador já limitou a data a "agora"), no `polaris-web`. Um só basta (limiar 1 em 60 min).

**Como confirmar.** Workers Logs do `polaris-web`: `event = "billing_webhook_unresolved_given_up"`, por `provider`, `reason` e o tipo do recurso; o `billing_webhook_unresolved` anterior do mesmo recurso mostra as tentativas.

**O que fazer.** Confira no painel do provedor se o recurso existe na conta do ambiente (um evento de outra conta ou de outro ambiente é ruído; um pagamento de loja real é fato perdido) e, se é de uma loja, reconcilie a organização pelos comandos de cobrança do Admin, seguindo a tabela de eventos do [runbook dos provedores](./billing-providers.md). Não reaplique o evento à mão no banco.

<a id="serie-falhando"></a>

### serie-falhando — a série de dicas falhou ao enviar ou ao varrer

**O que significa.** A série "Dicas para começar" ([ADR 0106](../adr/0106-avisos-de-ativacao-e-medida-de-comportamento.md)) está ligada e algo impediu um aviso ou a varredura. São três eventos, todos de nível `error`, no Worker `polaris-web`:

- `activation_notice_email_misconfigured`: o consumidor de `activation.notice` achou a flag ligada e a configuração do envio incompleta (`reason = "email_not_configured"`, com o `step` do aviso). O código o chama de incidente: a chave está ligada com um envio que não pode acontecer. **O aviso daquele ciclo é pulado** (fica `skipped` com `email_not_configured`) e não é reenviado quando a configuração volta; o que sai depois é só o aviso seguinte da série.
- `activation_notice_failed`: o envio falhou. Com `reason = "email_provider_unavailable"` (`outcome = "failure"`, com `httpStatus` e `errorCode` do Resend) o provedor não respondeu ou recusou por chave, remetente, domínio ou cota, e a fila tenta de novo até a DLQ; com `reason = "email_rejected"` (`outcome = "rejected"`) o provedor recusou o endereço e o aviso fica `failed`, sem nova tentativa.
- `activation_sweep_failed`: a varredura horária que grava os avisos devidos falhou (`errorClass`, `errorCode`, `seriesOn`); a hora seguinte tenta de novo.

O nível é `critical` e acorda desde a primeira ocorrência (60 min, limiar 1), porque a série é ligada de propósito e uma falha de segredo ou do provedor passa em silêncio: o primeiro aviso perdido não volta.

**Já existe monitor no staging.** O Arrascaeta incluiu os três eventos na política 3 da Cloudflare (a mesma de `http-5xx` e `erros-de-banco`, `custom_analytics`, 1 ou mais evento em 1 minuto, e-mail ao dono), em 17/11/2026, anotação dele; a seção [Monitores no staging](#monitores-no-staging) tem a linha. O e-mail não diz qual dos eventos disparou: abra os Workers Logs.

**Como confirmar.** Workers Logs do `polaris-web`: `event in ("activation_notice_email_misconfigured", "activation_notice_failed", "activation_sweep_failed")`, agrupe por `event` e por `reason` (e `step`, `httpStatus`, `errorCode`). O `activation_notice_skipped` com o mesmo `reason` mostra os avisos pulados. Os eventos não trazem endereço, nome de loja nem corpo.

**O que fazer.** Com `reason = "email_not_configured"`, falta segredo ou remetente no Worker de staging ou de produção: confira, sem imprimir valores e pela [política de perfis de CLI](./cli-profile-policy.md), os segredos (`wrangler secret list --env staging`): `RESEND_API_KEY`, `UNSUBSCRIBE_TOKEN_SECRET`, `ACTIVATION_SUPPRESSION_HMAC_SECRET` e `RESEND_WEBHOOK_SECRET`; as variáveis do `wrangler.jsonc` (não são segredo e `secret list` não as mostra): `ACTIVATION_EMAIL_FROM`, `BILLING_SUPPORT_EMAIL` e `BETTER_AUTH_BASE_URL` em `https`; e o binding `AUTH_HYPERDRIVE` (o roteiro da série em [staging.md](./staging.md) tem a lista do operador); depois de corrigir, os avisos já pulados ficam perdidos, então anote quantos foram. Se a configuração está certa e a série não deveria estar ligada, desligue a flag por PR ([ativacao-parada-da-serie.md](./ativacao-parada-da-serie.md) e a seção da série no `staging.md`). Com `email_provider_unavailable`, a classificação das respostas do Resend é a de [aviso-de-encerramento-falhando](#aviso-de-encerramento-falhando) (o cliente do Resend e a chave são os mesmos); com `email_rejected` repetido, olhe a reputação do domínio antes de qualquer reenvio. Com `activation_sweep_failed`, siga [erros-de-banco](#erros-de-banco) pelo `errorCode`.

<a id="email-de-acesso-falhando"></a>

### email-de-acesso-falhando — e-mail de acesso que não saiu

**O que significa.** O Worker `polaris-web` não conseguiu entregar ao Resend um e-mail de autenticação: verificação do cadastro, redefinição de senha, aviso de senha trocada ou definida, desbloqueio do login e o aviso de "você já tem conta". Evento `auth_email_delivery_failed`, de nível `error`, com `kind` (qual e-mail) e `errorClass`/`errorCode`, sem endereço, token nem corpo. A resposta da tela não muda de propósito (anti-enumeração, [email-auth.md](./email-auth.md)), então quem tenta se cadastrar vê a tela normal e o e-mail nunca chega: com a chave do Resend revogada ou o domínio do remetente sem verificação, todo cadastro novo fica parado sem nada visível. O nível é `critical` e o sinal acorda desde a primeira ocorrência (60 min, limiar 1) (veja o fim desta seção): o tráfego de cadastro é baixo e, com um limiar maior, uma chave quebrada passaria dias sem alarme; uma recusa isolada de endereço é rara, e o ruído é aceito.

**Como confirmar.** Workers Logs do `polaris-web`: `event = "auth_email_delivery_failed"`, agrupe por `kind` e por `errorClass`/`errorCode`. O evento não separa a recusa de um endereço da falha da chave: todos os `kind` falhando de uma vez sugere chave ou domínio, e uma ocorrência só, um endereço ou um tropeço do provedor.

**O que fazer.** Confira, sem imprimir valores e pela [política de perfis de CLI](./cli-profile-policy.md), a chave `RESEND_API_KEY` do Worker (`wrangler secret list`), o remetente `AUTH_EMAIL_FROM` e a verificação do domínio no painel do Resend ([email-auth.md](./email-auth.md)). Corrigida a causa, quem não recebeu o e-mail pede o reenvio na tela.

**Monitor no staging.** Coberto pela política 3 da Cloudflare (a mesma de `http-5xx` e `erros-de-banco`, 1 ou mais evento em 1 minuto, e-mail ao dono): o operador incluiu `auth_email_delivery_failed` nela em 17/11/2026 às 23:56, anotação dele (veja [Monitores no staging](#monitores-no-staging)). O e-mail não diz qual dos eventos disparou: abra os Workers Logs.

<a id="aviso-nao-entregue"></a>

### aviso-nao-entregue — aviso que perdeu a janela de 23 horas, ou e-mail de cobrança recusado

**O que significa.** Um aviso devido não saiu. Eventos, todos de nível `error` e no `polaris-web`: `activation_notice_delivery_window_passed` e `billing_notice_delivery_window_passed` (o aviso foi tentado pela primeira vez há mais de 23 horas, ficou `skipped` com `delivery_window_passed` e não é reenviado: o e-mail se perdeu, sem dano de dinheiro, mas indica fila ou provedor parado) e `billing_notice_failed` (o e-mail de cobrança foi recusado ou o provedor não respondeu; `outcome = "failure"` volta para a fila, `"rejected"` fecha o aviso como `failed`). A falha do aviso da série tem sinal próprio, [serie-falhando](#serie-falhando). Só vai ao resumo diário.

**Como confirmar.** Workers Logs do `polaris-web`: os três eventos, por `outcome`, `reason`, `httpStatus` e `errorCode`. O [runbook do e-mail de autenticação](./email-auth.md#quando-o-e-mail-volta-com-erro) tem a leitura dos eventos de cobrança.

**O que fazer.** Domínio não verificado, chave ou cota no Resend: a classificação é a de [aviso-de-encerramento-falhando](#aviso-de-encerramento-falhando). Repetido por mais de um dia, o aviso de cobrança que não saiu é um lojista que paga e não recebe o comprovante: avise o responsável. Conserte a causa antes de qualquer reenvio, e lembre que o aviso pulado não é reenviado.

<a id="cobranca-fato-estranho"></a>

### cobranca-fato-estranho — fato ou resposta de cobrança fora da forma esperada

**O que significa.** O provedor ou o fluxo de cobrança trouxe algo raro que a reconciliação horária costuma resolver, mas que vale olhar no mesmo dia. Eventos: `billing_trial_fact_without_claim` (um checkout pago começaria o teste de uma loja sem reserva de ninguém; erro só na última tentativa, e a manutenção cancela a assinatura antes da 1ª cobrança), `billing_webhook_state_not_shown` (200 sem fato: a releitura não mostrou o estado; a manutenção horária cobre, e vale contar para ver se o sandbox mudou), `billing_webhook_fact_event_malformed` (corpo assinado com evento malformado) e `billing_provider_response_malformed` (releitura fora da forma documentada: mudança do provedor). Só vai ao resumo diário.

**Como confirmar.** Workers Logs do `polaris-web`: os quatro eventos, por `provider` e `reason`; as linhas da tabela de eventos do [runbook dos provedores](./billing-providers.md) dizem o que cada um quer dizer.

**O que fazer.** Um evento isolado não pede ação. Vários do mesmo tipo em seguida: confira se o Asaas ou a Woovi mudaram o formato (`billing_provider_response_malformed`, `billing_webhook_fact_event_malformed`) e reconcile a organização pelo Admin. Não corrija `billing_events` à mão.

<a id="limitador-indisponivel"></a>

### limitador-indisponivel — limitador de taxa indisponível

**O que significa.** O Rate Limiting da Cloudflare não respondeu a uma checagem. O evento é `rate_limit_unavailable` (nível `error`, com `scope` e a classe do erro): a requisição **segue sem a checagem**, então por um tempo não há limite de taxa naquele escopo. Só vai ao resumo diário.

**Como confirmar.** Workers Logs do `polaris-web`: `event = "rate_limit_unavailable"`, agrupe por `scope`. Um escopo só aponta o binding dele; todos, a plataforma. Veja também `rate_limited` (aviso) para saber se o limitador voltou a negar.

**O que fazer.** Confira o status da Cloudflare e o binding no `wrangler.jsonc`. Se o escopo é o de login ou o de cadastro, olhe o tráfego do período por abuso: [auth-abuse-protection.md](./auth-abuse-protection.md) tem o que fazer.
