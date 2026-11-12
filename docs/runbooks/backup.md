# Backup diário do banco e ensaio de restauração

**Gatilho:** ligar o backup de um ambiente (staging primeiro, produção no go-live), um backup que falhou (issue com o rótulo `backup-staging`), o ensaio periódico de restauração ou uma restauração de verdade.

**Por quê:** o Neon Free guarda só 6 horas de histórico. O backup cobre o desastre maior (projeto apagado, conta perdida, corrupção percebida tarde): um `pg_dump` diário, cifrado fora do Neon, guardado 35 dias (o prazo de `provider_backups` do [ADR 0079](../adr/0079-retencao-por-classe-de-dado.md)). A decisão e as alternativas estão no [ADR 0099](../adr/0099-backup-logico-diario-no-r2-cifrado-com-age.md). O staging roda o mesmo mecanismo da produção, com outros nomes, para que ele chegue ao go-live já provado.

> **Estado:** os scripts e as checagens existem no repositório, mas nada foi criado nem executado contra um ambiente real. O workflow (`backup-staging.yml`) é aplicado pelo responsável. Os passos marcados **a provar** são o primeiro ensaio do staging; o resultado de cada um entra neste runbook, como no [restore e deletion ledger](./deletion-ledger-restore.md).

## Quem faz o quê

| Quem | O quê |
| --- | --- |
| Responsável (Arrascaeta) | cria o login, o bucket, o token R2, o Environment, as variáveis e o rótulo; aplica o workflow e liga a variável; cria e apaga a branch Neon do ensaio ([política de perfis da CLI](./cli-profile-policy.md)); decide qualquer restauração de verdade |
| Titular da chave (a pessoa escolhida pelo usuário; uma chave por ambiente) | gera a chave age offline, entrega só a chave pública; baixa e decifra um backup e roda o ensaio de restauração na máquina dele |
| Dev | mantém os scripts, o SQL e este runbook; nunca vê a chave privada nem a senha do login |

A chave privada nunca vai ao GitHub, ao R2, a servidor de agente nem a outro computador que não o do titular. Perder a chave deixa todos os backups dela ilegíveis, de propósito.

## O que existe

- `scripts/backup/dump.sh`: roda dentro da imagem `postgres:18` fixada por digest. Confere o marcador do banco (`polaris.environment=<ambiente>`, [ADR 0097](../adr/0097-staging-fixo-e-producao-em-conta-separada.md)) e o login (`sql/preflight.sql`), abre uma transação `REPEATABLE READ READ ONLY`, exporta o snapshot, faz `pg_dump -Fc --compress=zstd:6 --snapshot=…` e, no mesmo snapshot, lê `sql/reference.sql`: contagem de linhas de cada tabela, as migrations e as leituras do catálogo do restore (ACL das funções, RLS, políticas, deletion ledger). Grava `dump`, `roles.sql` (`pg_dumpall --roles-only --no-role-passwords`) e `manifest.json`. As contagens ficam **só** no manifest, que vai cifrado: o log do repositório é público.
- `scripts/backup/seal.sh`: `tar` dos três arquivos, cifrado com `age` para as chaves públicas de `ops/backup/recipients-<ambiente>.txt`; apaga o texto claro.
- `scripts/backup/upload.sh`: envia `daily/AAAAMMDDTHHMMSSZ.tar.age` com o cabeçalho `x-amz-checksum-sha256` (o R2 confere os bytes recebidos e recusa o envio que não bate) e o SHA-256 também no metadado `sha256`, relê tamanho e metadado com `head-object` e só então aplica a retenção (`scripts/backup/retention.mjs`).
- `scripts/backup/restore.mjs`: o ensaio de restauração (seção abaixo).
- `ops/backup/recipients-staging.txt`: a chave pública do staging. Trocar passa por PR revisado, junto com a variável `BACKUP_RECIPIENTS_SHA256`.
- `staging:verify-database after-migrate` aceita o login `polaris_backup_reader` como única exceção à regra "todo login é membro de um grupo `*_runtime`", e só com os atributos exatos abaixo (`packages/db/scripts/backup-reader.ts`).

**Retenção:** o job apaga o que tem mais de 35 dias, mas mantém sempre os 35 backups mais novos, e só depois de confirmar o envio do dia. Com o job parado por semanas, nada some. O bucket fica **sem** regra de ciclo de vida: ela apagaria o último backup quando o job para. Só objetos com o nome que o job grava entram na conta; outro arquivo no prefixo nunca é apagado.

**Log do job:** só "ok", o tamanho em MB, o SHA-256 do arquivo cifrado e o nome da checagem que falhou. Nunca a senha, o host com credencial, nome de tabela com contagem ou dado.

## Ligar no staging (responsável)

Tudo na conta Cloudflare e no projeto Neon do staging. Registre o resultado de cada passo (sem senha nem chave).

1. **A provar primeiro (decide o desenho).** Com o dono (`neondb_owner`) e a URL direta, criar o login pelo SQL, **nunca pelo console** (que põe o papel em `neon_superuser`), lendo a senha de um arquivo `umask 077` como no [runbook do staging, seção 1.4](./staging.md#1-banco-responsável):

   ```sql
   CREATE ROLE polaris_backup_reader LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS NOINHERIT
     CONNECTION LIMIT 2 PASSWORD '<senha em texto>';
   GRANT pg_read_all_data TO polaris_backup_reader WITH INHERIT TRUE, SET FALSE;
   ALTER ROLE polaris_backup_reader SET default_transaction_read_only = on;
   ```

   O `pg_read_all_data` também dá leitura aos catálogos, `pg_authid` incluído: quem tiver a senha desse login lê os verificadores SCRAM dos outros logins (não servem para entrar, só para tentar adivinhar a senha fora do banco; as senhas dos logins são aleatórias e longas). Por isso a senha dele fica só no Environment e se troca junto com qualquer suspeita de vazamento. Sem `idle_in_transaction_session_timeout` nesse login: a sessão que segura o snapshot fica ociosa em transação enquanto o `pg_dump` roda. **A provar:** se o `neondb_owner` consegue dar `BYPASSRLS` (o PostgreSQL 16+ exige que quem cria o tenha) e o `GRANT pg_read_all_data` (exige `ADMIN` nesse papel). Se não conseguir, pare: o desenho volta à revisão de segurança, porque a alternativa é usar o dono. Por que `BYPASSRLS`: com RLS forçado, o `pg_dump` liga `row_security = off` e **falha** numa tabela que a política filtraria, então um dump incompleto sem erro não acontece, mas sem o atributo o dump não sai.
2. **Conferir o login.** `bun run --filter @polaris/db staging:verify-database after-migrate` (com a URL do migrador) tem de listar `login polaris_backup_reader: pg_read_all_data, BYPASSRLS, read-only, owns nothing`. Qualquer outro atributo, pertença, objeto, grant ou política com o login, ou alguém que possa virar ele, reprova o deploy do staging, de propósito. **A provar:** que o Neon não acrescenta pertença nem dependência ao papel (se acrescentar, levar ao Rodrigo antes de afrouxar a checagem).
3. **Bucket e token.** Bucket privado `polaris-backup-staging`, sem ciclo de vida e sem acesso público. Token R2 "Object Read & Write" só nesse bucket, com validade. **A provar:** se o bucket lock (retenção por prefixo) de 7 dias em `daily/` é grátis no plano Free; se for, ligar.
4. **Chave.** O titular, na máquina dele: `age-keygen -o staging.key` e `age -p staging.key > staging.key.age` (identidade protegida por senha; apagar `staging.key` em seguida). Guardar `staging.key.age` no gerenciador de senhas e numa cópia física. A chave pública (`age-keygen -y staging.key` antes de apagar) vai num PR para `ops/backup/recipients-staging.txt`, uma linha `age1…`. Sem chave nesse arquivo o job recusa selar.
5. **Environment `staging-backup`**, restrito à branch `main`, sem revisor obrigatório (travaria o cron). Os segredos ficam **só** no Environment, nunca no repositório: o `if` do job é texto do próprio workflow, e quem tem escrita pode tirá-lo num branch; o que barra um `workflow_dispatch` de outro branch é a restrição do Environment. Depois de criar, dispare o workflow de um branch qualquer e confira que ele é recusado antes de qualquer passo. Segredos: `BACKUP_PGPASSWORD` (a senha do login), `R2_BACKUP_ACCESS_KEY_ID` e `R2_BACKUP_SECRET_ACCESS_KEY`. Variáveis: `BACKUP_PGHOST` (host **direto** do projeto, sem `-pooler`), `BACKUP_PGDATABASE` (`neondb`), `R2_BACKUP_ENDPOINT` (`https://<id da conta>.r2.cloudflarestorage.com`) e `BACKUP_RECIPIENTS_SHA256` (`sha256sum ops/backup/recipients-staging.txt` da `main`, depois do PR da chave). O bucket fica escrito no workflow (`polaris-backup-staging`): um backup do staging nunca vai a outro bucket.
6. **Rótulo** `backup-staging` no repositório (a issue de falha usa ele).
7. **Workflow.** Aplicar o patch que cria o workflow `backup-staging.yml` (entregue pelo dev; o dev não edita workflows; até ele entrar, o arquivo não existe no repositório) e criar a variável de repositório `STAGING_BACKUP_ENABLED` = `true`.
8. **Primeiro backup:** `workflow_dispatch` na `main`. Esperado no log: `ok: marker staging and login polaris_backup_reader`, `ok: pg_dump`, `ok: roles`, `ok: manifest (N entries, M MB)`, `ok: sealed for 1 key(s), …, sha256 …`, `ok: uploaded daily/…`, `ok: retention removed 0 object(s)`. Depois, o ensaio de restauração abaixo, que é o que prova o backup.

**Desligar:** apagar `STAGING_BACKUP_ENABLED`. Os backups existentes ficam no bucket até alguém apagá-los (a retenção só roda junto de um backup novo).

## Concorrência com o deploy

O job usa o grupo `deploy-staging`, o mesmo do deploy: um `pg_dump` (que segura `ACCESS SHARE` em todas as tabelas) nunca corre junto de uma migration, que esperaria por ele ou cairia no `lock_timeout` de 10 s. O GitHub guarda **um** job pendente por grupo: se o backup entrar na fila enquanto um deploy roda e outro espera, o que espera é cancelado (o próximo merge faz o deploy) e vice-versa (o backup do dia não sai; a próxima execução sai no dia seguinte). O horário (06:22 UTC) diminui a chance. Se o deploy pendente for cancelado, reexecute o run do deploy.

## Falha

- O job abre uma issue `backup-staging` com o link do run (texto genérico) e comenta nela a cada nova falha; o próximo sucesso a fecha. O e-mail do GitHub para cron com falha vai para quem editou o cron por último: quem aplica o patch recebe.
- Leia o log do run. As recusas dizem a causa pelo nome: `marker: …` (banco sem o marcador de staging ou URL de outro banco), `login: …` (atributo do login), `the recipients file …`, `… does not match BACKUP_RECIPIENTS_SHA256` (chave trocada sem atualizar a variável, ou o contrário: confira o PR), `the stored object does not match …` (envio corrompido: nada foi apagado), `an object with this stamp already exists`.
- Um job que não roda (cron desligado pelo GitHub depois de 60 dias sem atividade num repositório público, ou cancelado pelo grupo de concorrência) não abre issue. Por enquanto a conferência é manual: o objeto mais novo de `daily/` tem menos de 26 h. O vigia automático (sentinela lendo o bucket com um token só leitura) fica para o PR da produção.

## Ensaio de restauração

Quem: o titular da chave, com a branch criada pelo responsável. Quando: depois do primeiro backup do staging, depois de qualquer mudança de formato, de chave ou do script, e a cada trimestre. O ensaio do staging é o que libera o PR da produção.

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
   node scripts/backup/restore.mjs --environment staging --archive <stamp>.tar.age --identity staging.key.age --sha256 <hash do log do run>
   ```

   O `age` pede a senha da identidade. O script decifra num diretório `0700` (apagado no fim; `--keep-workdir` o mantém para investigar, e aí apague-o à mão, porque `restore.err` pode citar linhas de dados) e faz, sem perguntar, os passos 2, 2b e as conferências do passo 5 do [restore e deletion ledger](./deletion-ledger-restore.md): o preparo dos `GRANT` (sem o login de backup), o `pg_restore` com só os dois resultados aceitos, a reaplicação das ACLs como o dono de cada objeto, a conferência das ACLs das funções **antes** de revogar e a revogação em qualquer saída, com `set_restante` zero. O SQL de ACL só roda se vier protegido por `\restrict` e sem outro metacomando do `psql`; o pacote só é extraído se tiver exatamente os três arquivos, todos regulares; o manifest tem de ser do ambiente de `--environment`. Se o script for interrompido (Ctrl-C, máquina desligada) entre o preparo e a revogação, os `GRANT` de papel ficam no cluster da branch: apague a branch, como no passo 5.
4. **Ler o relatório.** O relatório traz também `tables`, `rows`, `migrations` e `ledger_rows` (totais, sem contagem por tabela): um ledger com 0 linhas faz a consulta final do passo 5 passar sem exercitar nada, então registre esse número. `ok: true` e `checks: []` querem dizer que o banco restaurado bate com o manifest tirado no snapshot do dump: a contagem de **cada** tabela, as migrations, as 18 donas, nenhuma função `SECURITY DEFINER` com outro dono ou executável por PUBLIC, o hash das ACLs das funções, as funções de purge, a ACL do `public`, as tabelas com RLS forçado e as políticas (hash), nenhuma política permissiva para PUBLIC, nenhum `polaris_*` (fora o login de backup) com `BYPASSRLS`, o mesmo número de linhas do deletion ledger e a consulta final do passo 5 vazia. Qualquer item em `checks` reprova o ensaio: registre o nome da checagem, não corrija à mão. Registre a data, quem fez, o `snapshot_at`, o RPO (instante do ensaio menos `snapshot_at`), o tempo do passo 3 (RTO de dados), o tamanho e o resultado. Só números e nomes, nenhum dado.
5. **Apagar** a branch (responsável) e o arquivo baixado. A identidade volta ao cofre.

**O que o ensaio não faz:** os passos 0, 1, 3 e 4 do [restore e deletion ledger](./deletion-ledger-restore.md) (ler o ledger da origem desde o backup, carregar e reaplicar os tombstones posteriores). Num ensaio o banco restaurado nunca é aberto, então eles não se aplicam; numa restauração de verdade são obrigatórios, à mão, antes de reabrir o ambiente, e o script vem antes deles. Também não restaura papéis num projeto novo (`roles.sql` vai no pacote para esse caso, de perda total, que segue o passo 2 daquele runbook) nem aponta Hyperdrive para o banco restaurado.

## Produção (go-live)

O mesmo mecanismo, com outros nomes, na conta Cloudflare e no projeto Neon da produção. Pré-requisito: o staging com backups diários verdes e um ensaio de restauração aprovado depois do último ajuste.

- Marcador `polaris.environment=production`, login `polaris_backup_reader` criado do mesmo jeito no banco da produção (e aceito pelo verificador da produção, quando ele existir, com a mesma exceção), bucket `polaris-backup`, token só nele, Environment `production-backup`, chave do titular da produção em `ops/backup/recipients-production.txt` (outra chave, não a do staging), variável `PRODUCTION_BACKUP_ENABLED`, grupo de concorrência do deploy da produção.
- O workflow da produção é cópia deste com essas trocas, aplicado pelo responsável. A frequência é diária (decisão do usuário; o egress do Neon Free limita execuções × tamanho do banco a cerca de 4 GB por mês). Só a 1ª cópia, no R2; a 2ª cópia fica para depois.
- O ensaio na produção usa uma branch descartável do projeto da produção, com autorização explícita do responsável, numa máquina com disco cifrado (os dados são reais). É item de bloqueio do [checklist de go-live](./README.md#checklist-de-go-live-cloudflare-e-neon) ("Backup diário e ensaio de restauração").
- Revisão obrigatória: `scripts/backup/`, `ops/backup/` e os workflows de backup decidem para quem o backup é cifrado e para onde vai; um PR que mexa neles passa pela revisão de segurança, e o responsável segura o merge automático desses caminhos.

## Escalonamento

O responsável decide qualquer restauração de verdade e qualquer exceção. Achado de segurança (atributo a mais no login, chave trocada sem PR, ACL divergente no ensaio) vai ao Rodrigo antes de mudar a checagem.
