# Auditoria do tenant depois do purge

**Gatilho:** alguém com autoridade pede para ler a auditoria de uma organização que já foi purgada (apuração de fraude, disputa de cobrança, ordem judicial, pedido da ANPD, ou o dono do Polaris conferindo o que um usuário fez). A [emenda de 19/10/2026 do ADR 0081](../adr/0081-purge-completo-da-organizacao-encerrada.md) manteve a auditoria do tenant (`tenant_audit_event`) depois do purge: ela é imutável e sai só por prazo.

> **Nada deste procedimento foi executado contra um ambiente real.** A consulta, a imutabilidade e os prazos são provados pelo gate `audit-retention` num PostgreSQL descartável. Uma função do Admin que leia a auditoria, ela própria auditada em `platform_audit_events`, **fica para o futuro** (ADR 0081, emenda): hoje a leitura é direta no banco, por quem é dono do Polaris.

## O que a auditoria guarda, e até quando

- Só IDs opacos (o ID do ator é pseudônimo: liga a linha a uma pessoa enquanto a conta existir): a organização, o ID interno do ator (`actor_user_id`), o tipo do evento, o tipo e o ID da entidade, o ID da requisição e a hora. Nenhum nome, e-mail ou telefone. A organização purgada continua existindo como tombstone (`status = 'purged'`, nome trocado por "Organização removida").
- Cada evento tem uma classe (`event_class`), definida pelo registro do domínio (`packages/domain/src/privacy/tenant-audit-events.ts`): `security` (exportações de dados, anonimização de cliente, concessões offline, vida da organização, publicação no catálogo público) ou `operational` (o resto).
- Prazos **propostos**, com a revisão jurídica pendente: `security`, 5 anos contados do evento; `operational`, 6 meses contados do purge. Nenhum job expurga ainda; quando existir, ele pula a organização sob legal hold. Se a pergunta chega depois do prazo e o job já rodou, a linha pode não existir mais.

## Pré-requisitos de acesso

- Quem lê é o **dono do banco** (o perfil do migrador), porque nenhum papel de aplicação lê a auditoria: o runtime do tenant só insere, e o dono da retenção (`polaris_retention_owner`, sem login) enxerga só quatro colunas. A tabela força RLS e não tem política para o dono; a leitura funciona com o papel dono da Neon, que ignora RLS (confirme antes, no ambiente, com `SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user`).
- Siga a [política de perfil de CLI](./cli-profile-policy.md): não rode nada sem confirmar o perfil e a identidade permitidos, e nunca contra produção sem o pedido explícito do responsável.
- **Registre o pedido antes de ler**: abra (ou use) um caso de suporte ou de privacidade da organização no Admin, com o motivo curto, sem dado pessoal. É a trilha de quem leu o quê, enquanto a função auditada do Admin não existe.

## Passos

1. **Confirmar que a organização foi purgada** e quando:

   ```sql
   SELECT o.id, o.status, p.purged_at
     FROM public.organizations AS o
     LEFT JOIN public.organization_purges AS p ON p.organization_id = o.id
    WHERE o.id = '<organização>';
   ```

2. **Ler a auditoria, só leitura.** Numa transação marcada como somente leitura (o banco recusa qualquer escrita), com limite e por período:

   ```sql
   BEGIN READ ONLY;
   SELECT created_at, event_class, event_type, entity_type, entity_id, actor_user_id, request_id
     FROM public.tenant_audit_event
    WHERE organization_id = '<organização>'
      AND created_at >= '<início>' AND created_at < '<fim>'
    ORDER BY created_at, id
    LIMIT 500;
   ROLLBACK;
   ```

   Para só um usuário, acrescente `AND actor_user_id = '<usuário>'`. Para só o que é de segurança, `AND event_class = 'security'`.
3. **Ligar o ator a uma pessoa** só se a apuração exigir e o caso permitir: `actor_user_id` é o ID interno de `public."user"`, que sobrevive ao purge da organização (a conta é outro fluxo, [ADR 0081](../adr/0081-purge-completo-da-organizacao-encerrada.md), "Contas de usuário ficam"). Não copie o nome ou o e-mail para o caso.
4. **Entregar só o necessário**, no canal que o caso definir, sem colar o resultado em issue, PR, log ou chat. A saída tem IDs opacos, mas é a lista do que cada pessoa fez.
5. **Fechar o caso** registrando o que foi lido (o período e a contagem), sem copiar as linhas.

## O que não fazer

- Não rode `UPDATE`, `DELETE` ou `TRUNCATE`: os gatilhos `ENABLE ALWAYS` recusam qualquer papel, o dono da tabela incluído, inclusive com `session_replication_role = replica` (desligar o gatilho é DDL do dono do banco, e não se faz). Apagar por prazo é só pela função `expire_tenant_audit_events`, do `polaris_retention_owner`, que ainda não tem job nem quem a execute.
- Não desligue um gatilho para "consertar" uma linha: a auditoria imutável é a prova.
- Não exporte a auditoria para fora do banco como cópia permanente (alternativa descartada no ADR 0081).

## Verificação

- `SELECT count(*) FROM public.tenant_audit_event WHERE organization_id = '<organização>'` é maior que zero para uma organização que teve atividade, e igual antes e depois do purge: é o que o gate `audit-retention` e o `organization-purge` provam.
- Para saber se uma linha já venceu: `SELECT public.tenant_audit_event_expired(organization_id, event_class, created_at) FROM public.tenant_audit_event WHERE id = '<id>'`.

## Escalonamento

O responsável pelo Polaris decide sobre ordem judicial, pedido da ANPD e qualquer entrega a terceiro; este runbook não autoriza a entrega.
