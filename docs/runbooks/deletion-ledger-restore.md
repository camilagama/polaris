# Restore de backup e deletion ledger

**Gatilho:** restaurar um backup ou uma branch do banco (por falha, corrupção ou teste de recuperação) para um instante anterior ao presente.

**Por quê:** um restore ressuscita o que já foi removido: um cliente anonimizado volta com nome, telefone, email e observações; uma organização purgada volta inteira. A [deletion ledger](../adr/0080-ledger-minimo-de-exclusoes.md) (`public.deletion_ledger`) é o registro mínimo (IDs opacos, tipo de registro, operação, instante) do que deve ser removido de novo. Regra de privacidade: **o restore reaplica o ledger antes de o ambiente ser reutilizado** ([privacidade](../business-rules/privacy.md)).

> **Nada deste procedimento foi executado contra um ambiente real**, e não há automação: ela é da Fase 16. A consulta de lista e a de verificação são provadas pelo gate `deletion-ledger` num banco descartável. Qualquer comando Cloudflare ou Neon segue a [política de perfis de CLI](./cli-profile-policy.md). Reaplicar altera dado: é uma ação do responsável, em ambiente já autorizado por ele.

## Pré-requisitos de acesso

- A conexão do **dono do banco** (a tabela força RLS e não há política para ele; funciona com o papel dono da Neon, que ignora RLS). Alternativa só para ler o ledger: `SET ROLE polaris_privacy_owner` (papel sem login, com `SELECT` no ledger; a sessão do dono precisa de `GRANT polaris_privacy_owner TO CURRENT_USER WITH SET TRUE` e o desfaz depois, como as migrations fazem).
- Nenhum papel de aplicação (tenant, Admin, privacidade, billing, catálogo) lê o ledger.

## O ponto que decide tudo: de onde ler o ledger

O ledger mora no mesmo banco. O backup traz o ledger **do instante do backup**, sem as exclusões feitas depois. Por isso:

1. **Antes** de substituir ou apagar o ambiente atual, **leia o ledger dele** (passo 1). O ambiente a ser substituído (ou a branch de origem, que **não** deve ser apagada) é a fonte dos tombstones posteriores ao backup.
2. Guarde a lista fora do banco, em local privado do responsável. Ela tem só IDs opacos, mas é a lista de quem pediu privacidade: trate como dado sensível.
3. **Não apague o ambiente ou a branch de origem** até a reaplicação estar conferida (passo 5).

Se o ambiente de origem não puder mais ser lido (perda total), os tombstones posteriores ao último backup estão perdidos: registre isso como incidente e decida com o responsável (a cópia do ledger fora do banco é da Fase 16).

## Passos

1. **Listar o ledger no ambiente de origem**, a partir do instante do backup menos uma margem (a lista é idempotente, a margem só evita perder um tombstone por diferença de relógio; sem filtro, lista tudo):

   ```sql
   SELECT entity_type, entity_id, operation, organization_id, privacy_case_id, recorded_at
     FROM public.deletion_ledger
    WHERE recorded_at >= $1   -- instante do backup, menos 1 hora
    ORDER BY recorded_at, id;
   ```

2. **Restaurar** o backup para o novo ambiente (não abra o ambiente restaurado a usuários, a aparelhos nem ao cron enquanto os passos 3 a 5 não terminarem: nem o Worker, nem a sincronização, nem a varredura horária).
3. **Carregar os tombstones da lista** no ambiente restaurado que ainda não existirem (`INSERT` pelo dono do banco; o índice único recusa repetição, então `ON CONFLICT DO NOTHING` é seguro). Os tombstones até o instante do backup já vieram nele.
4. **Reaplicar cada tombstone**, conforme o tipo:
   - `customer` / `anonymize`: se o cliente existe no ambiente restaurado e `anonymized_at IS NULL`, repetir o efeito do comando `customer.anonymizeForPrivacy` ([ADR 0075](../adr/0075-anonimizacao-de-cliente-por-privacidade.md)): nome `Cliente anonimizado`, telefone, email e observações nulos, `archived_at` preenchido (se ainda não estava), `anonymized_at` marcado e `version` +1, num `UPDATE` do dono do banco, **uma linha por vez, conferindo o ID e a organização do tombstone**. Se o cliente não existe, não há o que fazer.
   - `organization` / `purge`: se a organização existe no ambiente restaurado, ela precisa ser purgada de novo, pelo processo de purge (PR107; idempotente, inclui o R2 em `exports/v1/{organização}/`, mídia e derivados). Até o PR107 existir, um tombstone desse tipo não é gravado por nada, então não aparece.
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
    WHERE l.entity_type = 'organization' AND l.operation = 'purge';
   ```

   Vazia significa: nenhum cliente com tombstone continua com dado pessoal e nenhuma organização purgada continua existindo. Registre o resultado (sem IDs) e o instante.
6. **Só então** reabrir o ambiente (Workers, cron, sincronização). Aparelhos que sincronizaram com o ambiente anterior podem estar à frente do restaurado: é um limite geral do restore, tratado na Fase 16.

## Verificação do procedimento

O gate `deletion-ledger` (suítes `ci` e `gate10`) roda a consulta do passo 1 como o dono de privacidade e a do passo 5 sobre tombstones de cliente anonimizado e de cliente que não foi, num banco descartável.

## Rollback ou forward-fix

Reaplicar não tem volta (a anonimização é final, ADR 0075). Antes de reaplicar em produção, confira a linha por ID e organização no ambiente restaurado; se um tombstone estiver errado, **pare** e escale: um tombstone forjado anonimizaria uma pessoa real (o runtime do tenant só consegue gravar o de um cliente já anonimizado na própria organização).

## Escalonamento

Responsável pelo produto e pela privacidade: o Arrascaeta decide, o Léo revisa. Não execute em produção sem a autorização explícita do responsável.
