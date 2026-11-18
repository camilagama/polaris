# Backup diário do banco e ensaio de restauração

**Gatilho:** ligar o backup de um ambiente (staging primeiro, produção no go-live), um backup que falhou (issue com o rótulo `backup-staging` ou `backup-production`), o ensaio periódico de restauração ou uma restauração de verdade.

**Por quê:** o Neon Free guarda só 6 horas de histórico. O backup cobre o desastre maior (projeto apagado, conta perdida, corrupção percebida tarde): um `pg_dump` diário, cifrado fora do Neon, guardado 35 dias (o prazo de `provider_backups` do [ADR 0079](../adr/0079-retencao-por-classe-de-dado.md)). A decisão e as alternativas estão no [ADR 0099](../adr/0099-backup-logico-diario-no-r2-cifrado-com-age.md). O staging roda o mesmo mecanismo da produção, com outros nomes, para que ele chegue ao go-live já provado.

> **Estado:** os scripts e as checagens existem no repositório, mas o login, o bucket, o token, o Environment `staging-backup` e o rótulo existem desde 12/11/2026 e o workflow `backup-staging.yml` (só o staging) está no repositório. O workflow `backup.yml`, com um job por ambiente (`staging` e `production`), cada um só rodando com a variável do seu ambiente (`STAGING_BACKUP_ENABLED`, `PRODUCTION_BACKUP_ENABLED`, do responsável), está **pendente**: vem no patch `t1195-workflow.patch`, que o Arrascaeta aplica (o dev não altera `.github/workflows`), e substitui o `backup-staging.yml`. Até lá, o que vale no repositório é o `backup-staging.yml`, e tudo abaixo que cita o `backup.yml` descreve o estado depois do patch. A produção nasce desligada e sem chave: a [seção de produção](#produção-go-live) diz o que falta. O primeiro backup e o primeiro ensaio do staging passaram em 15/11/2026 ([resultado abaixo](#ensaio-de-15112026-staging)); a produção repete os dois no go-live.

## Quem faz o quê

| Quem | O quê |
| --- | --- |
| Responsável (Arrascaeta) | roda o ensaio de restauração com a identidade do cofre do servidor; cria o login, o bucket, o token R2, o Environment, as variáveis e o rótulo; liga a variável `STAGING_BACKUP_ENABLED` (a `PRODUCTION_BACKUP_ENABLED` só no go-live); configura e lê de volta o PITR do Neon; cria e apaga a branch Neon do ensaio ([política de perfis da CLI](./cli-profile-policy.md)); decide qualquer restauração de verdade |
| Titular da chave (a pessoa escolhida pelo usuário; uma chave por ambiente) | gera a chave age, guarda a identidade no cofre do servidor e entrega só a chave pública |
| Dev | mantém os scripts, o SQL e este runbook; nunca vê a chave privada nem a senha do login; a conferência da chave está descrita logo abaixo da tabela |

Quem garante que o dev não vê a chave privada é o responsável, dono do cofre do servidor: ele confere à mão, pelo modo e pelo dono do arquivo (`stat`), que a identidade é `0400` e de um usuário que não é o do processo do dev; o dev não tem como conferir isso nem ler o arquivo.

A chave privada nunca vai ao GitHub nem ao R2. Por decisão do dono de 12/11/2026, ela fica no cofre do servidor OpenBot (arquivo 0400 fora do repositório), não offline, para o ensaio de restauração rodar sem o titular; o resto do desenho não muda. Perder a chave deixa todos os backups dela ilegíveis, de propósito.

## O que existe

- `scripts/backup/dump.sh`: roda dentro da imagem `postgres:18` fixada por digest. Confere o marcador do banco (`polaris.environment=<ambiente>`, [ADR 0097](../adr/0097-staging-fixo-e-producao-em-conta-separada.md)) e o login (`sql/preflight.sql`), abre uma transação `REPEATABLE READ READ ONLY`, exporta o snapshot, faz `pg_dump -Fc --compress=zstd:6 --snapshot=…` e, no mesmo snapshot, lê `sql/reference.sql`: contagem de linhas de cada tabela, as migrations e as leituras do catálogo do restore (ACL das funções, RLS, políticas, deletion ledger). Grava `dump`, `roles.sql` (`pg_dumpall --roles-only --no-role-passwords`) e `manifest.json`. As contagens ficam **só** no manifest, que vai cifrado: o log do repositório é público.
- `scripts/backup/seal.sh`: `tar` dos três arquivos, cifrado com `age` para as chaves públicas de `ops/backup/recipients-<ambiente>.txt`; apaga o texto claro.
- `scripts/backup/upload.sh`: envia `daily/AAAAMMDDTHHMMSSZ.tar.age` com o cabeçalho `x-amz-checksum-sha256` (o R2 confere os bytes recebidos e recusa o envio que não bate) e o SHA-256 também no metadado `sha256`, relê tamanho e metadado com `head-object` e só então aplica a retenção (`scripts/backup/retention.mjs`).
- `scripts/backup/restore.mjs`: o ensaio de restauração (seção abaixo).
- `ops/backup/recipients-staging.txt` e `ops/backup/recipients-production.txt`: a chave pública de cada ambiente (a da produção está vazia, com a instrução no próprio arquivo). Trocar passa por PR revisado, junto com a variável `BACKUP_RECIPIENTS_SHA256` do Environment do ambiente.
- `scripts/verify-backup-workflow.mjs`: no `bun run test`, reprova o `backup.yml` (depois do patch; sem ele, o teste não confere nada) se os dois jobs diferirem em algo além dos nomes do ambiente, se um job citar bucket, Environment, chave, grupo de concorrência ou rótulo do outro, ou se o workflow ganhar gatilho além de `schedule` e `workflow_dispatch`.
- `staging:verify-database after-migrate` aceita o login `polaris_backup_reader` como única exceção à regra "todo login é membro de um grupo `*_runtime`", e só com os atributos exatos abaixo (`packages/db/scripts/backup-reader.ts`).

**Retenção:** o job apaga o que tem mais de 35 dias, mas mantém sempre os 35 backups mais novos, e só depois de confirmar o envio do dia. Com o job parado por semanas, nada some. O bucket fica **sem** regra de ciclo de vida: ela apagaria o último backup quando o job para. Só objetos com o nome que o job grava entram na conta; outro arquivo no prefixo nunca é apagado.

**Log do job:** só "ok", o tamanho em MB, o SHA-256 do arquivo cifrado e o nome da checagem que falhou. Nunca a senha, o host com credencial, nome de tabela com contagem ou dado.

## Ligar no staging (responsável)

Tudo na conta Cloudflare e no projeto Neon do staging. Registre o resultado de cada passo (sem senha nem chave).

1. **Criar o login (decide o desenho; provado no ensaio de 15/11/2026).** Com o dono (`neondb_owner`) e a URL direta, criar o login pelo SQL, **nunca pelo console** (que põe o papel em `neon_superuser`), lendo a senha de um arquivo `umask 077` como no [runbook do staging, seção 1.4](./staging.md#1-banco-responsável):

   ```sql
   CREATE ROLE polaris_backup_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS NOINHERIT
     CONNECTION LIMIT 2 PASSWORD '<senha em texto>';
   GRANT pg_read_all_data TO polaris_backup_reader WITH INHERIT TRUE, SET FALSE;
   ALTER ROLE polaris_backup_reader SET default_transaction_read_only = on;
   ```

   O `pg_read_all_data` também dá leitura aos catálogos, `pg_authid` incluído: quem tiver a senha desse login lê os verificadores SCRAM dos outros logins (não servem para entrar, só para tentar adivinhar a senha fora do banco; as senhas dos logins são aleatórias e longas). Por isso a senha dele fica só no Environment e se troca junto com qualquer suspeita de vazamento. Sem `idle_in_transaction_session_timeout` nesse login: a sessão que segura o snapshot fica ociosa em transação enquanto o `pg_dump` roda. **Provado em 15/11/2026:** o `neondb_owner` consegue dar `BYPASSRLS` (o PostgreSQL 16+ exige que quem cria o tenha) e o `GRANT pg_read_all_data` (exige `ADMIN` nesse papel), e o dump do primeiro backup saiu com esse login. Se um ambiente novo não conseguir, pare: o desenho volta à revisão de segurança, porque a alternativa é usar o dono. Por que `BYPASSRLS`: com RLS forçado, o `pg_dump` liga `row_security = off` e **falha** numa tabela que a política filtraria, então um dump incompleto sem erro não acontece, mas sem o atributo o dump não sai.
2. **Conferir o login.** `bun run --filter @polaris/db staging:verify-database after-migrate` (com a URL do migrador) tem de listar `login polaris_backup_reader: pg_read_all_data, BYPASSRLS, read-only, owns nothing`. Qualquer outro atributo, pertença, objeto, grant ou política com o login, ou alguém que possa virar ele, reprova o deploy do staging, de propósito. **Em aberto (o ensaio de 15/11/2026 não registrou):** que o Neon não acrescenta pertença nem dependência ao papel (se acrescentar, levar ao Rodrigo antes de afrouxar a checagem).
3. **Bucket e token.** Bucket privado `polaris-backup-staging`, sem ciclo de vida e sem acesso público. Token R2 "Object Read & Write" só nesse bucket, com validade. **Em aberto (o ensaio de 15/11/2026 não registrou):** se o bucket lock (retenção por prefixo) de 7 dias em `daily/` é grátis no plano Free; se for, ligar.
4. **Chave.** O titular gera a identidade: `age-keygen -o staging.key`. A identidade vai para o cofre do servidor OpenBot (0400, fora do repositório; decisão de 12/11/2026, ver acima), não para cópia offline, e `staging.key` é apagado da máquina onde foi gerada. A chave pública (`age-keygen -y staging.key` antes de apagar) vai num PR para `ops/backup/recipients-staging.txt`, uma linha `age1…`. Sem chave nesse arquivo o job recusa selar.
5. **Environment `staging-backup`**, restrito à branch `main`, sem revisor obrigatório (travaria o cron). Os segredos ficam **só** no Environment, nunca no repositório: o `if` do job é texto do próprio workflow, e quem tem escrita pode tirá-lo num branch; o que barra um `workflow_dispatch` de outro branch é a restrição do Environment. Crie e restrinja o Environment à `main` **antes** de gravar qualquer segredo nele, e confira a política de branches na tela do Environment (só `main`). Disparar o workflow de outro branch não prova a restrição, porque o `if` do job já o pula antes do Environment; ela só vale para quem editar o `if` num branch. Segredos: `BACKUP_PGPASSWORD` (a senha do login), `R2_BACKUP_ACCESS_KEY_ID` e `R2_BACKUP_SECRET_ACCESS_KEY`. Variáveis: `BACKUP_PGHOST` (host **direto** do projeto, sem `-pooler`), `BACKUP_PGDATABASE` (`neondb`), `R2_BACKUP_ENDPOINT` (`https://<id da conta>.r2.cloudflarestorage.com`) e `BACKUP_RECIPIENTS_SHA256` (`sha256sum ops/backup/recipients-staging.txt` da `main`, depois do PR da chave). O bucket fica escrito no workflow (`polaris-backup-staging`): um backup do staging nunca vai a outro bucket.
6. **Rótulo** `backup-staging` no repositório (a issue de falha usa ele).
7. **Ligar.** O workflow `backup-staging.yml` está no repositório; depois do patch do `backup.yml` (pendente, ver o início do runbook), o job `staging` dele o substitui com a mesma variável. Criar a variável de repositório `STAGING_BACKUP_ENABLED` = `true` liga o backup do staging em qualquer dos dois.
8. **Primeiro backup:** `workflow_dispatch` na `main` (o campo `environment` do disparo vale `staging` por padrão; o cron roda todos os ambientes ligados). Esperado no log: `ok: marker staging and login polaris_backup_reader`, `ok: pg_dump`, `ok: roles`, `ok: manifest (N entries, M MB)`, `ok: sealed for 1 key(s), …, sha256 …`, `ok: uploaded daily/…`, `ok: retention removed 0 object(s)`. Depois, o ensaio de restauração abaixo, que é o que prova o backup.

**Desligar:** apagar `STAGING_BACKUP_ENABLED` (na produção, `PRODUCTION_BACKUP_ENABLED`). Os backups existentes ficam no bucket até alguém apagá-los (a retenção só roda junto de um backup novo).

## Concorrência com o deploy

O job do staging usa o grupo `deploy-staging`, o mesmo do deploy, e o da produção o grupo `deploy-production`: um `pg_dump` (que segura `ACCESS SHARE` em todas as tabelas) nunca corre junto de uma migration, que esperaria por ele ou cairia no `lock_timeout` de 10 s. O GitHub guarda **um** job pendente por grupo: se o backup entrar na fila enquanto um deploy roda e outro espera, o que espera é cancelado (o próximo merge faz o deploy) e vice-versa (o backup do dia não sai; a próxima execução sai no dia seguinte). O horário (06:22 UTC) diminui a chance. Se o deploy pendente for cancelado, reexecute o run do deploy.

## Falha

- O job abre uma issue `backup-staging` (na produção, `backup-production`) com o link do run (texto genérico) e comenta nela a cada nova falha; o próximo sucesso a fecha. O e-mail do GitHub para cron com falha vai à conta do GitHub que editou o cron por último, e só a ela; o aviso que vale para todos é a issue do ambiente.
- Leia o log do run. As recusas dizem a causa pelo nome: `marker: …` (banco sem o marcador de staging ou URL de outro banco), `login: …` (atributo do login), `the recipients file …`, `… does not match BACKUP_RECIPIENTS_SHA256` (chave trocada sem atualizar a variável, ou o contrário: confira o PR), `the stored object does not match …` (envio corrompido: nada foi apagado), `an object with this stamp already exists`.
- Um job que não roda (cron desligado pelo GitHub depois de 60 dias sem atividade num repositório público, ou cancelado pelo grupo de concorrência) não abre issue. Por enquanto a conferência é manual: o objeto mais novo de `daily/` tem menos de 26 h. O vigia automático (sentinela lendo o bucket com um token só leitura) fica para depois.

## Ensaio de restauração

Quem: o responsável pelo servidor onde a identidade está (o titular não precisa participar, ver acima), com a branch que ele mesmo cria. Quando: depois do primeiro backup do staging, depois de qualquer mudança de formato, de chave ou do script, e a cada trimestre. O ensaio do staging é o que libera o PR da produção.

1. **Branch descartável.** O responsável cria uma branch Neon filha da branch principal do projeto do staging, com nome único (`restore-drill-AAAAMMDD`; nunca `--schema-only`, que cria raiz). A branch traz os papéis do staging, então os 21 `polaris_*_owner` já existem. Nela, com o dono e a conexão direta da branch:

   ```sql
   CREATE DATABASE polaris_restore_drill;
   COMMENT ON DATABASE polaris_restore_drill IS 'polaris.environment=restore-drill';
   ```

   O script recusa qualquer banco sem esse comentário exato, não vazio ou com outro nome; os gates também recusam o marcador `restore-drill`.
2. **Baixar.** Com um token só leitura do bucket: `aws s3api get-object --bucket polaris-backup-staging --key daily/<stamp>.tar.age --endpoint-url "$R2_BACKUP_ENDPOINT" <stamp>.tar.age`. O SHA-256 que vale é o da linha `ok: sealed … sha256 …` do log do run que gravou esse backup, **não** o metadado do objeto: quem tiver o token de escrita do bucket pode pôr lá um arquivo forjado (cifrado para a chave pública, que é pública) com o metadado que quiser, mas não reescreve o log do GitHub.
3. **Rodar**, num checkout da `main`, com Node 24, `age`, `psql` e `pg_restore` 18, e a conexão **só** por variáveis `PG*` da branch (nunca URL em argumento):

   ```bash
   export PGHOST=<host direto da branch> PGDATABASE=polaris_restore_drill PGUSER=neondb_owner PGSSLMODE=verify-full PGSSLROOTCERT=system
   # PGPASSWORD pelo ~/.pgpass (modo 600), não no histórico do shell
   node scripts/backup/restore.mjs --environment staging --archive <stamp>.tar.age --identity <caminho da identidade no cofre> --sha256 <hash do log do run>
   ```

   A identidade fica sem senha no cofre, então o `age` não pergunta nada. O script decifra num diretório `0700` (apagado no fim; `--keep-workdir` o mantém para investigar, e aí apague-o à mão, porque `restore.err` pode citar linhas de dados) e faz, sem perguntar, os passos 2, 2b e as conferências do passo 5 do [restore e deletion ledger](./deletion-ledger-restore.md): o preparo dos `GRANT` (sem o login de backup), o `pg_restore` com só os dois resultados aceitos, a reaplicação das ACLs como o dono de cada objeto, a conferência das ACLs das funções **antes** de revogar e a revogação em qualquer saída, com `set_restante` zero. O SQL de ACL só roda se vier protegido por `\restrict` e sem outro metacomando do `psql`; o pacote só é extraído se tiver exatamente os três arquivos, todos regulares; o manifest tem de ser do ambiente de `--environment`. Se o script for interrompido (Ctrl-C, máquina desligada) entre o preparo e a revogação, os `GRANT` de papel ficam no cluster da branch: apague a branch, como no passo 5.
4. **Ler o relatório.** O relatório traz também `tables`, `rows`, `migrations` e `ledger_rows` (totais, sem contagem por tabela): um ledger com 0 linhas faz a consulta final do passo 5 passar sem exercitar nada, então registre esse número. `ok: true` e `checks: []` querem dizer que o banco restaurado bate com o manifest tirado no snapshot do dump: a contagem de **cada** tabela, as migrations, os 21 `polaris_*_owner` (o piso `MIN_OWNER_ROLES` de `scripts/backup/restore-lib.mjs`, que também exige o mesmo número do manifest), nenhuma função `SECURITY DEFINER` com outro dono ou executável por PUBLIC, o hash das ACLs das funções, as funções de purge, a ACL do `public`, as tabelas com RLS forçado e as políticas (hash), nenhuma política permissiva para PUBLIC, nenhum `polaris_*` (fora o login de backup) com `BYPASSRLS`, o mesmo número de linhas do deletion ledger e a consulta final do passo 5 vazia. Qualquer item em `checks` reprova o ensaio: registre o nome da checagem, não corrija à mão. Registre a data, quem fez, o `snapshot_at`, o RPO (instante do ensaio menos `snapshot_at`), o tempo do passo 3 (RTO de dados), o tamanho e o resultado. Só números e nomes, nenhum dado.
5. **Apagar** a branch (responsável) e o arquivo baixado. A identidade volta ao cofre.

**O que o ensaio não faz:** os passos 0, 1, 3 e 4 do [restore e deletion ledger](./deletion-ledger-restore.md) (ler o ledger da origem desde o backup, carregar e reaplicar os tombstones posteriores). Num ensaio o banco restaurado nunca é aberto, então eles não se aplicam; numa restauração de verdade são obrigatórios, à mão, antes de reabrir o ambiente, e o script vem antes deles. Também não restaura papéis num projeto novo (`roles.sql` vai no pacote para esse caso, de perda total, que segue o passo 2 daquele runbook) nem aponta Hyperdrive para o banco restaurado.

## Ensaio de 15/11/2026 (staging)

Primeiro backup e primeiro ensaio de restauração do staging, que levaram o [ADR 0099](../adr/0099-backup-logico-diario-no-r2-cifrado-com-age.md) a `accepted` (escopo staging). Só números e nomes.

| Item | Resultado |
| --- | --- |
| Backup | run 43742485132 do job diário do staging (disparo manual, 17:41Z a 17:43Z) |
| Quando e quem | 15/11/2026: backup e leitura do pacote, relatório do Juan; restauração de ponta a ponta feita pelo Arrascaeta por volta das 15:20 BRT (18:20Z), de um servidor com TCP ao Neon |
| `snapshot_at` | 2026-11-15T17:41:53Z |
| Tamanho do pacote | 3.943.560 B (3,9 MB), `daily/20261115T174143Z.tar.age`; decifrado: `dump` 3.906.562 B, `roles.sql` 18.405 B, `manifest.json` 5.150 B |
| Restauração de ponta a ponta | `pg_restore` com `rc 1`, só os 2 erros de ACL padrão da plataforma (`ALTER DEFAULT PRIVILEGES FOR ROLE cloud_admin`, que o Neon recusa; classe `PLATFORM_DEFAULT_ACL`, aceita por `restoreOutcome` em `scripts/backup/restore-lib.mjs`, que só a admite com `rc 1`), `ok: true`, `checks: []` |
| Tabelas e linhas restauradas | 84 tabelas, 64.337 linhas |
| RTO de dados (passo 3) | 23 s |
| RPO medido | cerca de 38 min (cerca de 18:20Z menos o `snapshot_at` de 17:41:53Z) |

O RPO de desenho continua "até um dia mais o atraso do agendador": os 38 min são a medida deste ensaio.

Comando usado (passo 3 acima, com as variáveis `PG*` da branch descartável e a identidade do cofre; os valores não entram aqui):

```bash
node scripts/backup/restore.mjs --environment staging --archive <stamp>.tar.age --identity <caminho da identidade no cofre> --sha256 <hash do log do run>
```

Limites: o ledger tinha 0 linhas, então a consulta final do passo 5 do [restore e deletion ledger](./deletion-ledger-restore.md) não exercitou nada; PITR e produção não foram provados. A produção repete o primeiro backup e o primeiro ensaio no go-live ([release-checklist](./release-checklist.md#5-pendências-de-ambiente-do-go-live-block)).

## Produção (go-live)

O mesmo mecanismo, com outros nomes, na conta Cloudflare e no projeto Neon da produção. O job `production` do `backup.yml` (pendente do patch) é o do staging com as trocas da tabela abaixo; `scripts/verify-backup-workflow.mjs` garante que não há outra diferença. **Ele nasce desligado e sem chave:** só roda com `PRODUCTION_BACKUP_ENABLED` = `true`, e `ops/backup/recipients-production.txt` não tem chave, então o job também não passaria da conferência do hash nem selaria. O repositório não cria nenhum recurso da produção, e o job só existe depois que o patch do `backup.yml` for aplicado.

Pré-requisito: o staging com backups diários verdes e um ensaio de restauração aprovado depois do último ajuste, e o PITR da produção configurado e lido de volta (seção seguinte).

| | Staging | Produção |
| --- | --- | --- |
| Variável que liga | `STAGING_BACKUP_ENABLED` | `PRODUCTION_BACKUP_ENABLED` |
| Environment | `staging-backup` | `production-backup` |
| Bucket R2 | `polaris-backup-staging` | `polaris-backup` |
| Chave pública | `ops/backup/recipients-staging.txt` | `ops/backup/recipients-production.txt` (outra chave, nunca a do staging) |
| Marcador do banco | `polaris.environment=staging` | `polaris.environment=production` |
| Rótulo da issue de falha | `backup-staging` | `backup-production` |
| Grupo de concorrência | `deploy-staging` | `deploy-production` (o do workflow de deploy da produção: se o nome mudar lá, mude no `backup.yml` e em `scripts/verify-backup-workflow.mjs`) |

Os mesmos segredos e variáveis do staging (`BACKUP_PGPASSWORD`, `R2_BACKUP_ACCESS_KEY_ID`, `R2_BACKUP_SECRET_ACCESS_KEY`, `BACKUP_PGHOST`, `BACKUP_PGDATABASE`, `R2_BACKUP_ENDPOINT`, `BACKUP_RECIPIENTS_SHA256`), agora no Environment `production-backup`, com os valores da produção. O bucket fica escrito no workflow, como no staging: um backup da produção nunca vai a outro bucket.

**Ligar na produção (responsável, nesta ordem; registre o resultado de cada passo sem senha nem chave):**

1. **PITR do Neon**, como na seção seguinte.
2. **Login.** Criar `polaris_backup_reader` no banco da produção pelo SQL do passo 1 do staging, nunca pelo console, e conferir os atributos com o verificador do banco da produção quando ele existir (com a mesma exceção estrita do staging). A prova do `BYPASSRLS` e do `GRANT pg_read_all_data` é a do staging; se o Neon da produção se comportar diferente, pare e leve ao Rodrigo.
3. **Bucket e token.** Bucket privado `polaris-backup`, sem ciclo de vida e sem acesso público; token R2 "Object Read & Write" só nele, com validade. O custo é o de guardar 35 backups cifrados: multiplique o tamanho do último dump por 35 e confira na tabela de preços do R2 antes de criar (decisão de gasto do responsável, com o Juan).
4. **Chave.** O titular da produção gera outra identidade (`age-keygen -o production.key`), a guarda no cofre do servidor OpenBot (0400, fora do repositório), apaga a cópia da máquina onde a gerou e entrega só a chave pública (`age-keygen -y`). Ela entra em `ops/backup/recipients-production.txt` por PR revisado pela segurança, uma linha `age1…` e mais nada.
5. **Environment `production-backup`**, restrito à `main`, sem revisor obrigatório (travaria o cron), com os segredos e as variáveis acima. Crie e restrinja o Environment à `main` e confira a política de branches na tela (só `main`) **antes** de gravar qualquer segredo. `BACKUP_RECIPIENTS_SHA256` é o `sha256sum ops/backup/recipients-production.txt` da `main` depois do PR da chave.
6. **Rótulo** `backup-production` no repositório.
7. **Ligar.** Criar a variável de repositório `PRODUCTION_BACKUP_ENABLED` = `true`, só depois dos passos 4 e 5.
8. **Primeiro backup:** `workflow_dispatch` na `main` com `environment` = `production`. Esperado no log o mesmo do staging, com `ok: marker production and login polaris_backup_reader`. Depois, o ensaio de restauração.

**Se algo faltar, o job para antes de ler ou de sair dado da produção:** sem a variável, o job nem começa; arquivo sem nenhuma linha `age1…`, ou com hash diferente do de `BACKUP_RECIPIENTS_SHA256` (ou com a variável vazia), recusa na conferência dos destinatários, antes de abrir o banco; banco sem o marcador `production`, host com `-pooler` ou login que não é o de leitura esperado, o `dump.sh` recusa; o `seal.sh` ainda recusa chave malformada, e o texto claro, que só existe em memória, é apagado em qualquer saída. Nada disso depende de uma pessoa lembrar.

A frequência é diária (decisão do usuário; no plano Free o egress do Neon limita execuções × tamanho do banco a cerca de 4 GB por mês). Só a 1ª cópia, no R2; a 2ª cópia fica para depois.

O ensaio na produção usa uma branch descartável do projeto da produção, com autorização explícita do responsável, numa máquina com disco cifrado (os dados são reais). É item de bloqueio do [checklist de go-live](./README.md#checklist-de-go-live-cloudflare-e-neon) ("Backup diário e ensaio de restauração").

Revisão obrigatória: `scripts/backup/`, `ops/backup/` e os workflows de backup decidem para quem o backup é cifrado e para onde vai; um PR que mexa neles passa pela revisão de segurança, e o responsável segura o merge automático desses caminhos.

### PITR do Neon (produção)

O backup lógico não é a única camada: o Neon guarda o histórico do projeto e deixa criar uma branch num instante do passado, dentro da **janela de restauração** do plano. O PITR resolve o erro recente (uma migration ruim, um `DELETE` sem filtro) em minutos e sem baixar nada. Ele não cobre projeto apagado, conta perdida nem dano percebido depois da janela, porque o histórico mora no mesmo projeto: para isso existe o backup lógico, cifrado e fora do Neon. As duas camadas se completam, nenhuma substitui a outra.

A janela é do plano contratado e muda de plano para plano; **não presuma o padrão** (o Free guarda 6 horas, e é por isso que o staging tem o backup lógico). Escolher o plano e o tamanho da janela é decisão de gasto do responsável com o usuário; o dev não escolhe nem altera isso. O PITR é configuração do Neon, fora do repositório.

1. **Configurar (responsável).** No console do Neon, no projeto da produção, ajustar a janela de restauração ao valor decidido, dentro do máximo do plano.
2. **Ler de volta.** Conferir o valor gravado, não o digitado: no console, na mesma tela, ou pela API do projeto (o campo é `history_retention_seconds` das configurações do projeto; confirme o nome na documentação vigente). Com a CLI, só depois de confirmar o perfil e a identidade permitidos, como na [política de perfis da CLI](./cli-profile-policy.md). Registre aqui, sem mais nada: a data, o plano e a janela em horas.
3. **Provar uma restauração por PITR.** Depois de configurar e de a produção ter histórico para voltar, com a autorização explícita do responsável e numa máquina com disco cifrado (os dados são reais, como no ensaio acima): criar uma branch do projeto da produção num instante dentro da janela (nome único `pitr-drill-AAAAMMDD`, nunca `--schema-only`), conectar com o dono pela conexão direta, conferir o marcador `polaris.environment=production` e que uma tabela conhecida tem as linhas do instante escolhido, e apagar a branch. Registre o instante pedido, o tempo até a branch responder e o resultado, só números e nomes. É a prova de que a janela lida de volta é a que vale.
4. **Restauração de verdade por PITR** nunca acontece sobre a produção aberta: restaura-se numa branch nova, valida-se, e antes de qualquer cliente voltar aplicam-se os passos 0, 1, 3, 4 e 5 do [restore e deletion ledger](./deletion-ledger-restore.md), porque o PITR também devolve dado já apagado por pedido de exclusão. A decisão de restaurar é do responsável ([Escalonamento](#escalonamento)).

Valor lido de volta da produção: _a registrar pelo responsável (data, plano, janela em horas)._

## Escalonamento

O responsável decide qualquer restauração de verdade e qualquer exceção. Achado de segurança (atributo a mais no login, chave trocada sem PR, ACL divergente no ensaio) vai ao Rodrigo antes de mudar a checagem.
