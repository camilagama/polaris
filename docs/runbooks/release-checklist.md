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
- Severidade: **BLOCK** impede a promoção se falhar, faltar ou não puder ser lido. **WARN** não impede, desde que o registro cite o item e o responsável. A severidade de cada item abaixo é **proposta, pendente de decisão**.

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
- Respeitar a ordem de publicação de cada gate. A migration vai ao banco **antes** do Worker que a usa (Worker novo sobre banco antigo falha nas funções novas; ver o passo 1 do [checklist das filas](./queues.md)); o servidor vai ao ar antes do app que usa um campo novo de comando ([Gate 5](./gate-5-offline.md#ordem-de-publicação)).
- Pré-requisito de quem aplica: o papel que roda as migrations tem de ser o dono do banco (`datdba`) e do schema `public`. No Neon, é o `neondb_owner`. A migration 0077 revoga `TEMPORARY` no banco e `CREATE` no schema `public` de `PUBLIC`, e um `REVOKE` feito por quem não é dono só emite `WARNING`, sem efeito. Confirmar antes de aplicar, em modo leitura: `SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()` e `SELECT current_user`; os dois nomes têm de coincidir. O schema `public` pertence a `pg_database_owner` (PostgreSQL 15 ou superior), do qual o dono do banco é membro implícito; se `pg_namespace.nspowner` de `public` mostrar outro papel, ele também tem de ser o migrador.
- Se a 0077 falhar no bloco `DO` final (`PUBLIC still has TEMPORARY` ou `PUBLIC still has CREATE`): **parar**. Não seguir para as migrations seguintes nem para o deploy do Worker; conferir na tabela de controle do Drizzle se a 0077 ficou registrada (o Drizzle costuma aplicar o lote pendente numa transação só, e a exceção do bloco `DO` desfaz o lote inteiro; confirmar, sem presumir) e, se ficou, tratar como falha de privilégio a corrigir, não como aplicada. Conferir quem é o dono do banco (e, se `public` não for de `pg_database_owner`, do schema) e com que papel a migration rodou (a mesma consulta acima); se o migrador não é o dono, refazer a aplicação com o papel dono. Só seguir quando a 0077 passar. Nunca ajustar o bloco `DO` nem revogar à mão com outro papel para "passar".
- Comando de produção só entra no plano depois de testado em branch descartável ou staging, como pede o [README de runbooks](./README.md).
- Evidência: lista das migrations pendentes (nome e hash), saída da leitura do banco e o plano escrito.

### 4. Gates de banco em Neon descartável (BLOCK)

- Critério: a suíte completa (`bun run --filter @polaris/db gates:all`) passa a partir do SHA candidato, numa branch Neon descartável com as migrations replayadas do zero. Pela emenda do [ADR 0025](../adr/0025-estrategia-de-testes-de-banco.md), a suíte completa em Neon roda uma vez por fase e antes de uma liberação; por pull request os gates rodam no CI e, se preciso, no PostgreSQL 18 local, não em Neon. Este item é a execução "antes de uma liberação". O job `PostgreSQL 18 gates` do CI (item 2) roda a suíte `ci`, um subconjunto de `all`, num PostgreSQL em container e não a substitui, porque não reproduz o provedor real (papéis, hostnames e o caminho Worker, Hyperdrive e Neon).
- Uma única branch para a execução inteira, usada por todos os gates e apagada ao final. Não se cria uma branch por gate. Procedimento, nome da branch e limites: [Gate 4](./gate-4-sales-core.md#prova-antes-de-liberação-em-neon) e a política de perfis de CLI. O tipo de branch é a **filha de `production` sem `--schema-only`**, única por execução e apagada ao final, como descreve a seção [Prova antes de liberação em Neon](./gate-4-sales-core.md#prova-antes-de-liberação-em-neon) do Gate 4. Nenhum workflow cria branch; o CI usa o PostgreSQL 18 do runner.
- **Proposta, pendente de decisão:** a suíte completa é executada para cada promoção, a partir do SHA candidato. A alternativa é aceitar uma execução anterior (por exemplo, a do fim da fase, registrada na linha "Suíte completa em Neon" de `doc/status-implementacao.md`) quando nada que a emenda do ADR 0025 lista como gatilho mudou depois dela (executor `run-gates.ts`, suporte comum dos gates, migration que muda privilégios amplamente, objetos de banco tocados).
- Evidência: o resumo de cada gate (`"status": "passed"`), o nome da branch, a data e a confirmação de que a branch foi apagada. Sem connection string.

### 5. Pendências de ambiente do go-live (BLOCK)

- Critério: cada item do [checklist de go-live](./README.md#checklist-de-go-live-cloudflare-e-neon) que a promoção toca está marcado com leitura de volta: bindings Hyperdrive com query caching desabilitado, segredos, namespaces de rate limit, bucket de mídia e demais itens do trecho que se aplica; para as filas e os crons, o [checklist das filas](./queues.md#checklist-de-go-live-do-despachante-responsável) e o [Antes de ligar dos jobs agendados](./scheduled-jobs.md#antes-de-ligar-responsável). Itens que a promoção não toca ficam listados como não aplicáveis, com o motivo.
- **Proposta, pendente de decisão:** este item bloqueia **toda** promoção enquanto houver item tocado aberto no go-live, e não só a primeira exposição pública. A alternativa é bloquear só a primeira.
- Segredos: só nomes e data de criação, nunca valores.
- Evidência: lista dos itens tocados com a leitura de volta, a data e quem leu.

### 6. Smoke test definido e executado (BLOCK)

- Critério: antes da promoção, a lista de verificações de fumaça está escrita: rota, resposta esperada e o que fazer se falhar, para cada Worker promovido. Ela é executada contra o ambiente que recebe o SHA e, depois da implantação em produção, contra produção.
- **Proposta, pendente de decisão:** lista manual, escrita no relatório da execução e executada por uma pessoa com o perfil autorizado, porque o repositório não tem script de smoke test. A alternativa (script versionado ou verificação no CI) é decisão do time e muda este item.
- Evidência: a lista, o resultado de cada verificação, a data e o host. Sem tokens nem dados de cliente.

### 7. Critérios de rollback e responsável (BLOCK)

- Critério: para os Workers, os Static Assets e as migrations, a condição que dispara rollback ou forward-fix, a ação e o responsável com o escalonamento. Migration sem reversão automática precisa de forward-fix descrito. Os runbooks de [Filas Cloudflare](./queues.md#rollback-ou-forward-fix) e de [Jobs agendados](./scheduled-jobs.md#rollback-ou-forward-fix) já descrevem como parar o consumo e os crons.
- Evidência: o plano no relatório da execução, com nome ou papel do responsável (**proposta, pendente de decisão:** o responsável pelo projeto, como nos demais runbooks).

### 8. SHA implantado conferido no host de deploy (BLOCK)

- Critério: para cada Worker promovido, o SHA lido de volta no host de deploy (versão do Worker ou identificador exposto pelo deploy) é igual ao SHA candidato. A promoção só é dada como feita depois disso.
- **Proposta, pendente de decisão:** leitura manual, por quem tem o perfil autorizado ([política de perfis de CLI](./cli-profile-policy.md)), sem script. O repositório não expõe o SHA no Worker nem tem script de deploy.
- Se o host não expõe o SHA, o item fica como dados insuficientes. Não se presume que o deploy é igual ao candidato.
- Evidência: a leitura de volta, com o identificador e a data.

### 9. Nenhum achado "bloqueia" aberto do revisor (BLOCK)

- Critério: na revisão do PR de origem, nenhum achado de severidade "bloqueia" está aberto e nenhum achado de segurança está sem resolução.
- Evidência: link da revisão e o estado de cada achado.

### 10. Prazos legais com validação jurídica pendente (BLOCK)

- Critério: prazos legais com `legalReview` pendente bloqueiam a promoção a produção. Em `packages/domain/src/privacy/retention.ts`, toda classe de base legal (`basis: "lei"`) está com `legalReview` preenchido por quem validou (`reviewedBy` e `reviewedAt`: contador ou jurídico); uma classe ainda `"pending"` falha o item. Os prazos legais foram decididos pelo orquestrador com base em pesquisa (ADR 0079) e nenhuma validação profissional existe até esse campo ser preenchido.
- Evidência: a lista das classes legais com o `legalReview` lido no SHA candidato (quem validou e quando).

### 11. Registro de acesso do Marco Civil: pendências depois da tabela própria (BLOCK)

- Critério: a tabela própria do registro de acesso existe (`auth_access_log`, migration 0076, [ADR 0092](../adr/0092-registro-de-acesso-a-aplicacao.md)) e o bloqueio `access_record_table` da classe `auth_sessions` está resolvido no registro de retenção. Ainda faltam, para o item passar:
  - a revisão jurídica (`legalReview`) das classes `auth_access_log` e `auth_security_audit`, pendente. A regra geral está no item 10; este item só aponta as duas classes, sem repetir o critério;
  - o alerta sobre `auth_access_log_write_failed` configurado no destino dos logs, e o `auth_access_log_skipped` acompanhado ([runbook do registro de acesso](./registro-de-acesso.md#6-monitoramento));
  - o job de expurgo com guarda cautelar (Marco Civil, art. 15, §2º), que só pode existir antes do go-live + 6 meses. Nenhuma linha vence antes de 6 meses do go-live, e o bloqueio `access_log_hold` do registro impede o job até a guarda existir. Item datado: **job de expurgo com guarda cautelar antes de go-live + 6 meses**.
- Evidência: o nome da tabela e o resultado do gate `access-log` no SHA candidato; o `legalReview` lido no SHA candidato (quem validou e quando) das duas classes; a configuração do alerta (nome da regra, sem segredo); e, para o job, a pendência datada no [status de implementação](../../doc/status-implementacao.md).

### 12. Achados "vale corrigir" e "menor" registrados (WARN)

- Critério: os achados abertos desses níveis ficam listados no relatório, com dono e data prevista de correção.
- Evidência: a lista, com links.

### 13. Status com evidência de commit (WARN)

- Critério: o status do repositório (`doc/status-implementacao.md`) foi conferido contra o SHA promovido. Só é marcado como feito o que tem commit de evidência.
- Evidência: o trecho do status atualizado e o commit citado.

### 14. Formato do erro 9422 do binding IMAGES confirmado (BLOCK)

- Critério: confirmar no Cloudflare real o formato do erro 9422 do binding `IMAGES` (ou provocá-lo e registrar) antes do go-live. Motivo: a documentação da Cloudflare não mostra como o binding expõe o 9422, e a detecção em `apps/web/src/server/media-image-pipeline.ts` é uma suposição (`code` numérico ou texto, o número 9422 na mensagem do erro e o cabeçalho `Cf-Resized: err=9422`). Se o formato real for outro, o fallback não dispara e, com a cota estourada, as miniaturas do ERP voltam 503 e o upload falha com 503 `media_processing_unavailable`, em vez de `media_transform_quota_exceeded`. Confirmar também que não há cobrança acima da franquia, que hoje só consta na documentação (ADR 0018).
- Evidência: o formato observado (campo e valor, sem segredos), a data, quem leu e o ambiente. Se o formato diferir dos aceitos, o ajuste do código e do teste entra antes da promoção.
- Frequência (decisão do Arrascaeta): o item é conferido uma vez antes do go-live e de novo sempre que mudar a `compatibility_date` do Worker ou a configuração do binding `images` (`IMAGES`) em `apps/web/wrangler.jsonc`; o binding não tem versão própria. Fora esses casos, as promoções seguintes citam o registro vigente (formato, data, ambiente).

### 15. Todo login do app é membro de um `polaris_*_runtime` (BLOCK)

- Critério: todo login que o app usa em produção (os usuários dos bindings Hyperdrive de tenant, auth, onboarding, cleanup, catálogo, privacidade, Admin e os demais) é membro de um papel `polaris_*_runtime`. O gate `definer-hardening` ([ADR 0093](../adr/0093-funcoes-security-definer-e-privilegios-padrao.md)) só enxerga como runtime os papéis `polaris_*_runtime`, quem é membro deles e os logins dos gates; um login fora desses grupos escapa das verificações por papel (concessão direta de `TEMPORARY` ou `CREATE` em `public`, dono do banco e papéis poderosos alcançáveis). Listar os logins dos bindings e a pertença de cada um (`pg_auth_members`), em modo leitura.
- Evidência: a lista de logins (nome do papel, sem senha nem URL) com o grupo `polaris_*_runtime` de cada um, a data e quem leu. Login sem grupo, ou que seja o dono do banco, bloqueia até ser corrigido ou ter decisão registrada.

### 16. Exceção não capturada visível nos Workers Logs com `invocation_logs` desligado (BLOCK)

- Critério: os três Workers têm `observability.logs.invocation_logs: false` ([ADR 0094](../adr/0094-tracing-e-amostragem-do-workers-observability.md)), e a documentação da Cloudflare não diz se as exceções não capturadas continuam nos Workers Logs com ele desligado. No staging, provocar uma exceção não capturada em cada Worker (`polaris-web`, `polaris-admin`, `polaris-catalog`) e conferir se ela aparece nos Workers Logs. Se não aparecer em algum Worker, ligar `invocation_logs` nele (o custo é uma linha por requisição, dentro da estimativa do ADR 0094) antes do go-live e repetir a prova.
- **Proposta, pendente de decisão:** o item vale uma vez antes do go-live e de novo quando mudar a configuração `observability` de um Worker ou a `compatibility_date`; depois, as promoções citam o registro vigente (Worker, data, ambiente, resultado).
- Evidência: por Worker, o ambiente, a data, quem provocou a exceção, se ela apareceu nos Workers Logs (sim ou não) e, se não, o valor de `invocation_logs` depois da correção. Sem segredos nem dados de cliente.

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
- Nenhum `package.json` do repositório tem script de deploy nem de smoke test (o `build` de `apps/admin` usa `wrangler deploy --dry-run`). Os itens 6 e 8 precisam de definição antes da primeira execução.

## Decisões pendentes

Cada uma está marcada no texto como proposta, pendente de decisão:

1. Severidade final de cada item (hoje 14 BLOCK e 2 WARN) e do aviso da auditoria de dependências (item 2).
2. Se o item 5 bloqueia toda promoção ou só a primeira.
3. Quem é o responsável no escalonamento e no item 7.
4. Como fazer o smoke test do item 6.
5. Como ler o SHA no host de deploy (item 8).
6. Se uma execução anterior da suíte completa em Neon (a do fim da fase) vale como evidência do item 4, e se o nome `run-AAAA-MM-DD-<SHA curto>.md` é o adotado para o relatório.
