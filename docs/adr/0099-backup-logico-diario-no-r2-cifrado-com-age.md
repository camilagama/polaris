---
status: proposed
---

# Backup lógico diário do banco no R2, cifrado com age, provado primeiro no staging

> O número 0099 estava reservado ao backup na `main` e não é usado por nenhum PR aberto no momento da escrita; pode mudar se outro entrar antes. Este ADR fica `proposed` até o primeiro backup e o primeiro ensaio de restauração do staging passarem; o resultado entra como emenda.

## Contexto

O Neon Free ([ADR 0076](0076-teto-de-custo-e-free-tier-primeiro.md)) guarda 6 horas de histórico e não tem snapshot agendado, enquanto o [ADR 0079](0079-retencao-por-classe-de-dado.md) assume uma janela de backup de 35 dias (`provider_backups`). Sem backup próprio, um erro percebido depois de 6 horas, um projeto apagado ou a conta perdida perdem tudo. O desenho da produção previa um dump horário; o custo de egress do Neon Free (5 GB por mês) o derrubou, e o usuário decidiu pelo diário, só uma cópia (no R2) e uma chave por ambiente. Ele também decidiu que o que só existiria na produção precisa ter equivalente testável no staging ([ADR 0097](0097-staging-fixo-e-producao-em-conta-separada.md)).

## Decisão

1. **Um job diário no GitHub Actions por ambiente**, desligado por variável até os recursos existirem. Ele não roda dependência do repositório: só scripts de shell, SQL e um script Node sem pacote. O `pg_dump` é o 18 da imagem `postgres` fixada por digest, porque o cliente precisa ser da versão do servidor ou mais novo.
2. **Login próprio, só leitura:** `polaris_backup_reader`, criado à mão pelo dono (fora das migrations e fora de `neon_superuser`), `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS NOINHERIT CONNECTION LIMIT 2`, membro só de `pg_read_all_data` (`INHERIT TRUE, SET FALSE`) e com `default_transaction_read_only = on`. O `BYPASSRLS` é necessário porque o RLS é forçado e o `pg_dump` recusa uma tabela que a política filtraria (o que também impede um dump incompleto sem erro). É a leitura mais ampla fora do dono, então o verificador do ambiente aceita esse login pelo nome e só com esses atributos, sem objeto, grant, política ou membro.
3. **Contagens no mesmo snapshot.** O job exporta um snapshot `REPEATABLE READ`, faz o dump com `--snapshot` e, na mesma transação, lê as contagens de cada tabela e as leituras do catálogo que o restore confere (ACL das funções, RLS, políticas, deletion ledger). Tudo vai num manifest **dentro** do arquivo cifrado, nunca no log, que é público.
4. **Cifra assimétrica com age.** Só a chave pública fica no repositório (`ops/backup/recipients-<ambiente>.txt`, troca por PR revisado, com o hash numa variável do Environment que o job confere); o GitHub e o R2 não decifram nada. A chave privada nunca entra no repositório, no GitHub nem no R2; por decisão do dono de 12/11/2026, ela fica no cofre do servidor OpenBot (arquivo 0400 fora do repositório) e não offline, para o ensaio de restauração rodar sem o titular, e o resto do desenho não muda. Perder a chave perde os backups dela, de propósito.
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
