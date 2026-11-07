-- Minor fixes of the organization purge (ADR 0081, amended): two Admin functions are replaced, same names and owner.
--
-- 1. admin_retry_dead_letter no longer requires the operator's reason. The audit is immutable and the purge cannot
--    rewrite it, so the reason was checked and then thrown away (0075); asking for text that is never kept is worse
--    than not asking. The parameter stays, with a default and ignored, so the previous Worker (which still sends it)
--    and the new one (which does not) both call the same function.
-- 2. admin_list_organization_legal_holds no longer answers the organization's name: the ID is enough to find the
--    organization in the Admin, and a name can identify a person. The join with `organizations` goes with it.
--
-- Both keep the hardened search_path of 0077; ownership and grants of a replaced function stay as they were.
GRANT CREATE ON SCHEMA public TO polaris_admin_owner;--> statement-breakpoint
GRANT polaris_admin_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
SET ROLE polaris_admin_owner;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.admin_retry_dead_letter(p_principal uuid, p_incident uuid, p_event uuid, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  retried jsonb;
  outcome text;
BEGIN
  PERFORM public.admin_require_principal(p_principal);
  IF NOT EXISTS (
    SELECT 1 FROM public.queue_dead_letters AS dead WHERE dead.event_id = p_event AND dead.incident_id = p_incident
  ) THEN
    RETURN pg_catalog.jsonb_build_object('result', 'unknown_item');
  END IF;
  retried := public.retry_dead_letter(p_event);
  outcome := retried ->> 'result';
  PERFORM public.admin_record_audit(
    p_principal, 'operational_incident.retry', retried ->> 'organizationId', NULL,
    'queue_dead_letter', p_event::text, 'result=' || outcome
  );
  RETURN pg_catalog.jsonb_build_object('result', outcome);
END;
$function$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.admin_list_organization_legal_holds(p_limit integer, p_after uuid)
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
  RETURN (
    WITH page AS (
      SELECT hold.id, hold.organization_id, hold.support_case_id, hold.placed_at, hold.placed_by, hold.review_at
        FROM public.organization_legal_holds AS hold
       WHERE hold.released_at IS NULL
         AND (p_after IS NULL OR hold.id < p_after)
       ORDER BY hold.id DESC
       LIMIT p_limit + 1
    ),
    shown AS (SELECT * FROM page ORDER BY id DESC LIMIT p_limit)
    SELECT pg_catalog.jsonb_build_object(
      'holds', COALESCE((
        SELECT pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'id', shown.id,
            'organizationId', shown.organization_id,
            'supportCaseId', shown.support_case_id,
            'placedAt', shown.placed_at,
            'placedBy', shown.placed_by,
            'reviewAt', shown.review_at,
            'reviewDue', shown.review_at <= pg_catalog.now()
          ) ORDER BY shown.id DESC
        ) FROM shown
      ), '[]'::jsonb),
      'dueForReview', (
        SELECT pg_catalog.count(*) FROM public.organization_legal_holds AS due
         WHERE due.released_at IS NULL AND due.review_at <= pg_catalog.now()
      ),
      'next', CASE
        WHEN (SELECT pg_catalog.count(*) FROM page) > p_limit
          THEN (SELECT shown.id FROM shown ORDER BY shown.id LIMIT 1)
        ELSE NULL
      END
    )
  );
END;
$function$;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_admin_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_admin_owner;--> statement-breakpoint
DO $end_state$
BEGIN
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS p
       WHERE (p.oid = 'public.admin_retry_dead_letter(uuid, uuid, uuid, text)'::regprocedure AND p.proowner = 'polaris_admin_owner'::regrole)
          OR (p.oid = 'public.admin_list_organization_legal_holds(integer, uuid)'::regprocedure AND p.proowner = 'polaris_admin_owner'::regrole)) <> 2 THEN
    RAISE EXCEPTION 'the replaced functions do not have their owner';
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
