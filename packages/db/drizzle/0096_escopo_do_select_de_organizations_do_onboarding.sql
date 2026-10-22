-- A smaller tightening after 0095 (ADR 0093, amended; review of Rodrigo): the `id = app.owner_scope.onboarding_organization_id`
-- branch of the policy `organizations_onboarding_owner_select` now also requires `created_at = now()`. That branch exists so
-- the onboarding owner can read back the organization it has just created in the transaction (the final `RETURN QUERY` of
-- `create_initial_organization`, and the check of the membership policy before the membership exists). Without the
-- requirement, a function that pointed the setting at the id of an old organization would read its row. `created_at` has
-- `DEFAULT now()` and `now()` is the start of the transaction, so only an organization created in this transaction passes,
-- as is already so for the INSERT policy of `memberships` of the same owner. The branch by membership of the user (the
-- organization already open, returned with `created = false`) does not change.
-- Expand only (ADR 0096): only the policy of the new role, which the previous Worker does not use; the four functions and the
-- policies of the runtimes stay as they are. `ALTER POLICY` takes ACCESS EXCLUSIVE on `organizations`, a busy table: better to
-- fail and deploy again than to queue requests, as in 0095.
-- The `SET LOCAL lock_timeout` of 0095 held, unintentionally, for every later migration of the same run (the migrator runs
-- them all in one transaction). This is the next one: it keeps the timeout for itself and ends with `RESET`, which gives the
-- default (the role's or the database's; an earlier session-level SET is lost too, and the migrator makes none) back to
-- whatever comes next. A migration that uses `SET LOCAL lock_timeout` ends with `RESET lock_timeout`
-- (`migration-lock-timeout.test.ts` checks it).
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
-- the policy keeps its one role, its command and both branches: by id (now only of an organization created in this
-- transaction) and by membership of the user (the organization already open)
DO $end_state$
BEGIN
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_policies AS pol
       WHERE pol.schemaname = 'public' AND pol.tablename = 'organizations'
         AND pol.policyname = 'organizations_onboarding_owner_select'
         AND pol.roles = ARRAY['polaris_onboarding_owner']::name[]
         AND pol.cmd = 'SELECT'
         AND pol.qual LIKE '%created_at = now()%'
         AND pol.qual LIKE '%onboarding_organization_id%'
         AND pol.qual LIKE '%member_scope%'
         AND pol.qual LIKE '%onboarding_user_id%') <> 1 THEN
    RAISE EXCEPTION 'organizations_onboarding_owner_select lost a branch or was not narrowed to the organization created in this transaction';
  END IF;
END
$end_state$;--> statement-breakpoint
RESET lock_timeout;
