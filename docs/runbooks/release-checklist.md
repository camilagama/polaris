# Checklist de release para produção

Status: proposta, aguardando decisão do time. Nenhum item foi executado para uma promoção ainda. Onde o time ainda não decidiu, o texto traz um valor padrão conservador marcado como **proposta, pendente de decisão**; a lista está em [Decisões pendentes](#decisões-pendentes).

Checklist canônico para promover um SHA de `main` ao ambiente de produção do Polaris: os Workers `polaris-web` (com os Static Assets, as filas e os Cron Triggers declarados em `apps/web/wrangler.jsonc`), `polaris-catalog` e `polaris-admin`, e as migrations do banco. Ele não substitui o [checklist de go-live](./README.md#checklist-de-go-live-cloudflare-e-neon), que cobre a primeira exposição pública. Os itens de go-live aparecem por link e não são copiados aqui.

## Gatilho

Qualquer promoção de SHA para produção. Mudança neste checklist entra por PR, como as demais fontes de runbook.

## Pré-requisitos de acesso

- Leitura do repositório e do histórico de CI no GitHub.
- Leitura do banco de produção (tabela de controle de migrations) e do host de deploy, sempre com o perfil autorizado pela [política de perfis de CLI](./cli-profile-policy.md). Este checklist só lê; alterar produção exige autorização explícita do responsável.
- Relatórios não contêm segredos, connection strings nem tokens: só nomes e datas.

## Regras

- **CI verde não é aceito.** O verde é conferido job a job, no SHA candidato (itens 2 e 4); o CI não substitui os gates em Neon descartável (item 4).
- **Nunca aprovar parcialmente um item BLOCK.** Ou ele tem evidência e passa, ou não passa.
- **Nunca editar o resultado esperado para ficar verde.** Se o resultado esperado de um teste ou gate precisa mudar, a mudança é um commit próprio, revisado, e o SHA candidato muda.
- **Sem critério de aceite, o veredito é dados insuficientes.**
- Severidade: **BLOCK** impede a promoção se falhar, faltar ou não puder ser lido. **WARN** não impede, desde que o registro cite o item e o responsável. A severidade de cada item abaixo é **proposta, pendente de decisão**, exceto a dos itens 10, 14, 15, 16, 18 e 19, que já foram decididos.

## Itens

### 1. SHA candidato identificado (BLOCK)

- Critério: um SHA completo, já em `main`, com o PR de origem identificado.
- Evidência: o SHA, o link do PR e a saída de `git rev-parse origin/main` no momento da leitura.

### 2. CI do SHA verde, job a job (BLOCK)

- Critério: no SHA candidato, terminam com sucesso os jobs `Changed areas`, `Checks (lint, types, knip, build, tests)` e `PostgreSQL 18 gates`. Este último deixou de ser consultivo: perdeu o `continue-on-error` e a falha dele é falha do CI, como diz a emenda do [ADR 0025](../adr/0025-estrategia-de-testes-de-banco.md). Tornar o check obrigatório para o merge é proteção de branch do GitHub, do responsável, e não está no repositório: confira o resultado do job, não a proteção.
- `Dependency audit` é consultivo (`continue-on-error: true` em `.github/workflows/ci.yml`): o job pode terminar em falha sem derrubar o CI. O resultado real é lido e registrado, e cada aviso é comparado com o [runbook de auditoria de dependências](./dependency-audit.md): o job pode ficar vermelho só pelas exceções vigentes da tabela dele, dentro do prazo de revisão. Aviso que não está na tabela, ou exceção com prazo vencido, não é ignorado. **Proposta, pendente de decisão:** aviso alto em dependência que chega ao runtime bloqueia (o runbook já o trata como bloqueio); aviso só de ferramenta de desenvolvimento, com exceção vigente, é WARN, com dono e data no relatório (item 12).
- `Dependency audit` e `Offline persistence browser gate` dependem do job `Changed areas`. Nenhum dos dois é executado quando a mudança não toca o que ele exercita, e o gate de navegador não roda em evento `push`. Nesse caso, a evidência é a execução do evento `pull_request` do PR de origem; se `main` mudou depois dela, o job é reexecutado. A execução completa sob demanda (`workflow_dispatch`) roda os dois, e é o caminho para ter ambos no SHA candidato, desde que o SHA candidato seja a ponta do ref escolhido (normalmente `main`); se `main` já avançou, o dispatch não testa o candidato.
- `skipped` só vale quando `Changed areas` mostra que a área não mudou (`browser=false` ou `dependencies=false`). Qualquer outro `skipped` é falha. `Checks` e `PostgreSQL 18 gates` não têm condição: `skipped` neles é falha.
- Evidência: link da execução de CI do SHA, com o estado de cada job e, para o gate de navegador e a auditoria, o evento de onde vieram.

### 3. Migrações pendentes com plano de aplicação e de volta (BLOCK)

- Critério: listar as migrations de `packages/db/drizzle` ainda não aplicadas em produção, comparando com a tabela de controle do Drizzle, lida em modo leitura.
- Para cada migration: se é aditiva ou destrutiva, a ordem de aplicação e o plano de volta (rollback ou forward-fix).
- Migration destrutiva sem plano de volta bloqueia.
- Compatibilidade com a versão anterior do Worker ([ADR 0096](../adr/0096-migrations-compativeis-com-a-versao-anterior-do-worker.md)): cada migration pendente depois da 0077 é classificada como **compatível** (só adiciona), **contract** (remove o que nenhuma versão no ar usa mais; o PR diz qual versão parou de usar) ou **janela** (marcador `-- expand-contract: janela <motivo>`, com a janela descrita e autorizada). O rollback do Worker (PR 136 do plano) não volta o banco, então o Worker anterior precisa funcionar sobre o schema migrado. Migration sem classificação, ou `contract` cuja versão ainda está no ar ou na janela de rollback, bloqueia. Conferir também que `bun run migrations:compat` passa no SHA candidato.
- Respeitar a ordem de publicação de cada gate. A migration vai ao banco **antes** do Worker que a usa (Worker novo sobre banco antigo falha nas funções novas; por exemplo, o Worker que grava `user.verification_link_expires_at` sem a migration 0094 não envia nenhum e-mail de verificação, SQLSTATE 42703, só o evento `auth_verification_link_record_failed` no log; ver o passo 1 do [checklist das filas](./queues.md)); o servidor vai ao ar antes do app que usa um campo novo de comando ([Gate 5](./gate-5-offline.md#ordem-de-publicação)).
- Pré-requisito de quem aplica: o papel que roda as migrations tem de ser o dono do banco (`datdba`) e do schema `public`. No Neon, é o `neondb_owner`. A migration 0077 revoga `TEMPORARY` no banco e `CREATE` no schema `public` de `PUBLIC`, e um `REVOKE` feito por quem não é dono só emite `WARNING`, sem efeito. Confirmar antes de aplicar, em modo leitura: `SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()` e `SELECT current_user`; os dois nomes têm de coincidir. O schema `public` pertence a `pg_database_owner` (PostgreSQL 15 ou superior), do qual o dono do banco é membro implícito; se `pg_namespace.nspowner` de `public` mostrar outro papel, ele também tem de ser o migrador.
- Desde a 0097 e a 0098, `session`, `"user"`, `account`, `verification` e `auth_security_audit_event` têm RLS com `FORCE`, como as tabelas de tenant: o dono delas (o migrador) só as vê inteiras porque tem `BYPASSRLS` (no Neon) ou é superusuário (local e CI). Confirmar em modo leitura que o migrador continua com o atributo (`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`; o `staging:verify-database before-migrate` e o `DO` da 0098 recusam o contrário). Backfill ou outro DML de dados em migration roda como o migrador; depois de `SET ROLE` num `polaris_*_owner` ele fica sujeito às políticas desse dono e pode ver zero linhas sem erro.
- Se a 0077 falhar no bloco `DO` final (`PUBLIC still has TEMPORARY` ou `PUBLIC still has CREATE`): **parar**. Não seguir para as migrations seguintes nem para o deploy do Worker; conferir na tabela de controle do Drizzle se a 0077 ficou registrada (o Drizzle costuma aplicar o lote pendente numa transação só, e a exceção do bloco `DO` desfaz o lote inteiro; confirmar, sem presumir) e, se ficou, tratar como falha de privilégio a corrigir, não como aplicada. Conferir quem é o dono do banco (e, se `public` não for de `pg_database_owner`, do schema) e com que papel a migration rodou (a mesma consulta acima); se o migrador não é o dono, refazer a aplicação com o papel dono. Só seguir quando a 0077 passar. Nunca ajustar o bloco `DO` nem revogar à mão com outro papel para "passar".
- Comando de produção só entra no plano depois de testado em branch descartável ou staging, como pede o [README de runbooks](./README.md).
- Staging ([ADR 0097](../adr/0097-staging-fixo-e-producao-em-conta-separada.md)): a conferência de dono e a aplicação das migrations rodam primeiro no staging (`staging:verify-database before-migrate`, depois `db:migrate`), e isso serve de **ensaio**. A prova deste item vale de novo no go-live e a cada promoção, contra o banco de produção. A cada migrate no staging, a parte só de leitura do gate `definer-hardening` roda contra o banco de staging (`after-migrate`), como descreve o [runbook do staging](./staging.md#9-itens-do-release-checklist-no-staging).
- Evidência: lista das migrations pendentes (nome e hash), a classificação de cada uma (compatível, contract ou janela), saída da leitura do banco e o plano escrito.

### 4. Gates de banco em Neon descartável (BLOCK)

- Critério: a suíte completa (`bun run --filter @polaris/db gates:all`) passa a partir do SHA candidato, numa branch Neon descartável com as migrations replayadas do zero. Pela emenda do [ADR 0025](../adr/0025-estrategia-de-testes-de-banco.md), a suíte completa em Neon roda uma vez por fase e antes de uma liberação; por pull request os gates rodam no CI e, se preciso, no PostgreSQL 18 local, não em Neon. Este item é a execução "antes de uma liberação". O job `PostgreSQL 18 gates` do CI (item 2) roda a suíte `ci`, um subconjunto de `all`, num PostgreSQL em container e não a substitui, porque não reproduz o provedor real (papéis, hostnames e o caminho Worker, Hyperdrive e Neon).
- Uma única branch para a execução inteira, usada por todos os gates e apagada ao final. Não se cria uma branch por gate. Procedimento, nome da branch e limites: [Gate 4](./gate-4-sales-core.md#prova-antes-de-liberação-em-neon) e a política de perfis de CLI. O tipo de branch é a **filha de `production` sem `--schema-only`**, única por execução e apagada ao final, como descreve a seção [Prova antes de liberação em Neon](./gate-4-sales-core.md#prova-antes-de-liberação-em-neon) do Gate 4. Nenhum workflow cria branch; o CI usa o PostgreSQL 18 do runner.
- **Proposta, pendente de decisão:** a suíte completa é executada para cada promoção, a partir do SHA candidato. A alternativa é aceitar uma execução anterior (por exemplo, a do fim da fase, registrada na linha "Suíte completa em Neon" de `doc/status-implementacao.md`) quando nada que a emenda do ADR 0025 lista como gatilho mudou depois dela (executor `run-gates.ts`, suporte comum dos gates, migration que muda privilégios amplamente, objetos de banco tocados).
- Propriedade de estoque (**BLOCK**): a execução longa do `stock-property` (`POLARIS_PROPERTY_RUNS=500`, cerca de 5 min) passa num PostgreSQL 18 descartável e novo, a partir do SHA candidato, como diz a seção [Propriedade modelo × PostgreSQL](./gate-4-sales-core.md#propriedade-modelo--postgresql-estoque-e-devolução) do Gate 4. Evidência: a semente e o `passed`. Não há job novo no CI para isso.
- Corridas (**BLOCK**, como o resto do item): além da suíte `all`, rodar `gates:concurrency` (3 rodadas, o padrão da suíte) num PostgreSQL 18 descartável e novo, a partir do SHA candidato, como diz a seção [Corridas: quando o `gates:concurrency` é obrigatório](./gate-4-sales-core.md#corridas-quando-o-gatesconcurrency-é-obrigatório) do Gate 4. Não há job novo no CI para isso.
- **Pendências para a próxima prova de release em Neon** (mudanças no executor ou no suporte comum dos gates que mesclarem sem prova em Neon, por decisão do Arrascaeta (POL-14, 18/10/2026); a linha entra quando o PR mescla; cada linha sai da lista quando a prova a confere e registra o resultado):

  | PR | O que mudou | O que a prova em Neon precisa conferir |
  | --- | --- | --- |
  | [#191](https://github.com/camilagama/polaris/pull/191) (POL-58) | `run-gates.ts` (suíte `concurrency`) e `concurrency-support.ts` (barreira de largada e observador de bloqueio) usados por 14 gates de `gates:all` | O observador lê `pg_stat_activity` e `pg_blocking_pids` de outros papéis, o que exige superusuário ou `pg_read_all_stats`. Confirmar que o `neondb_owner` enxerga os papéis de login dos gates; se não enxergar, os 14 gates falham aqui com a mensagem de dono sem acesso ao observador (não com "não competiu"), e a correção é do suporte, não dos gates. |
  | T-124b | `run-gates.ts`: o gate `stock-property` entrou nas suítes `ci`, `gate4` e `all`, e o executor passou a repetir no JSON final as linhas `gate-note:` do gate | Que o `stock-property` passa em Neon com o papel de login temporário próprio (como os outros gates de venda). Também confere que o resumo do executor traz `notes` com a semente (o executor passou a repetir no JSON final as linhas `gate-note:` dos gates). A execução longa tem linha própria acima. |

- Evidência: o resumo de cada gate (`"status": "passed"`), o nome da branch, a data e a confirmação de que a branch foi apagada, mais o resultado de `gates:concurrency`, a semente e o `passed` da execução longa do `stock-property` e a baixa das pendências acima. Sem connection string.

### 5. Pendências de ambiente do go-live (BLOCK)

- Critério: cada item do [checklist de go-live](./README.md#checklist-de-go-live-cloudflare-e-neon) que a promoção toca está marcado com leitura de volta: bindings Hyperdrive com query caching desabilitado, segredos, namespaces de rate limit, bucket de mídia e demais itens do trecho que se aplica; para as filas e os crons, o [checklist das filas](./queues.md#checklist-de-go-live-do-despachante-responsável) e o [Antes de ligar dos jobs agendados](./scheduled-jobs.md#antes-de-ligar-responsável). Itens que a promoção não toca ficam listados como não aplicáveis, com o motivo.
- **Proposta, pendente de decisão:** este item bloqueia **toda** promoção enquanto houver item tocado aberto no go-live, e não só a primeira exposição pública. A alternativa é bloquear só a primeira.
- Marcador de ambiente: o banco de produção tem o comentário `polaris.environment=production` (`COMMENT ON DATABASE`, pelo dono; o Neon não dá superusuário para o `ALTER DATABASE … SET`), como no [go-live](./README.md#checklist-de-go-live-cloudflare-e-neon); sem ele o executor dos gates não recusa a URL direta da produção. Leitura de volta: `SELECT shobj_description(oid, 'pg_database') FROM pg_database WHERE datname = current_database();`.
- Segredos: só nomes e data de criação, nunca valores.
- Evidência: lista dos itens tocados com a leitura de volta, a data e quem leu.

### 6. Smoke test definido e executado (BLOCK)

- Critério: antes da promoção, a lista de verificações de fumaça está escrita: rota, resposta esperada e o que fazer se falhar, para cada Worker promovido. Ela é executada contra o ambiente que recebe o SHA e, depois da implantação em produção, contra produção.
- **Proposta, pendente de decisão:** lista manual, escrita no relatório da execução e executada por uma pessoa com o perfil autorizado, porque o repositório não tem script de smoke test. A alternativa (script versionado ou verificação no CI) é decisão do time e muda este item.
- Evidência: a lista, o resultado de cada verificação, a data e o host. Sem tokens nem dados de cliente.

### 7. Critérios de rollback e responsável (BLOCK)

- Critério: para os Workers, os Static Assets e as migrations, a condição que dispara rollback ou forward-fix, a ação e o responsável com o escalonamento. Migration sem reversão automática precisa de forward-fix descrito. O rollback dos Workers não volta o schema: o banco migrado tem de servir a versão revertida ([ADR 0096](../adr/0096-migrations-compativeis-com-a-versao-anterior-do-worker.md)). Os runbooks de [Filas Cloudflare](./queues.md#rollback-ou-forward-fix) e de [Jobs agendados](./scheduled-jobs.md#rollback-ou-forward-fix) já descrevem como parar o consumo e os crons.
- Evidência: o plano no relatório da execução, com nome ou papel do responsável (**proposta, pendente de decisão:** o responsável pelo projeto, como nos demais runbooks).

### 8. SHA implantado conferido no host de deploy (BLOCK)

- Critério: para cada Worker promovido, o SHA lido de volta no host de deploy (versão do Worker ou identificador exposto pelo deploy) é igual ao SHA candidato. A promoção só é dada como feita depois disso.
- **Proposta, pendente de decisão:** leitura manual, por quem tem o perfil autorizado ([política de perfis de CLI](./cli-profile-policy.md)), sem script. O repositório não expõe o SHA no Worker nem tem script de deploy.
- Se o host não expõe o SHA, o item fica como dados insuficientes. Não se presume que o deploy é igual ao candidato.
- Evidência: a leitura de volta, com o identificador e a data.

### 9. Nenhum achado "bloqueia" aberto do revisor (BLOCK)

- Critério: na revisão do PR de origem, nenhum achado de severidade "bloqueia" está aberto e nenhum achado de segurança está sem resolução.
- Evidência: link da revisão e o estado de cada achado.

### 10. Prazos legais: decidido pelo usuário em 19/10; revisão de advogado recomendada (WARN)

- Critério: o usuário aprovou todos os prazos, os legais incluídos, em 19/10/2026 (ADR 0079), e a revisão de advogado é **recomendada, sem bloquear**. Em `packages/domain/src/privacy/retention.ts`, a classe de base legal (`basis: "lei"`) com `legalReview` `"pending"` é só registrada no relatório; preenchida por quem validou (`reviewedBy` e `reviewedAt`: contador ou jurídico), sai da lista.
- A auditoria do tenant (classes `tenant_audit_security` e `tenant_audit_operational`, emenda de 19/10/2026 do ADR 0081) e o `deletion_ledger` entram na mesma regra (aviso), e **sem o job que chama `expire_tenant_audit_events` nada vence**: a guarda é indefinida até ele existir. Rodar o gate `audit-retention` no SHA candidato, para provar os gatilhos `ENABLE ALWAYS`.
- Evidência: a lista das classes legais com o `legalReview` lido no SHA candidato (quem validou e quando, ou "pendente: decidido pelo usuário em 19/10").

### 11. Registro de acesso do Marco Civil: pendências depois da tabela própria (BLOCK)

- Critério: a tabela própria do registro de acesso existe (`auth_access_log`, migration 0076, [ADR 0092](../adr/0092-registro-de-acesso-a-aplicacao.md)) e o bloqueio `access_record_table` da classe `auth_sessions` está resolvido no registro de retenção. Ainda faltam, para o item passar:
  - o alerta sobre `auth_access_log_write_failed` configurado no destino dos logs, e o `auth_access_log_skipped` acompanhado ([runbook do registro de acesso](./registro-de-acesso.md#6-monitoramento));
  - o job de expurgo com guarda cautelar (Marco Civil, art. 15, §2º), que só pode existir antes do go-live + 6 meses. Nenhuma linha vence antes de 6 meses do go-live, e o bloqueio `access_log_hold` do registro impede o job até a guarda existir. Item datado: **job de expurgo com guarda cautelar antes de go-live + 6 meses**.
- Evidência: o nome da tabela e o resultado do gate `access-log` no SHA candidato; a configuração do alerta (nome da regra, sem segredo); e, para o job, a pendência datada no [status de implementação](../../doc/status-implementacao.md).

### 12. Achados "vale corrigir" e "menor" registrados (WARN)

- Critério: os achados abertos desses níveis ficam listados no relatório, com dono e data prevista de correção.
- Evidência: a lista, com links.

### 13. Status com evidência de commit (WARN)

- Critério: o status do repositório (`doc/status-implementacao.md`) foi conferido contra o SHA promovido. Só é marcado como feito o que tem commit de evidência.
- Evidência: o trecho do status atualizado e o commit citado.

### 14. Formato do erro 9422 do binding IMAGES confirmado (BLOCK)

- Critério: confirmar no Cloudflare real o formato do erro 9422 do binding `IMAGES` (ou provocá-lo e registrar) antes do go-live. Motivo: a documentação da Cloudflare não mostra como o binding expõe o 9422, e a detecção em `apps/web/src/server/media-image-pipeline.ts` é uma suposição (`code` numérico ou texto, o número 9422 na mensagem do erro e o cabeçalho `Cf-Resized: err=9422`). Se o formato real for outro, o fallback não dispara e, com a cota estourada, as miniaturas do ERP voltam 503 e o upload falha com 503 `media_processing_unavailable`, em vez de `media_transform_quota_exceeded`. Confirmar também que não há cobrança acima da franquia, que hoje só consta na documentação (ADR 0018).
- Evidência: o formato observado (campo e valor, sem segredos), a data, quem leu e o ambiente. Se o formato diferir dos aceitos, o ajuste do código e do teste entra antes da promoção.
- Como provocar ([ADR 0097](../adr/0097-staging-fixo-e-producao-em-conta-separada.md)): no staging, pelo **caminho real de miniatura** (envio de imagens sintéticas distintas pelo app até a cota acabar), nos últimos dias do mês, como descreve o [runbook do staging](./staging.md#9-itens-do-release-checklist-no-staging). Não existe rota de diagnóstico, e nenhuma deve ser criada.
- Frequência (decisão do Arrascaeta): o item é conferido uma vez antes do go-live e de novo sempre que mudar a `compatibility_date` do Worker ou a configuração do binding `images` (`IMAGES`) em `apps/web/wrangler.jsonc`; o binding não tem versão própria. Fora esses casos, as promoções seguintes citam o registro vigente (formato, data, ambiente).

### 15. Todo login do app é membro de um `polaris_*_runtime` (BLOCK)

- Critério: todo login que o app usa em produção (os usuários dos bindings Hyperdrive de tenant, auth, onboarding, cleanup, catálogo, privacidade, Admin e os demais) é membro de um papel `polaris_*_runtime`. O gate `definer-hardening` ([ADR 0093](../adr/0093-funcoes-security-definer-e-privilegios-padrao.md)) só enxerga como runtime os papéis `polaris_*_runtime`, quem é membro deles e os logins dos gates; um login fora desses grupos escapa das verificações por papel (concessão direta de `TEMPORARY` ou `CREATE` em `public`, dono do banco e papéis poderosos alcançáveis). Listar os logins dos bindings e a pertença de cada um (`pg_auth_members`), em modo leitura.
- Evidência: a lista de logins (nome do papel, sem senha nem URL) com o grupo `polaris_*_runtime` de cada um, a data e quem leu. Login sem grupo, ou que seja o dono do banco, bloqueia até ser corrigido ou ter decisão registrada.
- No staging, a lista sai de `staging:verify-database after-migrate`. Ela é **ensaio**: a prova vale de novo no go-live, com os logins de produção ([ADR 0097](../adr/0097-staging-fixo-e-producao-em-conta-separada.md)).

### 16. Exceção não capturada visível nos Workers Logs com `invocation_logs` desligado (BLOCK)

- Critério: os três Workers têm `observability.logs.invocation_logs: false` ([ADR 0094](../adr/0094-tracing-e-amostragem-do-workers-observability.md)), e a documentação da Cloudflare não diz se as exceções não capturadas continuam nos Workers Logs com ele desligado. No staging, provocar uma exceção não capturada em cada Worker (`polaris-web`, `polaris-admin`, `polaris-catalog`) e conferir se ela aparece nos Workers Logs. Se não aparecer em algum Worker, ligar `invocation_logs` nele (o custo é uma linha por requisição, dentro da estimativa do ADR 0094) antes do go-live e repetir a prova.
- Como provocar (decisão do Arrascaeta, [ADR 0097](../adr/0097-staging-fixo-e-producao-em-conta-separada.md)): uma versão temporária, enviada com `wrangler versions upload --env staging` a partir de uma cópia local não commitada, lança a exceção. Depois, a conferência nos Workers Logs e o rollback. **Nunca** uma rota de falha no código. Os passos estão no [runbook do staging](./staging.md#9-itens-do-release-checklist-no-staging). O Admin não é exposto no staging: a prova dele fica para o go-live, atrás do Access da produção.
- Severidade BLOCK: decidida pelo Arrascaeta. Frequência: **em aberto, proposta pendente de decisão**: o item vale uma vez antes do go-live e de novo quando mudar a configuração `observability` de um Worker ou a `compatibility_date`; depois, as promoções citam o registro vigente (Worker, data, ambiente, resultado). Até a decisão, vale esta proposta.
- Evidência: por Worker, o ambiente, a data, quem provocou a exceção, se ela apareceu nos Workers Logs (sim ou não) e, se não, o valor de `invocation_logs` depois da correção. Sem segredos nem dados de cliente.

### 17. Sessões anteriores à revogação por aparelho (WARN)

- Critério: a revogação que encerra as sessões do aparelho ([ADR 0048](../adr/0048-tela-de-aparelhos.md), emenda de 19/10/2026) só alcança sessões que já usaram o aparelho depois do deploy dela, porque o vínculo `device_sessions` nasce com o uso e não há backfill. Uma sessão criada antes (um celular perdido e parado, por exemplo) não cai ao revogar o aparelho. No go-live não há sessões antigas e o item não se aplica. Se a revogação por aparelho for para produção depois de haver usuários (o item vale só nessa promoção; nas seguintes, citar o registro), antes de anunciar que "revogar encerra a sessão do aparelho perdido", fazer um destes: pedir aos usuários que usem "encerrar as outras sessões" (a opção da API `device.revoke`; a tela de aparelhos ainda não a oferece, e essa tela é tarefa de produto separada) ou encerrar as sessões existentes no deploy, por procedimento operacional aprovado pelo responsável (todos entram de novo).
- Evidência: "não se aplica, sem usuários antes do deploy" (com a data) ou o caminho escolhido e quando foi feito.
- Severidade WARN: proposta, pendente de decisão do responsável.

### 18. Gate das funções do purge verde (BLOCK)

- Critério: o gate `purge-functions` (suítes `ci` e `gate10`, `packages/db/scripts/verify-purge-functions-gate.ts`) passa no SHA candidato, com as migrations replayadas do zero. Ele lê `pg_get_functiondef` de `admin_schedule_organization_purge`, `organization_purge_blocker` e `purge_organization_data` (e, desde o [ADR 0102](../adr/0102-apagamento-automatico-da-loja-encerrada.md), de `schedule_closed_organization_purges` e `closed_organization_purge_wait`: D lido de `closure_deadlines`, as 48 horas depois de D, os 7 dias de aviso e os estados de uma renovação viva) e confere: o escopo `whole_organization` contra `ORGANIZATION_PURGE_REQUIRED_SCOPE`, o prazo contra `ORGANIZATION_PURGE_CLOSURE_PERIOD_DAYS`, as tabelas apagadas (nomes e ordem) contra `PURGE_DELETE_ORDER` e as chaves do fato de cobrança contra `PURGE_BILLING_FACT_KEYS`. Ele confere também que cada lista é lida (o laço sobre `deleted_tables`, a chamada de `organization_purge_blocker`, as duas conferências do escopo) e que nenhum outro `DELETE` existe. Motivo: duas migrations que recriam a mesma função não dão conflito no git, e a última sobrescreve a anterior sem aviso (a 0079 e a 0080 recriaram `admin_schedule_organization_purge` com corpos diferentes, e o prazo de 90 dias e o escopo sem a auditoria só foram preservados por conferência manual do diff). O gate também é obrigatório em todo PR que recrie uma dessas funções.
- Evidência: `"status": "passed"` do gate `purge-functions` no SHA candidato (no CI, ou na execução do item 4). Não vale rodar o gate num banco que não seja o das migrations do SHA.
- Severidade BLOCK: **decidida** (os revisores pediram o gate como obrigatório antes de qualquer PR que recrie uma das três funções, e o Arrascaeta decidiu BLOCK em 19/10/2026).

### 19. Ordem do controle de aceite legal: cliente primeiro, flag depois (BLOCK)

- Critério: vale quando a promoção liga `LEGAL_ACCEPTANCE_ENFORCED=true` no Worker `polaris-web` ou leva o P7 do [ADR 0100](../adr/0100-tela-de-entrada-senha-atras-de-flag-bloqueio-e-aceite-legal.md). O controle de aceite do servidor nasce **desligado** (`LEGAL_ACCEPTANCE_ENFORCED=false`, ou ausente). Só pode ser ligado depois de: (1) o cliente com o ramo novo (`data.reason` tratado antes de `isSessionRefusal` em `sync`, `issueLease` e `registerDevice`) estar **publicado em uma versão anterior** à promoção que liga a flag; e (2) o prazo de atualização do service worker ter passado desde essa publicação, para nenhum cliente em cache ainda ter o runtime antigo, que trata todo `FORBIDDEN` como sessão recusada e apagaria o lease e as coleções; e (3) o texto da entrada com Google **não prometer um aceite que não foi dado**: o cadastro social cria a conta sem aceite (o hook só olha `/sign-up/email`), e a pessoa só é parada no primeiro acesso autenticado; então um texto do tipo "ao criar a conta você aceita" só pode ficar na entrada com e-mail e senha, e a entrada com Google tem de dizer que os termos serão pedidos depois (hoje a tela só aponta para as páginas legais e não promete aceite; conferir de novo antes de ligar a flag). Enquanto isso não for verdade, a flag offline (`VITE_OFFLINE_RUNTIME_ENABLED`) segue **desligada em produção**.
- Ordem: publicar o cliente com o ramo novo, com a flag do servidor desligada; esperar o prazo de atualização do service worker; só então ligar a flag em outra promoção, com leitura de volta. Ligar a flag nunca entra na mesma promoção que publica o ramo novo do cliente.
- Evidência: o SHA e a data da publicação do cliente com o ramo novo; o prazo de atualização do service worker e a data em que passou; o texto da entrada com Google lido no build do SHA candidato (sem promessa de aceite); o sinal `aceite-no-cadastro` do [runbook de alertas](./alertas.md#aceite-no-cadastro) ligado no destino dos logs; o valor lido de `LEGAL_ACCEPTANCE_ENFORCED` e de `VITE_OFFLINE_RUNTIME_ENABLED` em produção (só os valores booleanos, sem segredo); o p95 acrescentado pelo controle medido no staging (alvo de até 30 ms; acima disso, cache por sessão).
- Severidade BLOCK: **decidida** pelo Arrascaeta em 19/10/2026.

### 20. Deploy de produção com `CLOUDFLARE_ENV=production` (BLOCK)

- Critério: o build de `apps/web` define `LEGAL_DRAFT_BUILD=1` por padrão (`apps/web/package.json`), e esse valor só deixa passar os marcadores `[preencher: ...]` das páginas legais quando não há ambiente nomeado. O deploy de produção define `CLOUDFLARE_ENV=production` no comando de build, e com ele o guarda legal recusa o build que ainda tenha marcador ([ADR 0100](../adr/0100-tela-de-entrada-senha-atras-de-flag-bloqueio-e-aceite-legal.md)). Sem essa variável, o build sai como rascunho e a produção publicaria os marcadores.
- Evidência: o comando ou a configuração de build do deploy com `CLOUDFLARE_ENV=production` e o resultado do build de produção do SHA candidato (o build tem de falhar enquanto houver marcador, e passar depois da revisão jurídica).
- Severidade BLOCK: proposta, pendente de decisão do responsável.

### 21. Sentry do navegador ligado, com source maps enviados e nenhum `.map` servido (WARN)

- Critério: o build que vai a produção (e o do staging, se quiser ver os erros lá) tem `VITE_SENTRY_DSN` (o DSN do projeto `polaris`, nenhum outro) e `VITE_SENTRY_ENVIRONMENT=production` (ou `staging`). O release é o SHA do commit: o Vite o grava sozinho (`GITHUB_SHA` ou o `HEAD` do git) quando há DSN. Sem o DSN, o navegador não reporta nada e o resto do app funciona igual ([ADR 0098](../adr/0098-sentry-no-navegador-so-erros-e-sanitizado.md)). O workflow de staging não define essas variáveis: o responsável as põe na build quando decidir ligar.
- Passos, com um token de CI do Sentry que permita enviar source maps (criado pelo responsável e guardado como segredo do ambiente, nunca no repositório, no log ou no PR). Confira os comandos e o escopo do token na [documentação atual do Sentry](https://docs.sentry.io/platforms/javascript/sourcemaps/uploading/cli/):
  1. Build com `VITE_SENTRY_DSN` e `VITE_SENTRY_ENVIRONMENT` definidos. Conferir em `apps/web/dist/client/_headers` que o `connect-src` tem `'self'`, `data:` e **só** o host de ingestão do DSN.
  2. Conferir que há `.map` em `apps/web/dist/client/assets` (é o `hidden`: os `.js` não os referenciam) e que `apps/web/dist/client/.assetsignore` lista `*.map` (a Cloudflare não os publica).
  3. Antes do deploy: `sentry-cli sourcemaps inject apps/web/dist/client/assets` (grava o debug id nos `.js` e nos `.map`, só nos assets, sem tocar o `sw.js`) e `sentry-cli sourcemaps upload --org <organização> --project polaris --release <SHA> apps/web/dist/client/assets`. Confirme que o `inject` achou os `.map` vizinhos (o build `hidden` não deixa `sourceMappingURL` nos `.js`); se não achar, o upload não casa com as pilhas. O deploy sai dos mesmos arquivos, já com o debug id; senão o Sentry não casa o mapa com a pilha.
  4. Deploy como de costume (o Wrangler respeita o `.assetsignore`).
  5. Depois do deploy, pedir um `.map` publicado (`/assets/<arquivo>.js.map`): a resposta tem de ser o HTML do shell (o fallback do app de página única, `content-type: text/html`), nunca um source map.
  6. No projeto `polaris`, antes de ligar em produção: conferir a opção de **não guardar endereço IP**, o scrubbing de dados no servidor e a retenção dos eventos. A retenção por classe ([ADR 0079](../adr/0079-retencao-por-classe-de-dado.md)) e o purge do tenant não alcançam o Sentry, e o Sentry é um operador a listar na política de privacidade.
  7. No staging (ou depois do go-live, com um erro de teste provocado por quem tem a conta), conferir no projeto `polaris` um evento com `environment` e `release` certos, a pilha com os nomes do código-fonte e **nenhum** dado pessoal (e-mail, CPF, telefone, cookie, token, valor de query). Qualquer vazamento impede ligar o DSN em produção até a correção.
- Severidade WARN: **proposta, pendente de decisão**. O app funciona sem o Sentry, mas um go-live sem ele deixa o navegador sem registro de erro; o registro cita o item e o responsável.
- Evidência: o ambiente, o SHA, a saída do upload (sem o token), o resultado do passo 5 e o evento de teste (sem dado pessoal).

### 22. Freio do apagamento automático (BLOCK)

- Critério: `CLOSURE_AUTO_PURGE_ENABLED` está `"false"` no ambiente promovido, a menos que a promoção seja o go-live que o liga ([ADR 0102](../adr/0102-apagamento-automatico-da-loja-encerrada.md), decisão N1 do corte da loja encerrada). Ligar em produção exige, antes:
  1. a prova de fiação em staging com datas retroagidas registrada (agendamento em D menos 7 e execução a partir de D mais 48 horas numa loja sintética);
  2. os critérios AC-47, AC-49 e AC-61 verdes;
  3. o lojista avisado antes de os dados saírem: os avisos por marco (D − 30, D − 7, D e o reagendamento depois de uma trava) e o e-mail ligados em produção, com o domínio definitivo (AC-30, AC-50 e AC-51), e o painel da loja encerrada com o pedido de cópia no ar; ou uma exceção registrada pelo responsável;
  4. a revisão de advogado dos termos;
  5. os sinais `apagamento-automatico` e `loja-encerrada-parada` do [runbook de alertas](./alertas.md) ligados no mesmo deploy.
- `CLOSURE_NOTICE_EMAIL_ENABLED` (o e-mail dos avisos, [runbook](./avisos-de-encerramento.md#ligar-o-e-mail)) só fica `"true"` no ambiente promovido com o PR G no ar: a tela da loja encerrada, com o pedido de cópia e o desfazer. Antes dele, o e-mail manda o dono pedir a cópia ou desfazer o encerramento num painel que não existe. Com o PR G, o link e o botão do e-mail apontam para essa tela. A chave de idempotência do Resend vale 24 horas: um reenvio depois disso, de um aviso cuja marca de enviado falhou, pode chegar duas vezes ao dono.
- Evidência: o valor da variável no `wrangler.jsonc` do SHA candidato (o teste `maintenance.test.ts` confere que está desligada nos três blocos) e, no go-live, o registro da prova em staging e da decisão do usuário.
- Severidade BLOCK: proposta, pendente de decisão do responsável.

### 23. Entrada por senha ligada só com as páginas do P9 no ar (BLOCK)

- Critério: vale quando a promoção liga `EMAIL_PASSWORD_AUTH_ENABLED=true` no Worker `polaris-web` ([ADR 0100](../adr/0100-tela-de-entrada-senha-atras-de-flag-bloqueio-e-aceite-legal.md)). Os botões dos e-mails levam a páginas do app: `/desbloquear`, `/redefinir-senha`, `/confirmar-email` e `/esqueci-a-senha` (as telas do P9). Com a flag ligada e uma delas fora do ar, o botão do e-mail cai numa rota que não existe. A flag só liga com as quatro páginas publicadas no SHA candidato (ou em um anterior já em produção). Antes de ligar, também: as variações de caminho de `sign-in/email`, `change-password` e `set-password` (maiúsculas, `%2F`, barra no fim, sufixo parecido) respondem 404 sem chegar ao Better Auth (testes de `handler.test.ts` verdes no SHA candidato). Também: o alerta no evento `auth_verification_link_record_failed` criado nos Workers Logs (um pico é cadastro sem e-mail de verificação; [runbook](./email-auth.md#ordem-de-implantação-da-gravação-do-link-e-alerta-antes-da-flag-da-senha)). Um teste de rota real na pilha local (T-125a), que mande essas variações com senha errada seis vezes, ainda não existe: é recomendado antes de ligar e fica registrado como pendência.
- Evidência: o SHA em que as quatro páginas existem e a data da publicação; o alerta no evento `auth_verification_link_record_failed` criado (nome e consulta); a leitura de cada rota pelo host de produção (a página abre, sem token); o resultado de `handler.test.ts` no SHA candidato e, se já existir, o do teste de rota real das variações de caminho.
- Severidade BLOCK: proposta, pendente de decisão do responsável.

## Veredito

Ordem de decisão:

1. **Bloquear**: algum item BLOCK falhou, com evidência.
2. **Dados insuficientes**: algum item BLOCK não tem evidência, critério ou leitura. Diga qual leitura falhou e por quê.
3. **Aprovar**: todos os itens BLOCK passaram com evidência, e os WARN estão registrados.

Nunca "talvez". O veredito vale só para o SHA e o ambiente lidos.

## Registro da execução

- O relatório de cada execução fica fora do repositório, na pasta compartilhada de operações do Polaris, com o nome `run-AAAA-MM-DD-<SHA curto>.md` (**proposta, pendente de decisão**).
- Conteúdo: SHA, cada item com status e evidência, veredito, incógnitas e decisões que faltam.

## Rollback ou forward-fix

Este checklist não altera recursos. Quando o veredito é bloquear, ele não reverte nada: a correção é um commit novo ou uma decisão do responsável.

## Escalonamento

**Proposta, pendente de decisão:** o responsável pelo projeto, como nos demais runbooks, até o time nomear pessoa ou papel. Veredito de bloquear ou dados insuficientes vai para o responsável e para quem pediu a promoção.

## Estado atual

- O checklist de go-live declara que nada foi executado. Enquanto um item tocado estiver aberto, a primeira execução tende a bloquear.
- Nenhum `package.json` do repositório tem script de deploy nem de smoke test (o `build` de `apps/admin` usa `wrangler deploy --dry-run`). Os itens 6 e 8 precisam de definição antes da primeira execução. O staging ([ADR 0097](../adr/0097-staging-fixo-e-producao-em-conta-separada.md)) traz a configuração `env.staging`/`env.production` e as verificações de isolamento. O workflow de deploy e o smoke do staging vêm num PR próprio.

## Decisões pendentes

Cada uma está marcada no texto como proposta, pendente de decisão:

1. Severidade final de cada item, exceto 10, 14, 15, 16, 18 e 19, já decididos (hoje 16 BLOCK e 4 WARN, mais o item 21, WARN proposto) e do aviso da auditoria de dependências (item 2).
2. Se o item 5 bloqueia toda promoção ou só a primeira.
3. Quem é o responsável no escalonamento e no item 7.
4. Como fazer o smoke test do item 6.
5. Como ler o SHA no host de deploy (item 8).
6. Se uma execução anterior da suíte completa em Neon (a do fim da fase) vale como evidência do item 4, e se o nome `run-AAAA-MM-DD-<SHA curto>.md` é o adotado para o relatório.
7. Frequência do item 16 (severidade BLOCK já decidida): se basta uma prova antes do go-live e outra quando mudar a configuração `observability` ou a `compatibility_date`, ou se é por promoção.
