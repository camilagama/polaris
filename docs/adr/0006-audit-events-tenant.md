---
status: accepted
---

# Eventos de auditoria tenant transacionais e append-only

## Contexto

O plano exige auditar mutações críticas no mesmo commit da mutação. O stream `auth_security_audit_event` é global e descreve operações de autenticação; eventos tenant precisam carregar organização, ator e entidade sem misturar os dois propósitos. Ainda não há leitor de histórico de auditoria nem política de retenção legal.

## Decisão

- Criar `tenant_audit_event` com organization ID, actor user ID interno, event type, entity type/ID, request ID UUID opcional e timestamp. Não armazenar metadata livre, snapshots, email, IP, user-agent, tokens ou conteúdo de negócio.
- Escrever eventos pelo `recordTenantAuditEvent()` dentro da transação já aberta; o writer não abre outra transação. O onboarding registra `organization.created` junto com organization e membership.
- O runtime recebe apenas `INSERT`, protegido por `FORCE ROW LEVEL SECURITY`; a policy exige user/organization no contexto e membership/organização ativas. Não conceder leitura, atualização ou exclusão neste PR.
- GUCs são contextos que o runtime pode alterar, não uma prova contra SQL arbitrário. A policy protege contra uso incorreto do contexto pela aplicação; não é defesa contra SQL injection.
- Eventos tenant são removidos quando a organização é purgada (`ON DELETE CASCADE`). Não adicionar expiração automática; revisar retenção legal e legal hold antes do go-live.

## Consequências

Mutações futuras de catálogo, estoque e vendas devem inserir o evento na transação autorizada da mesma operação. Histórico de auditoria na UI, capabilities de leitura e retenção configurável ficam para etapas posteriores.