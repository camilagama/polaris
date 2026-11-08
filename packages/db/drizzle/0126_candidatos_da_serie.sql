-- The activation series in the database (ADR 0106, D2 to D6 and D12): who gets which e-mail of the series, once, and
-- only inside its limits. Expand only (ADR 0096): one new table, one new function, new policies and column grants;
-- nothing existing is dropped, altered or recreated, and the previous Worker never touches any of it. Nothing here
-- sends an e-mail: the function only answers IDs, and the series stays off (D6).
--
-- * `activation_series_state`: one row, the instant the hourly sweep first found the switch of the series on, or null
--   while it finds it off. Only the billing role writes it. The function answers nothing while it is null, and every
--   step of a store created before it comes back as `series_off`, recorded skipped: a store made while the switch was
--   off never joins the series, and switching it on again does not resume the series of the stores of the earlier span.
-- * `activation_notice_candidates(p_now, p_limit)`, SECURITY DEFINER of `polaris_activation_notice_owner`, EXECUTE to
--   the billing role only: the steps owed now, at most `p_limit` (1 to 50) and whether more wait. `p_now` is the
--   caller's clock, which the day, the window and the triggers read; the role still sees only the stores of the last 14
--   days of the database's clock, and the billing role that passes it could record any notice by itself anyway.
-- * The stop rules of D3 that the database can tell are conditions of the same SELECT; the suppressed address (rule 7)
--   is the Worker's, which alone has the key of the HMAC. A store whose request about personal data is open stops the
--   series: `privacy_cases` reaches its store only through `support_cases`, so the owner of the series gets the two
--   columns of each that make that link, and only for the stores it already sees (D2, amended).
-- * The daily cap of 60 counts the notices recorded on the day of São Paulo and not skipped (owed, sent or failed): a
--   suppressed address is skipped by the Worker when it sends, and then stops counting. One sweep at a time takes the
--   cap: a lock held until the end of the caller's transaction, which records what it got in that same transaction
--   (READ COMMITTED); a sweep that finds the lock taken gets nothing and leaves the work to the one that holds it.
-- Each policy on an existing table takes a lock on a busy table: they are taken first, in one fixed order, and a lock
-- not had in 10 s fails the migration instead of queueing requests.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
LOCK TABLE public.support_cases, public.privacy_cases IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
CREATE TABLE "activation_series_state" (
	"enabled_since" timestamp with time zone,
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activation_series_state_single_row" CHECK ("activation_series_state"."id")
);
--> statement-breakpoint
ALTER TABLE "activation_series_state" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "activation_series_state_billing_runtime_select" ON "activation_series_state" AS PERMISSIVE FOR SELECT TO "polaris_billing_runtime" USING (true);--> statement-breakpoint
CREATE POLICY "activation_series_state_billing_runtime_insert" ON "activation_series_state" AS PERMISSIVE FOR INSERT TO "polaris_billing_runtime" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "activation_series_state_billing_runtime_update" ON "activation_series_state" AS PERMISSIVE FOR UPDATE TO "polaris_billing_runtime" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "activation_series_state_owner_select" ON "activation_series_state" AS PERMISSIVE FOR SELECT TO "polaris_activation_notice_owner" USING (true);--> statement-breakpoint
ALTER TABLE public.activation_series_state FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE public.activation_series_state FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_privacy_runtime, polaris_outbox_runtime, polaris_auth_runtime;--> statement-breakpoint
GRANT SELECT ON TABLE public.activation_series_state TO polaris_billing_runtime;--> statement-breakpoint
GRANT INSERT (enabled_since) ON TABLE public.activation_series_state TO polaris_billing_runtime;--> statement-breakpoint
GRANT UPDATE (enabled_since, updated_at) ON TABLE public.activation_series_state TO polaris_billing_runtime;--> statement-breakpoint
GRANT SELECT (enabled_since) ON TABLE public.activation_series_state TO polaris_activation_notice_owner;--> statement-breakpoint
-- the open request about personal data of a store the owner of the series already sees (rule 5)
GRANT SELECT (id, organization_id) ON TABLE public.support_cases TO polaris_activation_notice_owner;--> statement-breakpoint
CREATE POLICY support_cases_activation_notice_owner_select_recent ON public.support_cases
  AS PERMISSIVE FOR SELECT TO polaris_activation_notice_owner
  USING (EXISTS (SELECT 1 FROM public.organizations AS o WHERE o.id = support_cases.organization_id));--> statement-breakpoint
GRANT SELECT (support_case_id, resolved_at) ON TABLE public.privacy_cases TO polaris_activation_notice_owner;--> statement-breakpoint
CREATE POLICY privacy_cases_activation_notice_owner_select_recent ON public.privacy_cases
  AS PERMISSIVE FOR SELECT TO polaris_activation_notice_owner
  USING (EXISTS (SELECT 1 FROM public.support_cases AS s WHERE s.id = privacy_cases.support_case_id));--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO polaris_activation_notice_owner;--> statement-breakpoint
GRANT polaris_activation_notice_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
SET ROLE polaris_activation_notice_owner;--> statement-breakpoint
-- The steps owed at `p_now` (ADR 0106, D3 to D6), oldest trigger first. A person gets them only for the first store
-- where they are an active owner (the oldest such membership) and only as its oldest active owner; the store is active
-- (neither suspended, closing, closed nor in purge), younger than 14 days, never sold, never had a trial or Pro, is not
-- internal and has no open request about personal data; the person verified the e-mail and did not opt out. The states
-- are worked out here, never stored: S0 without a live product, S1 with one and no sale.
--   a1  24 hours after the store, still S0;
--   a2  3 days after the oldest live product (S1), or 4 days after the store, the 5th day, still S0;
--   a3  10 days after the store, once the a2 of the person went out.
-- Only between 08:00 and 12:00 of São Paulo, at most 60 recorded and not skipped a day of São Paulo, and only after the
-- switch is seen on. `outcome` says how the caller records each: `due` (owed), `expired` (3 days after the trigger
-- went by: recorded skipped) or `series_off` (a step of a store created before the switch went on: recorded
-- skipped); the last two do not count in the cap. `truncated` says that more were owed than this call returns, by the
-- batch or by the cap (with the cap reached and nothing but due steps, the answer is empty). Only IDs, a step and
-- instants.
CREATE FUNCTION public.activation_notice_candidates(p_now timestamptz, p_limit integer)
RETURNS TABLE (organization_id text, user_id text, step text, due_at timestamptz, outcome text, truncated boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  enabled timestamptz;
  local_now timestamp;
  counted integer;
BEGIN
  IF p_now IS NULL THEN
    RAISE EXCEPTION 'invalid_now' USING ERRCODE = '22023';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 50 THEN
    RAISE EXCEPTION 'invalid_limit' USING ERRCODE = '22023';
  END IF;
  -- one sweep at a time reads and spends the cap: the lock lasts until the caller has recorded what this returns, and
  -- a second sweep does not wait for it holding a connection of the billing role
  IF NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('activation_notice_candidates', 0)) THEN
    RETURN;
  END IF;
  SELECT state.enabled_since INTO enabled FROM public.activation_series_state AS state;
  IF enabled IS NULL OR enabled > p_now THEN
    RETURN;
  END IF;
  local_now := p_now AT TIME ZONE 'America/Sao_Paulo';
  IF pg_catalog.date_part('hour', local_now) < 8 OR pg_catalog.date_part('hour', local_now) >= 12 THEN
    RETURN;
  END IF;
  SELECT pg_catalog.count(*)::integer INTO counted
    FROM public.activation_notices AS notice
   WHERE notice.skipped_reason IS NULL
     AND notice.recorded_at >= (pg_catalog.date_trunc('day', local_now) AT TIME ZONE 'America/Sao_Paulo')
     AND notice.recorded_at < ((pg_catalog.date_trunc('day', local_now) + interval '1 day') AT TIME ZONE 'America/Sao_Paulo');
  RETURN QUERY
  WITH person AS (
    SELECT store.id AS organization_id, store.created_at, founder.user_id,
           (SELECT pg_catalog.min(product.created_at) FROM public.products AS product
             WHERE product.organization_id = store.id AND product.deleted_at IS NULL) AS first_product
      FROM public.organizations AS store
      CROSS JOIN LATERAL (
        SELECT membership.user_id, membership.created_at
          FROM public.memberships AS membership
         WHERE membership.organization_id = store.id AND membership.role = 'owner' AND membership.status = 'active'
         ORDER BY membership.created_at, membership.user_id
         LIMIT 1
      ) AS founder
     WHERE store.status = 'active'
       AND store.created_at > p_now - interval '14 days' AND store.created_at <= p_now
       AND NOT EXISTS (
         SELECT 1 FROM public.memberships AS earlier
          WHERE earlier.user_id = founder.user_id AND earlier.organization_id <> store.id
            AND earlier.role = 'owner' AND earlier.status = 'active'
            AND (earlier.created_at, earlier.organization_id) < (founder.created_at, store.id)
       )
       AND NOT EXISTS (SELECT 1 FROM public.sales AS sale WHERE sale.organization_id = store.id)
       AND NOT EXISTS (
         SELECT 1 FROM public.organization_billing AS billing
          WHERE billing.organization_id = store.id
            AND (billing.trial_started_at IS NOT NULL OR billing.state <> 'free')
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.platform_internal_organizations AS internal WHERE internal.organization_id = store.id
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.support_cases AS support_case
           JOIN public.privacy_cases AS privacy_case ON privacy_case.support_case_id = support_case.id
          WHERE support_case.organization_id = store.id AND privacy_case.resolved_at IS NULL
       )
       AND NOT EXISTS (SELECT 1 FROM public.email_opt_outs AS opt_out WHERE opt_out.user_id = founder.user_id)
       AND EXISTS (SELECT 1 FROM public."user" AS account WHERE account.id = founder.user_id AND account.email_verified)
  ),
  steps AS (
    SELECT p.organization_id, p.user_id, p.created_at, 'a1'::text AS step, p.created_at + interval '24 hours' AS due_at
      FROM person AS p
     WHERE p.first_product IS NULL
    UNION ALL
    SELECT p.organization_id, p.user_id, p.created_at, 'a2'::text,
           COALESCE(p.first_product + interval '3 days', p.created_at + interval '4 days')
      FROM person AS p
    UNION ALL
    SELECT p.organization_id, p.user_id, p.created_at, 'a3'::text, p.created_at + interval '10 days'
      FROM person AS p
     WHERE EXISTS (
       SELECT 1 FROM public.activation_notices AS sent
        WHERE sent.user_id = p.user_id AND sent.step = 'a2' AND sent.sent_at IS NOT NULL
     )
  ),
  owed AS (
    SELECT s.organization_id, s.user_id, s.created_at, s.step, s.due_at,
           CASE WHEN s.created_at < enabled THEN 'series_off'
                WHEN p_now >= s.due_at + interval '3 days' THEN 'expired'
                ELSE 'due' END AS outcome
      FROM steps AS s
     WHERE s.due_at <= p_now
       AND NOT EXISTS (
         SELECT 1 FROM public.activation_notices AS recorded
          WHERE recorded.user_id = s.user_id AND recorded.step = s.step
       )
  ),
  ranked AS (
    SELECT o.*,
           pg_catalog.count(*) OVER () AS owed_count,
           CASE WHEN o.outcome = 'due' THEN pg_catalog.row_number() OVER (
             PARTITION BY o.outcome ORDER BY o.due_at, o.created_at, o.organization_id, o.step
           ) END AS due_rank
      FROM owed AS o
  ),
  kept AS (
    SELECT r.*, pg_catalog.count(*) OVER () AS kept_count
      FROM ranked AS r
     WHERE r.outcome <> 'due' OR r.due_rank <= GREATEST(60 - counted, 0)
  )
  SELECT k.organization_id, k.user_id, k.step, k.due_at, k.outcome, k.owed_count > LEAST(k.kept_count, p_limit)
    FROM kept AS k
   ORDER BY k.due_at, k.created_at, k.organization_id, k.step
   LIMIT p_limit;
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.activation_notice_candidates(timestamptz, integer) FROM PUBLIC, polaris_pr11_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_privacy_runtime, polaris_outbox_runtime, polaris_auth_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.activation_notice_candidates(timestamptz, integer) TO polaris_billing_runtime;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_activation_notice_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_activation_notice_owner;--> statement-breakpoint
-- The end state (a REVOKE or an ALTER without the right is only a WARNING on Neon): the owner of the series holds
-- exactly the columns of 0124 and the five above, still no table privilege, write or CREATE, and owns only its
-- function; only the billing role executes it; the migrator keeps no SET or INHERIT on the owner; and of the
-- `polaris_*` groups and owners, only the billing role and the owner of the series reach the new table.
DO $end_state$
DECLARE
  held text[];
BEGIN
  SELECT COALESCE(pg_catalog.array_agg(p.entry ORDER BY p.entry COLLATE "C"), '{}')
    INTO held
    FROM (SELECT c.table_name || '.' || c.column_name || ':' || c.privilege_type AS entry
            FROM information_schema.column_privileges AS c
           WHERE c.grantee = 'polaris_activation_notice_owner') AS p;
  IF held IS DISTINCT FROM ARRAY(SELECT e FROM unnest(ARRAY[
    'activation_notices.due_at:SELECT', 'activation_notices.failed_at:SELECT', 'activation_notices.id:SELECT',
    'activation_notices.organization_id:SELECT', 'activation_notices.recorded_at:SELECT',
    'activation_notices.sent_at:SELECT', 'activation_notices.skipped_reason:SELECT', 'activation_notices.step:SELECT',
    'activation_notices.user_id:SELECT', 'activation_series_state.enabled_since:SELECT', 'email_opt_outs.user_id:SELECT',
    'memberships.created_at:SELECT', 'memberships.organization_id:SELECT', 'memberships.role:SELECT',
    'memberships.status:SELECT', 'memberships.user_id:SELECT', 'organization_billing.organization_id:SELECT',
    'organization_billing.state:SELECT', 'organization_billing.trial_started_at:SELECT',
    'organizations.created_at:SELECT', 'organizations.id:SELECT', 'organizations.status:SELECT',
    'platform_internal_organizations.organization_id:SELECT', 'privacy_cases.resolved_at:SELECT',
    'privacy_cases.support_case_id:SELECT', 'products.created_at:SELECT', 'products.deleted_at:SELECT',
    'products.organization_id:SELECT', 'sales.confirmed_at:SELECT', 'sales.organization_id:SELECT',
    'support_cases.id:SELECT', 'support_cases.organization_id:SELECT', 'user.email_verified:SELECT', 'user.id:SELECT'
  ]::text[]) AS e ORDER BY e COLLATE "C") THEN
    RAISE EXCEPTION 'the owner of the series does not hold exactly its columns: %', held;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.table_privileges AS t WHERE t.grantee = 'polaris_activation_notice_owner')
     OR pg_catalog.has_column_privilege('polaris_activation_notice_owner', 'public."user"', 'email', 'SELECT')
     OR pg_catalog.has_any_column_privilege('polaris_activation_notice_owner', 'public.session', 'SELECT')
     OR pg_catalog.has_schema_privilege('polaris_activation_notice_owner', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'the owner of the series reads the session or the address, or holds more than columns';
  END IF;
  IF (SELECT pg_catalog.array_agg(p.oid::regprocedure::text) FROM pg_catalog.pg_proc AS p
       WHERE p.proowner = 'polaris_activation_notice_owner'::regrole)
     IS DISTINCT FROM ARRAY['activation_notice_candidates(timestamp with time zone,integer)'] THEN
    RAISE EXCEPTION 'the owner of the series does not own exactly its function';
  END IF;
  IF pg_catalog.has_function_privilege('public', 'public.activation_notice_candidates(timestamptz, integer)', 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('polaris_billing_runtime', 'public.activation_notice_candidates(timestamptz, integer)', 'EXECUTE')
     OR EXISTS (
       SELECT 1 FROM pg_catalog.pg_roles AS r
        WHERE r.rolname LIKE 'polaris\_%' AND NOT r.rolcanlogin
          AND r.rolname NOT IN ('polaris_billing_runtime', 'polaris_activation_notice_owner')
          AND pg_catalog.has_function_privilege(r.oid, 'public.activation_notice_candidates(timestamptz, integer)', 'EXECUTE')
     ) THEN
    RAISE EXCEPTION 'the candidates function does not have its one executor';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members AS m
     WHERE m.member = (SELECT r.oid FROM pg_catalog.pg_roles AS r WHERE r.rolname = CURRENT_USER)
       AND m.roleid = 'polaris_activation_notice_owner'::regrole
       AND (m.set_option OR m.inherit_option)
  ) THEN
    RAISE EXCEPTION 'the migrator kept SET or INHERIT on the owner of the series';
  END IF;
  IF EXISTS (
    SELECT 1 FROM (
       SELECT 'public'::text AS role
       UNION ALL
       SELECT r.rolname::text FROM pg_catalog.pg_roles AS r
        WHERE r.rolname LIKE 'polaris\_%' AND NOT r.rolcanlogin
          AND (r.rolname LIKE '%\_runtime' OR r.rolname LIKE '%\_owner' OR r.rolname LIKE '%\_reader')
          AND r.rolname NOT IN ('polaris_billing_runtime', 'polaris_activation_notice_owner')
     ) AS r
     WHERE pg_catalog.has_any_column_privilege(r.role, 'public.activation_series_state', 'SELECT, INSERT, UPDATE, REFERENCES')
        OR pg_catalog.has_table_privilege(r.role, 'public.activation_series_state', 'DELETE, TRUNCATE, TRIGGER')
  ) THEN
    RAISE EXCEPTION 'a tenant or another role reaches the state of the series';
  END IF;
END
$end_state$;--> statement-breakpoint
-- the migrator runs the pending migrations in one transaction: the timeout of this one stops here
RESET lock_timeout;
