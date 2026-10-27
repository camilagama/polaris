-- The activation funnel of the stores, the database part (corte 2.4, PR A; ADR 0071 amended): a marker of the stores
-- of Polaris itself, the audited command that sets it, and one aggregate function the Admin reads. Expand only (ADR
-- 0096): a new table, new column grants, three new policies, a wider check of the platform audit and two new functions;
-- nothing is dropped, renamed or made NOT NULL, and no function the previous Worker calls is recreated.
--
-- * `platform_internal_organizations`: a store marked as internal (QA, the owner's, the team's) is kept out of every
--   number of the funnel. A table of the platform, not a column of `organizations` (the tenant reads and inserts rows
--   there: a column would need its own proof that a store never sees nor sets it) and never the `qa-` prefix of the
--   name (typed by the customer). Forced row security; only the Admin owner
--   reads, inserts and deletes it, and nobody else holds a grant. No personal data; it lives and dies with the row of
--   the organization (cascade).
-- * `admin_classify_organization`: marks or unmarks a store (capability `organization:classify`), audited in the same
--   transaction (`organization.marked_internal` / `organization.unmarked_internal`); a call that changes nothing
--   writes nothing.
-- * `admin_activation_funnel(p_weeks)`: weekly cohorts (ISO week of Brasília) of the stores created in the last
--   `p_weeks` weeks (1 to 26, nothing else to choose), and the verified sign-ups of the same weeks apart. Only counts,
--   each one shown only when it and every cell it could be told apart from hold at least 5 stores (k = 5, Rodrigo's
--   conditions on the amendment): anything else is `suppressed`, and what cannot be known yet is `unavailable` with a
--   reason, never 0. STABLE: it writes nothing, and nothing is stored. To compute it the Admin owner gains a read of
--   date and link columns only: `"user"` (id, created_at, email_verified; never the e-mail, the name or the image)
--   and `sales` (organization_id, confirmed_at; never an amount, an item or the date of the business).
-- CREATE POLICY on `sales` and `"user"` takes an ACCESS EXCLUSIVE lock on two busy tables: better to fail and deploy
-- again than to queue every sale and every `/get-session` behind it.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE "platform_internal_organizations" (
	"marked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"marked_by" uuid,
	"organization_id" text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
ALTER TABLE "platform_internal_organizations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "platform_audit_events" DROP CONSTRAINT "platform_audit_events_type_allowed";--> statement-breakpoint
ALTER TABLE "platform_internal_organizations" ADD CONSTRAINT "platform_internal_organizations_marked_by_platform_principals_id_fk" FOREIGN KEY ("marked_by") REFERENCES "public"."platform_principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_internal_organizations" ADD CONSTRAINT "platform_internal_organizations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_audit_events" ADD CONSTRAINT "platform_audit_events_type_allowed" CHECK ("platform_audit_events"."event_type" IN ('support_case.opened', 'support_case.closed', 'tenant_access.granted', 'tenant_access.revoked', 'tenant_data.customers_read', 'pii.revealed', 'organization.suspended', 'organization.reactivated', 'billing.entitlement_grant_requested', 'billing.entitlement_granted', 'billing.entitlement_revoke_requested', 'billing.entitlement_revoked', 'privacy_case.stage_recorded', 'privacy_case.action_recorded', 'operational_incident.retry', 'organization.purge_scheduled', 'organization.purge_cancelled', 'organization.purge_completed', 'organization.legal_hold_placed', 'organization.legal_hold_released', 'organization.legal_hold_reviewed', 'access_log.read', 'closure_notice.reissued', 'closure_notice.dismissed', 'billing.refund_window_read', 'organization.marked_internal', 'organization.unmarked_internal'));--> statement-breakpoint
CREATE POLICY "platform_internal_organizations_admin_owner_select" ON "platform_internal_organizations" AS PERMISSIVE FOR SELECT TO "polaris_admin_owner" USING (true);--> statement-breakpoint
CREATE POLICY "platform_internal_organizations_admin_owner_insert" ON "platform_internal_organizations" AS PERMISSIVE FOR INSERT TO "polaris_admin_owner" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "platform_internal_organizations_admin_owner_delete" ON "platform_internal_organizations" AS PERMISSIVE FOR DELETE TO "polaris_admin_owner" USING (true);--> statement-breakpoint
-- the marker: forced row security, no grant but the Admin owner's
ALTER TABLE public.platform_internal_organizations FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE public.platform_internal_organizations FROM PUBLIC, polaris_pr11_runtime;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON TABLE public.platform_internal_organizations TO polaris_admin_owner;--> statement-breakpoint
-- the columns the funnel reads, and only those: dates and links, never a name, an e-mail, an amount or an item
GRANT SELECT (id, created_at, email_verified) ON TABLE public."user" TO polaris_admin_owner;--> statement-breakpoint
CREATE POLICY user_admin_owner_select ON public."user"
  AS PERMISSIVE FOR SELECT TO polaris_admin_owner USING (true);--> statement-breakpoint
GRANT SELECT (organization_id, confirmed_at) ON TABLE public.sales TO polaris_admin_owner;--> statement-breakpoint
CREATE POLICY sales_admin_owner_select ON public.sales
  AS PERMISSIVE FOR SELECT TO polaris_admin_owner USING (true);--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO polaris_admin_owner;--> statement-breakpoint
GRANT polaris_admin_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
SET ROLE polaris_admin_owner;--> statement-breakpoint
-- Marks (p_internal true) or unmarks a store as one of Polaris itself, for an active operator. No case: the store is
-- the platform's own, and nothing of the tenant is read or changed. Audited in the same transaction only when the
-- marker changed; the answer says whether it did.
CREATE FUNCTION public.admin_classify_organization(p_principal uuid, p_organization text, p_internal boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  changed_rows integer;
BEGIN
  PERFORM public.admin_require_principal(p_principal);
  IF p_internal IS NULL THEN
    RAISE EXCEPTION 'invalid_classification' USING ERRCODE = '22023';
  END IF;
  IF p_organization IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.organizations AS organization WHERE organization.id = p_organization
  ) THEN
    RAISE EXCEPTION 'unknown_organization' USING ERRCODE = '22023';
  END IF;
  IF p_internal THEN
    INSERT INTO public.platform_internal_organizations (organization_id, marked_by)
    VALUES (p_organization, p_principal)
    ON CONFLICT (organization_id) DO NOTHING;
  ELSE
    DELETE FROM public.platform_internal_organizations AS internal
     WHERE internal.organization_id = p_organization;
  END IF;
  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  IF changed_rows > 0 THEN
    PERFORM public.admin_record_audit(
      p_principal,
      CASE WHEN p_internal THEN 'organization.marked_internal' ELSE 'organization.unmarked_internal' END,
      p_organization, NULL, 'organization', p_organization, NULL
    );
  END IF;
  RETURN pg_catalog.jsonb_build_object('changed', changed_rows > 0, 'internal', p_internal);
END;
$function$;--> statement-breakpoint
-- The activation funnel (corte 2.4, ADR 0071 amended): aggregate counts by weekly cohort, with no store, no person,
-- no amount and no individual date. The only choice is how many weeks back (1 to 26), so no window can be moved to
-- isolate a store by difference; it is computed at each call and stored nowhere.
--
-- * Weeks: ISO (Monday to Sunday) in America/Sao_Paulo for every store; the current week is `inProgress`.
-- * Sign-ups (F1, apart from the cohorts): verified accounts still existing, created in the week, and of these how
--   many are a member of a store today. Internal accounts are in it (they have no marker).
-- * Cohort of stores: created in the week (`organizations.created_at`), neither purged nor internal. Of these: with a
--   product (deleted ones count: the store got there; a store with a sale got there too), with a first sale
--   (`sales.confirmed_at`, the server's clock, never the date of the business; a cancelled sale counts), without a
--   sale yet, the time from the creation to the first sale in five bands (up to 10 minutes, 1 hour, 1 day, 7 days,
--   later), activated in 7 days (the first four bands), and retention: a sale confirmed in week 2, 3 or 5 of the store
--   (week 1 is the week of its creation), only once that week is closed.
-- * Suppression, k = 5: the cohort is cut into disjoint cells (no product; product and no sale; each band), and the
--   finest of a fixed list of coarser cuts whose cells all hold k stores or more is the one shown; every count shown
--   is a union of its cells, so neither it, nor its complement, nor the difference of two of them is under k (a
--   hidden cell cannot be found by a sum, and 0 or the whole cohort never shows). Retention of week N shows only
--   when it and the stores with a sale but none in that week both hold k or more. The stores of a cohort show when
--   they are k or more, the sign-ups likewise. A cell hidden by any of these is `suppressed`, with no value and no
--   reason (a reason would tell which side was small).
-- * Unavailable, never 0: the bands and the activation until every store of the cohort has had its 7 days
--   (`activation_window_open`); a week of retention not yet closed (`week_not_closed`).
CREATE FUNCTION public.admin_activation_funnel(p_weeks integer)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  k constant integer := 5;
  local_now timestamp := pg_catalog.now() AT TIME ZONE 'America/Sao_Paulo';
  current_week timestamp := pg_catalog.date_trunc('week', pg_catalog.now() AT TIME ZONE 'America/Sao_Paulo');
  first_week timestamp;
  suppressed constant jsonb := '{"state": "suppressed"}'::jsonb;
BEGIN
  IF p_weeks IS NULL OR p_weeks < 1 OR p_weeks > 26 THEN
    RAISE EXCEPTION 'invalid_weeks' USING ERRCODE = '22023';
  END IF;
  first_week := current_week - (p_weeks - 1) * interval '7 days';
  RETURN (
    WITH weeks AS (
      SELECT week.start
        FROM pg_catalog.generate_series(first_week, current_week, interval '7 days') AS week(start)
    ),
    stores AS (
      SELECT organization.id, organization.created_at,
             pg_catalog.date_trunc('week', organization.created_at AT TIME ZONE 'America/Sao_Paulo') AS cohort,
             EXISTS (
               SELECT 1 FROM public.platform_internal_organizations AS internal
                WHERE internal.organization_id = organization.id
             ) AS internal
        FROM public.organizations AS organization
       WHERE organization.created_at >= (first_week AT TIME ZONE 'America/Sao_Paulo')
         AND organization.status <> 'purged'
    ),
    marks AS (
      SELECT store.cohort,
             first_sale.at - store.created_at AS to_first_sale,
             first_sale.at IS NOT NULL OR EXISTS (
               SELECT 1 FROM public.products AS product WHERE product.organization_id = store.id
             ) AS has_product,
             EXISTS (
               SELECT 1 FROM public.sales AS sale
                WHERE sale.organization_id = store.id
                  AND sale.confirmed_at >= ((store.cohort + interval '7 days') AT TIME ZONE 'America/Sao_Paulo')
                  AND sale.confirmed_at < ((store.cohort + interval '14 days') AT TIME ZONE 'America/Sao_Paulo')
             ) AS sold_week_2,
             EXISTS (
               SELECT 1 FROM public.sales AS sale
                WHERE sale.organization_id = store.id
                  AND sale.confirmed_at >= ((store.cohort + interval '14 days') AT TIME ZONE 'America/Sao_Paulo')
                  AND sale.confirmed_at < ((store.cohort + interval '21 days') AT TIME ZONE 'America/Sao_Paulo')
             ) AS sold_week_3,
             EXISTS (
               SELECT 1 FROM public.sales AS sale
                WHERE sale.organization_id = store.id
                  AND sale.confirmed_at >= ((store.cohort + interval '28 days') AT TIME ZONE 'America/Sao_Paulo')
                  AND sale.confirmed_at < ((store.cohort + interval '35 days') AT TIME ZONE 'America/Sao_Paulo')
             ) AS sold_week_5
        FROM stores AS store
        LEFT JOIN LATERAL (
          SELECT pg_catalog.min(sale.confirmed_at) AS at
            FROM public.sales AS sale
           WHERE sale.organization_id = store.id
        ) AS first_sale ON true
       WHERE NOT store.internal
    ),
    tallies AS (
      SELECT weeks.start,
             pg_catalog.count(marks.cohort) AS n,
             pg_catalog.count(*) FILTER (WHERE NOT marks.has_product) AS p0,
             pg_catalog.count(*) FILTER (WHERE marks.has_product AND marks.to_first_sale IS NULL) AS p1,
             pg_catalog.count(*) FILTER (WHERE marks.to_first_sale IS NOT NULL) AS b,
             pg_catalog.count(*) FILTER (WHERE marks.to_first_sale <= interval '10 minutes') AS c1,
             pg_catalog.count(*) FILTER (
               WHERE marks.to_first_sale > interval '10 minutes' AND marks.to_first_sale <= interval '1 hour'
             ) AS c2,
             pg_catalog.count(*) FILTER (
               WHERE marks.to_first_sale > interval '1 hour' AND marks.to_first_sale <= interval '1 day'
             ) AS c3,
             pg_catalog.count(*) FILTER (
               WHERE marks.to_first_sale > interval '1 day' AND marks.to_first_sale <= interval '7 days'
             ) AS c4,
             pg_catalog.count(*) FILTER (WHERE marks.to_first_sale > interval '7 days') AS c5,
             pg_catalog.count(*) FILTER (WHERE marks.sold_week_2) AS r2,
             pg_catalog.count(*) FILTER (WHERE marks.sold_week_3) AS r3,
             pg_catalog.count(*) FILTER (WHERE marks.sold_week_5) AS r5,
             -- every store of the cohort was created before its end, so 7 days after the end each has had its 7
             weeks.start + interval '14 days' <= local_now AS window_closed,
             weeks.start + interval '14 days' <= current_week AS week_2_closed,
             weeks.start + interval '21 days' <= current_week AS week_3_closed,
             weeks.start + interval '35 days' <= current_week AS week_5_closed
        FROM weeks
        LEFT JOIN marks ON marks.cohort = weeks.start
       GROUP BY weeks.start
    ),
    tiered AS (
      SELECT tally.*,
             tally.c1 + tally.c2 + tally.c3 + tally.c4 AS a7,
             -- the finest cut whose cells all hold k stores or more: 1 every band; 2 activated and later; 3 product
             -- and sale; 4 activated and later without the product; 5 sale only; 6 product only; 7 nothing
             CASE
               WHEN tally.window_closed
                AND LEAST(tally.p0, tally.p1, tally.c1, tally.c2, tally.c3, tally.c4, tally.c5) >= k THEN 1
               WHEN tally.window_closed
                AND LEAST(tally.p0, tally.p1, tally.c1 + tally.c2 + tally.c3 + tally.c4, tally.c5) >= k THEN 2
               WHEN LEAST(tally.p0, tally.p1, tally.b) >= k THEN 3
               WHEN tally.window_closed
                AND LEAST(tally.p0 + tally.p1, tally.c1 + tally.c2 + tally.c3 + tally.c4, tally.c5) >= k THEN 4
               WHEN LEAST(tally.p0 + tally.p1, tally.b) >= k THEN 5
               WHEN LEAST(tally.p0, tally.p1 + tally.b) >= k THEN 6
               ELSE 7
             END AS tier
        FROM tallies AS tally
    ),
    cohorts AS (
      SELECT tally_row.start,
             pg_catalog.jsonb_build_object(
               'week', pg_catalog.to_char(tally_row.start, 'IYYY-"W"IW'),
               'weekStart', pg_catalog.to_char(tally_row.start, 'YYYY-MM-DD'),
               'inProgress', tally_row.start = current_week,
               'stores', CASE WHEN tally_row.n >= k
                 THEN pg_catalog.jsonb_build_object('state', 'shown', 'value', tally_row.n) ELSE suppressed END,
               'withFirstProduct', CASE WHEN tally_row.tier IN (1, 2, 3, 6)
                 THEN pg_catalog.jsonb_build_object('state', 'shown', 'value', tally_row.n - tally_row.p0) ELSE suppressed END,
               'withFirstSale', CASE WHEN tally_row.tier BETWEEN 1 AND 5
                 THEN pg_catalog.jsonb_build_object('state', 'shown', 'value', tally_row.b) ELSE suppressed END,
               'withoutSale', CASE WHEN tally_row.tier BETWEEN 1 AND 5
                 THEN pg_catalog.jsonb_build_object('state', 'shown', 'value', tally_row.p0 + tally_row.p1) ELSE suppressed END,
               'activatedIn7Days', CASE
                 WHEN NOT tally_row.window_closed
                   THEN '{"state": "unavailable", "reason": "activation_window_open"}'::jsonb
                 WHEN tally_row.tier IN (1, 2, 4)
                   THEN pg_catalog.jsonb_build_object('state', 'shown', 'value', tally_row.a7)
                 ELSE suppressed END,
               'timeToFirstSale', CASE
                 WHEN NOT tally_row.window_closed THEN pg_catalog.jsonb_build_object(
                   'upTo10Minutes', '{"state": "unavailable", "reason": "activation_window_open"}'::jsonb,
                   'upTo1Hour', '{"state": "unavailable", "reason": "activation_window_open"}'::jsonb,
                   'upTo1Day', '{"state": "unavailable", "reason": "activation_window_open"}'::jsonb,
                   'upTo7Days', '{"state": "unavailable", "reason": "activation_window_open"}'::jsonb,
                   'after7Days', '{"state": "unavailable", "reason": "activation_window_open"}'::jsonb
                 )
                 WHEN tally_row.tier = 1 THEN pg_catalog.jsonb_build_object(
                   'upTo10Minutes', pg_catalog.jsonb_build_object('state', 'shown', 'value', tally_row.c1),
                   'upTo1Hour', pg_catalog.jsonb_build_object('state', 'shown', 'value', tally_row.c2),
                   'upTo1Day', pg_catalog.jsonb_build_object('state', 'shown', 'value', tally_row.c3),
                   'upTo7Days', pg_catalog.jsonb_build_object('state', 'shown', 'value', tally_row.c4),
                   'after7Days', pg_catalog.jsonb_build_object('state', 'shown', 'value', tally_row.c5)
                 )
                 ELSE pg_catalog.jsonb_build_object(
                   'upTo10Minutes', suppressed,
                   'upTo1Hour', suppressed,
                   'upTo1Day', suppressed,
                   'upTo7Days', suppressed,
                   'after7Days', suppressed
                 )
               END,
               'retention', pg_catalog.jsonb_build_object(
                 'week2', CASE
                   WHEN NOT tally_row.week_2_closed THEN '{"state": "unavailable", "reason": "week_not_closed"}'::jsonb
                   WHEN tally_row.r2 >= k AND tally_row.b - tally_row.r2 >= k
                     THEN pg_catalog.jsonb_build_object('state', 'shown', 'value', tally_row.r2)
                   ELSE suppressed END,
                 'week3', CASE
                   WHEN NOT tally_row.week_3_closed THEN '{"state": "unavailable", "reason": "week_not_closed"}'::jsonb
                   WHEN tally_row.r3 >= k AND tally_row.b - tally_row.r3 >= k
                     THEN pg_catalog.jsonb_build_object('state', 'shown', 'value', tally_row.r3)
                   ELSE suppressed END,
                 'week5', CASE
                   WHEN NOT tally_row.week_5_closed THEN '{"state": "unavailable", "reason": "week_not_closed"}'::jsonb
                   WHEN tally_row.r5 >= k AND tally_row.b - tally_row.r5 >= k
                     THEN pg_catalog.jsonb_build_object('state', 'shown', 'value', tally_row.r5)
                   ELSE suppressed END
               )
             ) AS cohort
        FROM tiered AS tally_row
    ),
    accounts AS (
      SELECT pg_catalog.date_trunc('week', account.created_at AT TIME ZONE 'America/Sao_Paulo') AS week_start,
             EXISTS (
               SELECT 1 FROM public.memberships AS membership WHERE membership.user_id = account.id
             ) AS with_store
        FROM public."user" AS account
       WHERE account.email_verified
         AND account.created_at >= (first_week AT TIME ZONE 'America/Sao_Paulo')
    ),
    signups AS (
      SELECT weeks.start,
             pg_catalog.count(accounts.week_start) AS u,
             pg_catalog.count(*) FILTER (WHERE accounts.with_store) AS s
        FROM weeks
        LEFT JOIN accounts ON accounts.week_start = weeks.start
       GROUP BY weeks.start
    )
    SELECT pg_catalog.jsonb_build_object(
      'k', k,
      'weeks', p_weeks,
      'timezone', 'America/Sao_Paulo',
      'generatedAt', pg_catalog.now(),
      'internalStoresExcluded', (SELECT pg_catalog.count(*) FROM stores WHERE stores.internal),
      'signups', (
        SELECT pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'week', pg_catalog.to_char(signup.start, 'IYYY-"W"IW'),
            'weekStart', pg_catalog.to_char(signup.start, 'YYYY-MM-DD'),
            'inProgress', signup.start = current_week,
            'accounts', CASE WHEN signup.u >= k
              THEN pg_catalog.jsonb_build_object('state', 'shown', 'value', signup.u) ELSE suppressed END,
            'withStore', CASE WHEN signup.s >= k AND signup.u - signup.s >= k
              THEN pg_catalog.jsonb_build_object('state', 'shown', 'value', signup.s) ELSE suppressed END
          ) ORDER BY signup.start
        )
        FROM signups AS signup
      ),
      'cohorts', (SELECT pg_catalog.jsonb_agg(cohort.cohort ORDER BY cohort.start) FROM cohorts AS cohort)
    )
  );
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.admin_classify_organization(uuid, text, boolean) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_privacy_runtime, polaris_outbox_runtime, polaris_auth_runtime;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.admin_activation_funnel(integer) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_privacy_runtime, polaris_outbox_runtime, polaris_auth_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.admin_classify_organization(uuid, text, boolean) TO polaris_admin_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.admin_activation_funnel(integer) TO polaris_admin_runtime;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_admin_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_admin_owner;--> statement-breakpoint
-- The end state, as 0100 checks its own (a REVOKE or an ALTER without the right is only a WARNING on Neon): the two
-- functions belong to the Admin owner, it kept no CREATE on public, the migrator kept no SET or INHERIT on it, and the
-- marker has forced row security and no grant to anybody but the Admin owner.
DO $end_state$
BEGIN
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS p
       WHERE p.oid IN ('public.admin_classify_organization(uuid, text, boolean)'::regprocedure,
                       'public.admin_activation_funnel(integer)'::regprocedure)
         AND p.proowner = 'polaris_admin_owner'::regrole AND p.prosecdef) <> 2 THEN
    RAISE EXCEPTION 'the new functions do not have their owner';
  END IF;
  IF pg_catalog.has_schema_privilege('polaris_admin_owner', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'polaris_admin_owner kept CREATE on schema public';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members AS m
     WHERE m.member = (SELECT r.oid FROM pg_catalog.pg_roles AS r WHERE r.rolname = CURRENT_USER)
       AND m.roleid = 'polaris_admin_owner'::regrole
       AND (m.set_option OR m.inherit_option)
  ) THEN
    RAISE EXCEPTION 'the migrator kept SET or INHERIT on polaris_admin_owner';
  END IF;
  IF NOT (SELECT c.relrowsecurity AND c.relforcerowsecurity FROM pg_catalog.pg_class AS c
           WHERE c.oid = 'public.platform_internal_organizations'::regclass) THEN
    RAISE EXCEPTION 'platform_internal_organizations must have forced row security';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles AS r
     WHERE r.rolname LIKE 'polaris%' AND r.rolname <> 'polaris_admin_owner'
       AND (pg_catalog.has_table_privilege(r.oid, 'public.platform_internal_organizations', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
            OR pg_catalog.has_any_column_privilege(r.oid, 'public.platform_internal_organizations', 'SELECT,INSERT,UPDATE,REFERENCES'))
  ) THEN
    RAISE EXCEPTION 'a polaris role other than the Admin owner reaches platform_internal_organizations';
  END IF;
END
$end_state$;--> statement-breakpoint
-- the migrator runs the pending migrations in one transaction: the timeout of this one stops here
RESET lock_timeout;
