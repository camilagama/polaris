# Alertas operacionais

**Gatilho:** um alerta disparou (e-mail de alerta ou resumo diário), ou antes de ligar um deploy ao tráfego real. A definição de cada sinal é código: o registro `alertSignals` de [`packages/observability/src/alerts.ts`](../../packages/observability/src/alerts.ts); este runbook diz o que cada um significa, como confirmar e o que fazer ([ADR 0095](../adr/0095-onde-os-alertas-operacionais-vao-rodar.md), plano PR 119).

> **Nada disto roda ainda.** Não há ambiente, e este PR não cria alerta, cron, token nem conta em serviço externo. Hoje o runbook é lido à mão: as consultas abaixo funcionam no Workers Logs de um ambiente que exista (Fase 14). Se um limiar e o registro divergirem, vale o registro; ajuste os dois no mesmo PR (um teste exige que cada sinal tenha a seção abaixo e que ela cite cada evento dele, e que cada evento exista no código).

## Como ler

- **Severidade e quem acorda:** `critical` acorda alguém (e-mail imediato, no máximo um por sinal a cada 6 horas); `warning` só aparece no resumo diário. É o campo `notify` do registro (`wake` ou `report`).
- **Janela e limiar:** a contagem é de eventos na janela (não de requisições); `absence` quer dizer "nenhum evento na janela".
- **Consultas:** no painel Workers Logs do Worker `polaris-web` (Observability, Query), filtre pelo campo `event` (o nome do evento) e pelos campos canônicos do [ADR 0091](../adr/0091-esquema-canonico-de-eventos-largos.md) (`outcome`, `route`, `httpStatus`, `durationMs`, `reason`, `errorClass`, `errorCode`, `sqlState`, `requestId`). Eventos não trazem dado de cliente: para cruzar com um caso, use o `requestId`. Os Workers Logs guardam poucos dias (3 no plano Free até a cobrança nova de 1º/12/2026, depois 7); incidente mais antigo só se confirma pelo banco.
- **Banco:** as consultas SQL são só de leitura, com o papel de leitura que o responsável autorizar (as tabelas citadas são agregadas ou sem dado de cliente; o dono do banco ignora o RLS e não deve ser o padrão), em ambiente autorizado, seguindo a [política de perfis de CLI](./cli-profile-policy.md). Não cole resultado com dado de cliente em PR nem chat.
- **Admin:** o painel do Admin mostra os incidentes da DLQ e os casos de cobrança sem dar acesso ao tenant.

## Sinais

| Sinal | Evento de origem | Janela | Limiar | Severidade | Acorda |
| --- | --- | --- | --- | --- | --- |
| [`http-5xx`](#http-5xx) | `server_error` (`httpStatus >= 500`) | 15 min | 5 | critical | sim |
| [`latencia-p95`](#latencia-p95) | `http_request_timed` | 30 min | p95 acima do limite da rota (20 requisições, no mínimo) | warning | não |
| [`dlq`](#dlq) | `queue_dead_letter_recorded` e outros | 60 min | 3 | warning | não |
| [`outbox-parado`](#outbox-parado) | `scheduled_job_run` do `outbox.dispatch` | 180 min | ausência | critical | sim |
| [`outbox-falhando`](#outbox-falhando) | `outbox_send_failed`, `outbox_event_unsendable` | 120 min | 1 | warning | não |
| [`cobranca-reconcile`](#cobranca-reconcile) | `billing_maintenance_incomplete` e outros | 180 min | 3 | critical | sim |
| [`pix-cadastros-por-loja`](#pix-cadastros-por-loja) | `billing_payer_customer_created` | 60 min | 5 | warning | não |
| [`erros-de-banco`](#erros-de-banco) | `server_error` com `sqlState` e outros | 15 min | 3 | critical | sim |
| [`agendador-falhando`](#agendador-falhando) | `scheduled_job_claim_failed` e outros | 180 min | 2 | warning | não |
| [`r2-e-midia`](#r2-e-midia) | `media_removed_asset_failed` e outros | 60 min | 1 | warning | não |
| [`cota-de-transformacao`](#cota-de-transformacao) | `media_transform_quota_exceeded` | 60 min | 1 | warning | não |
| [`rejeicao-no-sync`](#rejeicao-no-sync) | `sync_push_command_rejected` | 15 min | 10 | warning | não |
| [`registro-de-acesso`](#registro-de-acesso) | `auth_access_log_write_failed` | 15 min | 3 | critical | sim |
| [`apagamento-automatico`](#apagamento-automatico) | `closure_auto_purge_volume_high` | 24 h | 1 | critical | sim |
| [`loja-encerrada-parada`](#loja-encerrada-parada) | `closure_purge_overdue` | 24 h | 1 | warning | não |
| [`aviso-de-encerramento-falhando`](#aviso-de-encerramento-falhando) | `closure_notice_email_failed` | 24 h | 1 | warning | não |

Os limiares são um primeiro chute, sem medida de tráfego real; a Fase 14 os revê. A taxa de 5xx é uma contagem por janela, sem denominador (só as rotas críticas emitem um evento por requisição).

<a id="http-5xx"></a>

### http-5xx — respostas 5xx

**O que significa.** O Worker respondeu 500 ou mais: uma exceção que ninguém tratou ou uma falha de dependência. O evento é `server_error` (nível `error`), com `route` (o padrão), `method`, `httpStatus`, `errorClass`, `errorCode`, `requestId` e a cadeia de causas (`causes`), nunca a mensagem. 4xx não conta. **Lacuna:** um 503 que o código devolve de propósito, sem exceção (configuração do Better Auth ausente, `auth_unavailable`, e as respostas `auth_*_unavailable` da proteção contra abuso), não gera `server_error`; nas rotas críticas ele aparece como `http_request_timed` com `outcome = "failure"`, que a contagem do sinal não soma (somar os dois contaria a mesma falha duas vezes).

**Como confirmar.** Workers Logs: `event = "server_error"` e `httpStatus >= 500`, agrupe por `route` e por `errorClass`/`errorCode`. Uma só rota ou um só `errorCode` aponta para a causa; vários indicam dependência (banco, R2). Veja também `http_request_timed` com `outcome = "failure"` nas rotas críticas. Cruze com um deploy recente.

**O que fazer.** Mitigue primeiro: se começou com um deploy, desfaça-o (o responsável faz o deploy). Se o `sqlState` aparece, siga [erros-de-banco](#erros-de-banco). Se é uma rota de cobrança ou de mídia, siga o sinal dela. Registre a causa e abra a correção por PR.

<a id="latencia-p95"></a>

### latencia-p95 — latência p95 por rota crítica

**O que significa.** O p95 de `durationMs` (tempo de parede, não de CPU) de uma rota de `criticalRoutes` passou do limite dela, com pelo menos 20 requisições na janela. As rotas e os limites (provisórios) estão no registro: `/rpc/sale/confirm`, `/rpc/sync/push`, `/rpc/sync/pull`, `/rpc/sync/bootstrapPage`, `/api/auth/*` e `/api/products/:productId/media`. O evento é `http_request_timed`, só dessas rotas. Ele sai uma vez por requisição, inclusive as de `/api/auth/*` que a sessão faz sozinha; se o volume pesar na cota dos Workers Logs, a emissão passa a ser só de falha ou de requisição lenta ([ADR 0095](../adr/0095-onde-os-alertas-operacionais-vao-rodar.md)).

**Como confirmar.** Workers Logs: `event = "http_request_timed"`, agrupe por `route`, calcule o p95 de `durationMs` e compare com o limite. Os 4xx (`outcome = "rejected"`: origem recusada, limite de taxa, sessão ausente) ficam de fora do cálculo, porque respondem rápido e baixariam o p95; separe também por `method` (a lista de produtos e o envio de imagem dividem a rota). Nos Workers Traces (5% das requisições, [ADR 0094](../adr/0094-tracing-e-amostragem-do-workers-observability.md)) abra um trace lento da rota e veja onde o tempo foi (consulta ao banco, R2, Images).

**O que fazer.** Latência de banco em geral é compute do Neon acordando do repouso (primeira requisição depois de minutos parado, no plano Free): se só a primeira é lenta, não é regressão. Se é constante, procure consulta nova sem índice (plano da consulta, em ambiente descartável), lote grande no `sync.push` ou imagem pesada no upload. Se o limite for irreal para o tráfego, ajuste `criticalRoutes` no registro, com a medida no PR.

<a id="dlq"></a>

### dlq — DLQ crescendo

**O que significa.** Mensagens esgotaram as tentativas ou foram recusadas e foram para a fila de mensagens mortas ([filas](./queues.md), [ADR 0085](../adr/0085-dlq-incidente-operacional-e-retry-no-admin.md)). Eventos: `queue_dead_letter_recorded` (a DLQ gravou o incidente), `queue_dead_letter_not_recorded` e `queue_dead_letter_send_failed` (a DLQ não conseguiu gravar ou o envio a ela falhou; a mensagem é retentada) e `outbox_events_exhausted` (um evento do outbox passou do teto de tentativas).

**Como confirmar.** Workers Logs: os quatro eventos, agrupados por `reason` e `queue`. No banco: `SELECT kind, cause, occurrence_count, first_seen_at, last_seen_at FROM operational_incidents ORDER BY last_seen_at DESC LIMIT 20` (uma linha por causa, sem corpo da mensagem). No Admin, a lista de incidentes mostra o mesmo e permite reenviar.

**O que fazer.** A causa diz o caminho: `retries_exhausted` (o handler falhou: ache o `queue_message_failed` do mesmo `eventId` e corrija, depois reenvie pelo Admin), `unknown_type` (o consumidor está mais velho que o produtor: faça o deploy do consumidor), `wrong_queue` (nome de fila com prefixo em vez de sufixo de ambiente), `invalid_envelope` (investigue quem escreveu na fila). Só reenvie depois de corrigir a causa; a retenção da fila é de 24 horas no Free.

<a id="outbox-parado"></a>

### outbox-parado — o despachante do outbox não conclui

**O que significa.** O job `outbox.dispatch` (cron horário `19 * * * *`, [agendador](./scheduled-jobs.md)) não terminou com sucesso em 3 horas (três ticks): os eventos do outbox (exportações, avisos) ficam `pending`. O sinal é a ausência de `scheduled_job_run` com `job = "outbox.dispatch"` e `outcome = "success"`. Não existe hoje um evento com a idade do evento pendente mais antigo (o banco não a expõe sem uma função nova); a consulta abaixo a dá à mão.

**Como confirmar.** Workers Logs: `event = "scheduled_job_run"` e `job = "outbox.dispatch"` nas últimas horas (veja o `outcome`), e `outbox_dispatch_not_configured` (o binding `OUTBOX_HYPERDRIVE` não existe) ou `scheduled_job_claim_failed` (login do outbox falhando). No banco: `SELECT count(*) AS pendentes, min(created_at) AS mais_antigo, min(available_at) AS proxima_tentativa FROM event_outbox WHERE status = 'pending'`; e `SELECT job_id, last_success_at, consecutive_failures, last_failure_at FROM scheduled_job_state WHERE job_id = 'outbox.dispatch'`. Um `mais_antigo` de horas com `proxima_tentativa` já passada confirma parada (um evento com `available_at` no futuro está só em recuo).

**O que fazer.** Cron fora do ar ou sem binding: veja o passo 7 do [checklist das filas](./queues.md). Login falhando (senha rotacionada, Hyperdrive fora, migration ausente): siga [agendador-falhando](#agendador-falhando). Para forçar uma execução depois de corrigir: [scheduled-jobs.md](./scheduled-jobs.md), "Forçar uma execução". Os eventos não se perdem (o outbox é transacional); o risco é o atraso do que depende deles.

<a id="outbox-falhando"></a>

### outbox-falhando — envio do outbox à fila falhando

**O que significa.** O despachante rodou, mas não conseguiu enviar um lote: `outbox_send_failed` (a fila recusou ou não está ligada; no Free, a cota de 10.000 operações por dia da conta pode ter acabado) ou `outbox_event_unsendable` (este deploy não sabe montar o envelope do evento: tipo ou versão desconhecidos). Os eventos ficam `pending` e voltam com recuo.

**Como confirmar.** Workers Logs: os dois eventos, por `queue` e `errorClass`/`errorCode`. Compare a hora com o início do dia UTC (a cota diária volta às 00:00 UTC).

**O que fazer.** Cota: espere a virada, ou reduza o consumo; subir de plano é decisão do responsável ([ADR 0076](../adr/0076-teto-de-custo-e-free-tier-primeiro.md)). Fila não criada ou mal nomeada: [filas](./queues.md). `unsendable`: o produtor é mais novo que o despachante; faça o deploy do consumidor e do despachante antes do produtor.

<a id="cobranca-reconcile"></a>

### cobranca-reconcile — falha de reconcile da cobrança

**O que significa.** A manutenção horária da cobrança (nova tentativa de eventos pendentes e varredura de assinaturas e concessões vencidas) falhou, ou um webhook do provedor não foi processado. Eventos: `billing_maintenance_incomplete` (o job termina em falha), `billing_sweep_failed`, `billing_event_retry_failed`, `billing_grant_sweep_failed` (um item falhou) e `billing_webhook_processing_failed` (o provedor tentará de novo). O job `billing.provider_reconcile` (consulta ao Asaas e à Woovi) está desligado até o Gate 7; quando ligar, a falha dele aparece como `scheduled_job_run` com `outcome = "failure"` e deve entrar neste sinal.

**Como confirmar.** Workers Logs: os cinco eventos, por `errorClass`/`errorCode`, `provider` e `sqlState`; veja também o `scheduled_job_run` de `billing.maintenance`. Uma só falha é retentada no tick seguinte; três em três horas é falha persistente (é o limiar).

**O que fazer.** Com `sqlState` ou erro de conexão, siga [erros-de-banco](#erros-de-banco). Com erro de provedor, confira o painel de homologação ou produção do provedor (o responsável) e a assinatura do webhook. Não reprocesse pagamento à mão sem registrar: o efeito é de dinheiro e de acesso (use os comandos de cobrança do Admin). Nunca cole segredo do provedor em log ou chat.

<a id="pix-cadastros-por-loja"></a>

### pix-cadastros-por-loja — muitos documentos novos no Pix (olhar por loja)

**O que significa.** O evento `billing_payer_customer_created` (nível info, só `organizationId` opaco e `provider`) sai a cada documento novo que um checkout Pix cadastra na Woovi. Uma loja que cadastra muitos documentos distintos em pouco tempo pode estar pré-cadastrando CPFs de terceiros com nome e e-mail seus, o que trava o Pix dessas pessoas até o suporte corrigir (ADR 0101, emenda do PR 6). Sem limite de taxa próprio do checkout (condição do Gate 7), este é o único sinal.

**Como confirmar.** Workers Logs: `event = "billing_payer_customer_created"`, agrupe por `organizationId`. **O sinal é global** (o registro não agrupa por loja: conta os eventos da plataforma, 5 em 60 min, e aparece só no resumo diário); o corte por loja é à mão, nesta consulta. O que importa é uma só loja: **3 ou mais numa hora, ou 10 ou mais em 24 horas, de uma mesma `organizationId`**, é padrão suspeito (uma loja legítima tem um pagador, raramente dois). Veja também `billing_pix_checkout_refused` da mesma loja. O evento não guarda documento, nome nem e-mail. **Limite conhecido:** o evento sai depois de o cliente e a assinatura serem ligados; um cliente criado na Woovi e seguido de falha antes disso não gera o evento (o `billing_pix_checkout_refused` e os erros do checkout cobrem esse caso em parte).

**O que fazer.** Avise o responsável com o `organizationId`; a decisão de bloquear a loja ou de limitar o Pix é dele (Admin, sem entrar no tenant). Não procure o documento: o Polaris não o guarda. Quem pedir correção de um cliente da Woovi passa pela confirmação do titular do documento do [runbook de provedores](./billing-providers.md).

<a id="erros-de-banco"></a>

### erros-de-banco — erros de banco

**O que significa.** O banco recusou ou não respondeu: `server_error` com `sqlState` (o SQLSTATE do erro, achado na cadeia de causas, por exemplo `08006` conexão, `40001` serialização, `53300` conexões demais, `57P01` desligamento), `scheduler_state_unavailable` (o estado do agendador não abriu) e `queue_ledger_unavailable` (o consumidor de fila não alcançou o registro de processamento). Não conta erro de regra de negócio traduzido para 4xx. **Lacuna:** um erro de banco sem SQLSTATE (conexão derrubada ou timeout do driver, como `ECONNRESET`) não tem `sqlState`; ele só aparece em [http-5xx](#http-5xx), com o `errorCode` do driver.

**Como confirmar.** Workers Logs: `server_error` com `sqlState` existente, agrupado por `sqlState` e `route`; o `errorCode` de `08*` e `53*` é infraestrutura, `23*` (violação de restrição) e `42*` (permissão ou SQL) são bugs de código ou de migration. No console do Neon: se o compute está ativo, o uso do mês (60% de armazenamento ou 70% de computação é o gatilho do ADR 0076) e incidentes do provedor.

**O que fazer.** Infraestrutura (`08*`, `53*`, `57*`): confirme o Neon e o Hyperdrive (binding, query caching desligado); no Free, o compute acorda sozinho e a primeira consulta pode falhar uma vez. `42501` (permissão negada): provável papel sem a concessão de uma migration recém-aplicada, ou migration não aplicada antes do Worker; aplique antes de qualquer deploy. `23*`: bug; abra a correção. Se o limite do plano foi atingido, a decisão é do responsável.

<a id="agendador-falhando"></a>

### agendador-falhando — jobs agendados falhando

**O que significa.** Os crons rodam, mas o job falha: `scheduled_job_claim_failed` (não conseguiu tomar o *lease*: login do outbox, Hyperdrive ou migration do agendador), `scheduled_job_record_failed` (rodou mas não gravou o resultado), `scheduled_job_handler_missing` (job habilitado sem handler neste deploy) e `scheduled_job_run` com `outcome = "failure"`. É o alerta que o [runbook das filas](./queues.md) pede antes de ligar o `OUTBOX_HYPERDRIVE`.

**Como confirmar.** Workers Logs: os quatro por `job`, `lane` e `errorClass`/`errorCode`. No banco: `SELECT job_id, covered_at, last_success_at, consecutive_failures, last_failure_at FROM scheduled_job_state ORDER BY job_id`; `consecutive_failures` crescente é um job que falha a cada tick.

**O que fazer.** `claim_failed`: para tudo o que depende do agendador (encerramento de organização, expiração de exportação, varredura de cobrança), então trate como urgente: confira o login, o Hyperdrive e as migrations (passos 1 a 3 do checklist das filas). Falha de um job só: veja o `errorClass`, corrija e force a execução ([scheduled-jobs.md](./scheduled-jobs.md)). Se a parada for longa, retirar o binding `OUTBOX_HYPERDRIVE` devolve o comportamento anterior.

<a id="r2-e-midia"></a>

### r2-e-midia — falha do R2 ou da mídia

**O que significa.** A limpeza de imagens removidas falhou ou o catálogo público não leu um arquivo do R2: `media_removed_asset_failed` (apagar objetos ou finalizar o ativo), `media_removed_asset_not_finalized` (o ativo ganhou vínculo depois de seus objetos serem apagados; **uma imagem pode ter perdido arquivos**), `media_removed_reconciliation_incomplete` (a execução terminou com falhas) e `catalog_media_read_failed` (leitura de objeto no catálogo). Falhas de rota de mídia do app aparecem como `server_error` nas rotas `/api/products/:productId/media` e `/api/media/:assetId`, e entram no sinal [http-5xx](#http-5xx).

**Como confirmar.** Workers Logs: os quatro eventos por `errorClass`/`errorCode`; confira o status do R2 e do binding `MEDIA_BUCKET` no console. O procedimento de reconciliação está em [media-storage-reconciliation.md](./media-storage-reconciliation.md).

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

<a id="apagamento-automatico"></a>

### apagamento-automatico — muitas lojas encerradas entrando no apagamento automático

**O que significa.** Com `CLOSURE_AUTO_PURGE_ENABLED` ligado, a varredura horária de privacidade agenda sozinha o purge de cada loja encerrada que chegou a D menos 7 dias ([ADR 0102](../adr/0102-apagamento-automatico-da-loja-encerrada.md)). O evento `closure_auto_purge_volume_high` (nível `warn`) sai quando, nas últimas 24 horas (janela móvel, não o dia do calendário), **mais de 5** lojas entraram no purge por esse caminho (campo `scheduledPurgesLastDay`, só a contagem, sem ID). O aviso vem depois do agendamento, não antes: o freio real são os 7 dias até a execução e o cancelamento pelo Admin. A função não tem teto diário próprio, e quem tem a conexão do papel de privacidade a executa com a chave desligada: a chave só controla o Worker. É o freio do apagamento automático: um volume acima do esperado pode ser um defeito de datas (fuso, relógio, migration) que apagaria lojas antes da hora. Nenhum dado sai no agendamento: o purge só roda a partir do maior entre D mais 48 horas e o agendamento mais 7 dias.

**Como confirmar.** Workers Logs: `event = "closure_auto_purge_volume_high"` e o `privacy_maintenance_complete` da mesma execução (`scheduledPurges`, `scheduledPurgesLastDay`). Banco, só leitura, seguindo a [política de perfis de CLI](./cli-profile-policy.md): `SELECT organization_id, scheduled_at, not_before FROM organization_purges WHERE trigger = 'closure_period' AND scheduled_at > now() - interval '24 hours'`, e para cada uma confira `organization_closures.requested_at` e o fuso da organização (`closure_deadlines`): o agendamento só é legítimo a partir de D menos 7 dias locais.

**Antes de ligar a chave.** `CLOSURE_AUTO_PURGE_ENABLED` só liga em produção com `CLOSURE_NOTICE_EMAIL_ENABLED` ligado e os avisos sendo entregues, e com o ato de suporte disponível no Admin (reemitir ou dispensar um aviso, capacidade `organization:purge`, [runbook dos avisos](./avisos-de-encerramento.md#ato-de-suporte)). Sem o aviso de D menos 7 dias entregue há pelo menos 7 dias nenhuma loja é agendada sozinha nem apagada (`closure_notice_not_delivered`), e as lojas esperam no alerta de [loja-encerrada-parada](#loja-encerrada-parada).

**Quem recebe.** O sinal é `critical` com `notify = wake`: quando o cron de alertas existir (Fase 14, [ADR 0095](../adr/0095-onde-os-alertas-operacionais-vao-rodar.md)), vai um e-mail imediato ao endereço de alertas que o responsável cadastrar, no máximo um a cada 6 horas, só com o nome do sinal, a contagem e a janela. Quem age é um operador do Admin com a capability `organization:purge`, porque o cancelamento exige caso e motivo; o deploy que desliga a chave é do responsável. **Até o cron existir, ninguém é acordado:** o evento fica só no Workers Logs. Enquanto isso, quem liga a chave em um ambiente confere o `privacy_maintenance_complete` de cada hora nos primeiros dias.

**O que fazer.** Se as datas estão certas (um lote real de encerramentos de 90 dias atrás), registre e siga. Se não estão, cancele em lote:

1. **Pare os agendamentos novos.** O responsável põe `CLOSURE_AUTO_PURGE_ENABLED` = `false` e faz o deploy. Os purges já agendados continuam valendo até serem cancelados.
2. **Liste o que ainda pode ser cancelado.** É só leitura, seguindo a [política de perfis de CLI](./cli-profile-policy.md): `SELECT organization_id, scheduled_at, not_before, locked_until FROM organization_purges WHERE trigger = 'closure_period' AND purged_at IS NULL AND storage_touched_at IS NULL ORDER BY not_before`. Um purge com `storage_touched_at` preenchido já começou a apagar o armazenamento e não pode mais ser cancelado. Registre esses no incidente.
3. **Cancele um por um, pelo menor `not_before`.** Para cada organização da lista, o operador abre no Admin um caso de suporte da organização e cancela o purge com motivo (`POST /support-cases/:caseId/purge/cancel`, função `admin_cancel_organization_purge`). O cancelamento devolve a loja a `closed`, fica na auditoria e pausa o caminho automático dela neste encerramento. O primeiro `not_before` de um agendamento é, no mínimo, 7 dias depois dele. Um cancelamento recusado com `purge_in_progress` quer dizer que uma execução segura o purge agora: tente de novo depois de `locked_until` (até 15 minutos).
4. **Se não der tempo de cancelar todos antes do `not_before`,** o último recurso é o responsável retirar o binding `PRIVACY_HYPERDRIVE` do Worker e fazer o deploy. Isso para o job inteiro de privacidade: nenhum purge, encerramento, aviso ou exportação roda, e nada é apagado. As exportações pedidas nesse intervalo esperam a volta do binding, quando o reenvio horário as manda de novo. Depois, termine os cancelamentos e devolva o binding.
5. **Depois.** Cada loja cancelada é uma decisão: pôr a trava legal, agendar de novo pelo Admin sob o caso de exclusão ou deixá-la esperar a correção. O dono continua recebendo os avisos pelas datas (o de D diz "a partir de", que segue verdadeiro). Abra a correção por PR antes de religar a chave.

<a id="loja-encerrada-parada"></a>

### loja-encerrada-parada — loja encerrada parada: sem apagamento, purge preso ou aviso sem entregar

**O que significa.** O evento `closure_purge_overdue` (nível `warn`) traz três contagens, `overduePurges`, `purgesHeldBack` e `closureNoticesOverdue` ([ADR 0102](../adr/0102-apagamento-automatico-da-loja-encerrada.md)), e sai quando uma delas passa de zero.

- `overduePurges` (só com `CLOSURE_AUTO_PURGE_ENABLED` ligado, porque com a chave desligada nenhuma loja seria apagada sozinha): as lojas que continuam `closed` 30 dias depois de D sem trava legal vigente. O apagamento prometido ao lojista não aconteceu por um destes motivos: um cancelamento do Admin neste encerramento (que pausa o caminho automático até alguém decidir), a renovação da assinatura ainda viva num provedor (o cancelamento do encerramento falhou, ou o provedor não tem a porta de saída e a pessoa não cancelou), um acesso temporário do Admin esquecido, ou o aviso de D menos 7 dias que não foi entregue, ou foi entregue há menos de 7 dias (`closure_notice_not_delivered`, por exemplo enquanto o e-mail não está configurado). Sem o aviso entregue, ninguém é apagado: a loja espera até o suporte resolver.
- `purgesHeldBack` (com a chave ligada ou desligada, porque o purge do Admin espera do mesmo jeito): os purges já agendados (`purge_pending`, do período ou do Admin) com o `not_before` vencido que a reconferência na execução segura por um acesso temporário do Admin vigente, uma renovação viva ou o aviso não entregue. A trava legal não conta: ela responde antes, e a decisão é do caso.
- `closureNoticesOverdue` (com a chave ligada ou desligada): os avisos de uma loja ainda em encerramento que seguem **não resolvidos** (nem enviados, nem falhos, nem pulados) há mais de **3 dias** (`CLOSURE_NOTICE_OVERDUE_DAYS`) depois da data do marco. O caso comum é o e-mail não configurado: o consumidor deixa o aviso como está para o envio poder acontecer depois.

**Fora da contagem.** O purge segurado pela trava legal (ela responde antes das outras razões, e a decisão sobre ela é do caso) e a loja `closed` sob trava legal. Um aviso pulado, enviado ou falho com código definitivo (um endereço recusado) não é "não resolvido": o falho segura o apagamento do mesmo jeito, porque não é um aviso entregue, e cai em `overduePurges` ou em `purgesHeldBack`. **Há ato de suporte para o aviso pulado ou falho:** o operador o reemite (um aviso novo do mesmo ciclo, para o dono atual) ou o dispensa com motivo (`owner_account_deleted`, `email_not_verified` ou `email_undeliverable`), sob um caso de privacidade da organização com a decisão registrada. As duas ações são rotas do Admin com a capacidade `organization:purge`, com as condições do [runbook dos avisos](./avisos-de-encerramento.md#ato-de-suporte). Nenhum ato edita um aviso: cada um grava uma linha nova. Dispensar conta como entrega, e o purge ainda espera 7 dias depois dela ([ADR 0102](../adr/0102-apagamento-automatico-da-loja-encerrada.md), emenda do PR E).

**Como confirmar.** Banco, só leitura, seguindo a [política de perfis de CLI](./cli-profile-policy.md): as organizações `closed` cujo `closure_deadlines(requested_at, timezone).deletable_from` mais 30 dias já passou e sem linha em `organization_legal_holds` com `released_at` nulo; para cada uma, veja `organization_purge_cancellations` (depois do `requested_at`), `organization_billing` (provedor, estado e `cancel_at_period_end`) e `tenant_access_grants` vigentes, e os `closure_notices` do ciclo atual (`closure_requested_at = organization_closures.requested_at`): sem um `d7` ou `rescheduled` com `sent_at` preenchido a loja espera. Para um purge já agendado (`purgesHeldBack`): `SELECT organization_id, trigger, not_before FROM organization_purges WHERE purged_at IS NULL AND not_before < now()`, e para cada um veja a trava legal, os acessos vigentes, a cobrança e esses avisos. Para os avisos parados: `SELECT organization_id, milestone, due_at FROM closure_notices WHERE NOT skipped AND sent_at IS NULL AND failed_at IS NULL AND due_at < now() - interval '3 days'`.

**O que fazer.** Cada loja é uma decisão: pôr a trava legal (se há motivo para guardar), agendar o purge pelo Admin sob o caso de exclusão, revogar o acesso temporário esquecido ou resolver a renovação no provedor (siga [cobranca-reconcile](#cobranca-reconcile) e o [runbook dos provedores](./billing-providers.md)) ou, se o aviso não foi entregue, corrigir o envio (o e-mail não configurado, um endereço recusado) para o aviso sair; não se grava `sent_at` à mão. Registre a decisão no caso.

**Com o e-mail desligado, nenhum purge sai**, nem o do Admin por caso de privacidade: nenhum aviso fica entregue, então o caso pode agendar o purge e a execução espera. Com o e-mail ligado, os avisos saem, e o repasse horário envia o mais recente de cada ciclo devido. O ato de suporte resolve o que sobra (aviso pulado, falho ou de dono sem conta). O prazo de resposta do caso (`PRIVACY_CASE_RESPONSE_DAYS`, 15 dias, provisório) segue valendo: responda ao titular dentro dele, dizendo que a exclusão está aceita e só ocorre depois do aviso, e registre o motivo da espera no caso.

<a id="aviso-de-encerramento-falhando"></a>

### aviso-de-encerramento-falhando — falha no envio do e-mail de aviso do encerramento

**O que significa.** O consumidor do aviso de encerramento tentou enviar o e-mail, e o provedor (Resend) recusou ou não respondeu. O evento é `closure_notice_email_failed` (nível `error`), com `outcome`: `rejected` quando o provedor recusou o envio de forma definitiva (400, 422 ou outra recusa de conteúdo ou endereço; o aviso fica falho com o código `email_rejected`, sem nova tentativa), e `failure` quando o provedor não aceitou por ora (401, 403, 409, 429, 5xx ou falha de rede; a fila tenta de novo, e o aviso segue devido). Traz `httpStatus` quando houve resposta, `milestone` e `noticeId` (id opaco). Nunca traz endereço nem nome.

**Como confirmar.** Workers Logs: `event = "closure_notice_email_failed"`, agrupado por `outcome`, `httpStatus` e `milestone`. Muitos `failure` com 401 ou 403 apontam para a chave ou o remetente do provedor; 5xx ou 429, para o provedor. Banco, só leitura, seguindo a [política de perfis de CLI](./cli-profile-policy.md): `SELECT organization_id, milestone, due_at, failed_at FROM closure_notices WHERE failure_code = 'email_rejected' AND failed_at > now() - interval '24 hours'`.

**O que fazer.** `outcome = "failure"`: o problema é do provedor ou da configuração. Confira o estado do Resend e o segredo `RESEND_API_KEY` do Worker (sem imprimir o valor). Não é preciso reenviar à mão: a fila tenta de novo, e o repasse horário envia o devido. Se a mensagem cair na DLQ, o incidente aparece em [dlq](#dlq). `outcome = "rejected"`: o provedor recusou o endereço, e não há reenvio automático. O dono corrige o endereço da conta, e o suporte, com um caso de privacidade aberto, reemite o aviso ([runbook dos avisos](./avisos-de-encerramento.md#ato-de-suporte)). Se o endereço não puder ser entregue, o responsável dispensa o aviso com o motivo `email_undeliverable`, sob um caso com a decisão registrada. Nunca grave `sent_at` nem `failed_at` à mão.

