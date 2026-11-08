-- The M3 of ADR 0106 (D9): of the stores that did not sell in their first 14 days, how many owners came back to the app
-- and how many never did, derived from `session` and frozen once per cohort week. Expand only (ADR 0096): a new role, a
-- new table, a new function, new policies and column grants; nothing existing is dropped, altered or recreated, and the
-- previous Worker never touches any of it. Nobody calls the function yet (the hourly sweep of billing will), and the
-- Admin does not read the table yet (the funnel will, after the Admin that accepts the cell is deployed: D12).
--
-- * `polaris_activation_owner` (NOLOGIN, NOINHERIT, NOBYPASSRLS) owns only the functions of the measure. It is not
--   `polaris_admin_owner`: every `admin_*` function runs as that one, and each would then be able to read the sessions.
-- * What it reads, by column and nothing else: `session` (`user_id`, `created_at`, `updated_at`; never `id`, `token`,
--   `ip_address`, `user_agent` nor `expires_at`), the stores of the last 42 days (`organizations`: `id`, `status`,
--   `created_at`) and, through them, their sales (`organization_id`, `confirmed_at`), billing record (`organization_id`,
--   `state`, `trial_started_at`) and internal marker (`organization_id`); and every active owner's membership
--   (`organization_id`, `user_id`, `role`, `status`, `created_at`: the first store of a person is the oldest one). Not
--   `products`, `"user"`, `auth_access_log` nor `devices`. On `session` its policy is its own, `USING (true)`: the filter
--   is the function's.
-- * `activation_return_weeks`: one row per cohort week (a Monday of São Paulo), with the two cells only when both hold k
--   (5) stores or more, else both null. No store, person or ID. Append-only: a trigger refuses UPDATE, DELETE and
--   TRUNCATE, whatever the role, also under session_replication_role = replica. The 12 months from `frozen_at` (D11)
--   have no job yet, as the other rows of the series.
-- * `activation_return_freeze()`, SECURITY DEFINER of the owner, EXECUTE to the billing role only (it runs the hourly
--   maintenance where the freezing goes): it freezes each cohort week whose 14 days are over for every store of it (the
--   start plus 21 days) and not yet frozen, while its sessions are still kept (before the start plus 31 days), and
--   answers only the counts it wrote. A week that was never frozen has no row: unavailable, never 0.
-- Each policy on an existing table takes a lock on a busy table, `session` (read by every /get-session) among them: they
-- are all taken first, in one fixed order, and a lock not had in 10 s fails the migration instead of queueing logins.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
LOCK TABLE public.organizations, public.memberships, public.sales, public.organization_billing, public.platform_internal_organizations, public.session IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'polaris_activation_owner') THEN
    EXECUTE 'CREATE ROLE polaris_activation_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
  END IF;
  -- a role that already existed gets the same attributes; NOSUPERUSER is refused to a migrator that is not a superuser
  -- (Neon), so the check below keeps that guarantee
  EXECUTE 'ALTER ROLE polaris_activation_owner NOLOGIN NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'polaris_activation_owner' AND rolsuper) THEN
    RAISE EXCEPTION 'polaris_activation_owner must not be a superuser';
  END IF;
END
$roles$;--> statement-breakpoint
CREATE TABLE "activation_return_weeks" (
	"cohort_week" date PRIMARY KEY NOT NULL,
	"frozen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"never_returned" integer,
	"returned" integer,
	CONSTRAINT "activation_return_weeks_monday" CHECK (extract(isodow from "activation_return_weeks"."cohort_week") = 1),
	CONSTRAINT "activation_return_weeks_suppressed" CHECK (("activation_return_weeks"."returned" IS NULL AND "activation_return_weeks"."never_returned" IS NULL) OR ("activation_return_weeks"."returned" IS NOT NULL AND "activation_return_weeks"."never_returned" IS NOT NULL AND "activation_return_weeks"."returned" >= 5 AND "activation_return_weeks"."never_returned" >= 5))
);
--> statement-breakpoint
ALTER TABLE "activation_return_weeks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "session_activation_owner_select" ON "session" AS PERMISSIVE FOR SELECT TO "polaris_activation_owner" USING (true);--> statement-breakpoint
CREATE POLICY "activation_return_weeks_owner_select" ON "activation_return_weeks" AS PERMISSIVE FOR SELECT TO "polaris_activation_owner" USING (true);--> statement-breakpoint
CREATE POLICY "activation_return_weeks_owner_insert" ON "activation_return_weeks" AS PERMISSIVE FOR INSERT TO "polaris_activation_owner" WITH CHECK (true);--> statement-breakpoint
ALTER TABLE public.activation_return_weeks FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TRIGGER activation_return_weeks_no_change
  BEFORE UPDATE OR DELETE ON public.activation_return_weeks
  FOR EACH ROW EXECUTE FUNCTION public.audit_record_is_immutable();--> statement-breakpoint
CREATE TRIGGER activation_return_weeks_no_truncate
  BEFORE TRUNCATE ON public.activation_return_weeks
  FOR EACH STATEMENT EXECUTE FUNCTION public.audit_record_is_immutable();--> statement-breakpoint
ALTER TABLE public.activation_return_weeks ENABLE ALWAYS TRIGGER activation_return_weeks_no_change;--> statement-breakpoint
ALTER TABLE public.activation_return_weeks ENABLE ALWAYS TRIGGER activation_return_weeks_no_truncate;--> statement-breakpoint
REVOKE ALL ON TABLE public.activation_return_weeks FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_privacy_runtime, polaris_outbox_runtime, polaris_auth_runtime;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO polaris_activation_owner;--> statement-breakpoint
-- the week already frozen is skipped, a second sweep at the same time inserts nothing (ON CONFLICT), and what was
-- written is answered (RETURNING)
GRANT SELECT (cohort_week, returned, never_returned) ON TABLE public.activation_return_weeks TO polaris_activation_owner;--> statement-breakpoint
GRANT INSERT (cohort_week, returned, never_returned) ON TABLE public.activation_return_weeks TO polaris_activation_owner;--> statement-breakpoint
GRANT SELECT (user_id, created_at, updated_at) ON TABLE public.session TO polaris_activation_owner;--> statement-breakpoint
-- the stores of the cohorts it can still freeze (the oldest week started 31 days back), with a margin
GRANT SELECT (id, status, created_at) ON TABLE public.organizations TO polaris_activation_owner;--> statement-breakpoint
CREATE POLICY organizations_activation_owner_select_recent ON public.organizations
  AS PERMISSIVE FOR SELECT TO polaris_activation_owner
  USING (created_at > pg_catalog.now() - interval '42 days');--> statement-breakpoint
GRANT SELECT (organization_id, user_id, role, status, created_at) ON TABLE public.memberships TO polaris_activation_owner;--> statement-breakpoint
CREATE POLICY memberships_activation_owner_select_owner ON public.memberships
  AS PERMISSIVE FOR SELECT TO polaris_activation_owner
  USING (role = 'owner' AND status = 'active');--> statement-breakpoint
GRANT SELECT (organization_id, confirmed_at) ON TABLE public.sales TO polaris_activation_owner;--> statement-breakpoint
CREATE POLICY sales_activation_owner_select_recent ON public.sales
  AS PERMISSIVE FOR SELECT TO polaris_activation_owner
  USING (EXISTS (SELECT 1 FROM public.organizations AS o WHERE o.id = sales.organization_id));--> statement-breakpoint
GRANT SELECT (organization_id, state, trial_started_at) ON TABLE public.organization_billing TO polaris_activation_owner;--> statement-breakpoint
CREATE POLICY organization_billing_activation_owner_select_recent ON public.organization_billing
  AS PERMISSIVE FOR SELECT TO polaris_activation_owner
  USING (EXISTS (SELECT 1 FROM public.organizations AS o WHERE o.id = organization_billing.organization_id));--> statement-breakpoint
GRANT SELECT (organization_id) ON TABLE public.platform_internal_organizations TO polaris_activation_owner;--> statement-breakpoint
CREATE POLICY platform_internal_organizations_activation_owner_select_recent ON public.platform_internal_organizations
  AS PERMISSIVE FOR SELECT TO polaris_activation_owner
  USING (EXISTS (SELECT 1 FROM public.organizations AS o WHERE o.id = platform_internal_organizations.organization_id));--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO polaris_activation_owner;--> statement-breakpoint
GRANT polaris_activation_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
SET ROLE polaris_activation_owner;--> statement-breakpoint
-- Freezes the cohort weeks that are due and answers what it wrote, oldest first (ADR 0106, D9). A week is due from its
-- start plus 21 days (each store of it then had its 14 days; earlier would undercount "came back") to its start plus 31
-- days: a session that proves a return was alive when touched, on the day after the store's or later, and an expired
-- session is kept 30 days after `expires_at` (ADR 0079), so its trace is still there. Each week gets 10 days of hourly
-- tries.
--
-- Who is counted (the population of the series, D9): a store of the week, not purged, not internal, with no sale
-- confirmed up to 14 days of 24 hours after its creation (as the funnel measures it, whatever the caller's zone); its
-- oldest active owner, and only if it is that person's first store (the oldest active owner's membership of theirs, as
-- the series has it); no billing relation (a trial, used or waived, or any state but free). "Came back": a session of
-- that person created or touched on a day of São Paulo after the day the store was created and up to 14 days after it.
-- A session lives only while signed in and its `updated_at` moves once a day at most, so this is a floor of "came back"
-- (D9).
--
-- Suppression, k = 5: both cells or neither. Each cell holds k stores or more, and so do the stores that did not sell in
-- 14 days but are left out of the measure (second stores, trial or Pro, no active owner): the funnel shows the stores of
-- the week and those that sold within 14 days, so its difference with the measure is a set of stores too.
CREATE FUNCTION public.activation_return_freeze()
RETURNS TABLE (week_start date, returned_stores integer, never_returned_stores integer)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  k constant integer := 5;
  local_now timestamp := pg_catalog.now() AT TIME ZONE 'America/Sao_Paulo';
  current_week timestamp := pg_catalog.date_trunc('week', pg_catalog.now() AT TIME ZONE 'America/Sao_Paulo');
BEGIN
  RETURN QUERY
  WITH due AS (
    SELECT week.start
      FROM pg_catalog.generate_series(current_week - interval '35 days', current_week, interval '7 days') AS week(start)
     WHERE week.start + interval '21 days' <= local_now
       AND week.start + interval '31 days' > local_now
       AND NOT EXISTS (
         SELECT 1 FROM public.activation_return_weeks AS frozen WHERE frozen.cohort_week = week.start::date
       )
  ),
  unsold AS (
    SELECT due.start, store.id, (store.created_at AT TIME ZONE 'America/Sao_Paulo')::date AS created_day
      FROM due
      JOIN public.organizations AS store
        ON store.created_at >= (due.start AT TIME ZONE 'America/Sao_Paulo')
       AND store.created_at < ((due.start + interval '7 days') AT TIME ZONE 'America/Sao_Paulo')
     WHERE store.status <> 'purged'
       AND NOT EXISTS (
         SELECT 1 FROM public.platform_internal_organizations AS internal WHERE internal.organization_id = store.id
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.sales AS sale
          WHERE sale.organization_id = store.id AND sale.confirmed_at - store.created_at <= interval '14 days'
       )
  ),
  measured AS (
    SELECT unsold.start, founder.user_id, unsold.created_day
      FROM unsold
      CROSS JOIN LATERAL (
        SELECT membership.user_id, membership.created_at
          FROM public.memberships AS membership
         WHERE membership.organization_id = unsold.id AND membership.role = 'owner' AND membership.status = 'active'
         ORDER BY membership.created_at, membership.user_id
         LIMIT 1
      ) AS founder
     WHERE NOT EXISTS (
         SELECT 1 FROM public.memberships AS earlier
          WHERE earlier.user_id = founder.user_id AND earlier.organization_id <> unsold.id
            AND earlier.role = 'owner' AND earlier.status = 'active'
            AND (earlier.created_at, earlier.organization_id) < (founder.created_at, unsold.id)
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.organization_billing AS billing
          WHERE billing.organization_id = unsold.id
            AND (billing.trial_started_at IS NOT NULL OR billing.state <> 'free')
       )
  ),
  marked AS (
    SELECT measured.start,
           EXISTS (
             SELECT 1 FROM public.session AS signed_in
              WHERE signed_in.user_id = measured.user_id
                AND (((signed_in.updated_at AT TIME ZONE 'America/Sao_Paulo')::date > measured.created_day
                      AND (signed_in.updated_at AT TIME ZONE 'America/Sao_Paulo')::date <= measured.created_day + 14)
                  OR ((signed_in.created_at AT TIME ZONE 'America/Sao_Paulo')::date > measured.created_day
                      AND (signed_in.created_at AT TIME ZONE 'America/Sao_Paulo')::date <= measured.created_day + 14))
           ) AS came_back
      FROM measured
  ),
  tallies AS (
    SELECT due.start,
           (SELECT pg_catalog.count(*) FROM unsold WHERE unsold.start = due.start) AS unsold_count,
           (SELECT pg_catalog.count(*) FROM marked WHERE marked.start = due.start) AS measured_count,
           (SELECT pg_catalog.count(*) FROM marked WHERE marked.start = due.start AND marked.came_back) AS back_count
      FROM due
  ),
  frozen AS (
    INSERT INTO public.activation_return_weeks AS target (cohort_week, returned, never_returned)
    SELECT tally.start::date,
           CASE WHEN tally.shown THEN tally.back_count::integer END,
           CASE WHEN tally.shown THEN (tally.measured_count - tally.back_count)::integer END
      FROM (
        SELECT t.*,
               t.back_count >= k AND t.measured_count - t.back_count >= k
                 AND t.unsold_count - t.measured_count >= k AS shown
          FROM tallies AS t
      ) AS tally
    ON CONFLICT (cohort_week) DO NOTHING
    RETURNING target.cohort_week, target.returned, target.never_returned
  )
  SELECT frozen.cohort_week, frozen.returned, frozen.never_returned FROM frozen ORDER BY frozen.cohort_week;
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.activation_return_freeze() FROM PUBLIC, polaris_pr11_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_privacy_runtime, polaris_outbox_runtime, polaris_auth_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.activation_return_freeze() TO polaris_billing_runtime;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_activation_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_activation_owner;--> statement-breakpoint
-- The end state (a REVOKE or an ALTER without the right is only a WARNING on Neon): the owner of the measure holds
-- exactly the columns above and nothing else (no table privilege, no write but its INSERT, no CREATE), its only policy on
-- `session` is its own and is the only new one there, it owns only its function, which only the billing role executes;
-- no role, the migrator included, keeps SET or INHERIT on it; and of the `polaris_*` groups and owners, only it reaches
-- the new table.
DO $end_state$
DECLARE
  held text[];
BEGIN
  SELECT COALESCE(pg_catalog.array_agg(p.entry ORDER BY p.entry COLLATE "C"), '{}')
    INTO held
    FROM (SELECT c.table_name || '.' || c.column_name || ':' || c.privilege_type AS entry
            FROM information_schema.column_privileges AS c
           WHERE c.grantee = 'polaris_activation_owner') AS p;
  IF held IS DISTINCT FROM ARRAY(SELECT e FROM unnest(ARRAY[
    'activation_return_weeks.cohort_week:INSERT', 'activation_return_weeks.cohort_week:SELECT',
    'activation_return_weeks.never_returned:INSERT', 'activation_return_weeks.never_returned:SELECT',
    'activation_return_weeks.returned:INSERT', 'activation_return_weeks.returned:SELECT',
    'memberships.created_at:SELECT', 'memberships.organization_id:SELECT', 'memberships.role:SELECT',
    'memberships.status:SELECT', 'memberships.user_id:SELECT', 'organization_billing.organization_id:SELECT',
    'organization_billing.state:SELECT', 'organization_billing.trial_started_at:SELECT',
    'organizations.created_at:SELECT', 'organizations.id:SELECT', 'organizations.status:SELECT',
    'platform_internal_organizations.organization_id:SELECT', 'sales.confirmed_at:SELECT',
    'sales.organization_id:SELECT', 'session.created_at:SELECT', 'session.updated_at:SELECT', 'session.user_id:SELECT'
  ]::text[]) AS e ORDER BY e COLLATE "C") THEN
    RAISE EXCEPTION 'the owner of the measure does not hold exactly its columns: %', held;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.table_privileges AS t WHERE t.grantee = 'polaris_activation_owner')
     OR pg_catalog.has_schema_privilege('polaris_activation_owner', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'the owner of the measure holds more than columns';
  END IF;
  IF ARRAY(SELECT p.policyname::text FROM pg_catalog.pg_policies AS p
            WHERE 'polaris_activation_owner' = ANY (p.roles) ORDER BY p.tablename COLLATE "C", p.policyname COLLATE "C")
     IS DISTINCT FROM ARRAY[
       'activation_return_weeks_owner_insert', 'activation_return_weeks_owner_select',
       'memberships_activation_owner_select_owner', 'organization_billing_activation_owner_select_recent',
       'organizations_activation_owner_select_recent', 'platform_internal_organizations_activation_owner_select_recent',
       'sales_activation_owner_select_recent', 'session_activation_owner_select'
     ]::text[] THEN
    RAISE EXCEPTION 'the owner of the measure does not have exactly its policies';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc AS p
     WHERE p.proowner = 'polaris_activation_owner'::regrole
       AND p.oid <> 'public.activation_return_freeze()'::regprocedure
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc AS p
     WHERE p.oid = 'public.activation_return_freeze()'::regprocedure
       AND p.proowner = 'polaris_activation_owner'::regrole AND p.prosecdef
       AND p.proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp']
  ) THEN
    RAISE EXCEPTION 'the freezing function does not have its owner or its search_path, or the owner owns another';
  END IF;
  IF EXISTS (
    SELECT 1 FROM (
      SELECT 'public'::text AS role
      UNION ALL
      SELECT r.rolname::text FROM pg_catalog.pg_roles AS r
       WHERE r.rolname LIKE 'polaris\_%' AND NOT r.rolcanlogin
         AND r.rolname NOT IN ('polaris_billing_runtime', 'polaris_activation_owner')
    ) AS r
     WHERE pg_catalog.has_function_privilege(r.role, 'public.activation_return_freeze()', 'EXECUTE')
  ) OR NOT pg_catalog.has_function_privilege('polaris_billing_runtime', 'public.activation_return_freeze()', 'EXECUTE') THEN
    RAISE EXCEPTION 'the freezing function must be executed by the billing role only';
  END IF;
  IF EXISTS (
    SELECT 1 FROM (
      SELECT 'public'::text AS role
      UNION ALL
      SELECT r.rolname::text FROM pg_catalog.pg_roles AS r
       WHERE r.rolname LIKE 'polaris\_%' AND NOT r.rolcanlogin
         AND (r.rolname LIKE '%\_runtime' OR r.rolname LIKE '%\_owner' OR r.rolname LIKE '%\_reader')
         AND r.rolname <> 'polaris_activation_owner'
    ) AS r
     WHERE pg_catalog.has_any_column_privilege(r.role, 'public.activation_return_weeks', 'SELECT, INSERT, UPDATE, REFERENCES')
        OR pg_catalog.has_table_privilege(r.role, 'public.activation_return_weeks', 'DELETE, TRUNCATE, TRIGGER')
  ) THEN
    RAISE EXCEPTION 'another role reaches the frozen counts';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members AS m
     WHERE m.roleid = 'polaris_activation_owner'::regrole
       AND (m.set_option OR m.inherit_option)
  ) THEN
    RAISE EXCEPTION 'a role (the migrator included) can become or inherit polaris_activation_owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles
              WHERE rolname = 'polaris_activation_owner'
                AND (rolcanlogin OR rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication OR rolinherit)) THEN
    RAISE EXCEPTION 'polaris_activation_owner has an attribute it must not have';
  END IF;
END
$end_state$;--> statement-breakpoint
-- the migrator runs the pending migrations in one transaction: the timeout of this one stops here
RESET lock_timeout;
