# Restore de backup e deletion ledger

**Gatilho:** restaurar um backup ou uma branch do banco (por falha, corrupção ou teste de recuperação) para um instante anterior ao presente.

**Por quê:** um restore ressuscita o que já foi removido: um cliente anonimizado volta com nome, telefone, email e observações; uma organização purgada volta inteira. A [deletion ledger](../adr/0080-ledger-minimo-de-exclusoes.md) (`public.deletion_ledger`) é o registro mínimo (IDs opacos, tipo de registro, operação, instante) do que deve ser removido de novo. Regra de privacidade: **o restore reaplica o ledger antes de o ambiente ser reutilizado** ([privacidade](../business-rules/privacy.md)).

> **Nada deste procedimento foi executado contra um ambiente real**, e não há automação: ela é da Fase 16. O restore lógico (`pg_dump`/`pg_restore`) foi ensaiado numa branch Neon descartável (31/10/2026, V12; três tentativas, só a terceira válida), e o que o ensaio achou está nos passos 2 e 2b e na conferência do passo 5. Os comandos do passo 2b (a reaplicação das ACLs, a conferência e a limpeza do preparo), **como estão escritos aqui, ainda não foram executados contra um banco**: isso vale em especial para os comandos novos do passo 2b (`pg_restore -L` com `sed`, `has_function_privilege`, o hash com `acldefault` e o `set_option`). Confira cada comando com atenção na primeira vez. A consulta de lista e a de verificação são provadas pelo gate `deletion-ledger` num banco descartável. Qualquer comando Cloudflare ou Neon segue a [política de perfis de CLI](./cli-profile-policy.md). Reaplicar altera dado: é uma ação do responsável, em ambiente já autorizado por ele.

## Pré-requisitos de acesso

- A conexão do **dono do banco** (a tabela força RLS e não há política para ele; funciona com o papel dono da Neon, que ignora RLS). **Confirme antes**, nas duas pontas (origem e restaurado), que a conexão ignora RLS: `SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = current_user;` deve dar `true`. Com um login que não ignora RLS, as consultas abaixo **voltam zero linhas sem erro** e o procedimento pareceria concluído sem ter feito nada. Registre também o `count(*)` do ledger de cada ponta.
- Alternativa só para ler o ledger: `SET ROLE polaris_privacy_owner` (papel sem login, com `SELECT` no ledger): a sessão do dono roda `GRANT polaris_privacy_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;` antes (pode exigir superusuário ou o papel que criou `polaris_privacy_owner`), `SET ROLE polaris_privacy_owner;` para ler e, ao terminar, `RESET ROLE;` e `REVOKE polaris_privacy_owner FROM CURRENT_USER;`, como as migrations fazem. Para o passo 5 (que lê `customers` e `organizations`) esse papel não serve: use o dono.
- Nenhum papel de aplicação (tenant, Admin, privacidade, billing, catálogo) lê o ledger.

## O ponto que decide tudo: de onde ler o ledger

O ledger mora no mesmo banco. O backup traz o ledger **do instante do backup**, sem as exclusões feitas depois. Por isso:

1. **Antes** de substituir ou apagar o ambiente atual, **leia o ledger dele** (passo 1). O ambiente a ser substituído (ou a branch de origem, que **não** deve ser apagada) é a fonte dos tombstones posteriores ao backup.
2. Guarde a lista fora do banco, em local privado do responsável. Ela tem só IDs opacos, mas é a lista de quem pediu privacidade: trate como dado sensível.
3. **Não apague o ambiente ou a branch de origem** até a reaplicação estar conferida (passo 5).

Se o ambiente de origem não puder mais ser lido (perda total), os tombstones posteriores ao último backup estão perdidos: registre isso como incidente e decida com o responsável (a cópia do ledger fora do banco é da Fase 16).

## Passos

0. **Conferir o ledger no ambiente de origem.** Nenhum cliente anonimizado pode estar sem tombstone (a migration 0069 grava os que já existiam, mas só o código garante os seguintes); esta consulta deve voltar **vazia** (se não, grave os tombstones que faltam antes de seguir, `INSERT ... ON CONFLICT DO NOTHING` pelo dono do banco):

   ```sql
   SELECT c.id, c.organization_id
     FROM public.customers AS c
     LEFT JOIN public.deletion_ledger AS l
       ON l.entity_type = 'customer' AND l.operation = 'anonymize'
      AND l.entity_id = c.id::text AND l.organization_id = c.organization_id
    WHERE c.anonymized_at IS NOT NULL AND l.id IS NULL;
   ```

   Confira também o contrário, que um tombstone nunca aponta para quem **não** foi anonimizado na origem (um tombstone falso anonimizaria uma pessoa real no restaurado); deve voltar **vazia**:

   ```sql
   SELECT l.entity_id, l.organization_id
     FROM public.deletion_ledger AS l
     JOIN public.customers AS c
       ON c.id::text = l.entity_id AND c.organization_id = l.organization_id
    WHERE l.entity_type = 'customer' AND l.operation = 'anonymize'
      AND c.anonymized_at IS NULL;
   ```

1. **Listar o ledger no ambiente de origem**, a partir do instante do backup menos uma margem (a lista é idempotente, a margem só evita perder um tombstone por diferença de relógio; sem filtro, lista tudo):

   ```sql
   SELECT entity_type, entity_id, operation, organization_id, privacy_case_id, recorded_at
     FROM public.deletion_ledger
    WHERE recorded_at >= TIMESTAMPTZ '2026-10-17 11:00:00+00'   -- instante do backup, menos 1 hora (troque pelo literal)
    ORDER BY recorded_at, id;
   ```

   Guarde a lista **e o número de linhas**: o passo 5 confere a contagem.

2. **Restaurar** o backup para o novo ambiente (não abra o ambiente restaurado a usuários, a aparelhos nem ao cron enquanto os passos 3 a 5 não terminarem: nem o Worker, nem a sincronização, nem a varredura horária).

   **Antes de restaurar as políticas, os papéis donos.** Papéis são do cluster, não do banco. Uma branch do Neon os leva junto, mas um restore lógico (`pg_dump`/`pg_restore`) num projeto novo não: cada política é `TO` um papel, e as funções `SECURITY DEFINER` pertencem a um `polaris_*_owner`. Sem o papel, o `CREATE POLICY` ou o `ALTER FUNCTION … OWNER TO` falha, ou é pulado com `--no-owner`, e uma função restaurada fica com o dono do banco, que tem `BYPASSRLS`. No destino, antes de restaurar, confira que os 18 papéis donos existem (é o `MIN_OWNER_ROLES` de `owner-role-attributes.ts`; o 18º, `polaris_billing_audit_owner`, é da 0100):

   ```sql
   SELECT count(*) FROM pg_roles WHERE rolname LIKE 'polaris\_%\_owner';  -- 18
   ```

   Se faltar algum, crie-os antes com o bloco `DO $roles$` da migration que cria cada um (por exemplo, a 0095 cria `polaris_sync_owner`, `polaris_authorization_epoch_owner` e `polaris_onboarding_owner`), nunca com `CREATE ROLE` à mão com outros atributos. Restaure **sem** `--no-owner` e **sem** `--no-privileges`. No Neon isso não funciona sem preparo (ver abaixo). Depois do restore, do passo 2b e das migrations do passo 3, a mesma consulta do papel e esta, que repete a checagem `foreignOwner` de `definer-hardening-checks.ts` (o `staging:verify-database` só aceita o marcador `staging`), devem voltar 18 e **vazia**:

   ```sql
   SELECT n.nspname || '.' || p.proname AS funcao, pg_get_userbyid(p.proowner) AS dono
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.prosecdef
      AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\_toast%'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
      AND pg_get_userbyid(p.proowner) NOT LIKE 'polaris\_%\_owner';
   ```

   Registre as duas respostas sem IDs. **Estas duas consultas não detectam o problema das ACLs das funções** (passo 2b): no ensaio V12 elas voltaram 18 e vazia num restaurado com 129 funções `SECURITY DEFINER` executáveis por PUBLIC. A prova das ACLs é a conferência obrigatória do passo 2b.

   **No Neon, o restore com donos exige preparo antes e limpeza depois.** O papel de login do banco (`neondb_owner`) tem `ADMIN` sobre os papéis `polaris_*`, mas não `SET`, e não pode criar objetos no `public` como outro papel. Sem o preparo, o `pg_restore` falha em dezenas de instruções (`must be able to SET ROLE "polaris_*_owner"`, depois `permission denied for schema public`). No ensaio foram 136. Conecte como o dono do banco, **no banco restaurado**, com a conexão lida do ambiente (variáveis `PG*` ou equivalente; nunca em argumento, log ou arquivo). Antes de qualquer comando abaixo, confirme o alvo nos dois sentidos: `SELECT current_database(), shobj_description(oid, 'pg_database') FROM pg_database WHERE datname = current_database();` tem de dar o nome do banco restaurado e o marcador do ambiente restaurado, **nunca** o da origem (o `GRANT`, o `REVOKE` e a reaplicação das ACLs rodariam na origem viva), e o `psql` e o `pg_restore` abaixo usam essa mesma conexão (`PGDATABASE`). Os `GRANT` de papel são do **cluster**, não do banco: apagar o banco restaurado não os desfaz. Em qualquer saída antes do passo 2b, item 3 (restore reprovado, banco apagado, procedimento abandonado), rode o `REVOKE` do passo 2b, item 3, e confirme `set_restante = 0`. Faça:

   1. **Antes do `pg_restore`**, conceda a si mesmo o `SET` nos papéis `polaris_*` e o `CREATE` no schema `public` aos donos:

      ```sql
      DO $grant$
      DECLARE r text;
      BEGIN
        FOR r IN SELECT rolname FROM pg_roles WHERE rolname LIKE 'polaris\_%' LOOP
          EXECUTE format('GRANT %I TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE', r);
        END LOOP;
        FOR r IN SELECT rolname FROM pg_roles WHERE rolname LIKE 'polaris\_%\_owner' LOOP
          EXECUTE format('GRANT CREATE ON SCHEMA public TO %I', r);
        END LOOP;
      END
      $grant$;
      ```

      Antes dos `GRANT` acima, registre a ACL do schema `public` **da origem** (`SELECT nspacl::text FROM pg_namespace WHERE nspname = 'public';`): ela é a referência da conferência do passo 2b.
   2. **Restaure**, com a saída de erro guardada (o `arquivo.dump` é o do `pg_dump -Fc` da origem):

      ```bash
      pg_restore --dbname="$PGDATABASE" --no-password arquivo.dump 2> restore.err; echo "rc=$?"
      ```

      **O `rc=1` é esperado mesmo quando o restore deu certo:** o Neon recusa dois `ALTER DEFAULT PRIVILEGES FOR ROLE cloud_admin`, que são da plataforma e inofensivos. Qualquer outro erro reprova o restore (revogue o preparo, apague o banco restaurado, corrija e refaça). Confira à mão a lista de `pg_restore: error:` em `restore.err`: no ensaio foram 2, e o `Command was:` de cada uma era um `ALTER DEFAULT PRIVILEGES FOR ROLE cloud_admin …`; qualquer erro cujo comando seja outro reprova. `restore.err` pode trazer linhas de dados de cliente quando o erro é de dados: trate-o como dado sensível, não o cole em PR nem em registro (só a contagem e os comandos do `cloud_admin`) e apague-o ao terminar. O `pg_restore` também **avisa** (`warning`, sem contar como erro) quando não consegue aplicar uma ACL: não use a contagem de erros como prova das ACLs, ela não pega isso.
   3. **Ainda com o preparo do item 1 ativo**, faça o passo 2b. Só depois revogue (passo 2b, item 3).

2b. **Reaplicar as ACLs, conferir e limpar o preparo (restore lógico no Neon).** O `pg_restore` aplica as ACLs como o papel de login, que não é dono das funções nem tem *grant option*. O PostgreSQL só **avisa**, e o `REVOKE ALL … FROM PUBLIC` e os `GRANT EXECUTE … TO polaris_*_runtime` das funções `SECURITY DEFINER` **não são aplicados**: o restaurado fica com as funções executáveis por PUBLIC e os runtimes sem os grants, sem nenhum erro. É uma falha de permissão de função definer: não abra o ambiente com ela. Com o preparo do passo 2 ainda ativo, no banco restaurado e **antes das migrations do passo 3**:

   1. **Reaplique só as entradas ACL**, como o dono de cada objeto. O `-l` lista o conteúdo do dump, o filtro fica só com as entradas `ACL` (as `DEFAULT ACL` não entram), o `-L` aplica só essa lista e o `-f` grava o SQL em vez de executar:

      ```bash
      pg_restore -l arquivo.dump | grep -E '^[0-9]+; [0-9]+ [0-9]+ ACL ' > acl.lst
      wc -l < acl.lst
      pg_restore -L acl.lst --use-set-session-authorization -f acl.sql arquivo.dump
      sed -E -e 's/^SET SESSION AUTHORIZATION /SET ROLE /' -e 's/^RESET SESSION AUTHORIZATION;/RESET ROLE;/' acl.sql > acl-role.sql
      grep -c 'SESSION AUTHORIZATION' acl-role.sql
      ```

      O `wc` tem de dar mais que zero e o último `grep -c`, **zero**: o papel de login não tem `SET SESSION AUTHORIZATION`, e o `SET ROLE <dono>` é o que o preparo do passo 2 permite. Rode o resultado parando no primeiro erro (qualquer erro reprova):

      ```bash
      psql --no-psqlrc --set=ON_ERROR_STOP=1 --file=acl-role.sql
      ```
   2. **Conferência obrigatória das ACLs.** No restaurado, esta consulta lista as funções `SECURITY DEFINER` do schema `public` executáveis por PUBLIC e **tem de voltar vazia**:

      ```sql
      SELECT p.oid::regprocedure AS funcao, pg_get_userbyid(p.proowner) AS dono
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE p.prosecdef AND n.nspname = 'public'
         AND has_function_privilege('public', p.oid, 'EXECUTE')
       ORDER BY 1;
      ```

      Rode também, **na origem e no restaurado, antes do passo 3**, a consulta do hash das ACLs das funções. Os dois valores têm de ser **iguais**. (As consultas 1 e 2 de RLS do passo 5 também se rodam na origem e no restaurado antes do passo 3, como o hash, quando o passo 3 aplicar migration: ver o passo 5.) A origem tem de estar no mesmo nível de migrations do backup (grave o hash dela no instante do `pg_dump`, ou compare só se ela não recebeu migration depois): as migrations pendentes do passo 3 criam e mudam funções e o hash deixa de bater por isso, sem defeito. O hash cobre as funções de todos os schemas, e a lista vazia cobre só o `public`:

      ```sql
      SELECT md5(string_agg(
               n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') '
               || pg_get_userbyid(p.proowner) || ' '
               || array_to_string(ARRAY(SELECT x::text FROM unnest(coalesce(p.proacl, acldefault('f', p.proowner))) AS x ORDER BY x::text COLLATE "C"), ','),
               E'\n' ORDER BY n.nspname COLLATE "C", p.proname COLLATE "C", pg_get_function_identity_arguments(p.oid) COLLATE "C")) AS hash_acl_funcoes
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\_toast%'
         AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e');
      ```

      Se a lista não voltar vazia ou o hash divergir, **pare**: não abra o ambiente, refaça o item 1 (a reaplicação é idempotente) e, persistindo, trate como incidente. A consulta de donos do passo 2 não serve para isso. A conferência cobre as funções, onde está o risco do `SECURITY DEFINER`. A reaplicação do item 1 reaplica **todas** as ACLs do dump (tabelas, sequências e schemas), que esta conferência não compara. Se quiser comparar as tabelas, normalize o `relacl` com `acldefault('r', relowner)` antes de comparar: no ensaio a única diferença foi `legal_acceptance_contract_end` (na origem, ACL explícita igual ao padrão do dono; no restaurado, nula), sem efeito.
   3. **Revogue o preparo** (só depois dos itens 1 e 2) e confira:

      ```sql
      DO $revoke$
      DECLARE r text;
      BEGIN
        FOR r IN SELECT rolname FROM pg_roles WHERE rolname LIKE 'polaris\_%\_owner' LOOP
          EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I', r);
        END LOOP;
        FOR r IN SELECT rolname FROM pg_roles WHERE rolname LIKE 'polaris\_%' LOOP
          EXECUTE format('REVOKE %I FROM CURRENT_USER', r);
        END LOOP;
      END
      $revoke$;

      SELECT count(*) AS set_restante
        FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid
       WHERE r.rolname LIKE 'polaris\_%' AND m.member = (SELECT oid FROM pg_roles WHERE rolname = current_user) AND m.set_option;

      SELECT nspacl::text FROM pg_namespace WHERE nspname = 'public';
      ```

      O `set_restante` tem de ser **0** e a ACL do `public` tem de ser **igual à da origem** (a registrada no passo 2). Se a ACL divergir, não corrija à mão com outro valor: pare e acione o responsável.

   Isto vale para o **restore lógico**. O restore por **branch Neon** (ponto no tempo) leva papéis e ACLs junto e dispensa o preparo, a reaplicação e o `GRANT`/`REVOKE` acima, mas **ainda não foi ensaiado**: depois dele, rode a mesma conferência do item 2 (a consulta vazia e o hash contra a origem) antes de seguir, e registre o resultado.

3. **Aplicar as migrations pendentes** no ambiente restaurado, se o backup for anterior à tabela ou a alguma migration (sem `public.deletion_ledger` os passos seguintes falham). **Carregar os tombstones da lista** que ainda não existirem (`INSERT` pelo dono do banco, **com lista de colunas**, copiando da lista, linha a linha, `organization_id`, `entity_type`, `entity_id`, `operation`, `privacy_case_id` e o `recorded_at` original, senão o instante vira o do ambiente restaurado; o índice único recusa repetição, então `ON CONFLICT DO NOTHING` é seguro):

   ```sql
   INSERT INTO public.deletion_ledger (organization_id, entity_type, entity_id, operation, privacy_case_id, recorded_at)
   VALUES ('<organização>', '<tipo>', '<ID>', '<operação>', NULL, TIMESTAMPTZ '<instante original>')
   ON CONFLICT DO NOTHING;
   ```

    Os tombstones até o instante do backup já vieram nele.
4. **Reaplicar cada tombstone**, conforme o tipo:
   - `customer` / `anonymize`: se o cliente existe no ambiente restaurado e `anonymized_at IS NULL`, repetir o efeito do comando `customer.anonymizeForPrivacy` ([ADR 0075](../adr/0075-anonimizacao-de-cliente-por-privacidade.md)), num `UPDATE` do dono do banco, **uma linha por vez, com o ID e a organização do tombstone**, e conferir que o resultado foi `UPDATE 1` (zero é um tombstone que não casou: investigue, não repita com outro filtro):

     ```sql
     UPDATE public.customers
        SET name = 'Cliente anonimizado', phone = NULL, email = NULL, notes = NULL,
            archived_at = COALESCE(archived_at, now()), anonymized_at = now(),
            updated_at = now(), version = version + 1
      WHERE id = '<ID do tombstone>' AND organization_id = '<organização do tombstone>'
        AND anonymized_at IS NULL;
     ```

     O CHECK `customers_anonymized_scrubbed` recusa um resultado incompleto, e o gatilho de sincronização grava a mudança no log que os aparelhos puxam (como no comando). Este `UPDATE` **não** grava `tenant_audit_event` (a auditoria do tenant é escrita pelo comando, com o ator): registre a reaplicação no registro do incidente. Se o cliente não existe, não há o que fazer.
   - `organization` / `purge`: se a organização existe no ambiente restaurado, ela precisa ser purgada de novo, com o procedimento da seção [Reaplicar um purge de organização](#reaplicar-um-purge-de-organização). O purge é idempotente e inclui o R2 em `exports/v1/{organização}/`, mídia e derivados.
5. **Conferir.** Esta consulta, no ambiente restaurado, deve voltar **vazia** antes de reabri-lo:

   ```sql
   SELECT l.entity_id, l.organization_id
     FROM public.deletion_ledger AS l
     JOIN public.customers AS c
       ON c.id::text = l.entity_id AND c.organization_id = l.organization_id
    WHERE l.entity_type = 'customer' AND l.operation = 'anonymize'
      AND c.anonymized_at IS NULL
   UNION ALL
   SELECT l.entity_id, l.organization_id
     FROM public.deletion_ledger AS l
     JOIN public.organizations AS o ON o.id = l.entity_id
    WHERE l.entity_type = 'organization' AND l.operation = 'purge'
      AND o.status <> 'purged';
   ```

   Vazia significa: nenhum cliente com tombstone continua com dado pessoal, e nenhuma organização com tombstone de purge está fora de `purged` (a linha da organização fica como marca de remoção, então a consulta confere o estado, não a existência). **Só vale se o passo 3 foi feito:** confira também que `SELECT count(*) FROM public.deletion_ledger` no ambiente restaurado é **no mínimo** o número de linhas da lista do passo 1 mais os tombstones que já vieram no backup (sem o passo 3, a consulta passa vazia sem provar nada sobre as exclusões posteriores ao backup). Rode de novo, nesse ponto (as migrations do passo 3 criam e mudam funções), a consulta das funções `SECURITY DEFINER` executáveis por PUBLIC do passo 2b: tem de voltar **vazia**. Num restore lógico no Neon, o passo 5 não fecha sem ela. Registre o resultado (sem IDs) e o instante.

   **Confira também que o isolamento entre lojas sobreviveu (RLS).** O `pg_restore` pode terminar sem erro e deixar uma tabela sem RLS forçado, uma política a menos ou um papel com `BYPASSRLS`; nesses casos uma loja passaria a ler os dados de outra. Rode as três consultas abaixo no ambiente restaurado e, as duas primeiras, também na origem, na mesma sessão com `SET search_path = pg_catalog;` (o texto das políticas depende do `search_path`). As migrations do passo 3 criam tabelas e políticas, então a linha de base muda conforme elas tenham ou não sido aplicadas: se o passo 3 **não** aplicou migration, compare com os valores da origem no instante do `pg_dump` (ou da origem, se ela não recebeu migration depois); se aplicou, rode as consultas 1 e 2 também no restaurado **antes do passo 3** (junto do hash das ACLs do passo 2b) e compare esses valores com os da origem no instante do `pg_dump`, e no passo 5 compare com um banco descartável migrado até o mesmo ponto. Nenhuma consulta usa URI, host ou segredo; a conexão é a do dono do banco, lida do ambiente, como no passo 2. Estas conferências não são cobertas pelo gate `deletion-ledger` e ainda não foram ensaiadas contra um restaurado.

   **Escopo das consultas 1 e 2:** cobrem só o schema `public` e as tabelas `r` (comuns) e `p` (particionadas). Hoje não há outro schema de loja nem tabela particionada (conferido nas migrations em 31/10/2026); se surgir tabela de loja em outro schema, estenda as consultas antes de confiar na conferência.

   1. **Tabelas do `public` com RLS ligado e forçado.** A contagem e o hash (nome qualificado da tabela, `relrowsecurity` e `relforcerowsecurity`) têm de ser **iguais aos da origem**. O hash compara tabela a tabela e pega a tabela que perdeu o RLS forçado (ou a que apareceu ou sumiu) mesmo quando os totais coincidem; `com_rls_forcado` dá o resumo para ler o resultado:

      ```sql
      SELECT count(*) AS tabelas,
             count(*) FILTER (WHERE c.relrowsecurity AND c.relforcerowsecurity) AS com_rls_forcado,
             md5(string_agg(
               n.nspname || '.' || c.relname || ' ' || c.relrowsecurity::text
               || ' ' || c.relforcerowsecurity::text,
               E'\n' ORDER BY n.nspname COLLATE "C", c.relname COLLATE "C")) AS hash_tabelas
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p');
      ```

      **Consulta 1b (só quando a 1 divergir): qual tabela divergiu.** É a mesma seleção sem o `md5`: uma linha por tabela, na mesma ordem `COLLATE "C"`. Grave-a em `consulta-1b.sql`, com o `SET search_path` na primeira linha, e rode uma vez em cada ponta, com as variáveis `PG*` daquela ponta (sem URI em argumento), salvando a saída em arquivo:

      ```sql
      SET search_path = pg_catalog;
      SELECT n.nspname || '.' || c.relname AS tabela,
             c.relrowsecurity, c.relforcerowsecurity
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
       ORDER BY n.nspname COLLATE "C", c.relname COLLATE "C";
      ```

      Primeiro comando com as variáveis `PG*` da origem, o segundo com as do restaurado (cada ponta no seu terminal ou `env` próprio); depois compare:

      ```sh
      psql --no-psqlrc --quiet -At --set=ON_ERROR_STOP=1 -f consulta-1b.sql > origem.txt
      psql --no-psqlrc --quiet -At --set=ON_ERROR_STOP=1 -f consulta-1b.sql > restaurado.txt
      wc -l origem.txt restaurado.txt
      diff origem.txt restaurado.txt
      ```

      As duas saídas têm de ter linhas (o `wc -l` bate com a contagem da consulta 1 de cada ponta). `diff` vazio com a consulta 1 divergente não prova que ela errou: as duas saídas vieram da mesma conexão, ou uma conexão falhou e deixou o arquivo vazio ou parcial. Refaça antes de concluir qualquer coisa. No `diff`, `<` é a origem e `>` é o restaurado: uma linha só `<` é tabela que sumiu no restaurado, uma só `>` é tabela a mais, e o par `<` e `>` com o mesmo nome é `relrowsecurity` ou `relforcerowsecurity` diferente (`t` ou `f`, separados por `|`, por exemplo `< public.tabela|t|t` e `> public.tabela|t|f`). Achar a tabela não libera nada: a divergência da consulta 1 continua sendo motivo para o passo 5 não fechar, conforme o parágrafo ao fim da lista.

   2. **Políticas do `public`.** A contagem e o hash (tabela, nome, permissiva ou restritiva, papéis, comando, `USING` e `WITH CHECK`) têm de ser **iguais aos da origem**. O hash pega a política trocada ou ampliada (por exemplo, passada a `PUBLIC`), que a contagem não pega:

      ```sql
      SELECT count(*) AS politicas,
             md5(string_agg(
               tablename || '.' || policyname || ' ' || permissive || ' '
               || array_to_string(roles, ',') || ' ' || cmd || ' '
               || coalesce(qual, '') || ' ' || coalesce(with_check, ''),
               E'\n' ORDER BY tablename COLLATE "C", policyname COLLATE "C")) AS hash_politicas
        FROM pg_policies
       WHERE schemaname = 'public';
      ```

   3. **Nenhum papel `polaris_*` ignora RLS.** No restaurado, esta consulta tem de voltar **vazia** (os papéis `polaris_*`, de runtime e donos, são criados `NOBYPASSRLS`; superusuário também ignora RLS, por isso a consulta o inclui; os papéis são do cluster, então ela vale para o cluster inteiro):

      ```sql
      SELECT rolname FROM pg_roles
       WHERE rolname LIKE 'polaris\_%' AND (rolbypassrls OR rolsuper)
       ORDER BY 1;
      ```

   Se qualquer uma divergir da origem (itens 1 e 2) ou não voltar vazia (item 3), **o passo 5 não fecha**: não abra o ambiente, não corrija à mão com outro valor, refaça o restore ou pare e acione o responsável, e trate como incidente de isolamento entre lojas. Registre os resultados (só números, hash e a lista vazia, sem IDs) e o instante.
6. **Só então** reabrir o ambiente (Workers, cron, sincronização). Aparelhos que sincronizaram com o ambiente anterior podem estar à frente do restaurado: é um limite geral do restore, tratado na Fase 16.

### Reaplicar um purge de organização

**Antes, as travas legais.** As travas legais (`organization_legal_holds`) também não voltam com o backup: uma trava posta depois do instante do backup some no ambiente restaurado, e o purge reaplicado rodaria sob ela. Junto da leitura do passo 1, leia no ambiente **que será substituído** as travas vigentes (`SELECT organization_id, support_case_id, placed_by, placed_at, review_at FROM public.organization_legal_holds WHERE released_at IS NULL`; a mesma lista sai de `GET /legal-holds` no Admin, com as vencidas marcadas como pendentes de revisão) e, no restaurado, antes de reaplicar qualquer purge, recoloque cada trava que não estiver lá. Pôr a trava exige um **caso de suporte aberto** da organização, e o caso original (o `support_case_id` lido acima) pode não existir no banco restaurado: se ele não estiver lá, ou estiver fechado, **abra um caso novo** pelo Admin (`POST /support-cases`, tipo `support`, motivo "restauração", a organização da trava) e **vincule a trava a ele**: `POST /support-cases/{caso novo}/legal-hold` com `{ organizationId, reviewAt }`. A data de revisão é obrigatória, no futuro e a no máximo 366 dias: use a lida acima se ainda valer e, se já tiver passado (a trava estava pendente de revisão), uma data nova, decidida pelo responsável. Na conferência, nenhuma organização com trava vigente na origem pode estar em `purge_pending` sem trava no restaurado. Registre o resultado sem IDs.

**Antes, a renovação.** O SQL abaixo agenda o purge sem passar pela rota do Admin, que recusa (`renewal_alive`) enquanto a renovação da assinatura estiver viva num provedor tratado ([ADR 0074](../adr/0074-encerramento-de-organizacao.md)). Confira à mão, no restaurado, cada organização a reaplicar: `SELECT state, cancel_at_period_end, provider FROM public.organization_billing WHERE organization_id = '<ID da organização>'`. Com `provider = 'asaas'`, `state` em `trialing`, `active` ou `grace` e `cancel_at_period_end` falso, não reaplique: o purge original só rodou depois do cancelamento, então o fato voltou atrás com o backup; reconcilie a organização (`reconcileOrganization`, [billing-providers](billing-providers.md)) até o registro dizer cancelada e só então siga.

Para cada tombstone `organization` / `purge` cuja organização reapareceu no ambiente restaurado (com qualquer status diferente de `purged`), o dono do banco, à mão e antes de reabrir o ambiente, faz as duas instruções numa única transação, trocando os `<…>` pelos valores do tombstone:

```sql
BEGIN;

UPDATE public.organizations
   SET status = 'purge_pending'
 WHERE id = '<ID da organização>' AND status <> 'purged';

INSERT INTO public.organization_purges (organization_id, scheduled_by, support_case_id, privacy_case_id, not_before, storage_touched_at)
VALUES ('<ID da organização>', '<quem agendou>', '<caso de privacidade>', '<caso de privacidade>', now(), now())
ON CONFLICT (organization_id) DO UPDATE
   SET not_before = now(), attempts = 0, locked_until = NULL,
       last_error_code = NULL, purged_at = NULL, swept_at = NULL, storage_touched_at = now();

COMMIT;
```

- `scheduled_by` e o caso são os do agendamento original. Se o agendamento foi feito antes do backup, a linha já existe no backup e o `ON CONFLICT` só reabre o purge, mantendo quem agendou, o caso e o `trigger`; se não, a linha é criada e o caso é o `privacy_case_id` do próprio tombstone no `deletion_ledger`.
- **Purge automático** ([ADR 0102](../adr/0102-apagamento-automatico-da-loja-encerrada.md)): o tombstone vem com `privacy_case_id` nulo, porque ninguém agendou. Se a linha não estava no backup, crie-a como o período a criou, sem operador nem caso (a tabela recusa uma linha do período com qualquer um dos três preenchido), no lugar do `INSERT` acima:

  ```sql
  INSERT INTO public.organization_purges (organization_id, trigger, not_before, storage_touched_at)
  VALUES ('<ID da organização>', 'closure_period', now(), now())
  ON CONFLICT (organization_id) DO UPDATE
     SET not_before = now(), attempts = 0, locked_until = NULL,
         last_error_code = NULL, purged_at = NULL, swept_at = NULL, storage_touched_at = now();
  ```

  A conclusão reaplicada é auditada de novo como do sistema. O freio `CLOSURE_AUTO_PURGE_ENABLED` não interfere: ele só liga o agendamento, não a execução de um purge já agendado.
- `storage_touched_at` vai preenchido de propósito: o tombstone só existe porque o purge original já apagou o R2, então o purge reaplicado não pode ser cancelado (a função de cancelamento recusa com `purge_storage_touched`) e deixar a organização `closed` com mídia e exportações que apontam para objetos que não existem mais.
- A tabela exige que `support_case_id` e `privacy_case_id` sejam o mesmo ID, e num purge do Admin (`trigger = 'admin'`, o padrão) os dois e `scheduled_by` não podem ser nulos: use o ID do caso de privacidade nos dois. Se o caso de privacidade foi aberto depois do instante do backup, ele não existe no ambiente restaurado e o `INSERT` falha pela chave estrangeira: pare, não reabra o ambiente e acione o responsável (recriar o caso é decisão dele, com o registro do atendimento original).
- Não execute o bloco para organização que já está `purged` no ambiente restaurado: o `ON CONFLICT` zera `purged_at` e `swept_at`, e o `UPDATE` não muda nada nela.
- O purge reaplicado também refaz a pseudonimização da cobrança (o `fact` de `billing_events`, só com as chaves de `PURGE_BILLING_FACT_KEYS`; as referências do provedor continuam) e a troca do texto livre dos casos de suporte e de privacidade, dos cancelamentos e dos motivos das concessões. Isso acontece no job de privacidade, na mesma transação das linhas; não há passo SQL à parte para isso.
- A trava dos 90 dias não impede a reaplicação. O tombstone `organization`/`purge` já está no ledger (o passo 3 o recoloca), e o purge confere o prazo por ele, não pela data de encerramento do backup, que pode não ter voltado.
- Uma trava legal vigente no ambiente restaurado (linha em `organization_legal_holds` sem `released_at`) impede o purge enquanto não for liberada no Admin (toda escrita no Admin manda `Origin: https://<host do Admin>`; sem ela, 403, [ADR 0070](../adr/0070-admin-acesso-identidade-e-capacidades.md)), e a reaplicação não a libera. O purge fica agendado e não roda. Registre a trava encontrada (ID da organização e do caso, sem texto) no registro do incidente, e libere-a só com a decisão do responsável.

Depois do `COMMIT`, o purge precisa do job de privacidade, que roda no `scheduled` do Worker. Esse gatilho só faz manutenção (mídia, cobrança, privacidade) e não abre rota nem sincronização a usuários: com o ambiente ainda fechado (antes do passo 6), deixe só o cron ativo, ou dispare-o à mão uma vez, seguindo a [política de perfis da CLI](cli-profile-policy.md). Uma organização com exportação em andamento vigente fica para a execução seguinte, como qualquer purge. Confira:

```sql
SELECT o.status, p.swept_at IS NOT NULL AS varrida
  FROM public.organization_purges AS p
  JOIN public.organizations AS o ON o.id = p.organization_id
 WHERE p.organization_id = '<ID da organização>';
```

O resultado esperado é `purged` e `varrida` verdadeiro. Além disso, a organização não pode ter linha em nenhuma tabela listada em `PURGE_DELETE_ORDER` (`packages/db/src/purge-datasets.ts`). O R2 não volta com o backup do banco, mas a varredura dos prefixos `exports/v1/{organização}/` e `media/v2/{organização}/` roda mesmo assim, antes e depois de apagar as linhas. Também, `billing_events` da organização só pode ter no `fact` chaves da lista `PURGE_BILLING_FACT_KEYS`, e os casos da organização (`support_cases`, `privacy_cases` e `organization_purge_cancellations`) não podem ter texto livre: o motivo do caso de suporte e o do cancelamento são o texto fixo `Texto removido pelo purge da organização.`, e `context`, `resolution`, `note` e `decision_note` estão nulos. Registre o resultado sem IDs.

## Verificação do procedimento

O gate `deletion-ledger` (suítes `ci` e `gate10`) roda a consulta do passo 1 como o dono de privacidade e as dos passos 0 e 5 sobre tombstones de cliente anonimizado e de cliente que não foi, num banco descartável. O gate **não** cobre o preparo de papéis, a reaplicação de ACLs nem a conferência do passo 2b: elas só existem no restore lógico em Neon, ensaiado à mão (V12).

## Rollback ou forward-fix

Reaplicar não tem volta (a anonimização é final, ADR 0075). Antes de reaplicar em produção, confira a linha por ID e organização no ambiente restaurado; se um tombstone estiver errado (a consulta inversa do passo 0 não voltou vazia), **pare** e escale: um tombstone forjado anonimizaria uma pessoa real (o runtime do tenant só consegue gravar o de um cliente já anonimizado na própria organização, mas o `INSERT` do dono do passo 3 não tem essa proteção).

## Escalonamento

Responsável pelo produto e pela privacidade: o Arrascaeta decide, o Léo revisa. Não execute em produção sem a autorização explícita do responsável.
