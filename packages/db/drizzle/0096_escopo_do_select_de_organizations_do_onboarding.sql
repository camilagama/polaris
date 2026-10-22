-- Aperto menor do PR da 0095 (ADR 0093, emenda; revisão do Rodrigo): o ramo `id = app.owner_scope.onboarding_organization_id`
-- da política `organizations_onboarding_owner_select` passa a exigir também `created_at = now()`. Esse ramo existe para o
-- dono do onboarding reler a organização que ele acabou de criar na transação (o `RETURN QUERY` final de
-- `create_initial_organization`); sem a exigência, uma função que fixasse o GUC com o id de uma organização antiga leria a
-- linha dela. `created_at` tem `DEFAULT now()` e `now()` é o início da transação, então só uma organização criada nesta
-- transação passa, como já vale para a política de INSERT de `memberships` do mesmo dono. O ramo por membership do
-- usuário (a organização já aberta, devolvida em `created = false`) não muda.
-- Expand only (ADR 0096): só a política do papel novo, que o Worker anterior não usa; as quatro funções e as políticas dos
-- runtimes ficam como estão. `ALTER POLICY` pega `ACCESS EXCLUSIVE` em `organizations`, uma tabela quente: melhor falhar e
-- repetir o deploy do que enfileirar requisições, como na 0095.
-- O `SET LOCAL lock_timeout` da 0095 valia, sem querer, para todas as migrations seguintes da mesma execução (o migrador
-- roda todas numa transação só). Esta é a seguinte: ela mantém o prazo para si e termina com `RESET`, que devolve o valor
-- padrão da sessão (o do papel ou do banco) para o que vier depois. Quem usar `SET LOCAL lock_timeout` numa migration
-- termina com `RESET lock_timeout` (o teste `migration-lock-timeout.test.ts` confere a ordem dos arquivos).
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER POLICY organizations_onboarding_owner_select ON public.organizations
  TO polaris_onboarding_owner
  USING ((id = NULLIF(pg_catalog.current_setting('app.owner_scope.onboarding_organization_id', true), '')
      AND created_at = pg_catalog.now())
    OR EXISTS (
      SELECT 1 FROM public.memberships AS member_scope
       WHERE member_scope.organization_id = organizations.id
         AND member_scope.user_id = NULLIF(pg_catalog.current_setting('app.owner_scope.onboarding_user_id', true), '')
    ));--> statement-breakpoint
-- the policy keeps its one role and its two scopes (a REPLACE of a policy that lost its role would be a finding of the gate)
DO $end_state$
BEGIN
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_policies AS pol
       WHERE pol.schemaname = 'public' AND pol.tablename = 'organizations'
         AND pol.policyname = 'organizations_onboarding_owner_select'
         AND pol.roles = ARRAY['polaris_onboarding_owner']::name[]
         AND pol.cmd = 'SELECT'
         AND pol.qual LIKE '%created_at = now()%') <> 1 THEN
    RAISE EXCEPTION 'organizations_onboarding_owner_select was not narrowed to the organization created in this transaction';
  END IF;
END
$end_state$;--> statement-breakpoint
RESET lock_timeout;
