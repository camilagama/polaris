---
status: accepted
---

# Backup lógico diário do banco no R2, cifrado com age, provado primeiro no staging

> Este ADR está `accepted` com escopo **staging**: o primeiro backup e o primeiro ensaio de restauração do staging passaram em 15/11/2026 (ver a [emenda](#emenda-de-15112026-primeiro-backup-e-primeiro-ensaio-do-staging)). A produção repete os dois no go-live.

## Contexto

O Neon Free ([ADR 0076](0076-teto-de-custo-e-free-tier-primeiro.md)) guarda 6 horas de histórico e não tem snapshot agendado, enquanto o [ADR 0079](0079-retencao-por-classe-de-dado.md) assume uma janela de backup de 35 dias (`provider_backups`). Sem backup próprio, um erro percebido depois de 6 horas, um projeto apagado ou a conta perdida perdem tudo. O desenho da produção previa um dump horário; o custo de egress do Neon Free (5 GB por mês) o derrubou, e o usuário decidiu pelo diário, só uma cópia (no R2) e uma chave por ambiente. Ele também decidiu que o que só existiria na produção precisa ter equivalente testável no staging ([ADR 0097](0097-staging-fixo-e-producao-em-conta-separada.md)).

## Decisão

1. **Um job diário no GitHub Actions por ambiente**, desligado por variável até os recursos existirem. Ele não roda dependência do repositório: só scripts de shell, SQL e um script Node sem pacote. O `pg_dump` é o 18 da imagem `postgres` fixada por digest, porque o cliente precisa ser da versão do servidor ou mais novo.
2. **Login próprio, só leitura:** `polaris_backup_reader`, criado à mão pelo dono (fora das migrations e fora de `neon_superuser`), `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS NOINHERIT CONNECTION LIMIT 2`, membro só de `pg_read_all_data` (`INHERIT TRUE, SET FALSE`) e com `default_transaction_read_only = on`. O `BYPASSRLS` é necessário porque o RLS é forçado e o `pg_dump` recusa uma tabela que a política filtraria (o que também impede um dump incompleto sem erro). É a leitura mais ampla fora do dono, então o verificador do ambiente aceita esse login pelo nome e só com esses atributos, sem objeto, grant, política ou membro.
3. **Contagens no mesmo snapshot.** O job exporta um snapshot `REPEATABLE READ`, faz o dump com `--snapshot` e, na mesma transação, lê as contagens de cada tabela e as leituras do catálogo que o restore confere (ACL das funções, RLS, políticas, deletion ledger). Tudo vai num manifest **dentro** do arquivo cifrado, nunca no log, que é público.
4. **Cifra assimétrica com age.** Só a chave pública fica no repositório (`ops/backup/recipients-<ambiente>.txt`, troca por PR revisado, com o hash numa variável do Environment que o job confere); o GitHub e o R2 não decifram nada. A chave privada nunca entra no repositório, no GitHub nem no R2; por decisão do dono de 12/11/2026, ela fica no cofre do servidor OpenBot (arquivo 0400 fora do repositório, com a identidade `age` sem senha) e não offline, para o ensaio de restauração rodar sem o titular, e o resto do desenho não muda. Perder a chave perde os backups dela, de propósito.
5. **Retenção pelo job, não pelo ciclo de vida do bucket:** apaga o que tem mais de 35 dias, mantendo sempre os 35 mais novos, e só depois de confirmar o envio do dia. Um ciclo de vida apagaria os últimos backups quando o job parasse.
6. **Mesmo grupo de concorrência do deploy do ambiente**, para um dump nunca correr junto de uma migration.
7. **Ensaio de restauração automatizado** (`scripts/backup/restore.mjs`) numa branch Neon descartável, num banco marcado `restore-drill`: os passos 2 e 2b e as conferências do passo 5 do [restore e deletion ledger](../runbooks/deletion-ledger-restore.md), mais a comparação com o manifest. O staging prova o mecanismo; a produção só troca os nomes.

## Consequências

- O RPO é de até um dia mais o atraso do agendador; para erro percebido em até 6 horas, o histórico do Neon continua sendo o caminho.
- Os backups levam dado eliminado por até 35 dias, como o ADR 0079 já aceita; qualquer restauração de verdade reaplica o deletion ledger antes de reabrir o ambiente.
- Um job de backup na fila pode tirar o lugar de um deploy pendente (o GitHub guarda um pendente por grupo), e vice-versa; o próximo merge ou o dia seguinte recupera.
- Fica para depois: a 2ª cópia fora da Cloudflare, o vigia de backup ausente, o teste de restore no CI e o bucket lock (a confirmar se é grátis).

## Alternativas descartadas

- **Plano pago do Neon (7 dias de histórico):** o usuário decidiu ficar no Free.
- **gpg simétrico:** a senha ficaria no GitHub, e quem lê os segredos decifraria os backups.
- **Usar o dono do banco no dump:** dá escrita e DDL a um job agendado.
- **Worker Cron fazendo o dump:** sem `pg_dump` e com o limite de CPU do plano Free.
- **Dump horário ou a cada 3 horas:** estoura o egress do Neon Free.

## Emenda de 15/11/2026: primeiro backup e primeiro ensaio do staging

Decisão de 18/11/2026: o ADR passa a `accepted`, com escopo staging.

- **Backup:** o primeiro job diário do staging passou no run 43742485132, com `snapshot_at` 2026-11-15T17:41:53Z e pacote de 3.943.560 B (relatório do Juan).
- **Restauração:** o ensaio de ponta a ponta, feito pelo Arrascaeta em 15/11, por volta das 15:20 BRT (18:20Z), com a identidade do cofre do servidor, teve o `pg_restore` saindo com `rc 1`, só com os 2 erros de ACL padrão da plataforma (`ALTER DEFAULT PRIVILEGES FOR ROLE cloud_admin`, que o Neon recusa), aceitos por `restoreOutcome` em `scripts/backup/restore-lib.mjs`; o ensaio terminou `ok: true` e `checks: []`: 84 tabelas e 64.337 linhas, as contagens de cada tabela iguais às do manifest.
- **RTO de dados:** 23 s (passo 3 do [ensaio](../runbooks/backup.md#ensaio-de-restauração)).
- **RPO medido:** cerca de 38 min (instante do ensaio menos o `snapshot_at` do backup).
- **O RPO de desenho não muda:** continua "até um dia mais o atraso do agendador" (Consequências); os 38 min são a medida deste ensaio, não uma garantia.
- **Limites:** o ledger de eliminação do staging tinha 0 linhas, então a consulta final do passo 5 do [restore e deletion ledger](../runbooks/deletion-ledger-restore.md) passou sem exercitar nada; a restauração por PITR e a produção não foram provadas.
- **Produção:** repete o primeiro backup e o primeiro ensaio de restauração no go-live, como pré-condição no [release-checklist](../runbooks/release-checklist.md#5-pendências-de-ambiente-do-go-live-block). Isso não reabre este ADR.

Os detalhes e o comando estão no [runbook](../runbooks/backup.md#ensaio-de-15112026-staging).
