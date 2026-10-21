# Jobs agendados

**Gatilho:** antes de ligar o `OUTBOX_HYPERDRIVE` em produção (o agendador passa a valer nesse momento), ao acrescentar um job ou um Cron Trigger, ao mudar a cadência de um job, ou ao investigar um cron que falha ([ADR 0086](../adr/0086-framework-de-jobs-agendados.md)).

> **Nada deste procedimento foi executado**, e o PR do agendador não cria recurso algum na conta Cloudflare nem toca o banco remoto. Os comandos são para o responsável, depois de aprovar, com a identidade confirmada pela [política de perfis de CLI](./cli-profile-policy.md): não execute o CLI sem confirmar o perfil e a conta permitidos. Consultas SQL abaixo rodam com a **identidade administrativa com que as migrations rodam** (a que ignora o RLS, `BYPASSRLS`; a tabela tem RLS forçado e uma política só para o papel do outbox, então um login sem essa permissão **não enxerga linha alguma e um `UPDATE` afeta zero linhas, sem erro**), num ambiente que o responsável escolheu, e nunca com segredo em comando ou log. Rode o `UPDATE` dentro de `BEGIN; ... COMMIT;` e confira `UPDATE 1` antes de confirmar: zero linhas quer dizer identidade errada, e a saída **não** é criar política ou `GRANT` para contornar.

## O que existe

Em `apps/web/wrangler.jsonc` (Worker `polaris-web`) há **dois** Cron Triggers, de um limite de **cinco** por conta no plano Workers Free (nenhum outro Worker declara cron). Cada um é uma **pista**: o cron dispara, o agendador pergunta ao banco quais jobs da pista estão vencidos, toma o *lease* de cada um, roda e registra.

| Cron | Pista | Jobs (nesta ordem) | Cadência |
| --- | --- | --- | --- |
| `17 * * * *` | `maintenance` | `media.maintenance`, `billing.maintenance`, `privacy.maintenance`, `auth.login_lock_expiry` (expurgo do contador do bloqueio da entrada, pela conexão `AUTH_HYPERDRIVE`), `auth.unverified_user_purge` (apaga o usuário por senha nunca verificado, lotes de 200, até 5 por execução, pela mesma conexão) | 1 hora |
| `19 * * * *` | `outbox` | `outbox.dispatch` (despachante, varredor e expiração do registro do consumidor) | 1 hora |

Registrados e **desligados** (sem pista, sem handler, nunca rodam): `billing.provider_reconcile` (espera o Gate 7, Asaas e Woovi) e `expenses.recurring_generation` (a geração ao ler já cobre; um job exige um papel que escreve em todas as organizações, decisão de segurança do responsável). A fonte de tudo isso é `@polaris/domain/scheduling/scheduled-jobs`; um teste confere que o `wrangler.jsonc` declara exatamente os crons das pistas.

O estado fica na tabela `scheduled_job_state` (nome do job, início e fim da última execução bem-sucedida, *lease*, contagem de falhas seguidas), acessada só pelas funções `claim_scheduled_job`, `complete_scheduled_job` e `release_scheduled_job` do papel do outbox (o mesmo login e o mesmo `OUTBOX_HYPERDRIVE` do despachante). Sem esse binding, cada cron roda todos os jobs da pista a cada disparo (aviso `scheduler_state_unavailable`), como antes do agendador.

## Como um job vence

O tempo é cortado em janelas da cadência do job (a hora cheia, em UTC). O job está vencido quando a janela atual é posterior à da última execução bem-sucedida, contada pelo instante em que ela **começou**. Depois de uma lacuna, uma execução cobre tudo (cada job lê do banco o trabalho devido). Falha ou "papel não provisionado" não cobrem a janela: o próximo tick tenta de novo. Um *lease* de 960 s impede duas execuções do mesmo job ao mesmo tempo; uma execução que morreu é retomada quando o *lease* vence (`recovered: true`).

## Antes de ligar (responsável)

1. **Migration 0073 (ou o número que tiver na `main`) aplicada no banco do ambiente antes do Worker.** Com o `OUTBOX_HYPERDRIVE` ligado e a migration ausente, os crons **falham sem rodar nada** (de propósito: sem o *lease* dois jobs poderiam se sobrepor).
2. O `OUTBOX_HYPERDRIVE` entra no passo 7 do [checklist das filas](./queues.md), depois de medir. A migration só concede às funções novas o mesmo papel (`polaris_outbox_runtime`): nenhum login novo, nenhum Hyperdrive novo.
3. **Alerta antes de ligar.** Com o binding ligado, a tabela de estado passa a ser dependência de **todos** os jobs das duas pistas, inclusive o encerramento de organizações e a expiração de exportações (prazos de privacidade) e a varredura de cobrança: se o login do outbox falhar (senha rotacionada, Hyperdrive fora, migration ausente), **nada roda** e o cron falha (`scheduled_job_claim_failed`, e a falha do cron). Ligue, antes do passo 7 do checklist das filas, o alerta sobre `scheduled_job_claim_failed` (o sinal `agendador-falhando`, definido no [runbook de alertas](./alertas.md)) e sobre falha repetida dos dois crons; sem ele a parada é silenciosa. Desde o ADR 0089 as linhas do agendador são objetos com o nome no campo `event`: o alerta filtra por `event = "scheduled_job_claim_failed"`, não pelo texto da mensagem.
4. **Medir o CPU do tick** numa prévia com banco descartável (`wrangler tail` em cada cron): o `cpuTime` precisa ficar abaixo de 10 ms no plano Free. A pista `maintenance` abre uma conexão a mais que antes (a do estado, além de mídia, cobrança e privacidade) e já não tinha garantia de caber; se não couber, separe um job em pista própria (outro trigger: restam três) ou leve ao responsável a decisão do plano pago. **Não foi medido.**

## Verificação

1. No `wrangler tail`, cada tick mostra uma linha `scheduled_job_run` por job (`job`, `lane`, `outcome`, `durationMs`, `missedWindows`, `recovered`) ou `scheduled_job_skipped` (`outcome: "skipped"` e `reason`: `not_due` ou `busy`). `outcome` segue o esquema canônico do [ADR 0091](../adr/0091-esquema-canonico-de-eventos-largos.md): `success`, `skipped` ou `failure` (antes eram `completed`, `skipped` e `failed`; filtro ou alerta que dependa dos valores antigos muda). A linha não traz dado de cliente; em falha, só a classe do erro (`errorClass`, antes `errorName`) e um código (`errorCode`: SQLSTATE ou do provedor). `durationMs` é tempo de parede, não de CPU.
2. Dois disparos na mesma hora: o segundo mostra `scheduled_job_skipped` com `reason: "not_due"` e nada roda duas vezes.
3. Estado de um job (somente leitura, como dono do banco): `SELECT job_id, covered_at, last_success_at, lease_until, consecutive_failures, last_failure_at FROM scheduled_job_state ORDER BY job_id`. Um job com `consecutive_failures` crescente está falhando a cada tick; o log do cron traz a classe do erro.
4. `scheduled_job_lease_lost` (com `runOutcome`, o resultado da execução que perdeu o *lease*) quer dizer que uma execução passou do *lease* (960 s) e outra a retomou; investigue o job lento.

## Forçar, mudar ou desligar

- **Forçar uma execução dentro da janela** (por exemplo, depois de corrigir a causa de uma falha, sem esperar a hora seguinte): como dono do banco, `UPDATE scheduled_job_state SET covered_at = NULL WHERE job_id = '<job>'` e dispare o cron (ou espere o tick). Um *lease* vivo (`lease_until` no futuro) continua valendo.
- **Mudar a cadência de um job:** edite `cadenceSeconds` no registro (um divisor de um dia, nunca menor que o tick da pista); não há migration, a cadência é argumento da tomada. Cadência menor que a hora exige também um tick menor (outra expressão no `wrangler.jsonc` e na pista, no mesmo PR) e **acorda o banco do Neon mais vezes** (no plano gratuito o compute suspende depois de alguns minutos sem uso): é decisão de custo do responsável (ADR 0076).
- **Acrescentar um job:** uma entrada no registro (com a razão de a repetição ser segura), um handler no Worker e, se for expurgo, a classe de retenção **aprovada** no mesmo PR (o teste da retenção falha para classe em `proposta`).
- **Ligar um job desligado:** só com a pendência resolvida (o Gate 7, ou a decisão do papel multi-organização); troque `status` para `enabled`, dê pista e handler. O teste do registro lista o que falta.
- **Parar o agendador sem apagar nada:** retire o binding `OUTBOX_HYPERDRIVE` (os jobs voltam a rodar a cada disparo, sem *lease*; o despachante deixa de enviar, ver o [runbook das filas](./queues.md)) ou retire o cron da pista que quer parar.

## Rollback ou forward-fix

A migration é aditiva (uma tabela e três funções). Para voltar o comportamento anterior basta desfazer o deploy do Worker ou retirar o binding; a tabela pode ficar. Remover a tabela e as funções exige uma migration revisada.

## Limites conhecidos

- Nada foi criado nem medido na conta (CPU dos ticks, cron real, Neon acordando).
- Cadência horária; um job que falha só é tentado de novo no tick seguinte.
- Sem tela no Admin para o estado dos jobs; a contagem de falhas só está no banco e no log.
- Quem tem a credencial do login do outbox já controla o despachante e agora também pode **adiar** jobs (tomar o *lease* ou cobrir uma janela sem rodar, e criar linhas de estado com nomes livres): trate a credencial como a de um papel que escreve no banco (política de perfis de CLI).
- A linha `scheduled_job_*` não traz dado de cliente, mas a **exceção** que o cron relança ao fim é registrada pela plataforma com a mensagem do erro (como já era antes do agendador); erros de provedor ou do R2 podem trazer nomes de objeto. A mensagem do erro agregado mudou: `scheduled_jobs_failed` (antes `scheduled_maintenance_failed` e `outbox_jobs_failed`); ajuste filtros de alerta que dependam do texto.
- Um disparo manual ou de expressão não declarada também passa pela janela quando o binding existe: um job já rodado na hora aparece só como `scheduled_job_skipped` (use o `UPDATE` acima para forçar).
- Despesas recorrentes seguem geradas ao ler; provider reconcile não existe até o Gate 7.

Escalonamento: o responsável pelo teto de custo e pelas contas Cloudflare.
