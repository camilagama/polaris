# Prova do apagamento automático com datas retroagidas (staging)

**Gatilho:** o [item 22 do release-checklist](./release-checklist.md#22-freio-do-apagamento-automático-block) pede a prova de fiação do apagamento automático em staging antes de ligar `CLOSURE_AUTO_PURGE_ENABLED` em produção: o agendamento em D menos 7 dias locais e a execução a partir de D mais 48 horas, numa loja sintética, sem esperar 90 dias ([ADR 0102](../adr/0102-apagamento-automatico-da-loja-encerrada.md), consequências). Refaça a prova também depois de mudar `schedule_closed_organization_purges`, `closed_organization_purge_wait`, `organization_purge_blocker`, `closure_deadlines` ou os avisos do encerramento.

**Quem:** o **operador** (Arrascaeta ou Juan) roda os passos; o **Diego** confere o resultado. O dev só entrega este roteiro e a chave.

## Pré-requisitos de acesso

- Perfil do dono do banco do **staging**, seguindo a [política de perfis de CLI](./cli-profile-policy.md). Não rode nada sem confirmar o perfil e a identidade permitidos. **Nunca na produção.**
- Entregue a connection string ao `psql` por variável de ambiente (`PGHOST`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`) ou arquivo local fora do repositório, nunca na linha de comando, no PR nem no registro da prova.
- **Confirme o ambiente antes de qualquer escrita**, na mesma sessão do `psql`: `SELECT shobj_description(oid, 'pg_database') FROM pg_database WHERE datname = current_database();` tem de devolver exatamente `polaris.environment=staging` (o marcador do [ADR 0097](../adr/0097-staging-fixo-e-producao-em-conta-separada.md)). Qualquer outro texto, ou vazio: pare.
- O dono da Neon ignora o RLS que as tabelas forçam (o mesmo pré-requisito da [auditoria depois do purge](./auditoria-do-tenant-apos-o-purge.md#pré-requisitos-de-acesso)). Se algum `UPDATE` abaixo disser `UPDATE 0` onde o texto espera `UPDATE 1`, o perfil não é o certo: pare e não contorne.
- No staging, já no ar: `CLOSURE_AUTO_PURGE_ENABLED` = `"true"` e `CLOSURE_NOTICE_EMAIL_ENABLED` = `"true"` (confira o `env.staging` do `wrangler.jsonc` do SHA implantado), os dois alertas de [apagamento-automatico](./alertas.md#apagamento-automatico) e [loja-encerrada-parada](./alertas.md#loja-encerrada-parada), e o painel `/loja-encerrada`.
- Acesso aos Workers Logs do `polaris-web-staging`. Eles guardam poucos dias (3 no plano Free): **cada etapa é conferida no mesmo dia**, e o registro guarda só nome do evento, hora e contagens.

## Alvo seguro

Uma loja **sintética de staging encerrada só para esta prova**, escolhida por ID (`<org>` abaixo). A etapa 2 **apaga a loja de verdade**: não use uma loja que alguém ainda precise (a loja 5 do Gate 7 só se a decisão for apagá-la agora). A dona da loja tem de ser uma conta de teste com e-mail **verificado** numa caixa de teste (`teste.araute.app`): sem o aviso de D menos 7 dias entregue há 7 dias nada é agendado nem apagado. Nada de dado pessoal no registro da prova: IDs opacos, datas e contagens.

Crie a loja e encerre-a pelo app. A loja só chega a `closed` quando a janela de recuperação (30 dias) acaba: use uma que já esteja `closed` ou, se ela ainda está em `closing`, leve-a a `closed` sem esperar os 30 dias pelo [passo A](#a-loja-ainda-em-closing-levar-a-closed-sem-esperar-a-janela). Com a chave ligada, **qualquer** loja encerrada de staging que cumpra as regras é agendada pela mesma varredura, **a partir do primeiro cron depois do deploy que liga a chave**, não só durante a prova. Liste as candidatas **antes desse deploy** e de novo antes de começar (são só IDs), para saber o que mais pode entrar e para avisar o Diego sobre as fixtures de outras tarefas e a loja 5 do Gate 7:

```sql
SELECT o.id, c.requested_at, d.d7_at
  FROM public.organizations AS o
  JOIN public.organization_closures AS c ON c.organization_id = o.id
  CROSS JOIN LATERAL public.closure_deadlines(c.requested_at, o.timezone) AS d
 WHERE o.status = 'closed' AND d.d7_at <= now() + interval '3 days'
 ORDER BY c.requested_at;
```

## Passos

Os comandos são do `psql`. Defina a loja uma vez: `\set org '<org>'`.

### A. Loja ainda em `closing`: levar a `closed` sem esperar a janela

Só para a loja que ainda está em `closing` (o dono acabou de encerrá-la pelo app). Loja já `closed`: comece no passo 0.

**Por que é preciso.** Quem leva `closing` a `closed` é a varredura horária de privacidade (`privacy.maintenance`, cron `17 * * * *` do `wrangler.jsonc`, pista `maintenance`; [scheduled-jobs](./scheduled-jobs.md)): `runPrivacyMaintenance` chama `finalizeExpiredClosures` antes de agendar e de gravar os avisos (`apps/web/src/server/privacy/maintenance.ts`), e a função `finalize_expired_closures` (`packages/db/drizzle/0065_organization_closure.sql`, o `WITH due`) escolhe as lojas com `status = 'closing'` e `recover_until <= now()`, passa-as a `closed` e grava `closed_at = now()`. `recovered_at` não entra na condição: a loja recuperada volta a `active` (`recover_organization_closure`), então `closing` já implica pedido não recuperado. Sem recuar `recover_until`, a espera é a janela inteira.

1. **Confirme o ambiente** (o marcador `polaris.environment=staging` dos pré-requisitos, na mesma sessão) e **leia a loja**:

   ```sql
   SELECT o.status, c.requested_at, c.recover_until, c.closed_at, c.recovered_at,
          c.recover_until - c.requested_at AS janela
     FROM public.organizations AS o
     JOIN public.organization_closures AS c ON c.organization_id = o.id
    WHERE o.id = :'org';
   ```

   Esperado: `status = closing`, `closed_at` e `recovered_at` nulos, `janela` menor que 2016 horas (a de uma loja encerrada pelo app é de 30 dias). **Anote `requested_at` e `recover_until`**: são os valores originais que a reversão devolve. Qualquer outro resultado: pare e escolha outra loja.

   **Antes de qualquer `UPDATE`, confira a dona e os bloqueios** rodando agora o segundo e o terceiro comandos do [passo 0](#0-conferir-a-loja-e-guardar-as-datas-originais) (bloqueios e dona verificada; o primeiro comando do passo 0 espera `closed` e só passa depois deste passo). Esperado, como lá: as quatro colunas do segundo comando `false` (retenção legal, acesso de suporte, cancelamento do apagamento, renovação viva), `owners ≥ 1` e `owners_verified = true`. Se algum não bater, **pare antes do item 2 (o primeiro `UPDATE`)**: a loja não serve para a prova (sem dona verificada ou com bloqueio ela não é agendada nem apagada), e recuar as datas só a gastaria. Escolha outra loja (em `closing`, volte ao item 1 com ela; já `closed`, comece no passo 0) e **não** libere o bloqueio nem marque o e-mail como verificado à mão para encaixar a prova. Registre só o ID opaco da loja descartada e qual coluna reprovou.
2. **Recue o pedido e mantenha a duração da janela.** O pedido passa a ser de 84 dias atrás (2016 horas, as contas em horas, para o fuso da sessão não mexer nelas) e `recover_until` fica no passado, porque a janela (30 dias) é menor que os 84 dias. O `closed_at` fica como está (nulo): quem o grava é a varredura.

   ```sql
   BEGIN;
   UPDATE public.organization_closures
      SET requested_at  = now() - interval '2016 hours',
          recover_until = now() - interval '2016 hours' + (recover_until - requested_at)
    WHERE organization_id = :'org'
      AND closed_at IS NULL AND recovered_at IS NULL
      AND recover_until - requested_at < interval '2016 hours'
      AND EXISTS (SELECT 1 FROM public.organizations
                   WHERE id = :'org' AND status = 'closing');
   -- confira "UPDATE 1" e então rode COMMIT; (com qualquer outro resultado, ROLLBACK;)
   ```

   Esperado: `UPDATE 1`. Se não for, `ROLLBACK;` e volte à leitura do item 1. Se for, `COMMIT;`. O `UPDATE` cabe nas constraints da tabela (`organization_closures_window_allowed`: `recover_until` depois de `requested_at` e até 2160 horas dele).
3. **Espere a próxima varredura** (no máximo uma hora; o evento `privacy_maintenance_complete` traz `closedOrganizations ≥ 1`) e confira:

   ```sql
   SELECT o.status, c.requested_at, c.recover_until, c.closed_at
     FROM public.organizations AS o
     JOIN public.organization_closures AS c ON c.organization_id = o.id
    WHERE o.id = :'org';
   ```

   Esperado: `status = closed`, `closed_at` preenchido (a hora da varredura), `recover_until` no passado.

Daqui em diante siga pelo passo 0, que agora passa. **O passo 1 pode ser pulado**: o pedido já foi recuado em 84 dias, e recuar de novo só o desloca por algumas horas. Pule o `UPDATE` do passo 1 e confira só que o pedido já é de 84 dias atrás (`now() - requested_at` de 84 dias mais as horas de espera). A varredura que fechou a loja já pode ter gravado os avisos do ciclo recuado (ela grava os avisos depois de fechar e agendar): comece o passo 1 pela conferência do aviso (item 2) e pela entrega do `d7`. O `closed_at` fica na hora da varredura, não no passado; a etapa 2 o recua junto com o pedido. Com o passo 0 depois do A, o `requested_at` e o `recover_until` que ele manda anotar já são os recuados; os originais são os do passo A.

### 0. Conferir a loja e guardar as datas originais

```sql
SELECT o.status, o.timezone, c.requested_at, c.recover_until, c.closed_at, c.recovered_at
  FROM public.organizations AS o
  JOIN public.organization_closures AS c ON c.organization_id = o.id
 WHERE o.id = :'org';

SELECT
  EXISTS (SELECT 1 FROM public.organization_legal_holds
           WHERE organization_id = :'org' AND released_at IS NULL) AS legal_hold,
  EXISTS (SELECT 1 FROM public.tenant_access_grants
           WHERE organization_id = :'org' AND revoked_at IS NULL AND expires_at > now()) AS tenant_access,
  EXISTS (SELECT 1 FROM public.organization_purge_cancellations
           WHERE organization_id = :'org') AS cancellation,
  EXISTS (SELECT 1 FROM public.organization_billing
           WHERE organization_id = :'org' AND provider IS NOT NULL AND provider_ref IS NOT NULL
             AND state IN ('trialing', 'active', 'grace') AND NOT cancel_at_period_end) AS renewal_alive;

SELECT count(*) AS owners, bool_and(u.email_verified) AS owners_verified
  FROM public.memberships AS m
  JOIN public."user" AS u ON u.id = m.user_id
 WHERE m.organization_id = :'org' AND m.role = 'owner' AND m.status = 'active';
```

Esperado: `status = closed`, `closed_at` preenchido, `recovered_at` nulo; as quatro colunas do segundo comando `false`; `owners ≥ 1` e `owners_verified = true`. Qualquer outro resultado: escolha outra loja. **Anote** `requested_at`, `recover_until` e `closed_at` do primeiro comando: são o que a reversão devolve (numa loja que veio do passo A, são os valores já recuados; os originais são os anotados no passo A).

### 1. Recuar as datas para D menos 6 dias (agendamento)

O pedido passa a ser de 84 dias atrás (2016 horas; as contas em horas, para o fuso da sessão não mexer nelas): D é o pedido mais 90 dias locais, então D fica 6 dias no futuro e D menos 7 já passou. A janela de recuperação mantém a duração que a loja tinha.

```sql
BEGIN;
UPDATE public.organization_closures
   SET requested_at  = now() - interval '2016 hours',
       recover_until = now() - interval '2016 hours' + (recover_until - requested_at),
       closed_at     = now() - interval '2016 hours' + (recover_until - requested_at)
 WHERE organization_id = :'org'
   AND closed_at IS NOT NULL AND recovered_at IS NULL
   AND EXISTS (SELECT 1 FROM public.organizations
                WHERE id = :'org' AND status = 'closed');
-- confira "UPDATE 1" e então rode COMMIT; (com qualquer outro resultado, ROLLBACK;)
```

Esperado: `UPDATE 1`. Se não for, `ROLLBACK;` e volte ao passo 0. Se for, `COMMIT;`.

O que a varredura horária faz agora (cron `17 * * * *`, [scheduled-jobs](./scheduled-jobs.md)):

1. **Primeira varredura:** os marcos `closure` e `d30` do novo ciclo ficam gravados como pulados e o `d7` sai por e-mail (só o último marco devido vai). A loja **ainda não é agendada**: o aviso de D menos 7 tem de estar entregue há 7 dias (`closure_notice_not_delivered`).
2. Confira o aviso (sem e-mail, só estado):

   ```sql
   SELECT n.milestone, n.skipped, n.due_at,
          n.sent_at IS NOT NULL AS sent, n.failed_at IS NOT NULL AS failed,
          n.dismissed_at IS NOT NULL AS dismissed
     FROM public.closure_notices AS n
     JOIN public.organization_closures AS c
       ON c.organization_id = n.organization_id AND c.requested_at = n.closure_requested_at
    WHERE n.organization_id = :'org'
    ORDER BY n.due_at;
   ```

   Esperado: `closure` e `d30` com `skipped = true`; `d7` com `sent = true`. `d7` sem `sent` depois de uma hora: veja os eventos abaixo e o [runbook dos avisos](./avisos-de-encerramento.md#conferir) (e-mail não verificado ou falho pede o [ato de suporte](./avisos-de-encerramento.md#ato-de-suporte)); não grave `sent_at` à mão para um aviso que não saiu.
3. **Recue a entrega do `d7`** para 8 dias atrás, o que vale como "entregue há mais de 7 dias" sem esperar uma semana:

   ```sql
   UPDATE public.closure_notices AS n
      SET sent_at = now() - interval '192 hours'
     FROM public.organization_closures AS c
    WHERE n.organization_id = :'org'
      AND c.organization_id = n.organization_id AND c.requested_at = n.closure_requested_at
      AND n.milestone = 'd7' AND n.sent_at IS NOT NULL;
   ```

   Esperado: `UPDATE 1`.
4. **Varredura seguinte** (no máximo uma hora depois): a loja é agendada. Confira:

   ```sql
   SELECT status FROM public.organizations WHERE id = :'org';

   SELECT trigger, scheduled_at, not_before, attempts, purged_at, storage_touched_at
     FROM public.organization_purges WHERE organization_id = :'org';

   SELECT actor, event_type, created_at FROM public.platform_audit_events
    WHERE organization_id = :'org' AND event_type = 'organization.purge_scheduled'
    ORDER BY created_at DESC LIMIT 1;
   ```

   Esperado: `status = purge_pending`; `trigger = closure_period`, `attempts = 0`, `purged_at` e `storage_touched_at` nulos; `not_before` é **D mais 48 horas** (meia-noite local do dia de hoje mais 8, no fuso da loja) e nunca menos de `scheduled_at` mais 7 dias; o evento é `actor = system`. **Nenhum dado foi apagado** nesta etapa.

**Parar aqui é um resultado válido** (D menos 7 provado). Registre e siga para a etapa 2 só se a loja pode mesmo ser apagada.

### 2. Recuar as datas para D mais 48 horas (execução)

**Esta etapa leva ao apagamento definitivo da loja.** Ela recua o pedido para 92 dias atrás (2208 horas: D é a meia-noite local de dois dias atrás, então D mais 48 horas é a meia-noite local de hoje, que já passou; recuar mais deixaria o marco `deletion_day` atrasado há mais de 72 horas, e o aviso atrasado dispararia o `closure_purge_overdue` à toa), leva o aviso do ciclo junto (a chave do ciclo do aviso é o `requested_at`) e põe o agendamento no passado, mantendo o `not_before` coerente (o maior entre D mais 48 horas e o agendamento mais 7 dias), para não nascer um aviso `rescheduled` novo, que reiniciaria os 7 dias de espera.

```sql
SELECT requested_at AS old_requested FROM public.organization_closures
 WHERE organization_id = :'org' \gset
SELECT now() - interval '2208 hours' AS new_requested \gset

BEGIN;
UPDATE public.organization_closures
   SET requested_at  = :'new_requested'::timestamptz,
       recover_until = :'new_requested'::timestamptz + (recover_until - requested_at),
       closed_at     = :'new_requested'::timestamptz + (recover_until - requested_at)
 WHERE organization_id = :'org' AND recovered_at IS NULL
   AND EXISTS (SELECT 1 FROM public.organizations
                WHERE id = :'org' AND status = 'purge_pending');

UPDATE public.closure_notices
   SET closure_requested_at = :'new_requested'::timestamptz
 WHERE organization_id = :'org' AND closure_requested_at = :'old_requested'::timestamptz;

UPDATE public.organization_purges AS p
   SET scheduled_at = now() - interval '192 hours',
       not_before   = GREATEST(deadline.deletable_from + interval '48 hours', now() - interval '24 hours')
  FROM public.organizations AS o
  JOIN public.organization_closures AS c ON c.organization_id = o.id
  CROSS JOIN LATERAL public.closure_deadlines(c.requested_at, o.timezone) AS deadline
 WHERE p.organization_id = :'org' AND o.id = p.organization_id
   AND p.trigger = 'closure_period' AND p.purged_at IS NULL AND p.storage_touched_at IS NULL;
-- confira as três contagens e então rode COMMIT; (com qualquer outra, ROLLBACK;)
```

Esperado: `UPDATE 1`, `UPDATE` com a contagem de avisos do ciclo (pelo menos 3) e `UPDATE 1`. Qualquer contagem diferente: `ROLLBACK;` (isto desfaz a etapa 2 inteira, e a seção de reversão abaixo não é necessária). Se estiver certo, `COMMIT;`. Antes de rodar, confira que a loja é a do passo 0 e está `purge_pending` (`SELECT status FROM public.organizations WHERE id = :'org';`): o `UPDATE` do pedido abaixo também só vale para essa situação. Se a hora local da loja for logo depois da meia-noite, espere a hora seguinte, para o `not_before` não ficar no futuro.

Na varredura seguinte o purge vence (`not_before` no passado, pedido há 92 dias, aviso entregue há mais de 7 dias): o job apaga o armazenamento e o banco, e o marco `deletion_day` do ciclo recuado fica gravado. Confira:

```sql
SELECT o.status, p.purged_at, p.swept_at, p.attempts, p.last_error_code
  FROM public.organizations AS o
  JOIN public.organization_purges AS p ON p.organization_id = o.id
 WHERE o.id = :'org';

SELECT actor, event_type, created_at FROM public.platform_audit_events
 WHERE organization_id = :'org' AND event_type = 'organization.purge_completed'
 ORDER BY created_at DESC LIMIT 1;
```

Esperado: `status = purged`, `purged_at` preenchido, `last_error_code` nulo; evento `actor = system`. Se `swept_at` ainda está nulo, a segunda varredura do armazenamento corre na execução seguinte. A auditoria que sobrevive ao purge está em [auditoria depois do purge](./auditoria-do-tenant-apos-o-purge.md).

## Verificação (eventos de log no mesmo dia)

Workers Logs do `polaris-web-staging`, filtrando por `event`. Registre o nome, a hora e as contagens.

| Quando | Evento | Esperado |
| --- | --- | --- |
| Passo A (se feito) | `privacy_maintenance_complete` | `closedOrganizations ≥ 1` na varredura seguinte ao `UPDATE` |
| Depois do passo 1 | `privacy_maintenance_complete` | `purgeSchedulingEnabled = true`, `closureNoticesRecorded ≥ 1`, `closureNoticesSkipped ≥ 2`, `scheduledPurges = 0` |
| Depois do passo 1 | `closure_notice_email_sent` | `milestone = d7`, `outcome = success` |
| Varredura do passo 4 | `privacy_maintenance_complete` | `scheduledPurges = 1`, `scheduledPurgesLastDay ≥ 1` (acima de 5 o `closure_auto_purge_volume_high` sai: investigue as outras lojas) |
| Varredura da etapa 2 | `organization_purge_complete` | `purged = 1`, `failed = 0` |
| Em nenhum momento | `closure_auto_purge_volume_high`, `closure_purge_overdue`, `organization_purge_stalled` | ausentes (os dois primeiros mandam o e-mail do alerta da Cloudflare: se ele chegou, investigue a causa pelos runbooks de [apagamento-automatico](./alertas.md#apagamento-automatico) e [loja-encerrada-parada](./alertas.md#loja-encerrada-parada)) |

O `closure_purge_overdue` é o sinal de [loja-encerrada-parada](./alertas.md#loja-encerrada-parada): `purgesHeldBack ≥ 1` na etapa 2 quer dizer que a reconferência segurou o purge (acesso temporário, renovação viva ou aviso sem a entrega de 7 dias); o `organization_purge_step_failed` com `outcome = rejected` traz o motivo (`reason`). O marco `deletion_day` do ciclo recuado também é gravado na etapa 2, mas o purge apaga a fila de eventos da loja: o e-mail dele pode não sair, e não faz parte da prova.

Registro da prova (no PR do item 22 ou na issue do go-live, sem dado pessoal): o SHA implantado, o ID opaco da loja, as datas originais, a hora de cada passo, a saída dos comandos de verificação e os eventos acima. O Diego confirma o `not_before` (D mais 48 horas) e que nenhum outro purge foi agendado sem ser esperado.

## Rollback ou forward-fix

- **Passo A com a loja ainda em `closing`** (a varredura não passou): devolva as duas datas anotadas no passo A. O `closed_at` continua nulo.

  ```sql
  UPDATE public.organization_closures
     SET requested_at = '<requested_at original do passo A>', recover_until = '<recover_until original do passo A>'
   WHERE organization_id = :'org' AND closed_at IS NULL AND recovered_at IS NULL
     AND EXISTS (SELECT 1 FROM public.organizations WHERE id = :'org' AND status = 'closing');
  ```

  Esperado: `UPDATE 1`. Depois que a varredura levou a loja a `closed`, ela **não volta** a `closing` (nenhuma função da aplicação faz isso, e `recover_organization_closure` só vale em `closing`): a reversão passa a ser a do item seguinte, e o `recover_until` original, no futuro, não reabre a janela. Para o app voltar a mostrar a loja como recuperável não há caminho neste roteiro: use outra loja.
- **Datas erradas, antes de a loja ser agendada** (a loja continua `closed`): devolva as datas anotadas no passo 0 e deixe o ciclo recuado para trás. Se a loja veio do passo A e a prova vai ser abandonada, `requested_at` e `recover_until` são os **originais do passo A** (não os do passo 0) e `closed_at` é o do passo 0; o efeito é a loja ficar `closed` com `recover_until` no futuro, que a varredura não reabre e que o agendamento só aceita depois que essa janela original acabar (`recover_until <= now()`). Para repetir a prova com a mesma loja, deixe as datas recuadas e siga do passo 1:

  ```sql
  UPDATE public.organization_closures
     SET requested_at = '<requested_at anotado>', recover_until = '<recover_until anotado>',
         closed_at = '<closed_at anotado>'
   WHERE organization_id = :'org' AND recovered_at IS NULL;
  ```

  Esperado: `UPDATE 1`. Os avisos do ciclo recuado ficam gravados e não atrapalham (a chave deles é o ciclo); os do ciclo original não foram tocados.
- **Agendada errado** (a loja está `purge_pending`, ou outra loja entrou): a chave desliga o Worker, não o banco. Siga o passo a passo de [apagamento-automatico](./alertas.md#apagamento-automatico): (1) o responsável põe `CLOSURE_AUTO_PURGE_ENABLED` = `"false"` no `env.staging` e faz o deploy; (2) o operador cancela o purge pelo Admin (`POST /support-cases/:caseId/purge/cancel`, com `Origin`), que devolve a loja a `closed`; (3) só então devolva as datas, como acima. O cancelamento pausa o caminho automático **dessa** loja neste encerramento: para repetir a prova use outra loja.
- **Depois de `storage_touched_at` preenchido** o purge já apagou objetos e o cancelamento é recusado para sempre: é a etapa 2 funcionando. Registre e confira a conclusão (`purged_at`).
- **Aviso falho ou sem entrega** (passo 1): resolva pelo [ato de suporte](./avisos-de-encerramento.md#ato-de-suporte); o roteiro continua depois.
- **Voltar o staging ao estado anterior à prova:** a chave volta a `"false"` por PR e deploy. Nenhuma migration nem função muda neste roteiro; só dados da loja da prova.

## Limites

- O roteiro altera linhas de uma loja sintética com SQL do dono do banco, o único caminho que **recua** `requested_at`, `recover_until`, `closed_at`, `closure_notices.sent_at` e `organization_purges.not_before`: as funções da aplicação os gravam só para frente, no instante do ato. Não o use fora do staging.
- Prova a fiação do Worker, da varredura, dos avisos e das funções com as datas recuadas. Os critérios AC-47, AC-49 e AC-61 são dos gates de banco (`purge-functions` e as verificações do apagamento automático), que rodam no CI, não aqui.
- A prova é por uma loja; o volume e o fuso de lojas diferentes ficam nos gates.

Escalonamento: o responsável pelo staging (Arrascaeta) e o revisor de privacidade (Rodrigo).
