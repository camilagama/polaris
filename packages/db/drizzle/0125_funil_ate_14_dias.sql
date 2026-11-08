-- The activation funnel of the stores, now with the first sale "within 14 days" and the Pro trial (corte
-- ativacao-fase1, item 3b; ADR 0071 amended, ADR 0106). The same function, the same signature and the same grants as
-- 0105: `CREATE OR REPLACE` keeps its owner and its privileges (the search_path is restated because a replace without
-- it would clear it). No parameter, column, table, grant or function is added; `polaris_admin_owner` already reads
-- `organization_billing.trial_started_at` (0062), and the Admin runtime reaches the funnel only through the audited read.
-- Expand only (ADR 0096): the answer gains three keys in each cohort, and the Admin that parses them (strict, with the
-- three keys optional) is deployed before this migration. The Worker of the Admin before that one refuses the new
-- answer, so the Admin must not go back to a version older than the one that accepts the cells after this migration.
--
-- Three cells per cohort, all under k = 5 and written so that none is found by a sum or a difference:
-- * `activatedWithin14Days`: the stores whose first sale (`sales.confirmed_at`, the server's clock) came up to 14 days
--   after the creation. Its own window: while the start of the cohort plus 21 days is not past it is `unavailable`
--   (`activation_window_open`), never 0. The cell is the up-to-7-days activation plus the band of 8 to 14 days, and is
--   shown only when the cut of the 7-day cells is one that shows it and both that band and the sales after 14 days hold
--   k stores or more: the band is the difference with the activation of 7 days, the sales after 14 days are the
--   difference with the stores that sold, and both are sets of stores like any other. A store that sold in the second
--   week of its cohort had its first sale before 14 days, so the cell is also hidden when the retention of week 2 shows
--   and the stores of the cell that did not sell in that week are fewer than k.
-- * `trialStarted`: the stores with `trial_started_at` (written once, never cleared, also by a store that pays for Pro
--   with no trial: the record says that the trial was used or waived). Shown when it and the stores without it hold k
--   or more.
-- * `soldInTrial`: of those, the stores whose first sale came before `trial_started_at` plus the 7 days of the trial.
--   Shown when it, the trial stores that did not, the stores that sold and are not in it, and the trial and the
--   non-trial stores all hold k or more (it is a subset of each of the first three).
-- Internal and purged stores stay out, as in every number of the funnel.
GRANT CREATE ON SCHEMA public TO polaris_admin_owner;--> statement-breakpoint
GRANT polaris_admin_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
SET ROLE polaris_admin_owner;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.admin_activation_funnel(p_weeks integer)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  k constant integer := 5;
  trial_length constant interval := interval '7 days';
  local_now timestamp := pg_catalog.now() AT TIME ZONE 'America/Sao_Paulo';
  current_week timestamp := pg_catalog.date_trunc('week', pg_catalog.now() AT TIME ZONE 'America/Sao_Paulo');
  first_week timestamp;
  calc_first timestamp;
  suppressed constant jsonb := '{"state": "suppressed"}'::jsonb;
BEGIN
  IF p_weeks IS NULL OR p_weeks < 1 OR p_weeks > 26 THEN
    RAISE EXCEPTION 'invalid_weeks' USING ERRCODE = '22023';
  END IF;
  first_week := current_week - (p_weeks - 1) * interval '7 days';
  calc_first := first_week - interval '28 days';
  RETURN (
    WITH weeks AS (
      SELECT week.start
        FROM pg_catalog.generate_series(first_week, current_week, interval '7 days') AS week(start)
    ),
    -- the cohorts are computed 4 weeks before the first week asked for (the retention of week 5 reaches that far) and
    -- shown only from it: which retention cells are inside a week of the series then never depends on `p_weeks`
    calc_weeks AS (
      SELECT week.start
        FROM pg_catalog.generate_series(calc_first, current_week, interval '7 days') AS week(start)
    ),
    stores AS (
      SELECT organization.id, organization.created_at,
             pg_catalog.date_trunc('week', organization.created_at AT TIME ZONE 'America/Sao_Paulo') AS cohort,
             EXISTS (
               SELECT 1 FROM public.platform_internal_organizations AS internal
                WHERE internal.organization_id = organization.id
             ) AS internal
        FROM public.organizations AS organization
       WHERE organization.created_at >= (calc_first AT TIME ZONE 'America/Sao_Paulo')
         AND organization.status <> 'purged'
    ),
    marks AS (
      SELECT store.cohort,
             first_sale.at - store.created_at AS to_first_sale,
             billing.trial_started_at IS NOT NULL AS trial_started,
             COALESCE(first_sale.at < billing.trial_started_at + trial_length, false) AS sold_in_trial,
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
        LEFT JOIN public.organization_billing AS billing ON billing.organization_id = store.id
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
             pg_catalog.count(*) FILTER (
               WHERE marks.to_first_sale > interval '7 days' AND marks.to_first_sale <= interval '14 days'
             ) AS d8,
             pg_catalog.count(*) FILTER (WHERE marks.to_first_sale > interval '14 days') AS e14,
             pg_catalog.count(*) FILTER (WHERE marks.trial_started) AS t,
             pg_catalog.count(*) FILTER (WHERE marks.sold_in_trial) AS s,
             pg_catalog.count(*) FILTER (WHERE marks.sold_week_2) AS r2,
             pg_catalog.count(*) FILTER (WHERE marks.sold_week_3) AS r3,
             pg_catalog.count(*) FILTER (WHERE marks.sold_week_5) AS r5,
             -- every store of the cohort was created before its end, so 7 days after the end each has had its 7 (and
             -- 14 days after it, its 14)
             weeks.start + interval '14 days' <= local_now AS window_closed,
             weeks.start + interval '21 days' <= local_now AS window_14_closed,
             weeks.start + interval '14 days' <= current_week AS week_2_closed,
             weeks.start + interval '21 days' <= current_week AS week_3_closed,
             weeks.start + interval '35 days' <= current_week AS week_5_closed
        FROM calc_weeks AS weeks
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
               'activatedWithin14Days', CASE
                 WHEN NOT tally_row.window_14_closed
                   THEN '{"state": "unavailable", "reason": "activation_window_open"}'::jsonb
                 WHEN tally_row.tier IN (1, 2, 4) AND LEAST(tally_row.d8, tally_row.e14) >= k
                      -- a store that sold in week 2 of its cohort sold its first one before 14 days, so when that
                      -- retention cell shows, the stores of this cell that did not sell in week 2 are its difference
                      AND (NOT (tally_row.r2 >= k AND tally_row.b - tally_row.r2 >= k)
                           OR tally_row.a7 + tally_row.d8 - tally_row.r2 >= k)
                   THEN pg_catalog.jsonb_build_object('state', 'shown', 'value', tally_row.a7 + tally_row.d8)
                 ELSE suppressed END,
               'trialStarted', CASE
                 WHEN LEAST(tally_row.t, tally_row.n - tally_row.t) >= k
                   THEN pg_catalog.jsonb_build_object('state', 'shown', 'value', tally_row.t)
                 ELSE suppressed END,
               'soldInTrial', CASE
                 WHEN LEAST(tally_row.t, tally_row.n - tally_row.t, tally_row.s, tally_row.t - tally_row.s,
                            tally_row.b - tally_row.s) >= k
                   THEN pg_catalog.jsonb_build_object('state', 'shown', 'value', tally_row.s)
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
       WHERE tally_row.start >= first_week
    ),
    scope AS (
      SELECT organization.id, organization.created_at
        FROM public.organizations AS organization
       WHERE organization.status <> 'purged'
         AND NOT EXISTS (
           SELECT 1 FROM public.platform_internal_organizations AS internal
            WHERE internal.organization_id = organization.id
         )
    ),
    activity AS (
      SELECT weeks.start,
             pg_catalog.count(scope.id) AS existing,
             pg_catalog.count(*) FILTER (
               WHERE weeks.start < current_week
                 AND EXISTS (
                   SELECT 1 FROM public.sales AS sale
                    WHERE sale.organization_id = scope.id
                      AND sale.confirmed_at >= (weeks.start AT TIME ZONE 'America/Sao_Paulo')
                      AND sale.confirmed_at < ((weeks.start + interval '7 days') AT TIME ZONE 'America/Sao_Paulo')
                 )
             ) AS active
        FROM weeks
        LEFT JOIN scope ON scope.created_at < ((weeks.start + interval '7 days') AT TIME ZONE 'America/Sao_Paulo')
       GROUP BY weeks.start
    ),
    -- the retention cells the answer shows, put on the calendar week they fall in: the stores of the cohort that sold
    -- in it (r) and the ones that did not (n - r), both inside the series of that week
    shown_retention AS (
      SELECT tally.start + interval '7 days' AS week_start, tally.r2 AS r, tally.n - tally.r2 AS idle
        FROM tallies AS tally
       WHERE tally.week_2_closed AND tally.r2 >= k AND tally.b - tally.r2 >= k
      UNION ALL
      SELECT tally.start + interval '14 days', tally.r3, tally.n - tally.r3
        FROM tallies AS tally
       WHERE tally.week_3_closed AND tally.r3 >= k AND tally.b - tally.r3 >= k
      UNION ALL
      SELECT tally.start + interval '28 days', tally.r5, tally.n - tally.r5
        FROM tallies AS tally
       WHERE tally.week_5_closed AND tally.r5 >= k AND tally.b - tally.r5 >= k
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
      'internalStoresExcluded', (
        SELECT pg_catalog.count(*) FROM stores
         WHERE stores.internal AND stores.created_at >= (first_week AT TIME ZONE 'America/Sao_Paulo')
      ),
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
      'cohorts', (SELECT pg_catalog.jsonb_agg(cohort.cohort ORDER BY cohort.start) FROM cohorts AS cohort),
      'activeStores', (
        SELECT pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'week', pg_catalog.to_char(week_row.start, 'IYYY-"W"IW'),
            'weekStart', pg_catalog.to_char(week_row.start, 'YYYY-MM-DD'),
            'inProgress', week_row.start = current_week,
            'stores', CASE
              WHEN week_row.start = current_week
                THEN '{"state": "unavailable", "reason": "week_not_closed"}'::jsonb
              WHEN week_row.active - week_row.overlap_active >= k
               AND week_row.existing - week_row.active - week_row.overlap_idle >= k
                THEN pg_catalog.jsonb_build_object('state', 'shown', 'value', week_row.active)
              ELSE suppressed END
          ) ORDER BY week_row.start
        )
        FROM (
          SELECT activity.*,
                 COALESCE((SELECT pg_catalog.sum(shown.r) FROM shown_retention AS shown
                            WHERE shown.week_start = activity.start), 0) AS overlap_active,
                 COALESCE((SELECT pg_catalog.sum(shown.idle) FROM shown_retention AS shown
                            WHERE shown.week_start = activity.start), 0) AS overlap_idle
            FROM activity
        ) AS week_row
      )
    )
  );
END;
$function$;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_admin_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_admin_owner;--> statement-breakpoint
-- The end state, as 0105 checks its own (a REVOKE or an ALTER without the right is only a WARNING on Neon): the
-- function is still the Admin owner's and the Admin runtime still reaches the funnel only through the audited read.
DO $end_state$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc AS p
     WHERE p.oid = 'public.admin_activation_funnel(integer)'::regprocedure
       AND p.proowner = 'polaris_admin_owner'::regrole AND p.prosecdef
       AND p.proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp']
  ) THEN
    RAISE EXCEPTION 'the funnel function does not have its owner or its search_path';
  END IF;
  IF pg_catalog.has_function_privilege('polaris_admin_runtime', 'public.admin_activation_funnel(integer)', 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('polaris_admin_runtime', 'public.admin_read_activation_funnel(uuid, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'the Admin runtime must reach the funnel only through the audited read';
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
END
$end_state$;
