---
status: partially superseded
superseded_in_part_by: 0007, 0027
---

# Usar Neon PostgreSQL 18 com Hyperdrive e RLS transacional

PostgreSQL 18 no Neon é o baseline relacional inicial; Hyperdrive fornece pooling com SQL query caching desabilitado para dados tenant e Admin. Cada operação tenant define o contexto da organização localmente dentro de uma transação explícita, depois de validar membership e capability no servidor, e RLS adiciona uma segunda camada de isolamento. Features tenant aguardam prova remota Worker → Hyperdrive → Neon cobrindo concorrência, rollback, falha/retry, contexto ausente, reuso de conexão e role runtime sem ownership ou BYPASSRLS.

GUCs transaction-local são contexto definido pelo runtime e podem ser alterados por qualquer sessão que use esse papel; eles não são uma prova de identidade contra SQL arbitrário. Por isso, o papel runtime recebe apenas SELECT em organizations/memberships e não pode criar organizations ou memberships. RLS continua como defesa contra consultas sem o filtro/contexto esperado, não contra SQL injection com acesso direto à sessão.

## Nota de revisão (13/10/2026)

O parágrafo original sobre onboarding afirmava que o use case permanecia interno, com uma conexão privilegiada separada, e que sua exposição a requests ficava adiada. Ele foi substituído por esta nota porque contradizia o [ADR 0007](0007-gate2-onboarding-and-category-rls.md): o onboarding passou a ser exposto por uma função `SECURITY DEFINER` chamada por um binding Hyperdrive dedicado, com a role `polaris_onboarding_runtime`, sem DML direto da role tenant em organizations/memberships.

A premissa de uma única role runtime para autenticação e tenant é substituída pelo [ADR 0027](0027-separacao-de-roles-auth-tenant-e-superficies-poc.md), que separa a role de auth da role de tenant. Os demais pontos deste ADR continuam em vigor.

## Emenda de 19/11/2026: a entrada da transação de tenant num statement

O Hyperdrive conta cada statement contra a cota diária da conta (100.000 por dia no Workers Free), e a entrada de toda transação de tenant gastava seis: o `BEGIN`, os três timeouts, `app.user_id`, o membership, `app.organization_id` e o status da organização. A partir da migration 0136, a entrada é o `BEGIN` e **uma** chamada a `public.begin_tenant_request(p_user, p_organization, p_roles, p_statement_timeout_ms, p_lock_timeout_ms, p_idle_timeout_ms)`, que faz o mesmo, na mesma ordem:

1. grava os timeouts e `app.user_id` com `set_config(…, true)` (locais à transação; um timeout nulo ou não positivo recusa com `22023`, porque `set_config` com nulo tiraria o limite);
2. lê o membership do usuário sob `memberships_current_user_select`: ausente ou não ativo → `tenant_access_denied`;
3. confere o papel do membership contra `p_roles`, os papéis que têm a capability no mapa do domínio (`rolesWithCapability`, em `packages/domain/src/authorization/capabilities.ts`, a única fonte do mapa): lista vazia ou nula → `capability_denied`;
4. só então grava `app.organization_id` e lê a organização ativa sob `organizations_active_tenant_select`; se não houver, `closed_organization_status` (0085) separa o encerramento (`organization_closed`) do resto (`tenant_access_denied`).

Cada recusa é `RAISE` com SQLSTATE `42501` e a mensagem igual ao código de `TenantAuthorizationError`; o Worker converte só esse par (SQLSTATE **e** mensagem), então um `42501` de grant faltando sobe como erro. O `RAISE` aborta a transação: nada roda depois de uma recusa.

A função é `SECURITY INVOKER`, com `search_path` fixo e `EXECUTE` só de `polaris_pr11_runtime`: lê só o que o runtime de tenant já lia, sob as mesmas políticas, e não cria dono, política nem privilégio. **Desde 20/11/2026 (migration 0138; [ADR 0100](0100-tela-de-entrada-senha-atras-de-flag-bloqueio-e-aceite-legal.md), emenda de 20/11/2026) ela também confere o aceite legal**, primeiro, logo depois de gravar `app.user_id`: a sobrecarga de nove argumentos recebe `p_require_legal` e os dois mínimos, sem `DEFAULT`, e chama a única `SECURITY DEFINER` da entrada, `legal_acceptance_pending` (dono `polaris_legal_acceptance_owner`, `EXECUTE` só do runtime de tenant, só nomes de documentos pendentes). A entrada continua INVOKER; a recusa é `42501 legal_acceptance_required` com os documentos no `DETAIL`, que o Worker devolve como a recusa do portão. A de seis argumentos fica para o Worker anterior até a contração. Ela é um atalho na contagem de statements, não uma fronteira de segurança: quem tem SQL arbitrário como runtime já grava os GUCs direto, como diz este ADR. Ela **depende do query caching do Hyperdrive desligado**: um resultado servido do cache pularia a entrada inteira (os `set_config` e as conferências). O cache é configuração do Hyperdrive na Cloudflare, fora do repositório (o comentário de `apps/web/wrangler.jsonc` só a registra), e nenhum teste do repositório a vigia; quem prova é a execução remota Worker → Hyperdrive → Neon antes da liberação ([ADR 0025](0025-estrategia-de-testes-de-banco.md)), que precisa passar pela função. Com isso, a entrada cai de 6 statements para 2 (mais o `COMMIT`), medidos por rota no teste `STATEMENT_COUNTS` de `apps/web/worker/index.workerd-db.test.ts` (`sync/pull` de 10 para 6). Voltar atrás é reverter o Worker; a função fica sem uso e só sai numa migration de contração.

## Emenda de 20/11/2026: as lojas do usuário num statement

A lista das lojas da sessão (`organization.listMine`, uma vez por abertura do app) gastava, depois do `BEGIN`, o `set_config` do usuário, a leitura dos memberships e dois statements por loja (o `set_config` da organização e a linha dela, que só a política da própria organização deixa ler). A partir da migration 0137, ela é **uma** chamada a `public.list_user_organizations(p_user)`, que faz o mesmo na mesma ordem, sob as mesmas políticas: `SECURITY INVOKER`, `search_path` fixo, `EXECUTE` só de `polaris_pr11_runtime`, sem dono, política nem privilégio novos. Ela devolve só `id`, `name`, `role` e `timezone`, recusa um usuário nulo, vazio ou com espaço nas pontas com `42501` `tenant_access_denied`, grava os GUCs com `set_config(…, true)` e os deixa vazios ao terminar. O argumento é sempre o `session.user.id` do `getSession`, nunca um valor do cliente. Como ela termina com os dois GUCs vazios, roda só numa transação própria, nunca dentro de uma transação de tenant, cujo contexto ela apagaria. Com isso, `organization/listMine` cai de 8 para 5 statements com uma loja (2 a menos por loja a mais).

Como a 0136, ela **depende do query caching do Hyperdrive desligado**: um resultado servido do cache continuaria listando a loja de quem foi removido dela, e pularia os `set_config`. A prova é a mesma execução remota Worker → Hyperdrive → Neon antes da liberação, que precisa passar pela função.
