# Checklist de release para produção

Status: proposta, aguardando decisão do time. Nenhum item foi executado para uma promoção ainda.

Checklist canônico para promover um SHA de `main` ao ambiente de produção do Polaris: Worker de Web, Static Assets e migrations do banco. Ele não substitui o [checklist de go-live](./README.md#checklist-de-go-live-cloudflare-e-neon), que cobre a primeira exposição pública. Os itens de go-live aparecem por link e não são copiados aqui.

## Gatilho

Qualquer promoção de SHA para produção. Mudança neste checklist entra por PR, como as demais fontes de runbook.

## Pré-requisitos de acesso

- Leitura do repositório e do histórico de CI no GitHub.
- Leitura do banco de produção (tabela de controle de migrations) e do host de deploy, sempre com o perfil autorizado pela [política de perfis de CLI](./cli-profile-policy.md). Este checklist só lê; alterar produção exige autorização explícita do responsável.
- Relatórios não contêm segredos, connection strings nem tokens: só nomes e datas.

## Regras

- **CI verde não é aceito.** O verde é conferido job a job, no SHA candidato (itens 2 e 4).
- **Nunca aprovar parcialmente um item BLOCK.** Ou ele tem evidência e passa, ou não passa.
- **Nunca editar o resultado esperado para ficar verde.** Se o resultado esperado de um teste ou gate precisa mudar, a mudança é um commit próprio, revisado, e o SHA candidato muda.
- **Sem critério de aceite, o veredito é dados insuficientes.**
- Severidade: **BLOCK** impede a promoção se falhar, faltar ou não puder ser lido. **WARN** não impede, desde que o registro cite o item e o responsável.

## Itens

### 1. SHA candidato identificado (BLOCK)

- Critério: um SHA completo, já em `main`, com o PR de origem identificado.
- Evidência: o SHA, o link do PR e a saída de `git rev-parse origin/main` no momento da leitura.

### 2. CI do SHA verde, job a job (BLOCK)

- Critério: no SHA candidato, os jobs `Changed areas` e `Checks (lint, types, knip, build, tests)` terminam com sucesso.
- Os jobs `PostgreSQL 18 gates` e `Dependency audit` têm `continue-on-error: true` em `.github/workflows/ci.yml`. O resultado real deles é lido e registrado; falha conta como falha.
- `Offline persistence browser gate` não roda em evento `push` (ver `ci.yml`). Nesse caso, a evidência é a execução do evento `pull_request` do PR de origem. Se `main` mudou depois dele, o gate é reexecutado.
- `skipped` só vale quando o job `Changed areas` mostra que a área não mudou. Qualquer outro `skipped` é falha.
- Evidência: link da execução de CI do SHA, com o estado de cada job.

### 3. Migrações pendentes com plano de aplicação e de volta (BLOCK)

- Critério: listar as migrations de `packages/db/drizzle` ainda não aplicadas em produção, comparando com a tabela de controle do Drizzle, lida em modo leitura.
- Para cada migration: se é aditiva ou destrutiva, a ordem de aplicação e o plano de volta (rollback ou forward-fix).
- Migration destrutiva sem plano de volta bloqueia.
- Respeitar a ordem de publicação de cada gate (por exemplo, [Gate 5](./gate-5-offline.md#ordem-de-publicação)).
- Comando de produção só entra no plano depois de testado em branch descartável ou staging, como pede o [README de runbooks](./README.md).
- Evidência: lista das migrations pendentes (nome e hash), saída da leitura do banco e o plano escrito.

### 4. Gates de banco na branch Neon descartável (BLOCK)

- Critério: a partir do SHA candidato, uma branch Neon descartável com as migrations replayadas do zero, e `bun run --filter @polaris/db gates:ci` mais os gates da fase atual passando. O próprio `ci.yml` diz que esses gates continuam obrigatórios em Neon descartável antes de release.
- A branch é apagada ao final.
- Evidência: saída dos gates com o nome da branch e a data, e a confirmação de que a branch foi apagada.

### 5. Pendências de ambiente do go-live (BLOCK)

- Critério: cada item do [checklist de go-live](./README.md#checklist-de-go-live-cloudflare-e-neon) que a mudança toca está marcado com leitura de volta: bindings Hyperdrive, segredos, namespaces de rate limit, bucket de mídia e demais itens do trecho que se aplica. Itens que a mudança não toca ficam listados como não aplicáveis, com o motivo.
- Enquanto um item tocado estiver aberto no checklist de go-live, o veredito é bloquear.
- Segredos: só nomes e data de criação, nunca valores.
- Evidência: lista dos itens tocados com a leitura de volta, a data e quem leu.

### 6. Smoke test definido e executado (BLOCK)

- Critério: antes da promoção, a lista de verificações de fumaça está escrita: rota, resposta esperada e o que fazer se falhar. Ela é executada contra o ambiente que recebe o SHA e, depois da implantação em produção, contra produção.
- Evidência: a lista, o resultado de cada verificação, a data e o host. Sem tokens nem dados de cliente.

### 7. Critérios de rollback e responsável (BLOCK)

- Critério: para o Worker, os Static Assets e as migrations, a condição que dispara rollback ou forward-fix, a ação e o responsável com o escalonamento. Migration sem reversão automática precisa de forward-fix descrito.
- Evidência: o plano no relatório da execução, com nome ou papel do responsável.

### 8. SHA implantado conferido no host de deploy (BLOCK)

- Critério: o SHA lido de volta no host de deploy (versão do Worker ou identificador exposto pelo deploy) é igual ao SHA candidato. A promoção só é dada como feita depois disso.
- Se o host não expõe o SHA, o item fica como dados insuficientes. Não se presume que o deploy é igual ao candidato.
- Evidência: a leitura de volta, com o identificador e a data.

### 9. Nenhum achado "bloqueia" aberto do revisor (BLOCK)

- Critério: na revisão do PR de origem, nenhum achado de severidade "bloqueia" está aberto e nenhum achado de segurança está sem resolução.
- Evidência: link da revisão e o estado de cada achado.

### 10. Achados "vale corrigir" e "menor" registrados (WARN)

- Critério: os achados abertos desses níveis ficam listados no relatório, com dono e data prevista de correção.
- Evidência: a lista, com links.

### 11. Status com evidência de commit (WARN)

- Critério: o status do repositório foi conferido contra o SHA promovido. Só é marcado como feito o que tem commit de evidência.
- Evidência: o trecho do status atualizado e o commit citado.

## Veredito

Ordem de decisão:

1. **Bloquear**: algum item BLOCK falhou, com evidência.
2. **Dados insuficientes**: algum item BLOCK não tem evidência, critério ou leitura. Diga qual leitura falhou e por quê.
3. **Aprovar**: todos os itens BLOCK passaram com evidência, e os WARN estão registrados.

Nunca "talvez". O veredito vale só para o SHA e o ambiente lidos.

## Registro da execução

- O relatório de cada execução fica fora do repositório, na pasta compartilhada de operações do Polaris, com o nome `run-AAAA-MM-DD-<SHA curto>.md`.
- Conteúdo: SHA, cada item com status e evidência, veredito, incógnitas e decisões que faltam.

## Rollback ou forward-fix

Este checklist não altera recursos. Quando o veredito é bloquear, ele não reverte nada: a correção é um commit novo ou uma decisão do responsável.

## Escalonamento

Responsável pelo projeto. Veredito de bloquear ou dados insuficientes vai para o responsável do projeto e para quem pediu a promoção.

## Estado atual

- O checklist de go-live declara que nada foi executado. Enquanto um item tocado estiver aberto, a primeira execução tende a bloquear.
- `package.json` não tem script de deploy nem de smoke test. Os itens 6 e 8 precisam de definição antes da primeira execução.
