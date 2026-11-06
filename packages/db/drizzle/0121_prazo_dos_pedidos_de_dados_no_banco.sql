-- The Admin's list of data requests now says by itself how many calendar days in `America/Sao_Paulo` lie between today and
-- the due day (`dueInDays`: 0 is the due day, below 0 is past), counted from the same `now()` that
-- decides `overdue` and the `overdue` filter, so a case cannot be "overdue" under one clock and "due today" under
-- another around midnight in Brasília.
-- Same function in every other way: same signature and `jsonb` result (one key added, which the Admin of the previous
-- version ignores, ADR 0096), SECURITY DEFINER owned by `polaris_admin_owner` with the search_path pinned to end in
-- pg_temp (0077), EXECUTE only for `polaris_admin_runtime` (0067); CREATE OR REPLACE keeps owner and grants, which are
-- stated again below so the migration does not depend on that.
GRANT CREATE ON SCHEMA public TO polaris_admin_owner;--> statement-breakpoint
GRANT polaris_admin_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
SET ROLE polaris_admin_owner;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.admin_list_privacy_cases(p_filter text, p_limit integer, p_after uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 50 THEN
    RAISE EXCEPTION 'invalid page size' USING ERRCODE = '22023';
  END IF;
  IF p_filter IS NOT NULL AND p_filter NOT IN ('open', 'closed', 'overdue') THEN
    RAISE EXCEPTION 'invalid status' USING ERRCODE = '22023';
  END IF;
  RETURN (
    WITH page AS (
      SELECT privacy_case.support_case_id AS id, support_case.organization_id, organization.name AS organization_name,
             support_case.status, support_case.opened_at, privacy_case.request_type, privacy_case.requester_kind,
             privacy_case.stage, privacy_case.due_at,
             (privacy_case.stage <> 'resolved' AND pg_catalog.now() > privacy_case.due_at) AS overdue,
             ((privacy_case.due_at AT TIME ZONE 'America/Sao_Paulo')::date
               - (pg_catalog.now() AT TIME ZONE 'America/Sao_Paulo')::date) AS due_in_days
        FROM public.privacy_cases AS privacy_case
        JOIN public.support_cases AS support_case ON support_case.id = privacy_case.support_case_id
        JOIN public.organizations AS organization ON organization.id = support_case.organization_id
       WHERE (p_filter IS NULL
              OR (p_filter = 'open' AND support_case.status = 'open')
              OR (p_filter = 'closed' AND support_case.status = 'closed')
              OR (p_filter = 'overdue' AND privacy_case.stage <> 'resolved' AND pg_catalog.now() > privacy_case.due_at))
         AND (p_after IS NULL OR privacy_case.support_case_id < p_after)
       ORDER BY privacy_case.support_case_id DESC
       LIMIT p_limit + 1
    ),
    shown AS (SELECT * FROM page ORDER BY id DESC LIMIT p_limit)
    SELECT pg_catalog.jsonb_build_object(
      'cases', COALESCE((
        SELECT pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'id', shown.id, 'organizationId', shown.organization_id, 'organizationName', shown.organization_name,
            'status', shown.status, 'openedAt', shown.opened_at, 'requestType', shown.request_type,
            'requesterKind', shown.requester_kind, 'stage', shown.stage, 'dueAt', shown.due_at, 'overdue', shown.overdue,
            'dueInDays', shown.due_in_days
          ) ORDER BY shown.id DESC
        ) FROM shown
      ), '[]'::jsonb),
      'next', CASE
        WHEN (SELECT pg_catalog.count(*) FROM page) > p_limit
          THEN (SELECT shown.id FROM shown ORDER BY shown.id LIMIT 1)
        ELSE NULL
      END
    )
  );
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.admin_list_privacy_cases(text, integer, uuid) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_privacy_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.admin_list_privacy_cases(text, integer, uuid) TO polaris_admin_runtime;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_admin_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_admin_owner;
