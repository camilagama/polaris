# Restore de backup e deletion ledger

**Gatilho:** restaurar um backup ou uma branch do banco (por falha, corrupção ou teste de recuperação) para um instante anterior ao presente.

**Por quê:** um restore ressuscita o que já foi removido: um cliente anonimizado volta com nome, telefone, email e observações; uma organização purgada volta inteira. A [deletion ledger](../adr/0080-ledger-minimo-de-exclusoes.md) (`public.deletion_ledger`) é o registro mínimo (IDs opacos, tipo de registro, operação, instante) do que deve ser removido de novo. Regra de privacidade: **o restore reaplica o ledger antes de o ambiente ser reutilizado** ([privacidade](../business-rules/privacy.md)).

> **Nada deste procedimento foi executado contra um ambiente real**, e não há automação: ela é da Fase 16. A consulta de lista e a de verificação são provadas pelo gate `deletion-ledger` num banco descartável. Qualquer comando Cloudflare ou Neon segue a [política de perfis de CLI](./cli-profile-policy.md). Reaplicar altera dado: é uma ação do responsável, em ambiente já autorizado por ele.

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

   Vazia significa: nenhum cliente com tombstone continua com dado pessoal, e nenhuma organização com tombstone de purge está fora de `purged` (a linha da organização fica como marca de remoção, então a consulta confere o estado, não a existência). **Só vale se o passo 3 foi feito:** confira também que `SELECT count(*) FROM public.deletion_ledger` no ambiente restaurado é **no mínimo** o número de linhas da lista do passo 1 mais os tombstones que já vieram no backup (sem o passo 3, a consulta passa vazia sem provar nada sobre as exclusões posteriores ao backup). Registre o resultado (sem IDs) e o instante.
6. **Só então** reabrir o ambiente (Workers, cron, sincronização). Aparelhos que sincronizaram com o ambiente anterior podem estar à frente do restaurado: é um limite geral do restore, tratado na Fase 16.

### Reaplicar um purge de organização

**Antes, as travas legais.** As travas legais (`organization_legal_holds`) também não voltam com o backup: uma trava posta depois do instante do backup some no ambiente restaurado, e o purge reaplicado rodaria sob ela. Junto da leitura do passo 1, leia no ambiente **que será substituído** as travas vigentes (`SELECT organization_id, support_case_id, placed_by, placed_at, review_at FROM public.organization_legal_holds WHERE released_at IS NULL`; a mesma lista sai de `GET /legal-holds` no Admin, com as vencidas marcadas como pendentes de revisão) e, no restaurado, antes de reaplicar qualquer purge, recoloque cada trava que não estiver lá. Pôr a trava exige um **caso de suporte aberto** da organização, e o caso original (o `support_case_id` lido acima) pode não existir no banco restaurado: se ele não estiver lá, ou estiver fechado, **abra um caso novo** pelo Admin (`POST /support-cases`, tipo `support`, motivo "restauração", a organização da trava) e **vincule a trava a ele**: `POST /support-cases/{caso novo}/legal-hold` com `{ organizationId, reviewAt }`. A data de revisão é obrigatória, no futuro e a no máximo 366 dias: use a lida acima se ainda valer e, se já tiver passado (a trava estava pendente de revisão), uma data nova, decidida pelo responsável. Na conferência, nenhuma organização com trava vigente na origem pode estar em `purge_pending` sem trava no restaurado. Registre o resultado sem IDs.

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

- `scheduled_by` e o caso são os do agendamento original. Se o agendamento foi feito antes do backup, a linha já existe no backup e o `ON CONFLICT` só reabre o purge, mantendo quem agendou e o caso; se não, a linha é criada e o caso é o `privacy_case_id` do próprio tombstone no `deletion_ledger` (todo purge nasce de um caso de privacidade de exclusão, ADR 0081).
- `storage_touched_at` vai preenchido de propósito: o tombstone só existe porque o purge original já apagou o R2, então o purge reaplicado não pode ser cancelado (a função de cancelamento recusa com `purge_storage_touched`) e deixar a organização `closed` com mídia e exportações que apontam para objetos que não existem mais.
- A tabela exige que `support_case_id` e `privacy_case_id` sejam o mesmo ID, e os dois não podem ser nulos: use o ID do caso de privacidade nos dois. Se o caso de privacidade foi aberto depois do instante do backup, ele não existe no ambiente restaurado e o `INSERT` falha pela chave estrangeira: pare, não reabra o ambiente e acione o responsável (recriar o caso é decisão dele, com o registro do atendimento original).
- Não execute o bloco para organização que já está `purged` no ambiente restaurado: o `ON CONFLICT` zera `purged_at` e `swept_at`, e o `UPDATE` não muda nada nela.
- O purge reaplicado também refaz a pseudonimização da cobrança (o `fact` de `billing_events`, só com as chaves de `PURGE_BILLING_FACT_KEYS`; as referências do provedor continuam) e a troca do texto livre dos casos de suporte e de privacidade, dos cancelamentos e dos motivos das concessões. Isso acontece no job de privacidade, na mesma transação das linhas; não há passo SQL à parte para isso.
- A trava dos 90 dias não impede a reaplicação. O tombstone `organization`/`purge` já está no ledger (o passo 3 o recoloca), e o purge confere o prazo por ele, não pela data de encerramento do backup, que pode não ter voltado.
- Uma trava legal vigente no ambiente restaurado (linha em `organization_legal_holds` sem `released_at`) impede o purge enquanto não for liberada no Admin, e a reaplicação não a libera. O purge fica agendado e não roda. Registre a trava encontrada (ID da organização e do caso, sem texto) no registro do incidente, e libere-a só com a decisão do responsável.

Depois do `COMMIT`, o purge precisa do job de privacidade, que roda no `scheduled` do Worker. Esse gatilho só faz manutenção (mídia, cobrança, privacidade) e não abre rota nem sincronização a usuários: com o ambiente ainda fechado (antes do passo 6), deixe só o cron ativo, ou dispare-o à mão uma vez, seguindo a [política de perfis da CLI](cli-profile-policy.md). Uma organização com exportação em andamento vigente fica para a execução seguinte, como qualquer purge. Confira:

```sql
SELECT o.status, p.swept_at IS NOT NULL AS varrida
  FROM public.organization_purges AS p
  JOIN public.organizations AS o ON o.id = p.organization_id
 WHERE p.organization_id = '<ID da organização>';
```

O resultado esperado é `purged` e `varrida` verdadeiro. Além disso, a organização não pode ter linha em nenhuma tabela listada em `PURGE_DELETE_ORDER` (`packages/db/src/purge-datasets.ts`). O R2 não volta com o backup do banco, mas a varredura dos prefixos `exports/v1/{organização}/` e `media/v2/{organização}/` roda mesmo assim, antes e depois de apagar as linhas. Também, `billing_events` da organização só pode ter no `fact` chaves da lista `PURGE_BILLING_FACT_KEYS`, e os casos da organização (`support_cases`, `privacy_cases` e `organization_purge_cancellations`) não podem ter texto livre: o motivo do caso de suporte e o do cancelamento são o texto fixo `Texto removido pelo purge da organização.`, e `context`, `resolution`, `note` e `decision_note` estão nulos. Registre o resultado sem IDs.

## Verificação do procedimento

O gate `deletion-ledger` (suítes `ci` e `gate10`) roda a consulta do passo 1 como o dono de privacidade e as dos passos 0 e 5 sobre tombstones de cliente anonimizado e de cliente que não foi, num banco descartável.

## Rollback ou forward-fix

Reaplicar não tem volta (a anonimização é final, ADR 0075). Antes de reaplicar em produção, confira a linha por ID e organização no ambiente restaurado; se um tombstone estiver errado (a consulta inversa do passo 0 não voltou vazia), **pare** e escale: um tombstone forjado anonimizaria uma pessoa real (o runtime do tenant só consegue gravar o de um cliente já anonimizado na própria organização, mas o `INSERT` do dono do passo 3 não tem essa proteção).

## Escalonamento

Responsável pelo produto e pela privacidade: o Arrascaeta decide, o Léo revisa. Não execute em produção sem a autorização explícita do responsável.
