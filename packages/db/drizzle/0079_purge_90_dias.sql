-- The purge now waits 90 days after the closure was requested, not 30 (decision of 19/10/2026, ADR 0081; the
-- intent is that the owner only reads and exports during that time, which needs a read-only mode that does not exist yet). Only two function bodies hold the period: the schedule of the
-- purge (`not_before` and the `closure_period_not_elapsed` refusal) and `organization_purge_blocker`, which
-- the claim, the database step and the storage step consult. CREATE OR REPLACE keeps the owner and the grants
-- of 0075 and 0077; the search_path is restated because a replace without it would clear it. Nothing else
-- changes, so the previous Worker keeps working against it (ADR 0096): it calls the same functions with the
-- same signatures, and the longer wait is only stricter. A purge already scheduled keeps its `not_before`, but
-- the blocker still holds it back until the closure is 90 days old.
-- Each function is replaced by its own owner (polaris_admin_owner and polaris_purge_owner, as in 0075), the way the
-- earlier migrations do it: the executor takes the role for the statement and gives it back, with the CREATE on the schema.
GRANT CREATE ON SCHEMA public TO polaris_admin_owner;--> statement-breakpoint
GRANT polaris_admin_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
SET ROLE polaris_admin_owner;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.admin_schedule_organization_purge(p_principal uuid, p_case uuid, p_organization text, p_delay_seconds bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  target text;
  current_status text;
  window_end timestamptz;
  closure_requested timestamptz;
  privacy_case uuid;
  privacy_type text;
  privacy_requester text;
  privacy_stage text;
  privacy_decision text;
  privacy_scope text[];
  whole_organization text[] := ARRAY['organization_profile', 'customers', 'sales', 'inventory_catalog', 'media', 'audit_logs'];
  due timestamptz;
BEGIN
  PERFORM public.admin_require_principal(p_principal);
  target := public.admin_require_open_case(p_case);
  IF p_organization IS DISTINCT FROM target THEN
    RAISE EXCEPTION 'organization_mismatch' USING ERRCODE = '55000';
  END IF;
  IF p_delay_seconds IS NULL OR p_delay_seconds < 0 OR p_delay_seconds > 315360000 THEN
    RAISE EXCEPTION 'invalid_purge_delay' USING ERRCODE = '22023';
  END IF;
  -- the case comes first: a plain support case is refused whatever the organization's state
  SELECT privacy.support_case_id, privacy.request_type, privacy.requester_kind, privacy.stage, privacy.decision,
         privacy.scope_categories
    INTO privacy_case, privacy_type, privacy_requester, privacy_stage, privacy_decision, privacy_scope
    FROM public.privacy_cases AS privacy WHERE privacy.support_case_id = p_case;
  IF privacy_case IS NULL THEN
    RAISE EXCEPTION 'privacy_case_required' USING ERRCODE = '55000';
  END IF;
  IF privacy_type IS DISTINCT FROM 'deletion' THEN
    RAISE EXCEPTION 'privacy_case_not_deletion' USING ERRCODE = '55000';
  END IF;
  IF privacy_requester IS DISTINCT FROM 'organization_owner' THEN
    RAISE EXCEPTION 'privacy_requester_not_owner' USING ERRCODE = '55000';
  END IF;
  IF privacy_stage NOT IN ('decided', 'executed') OR privacy_decision IS DISTINCT FROM 'accept' THEN
    RAISE EXCEPTION 'privacy_case_not_accepted' USING ERRCODE = '55000';
  END IF;
  IF privacy_scope IS NULL OR NOT (privacy_scope @> whole_organization) THEN
    RAISE EXCEPTION 'privacy_scope_incomplete' USING ERRCODE = '55000';
  END IF;
  -- exactly what the purge removes: a case that also covers data the purge keeps (account, authentication,
  -- billing) would record a decision the purge does not carry out
  IF NOT (privacy_scope <@ whole_organization) THEN
    RAISE EXCEPTION 'privacy_scope_covers_kept_data' USING ERRCODE = '55000';
  END IF;
  SELECT organization.status INTO current_status
    FROM public.organizations AS organization WHERE organization.id = target FOR UPDATE;
  IF current_status IN ('purge_pending', 'purged') THEN
    RETURN pg_catalog.jsonb_build_object('changed', false, 'status', current_status);
  END IF;
  IF current_status IS DISTINCT FROM 'closed' THEN
    RAISE EXCEPTION 'organization_not_closed' USING ERRCODE = '55000';
  END IF;
  SELECT closure.recover_until, closure.requested_at INTO window_end, closure_requested
    FROM public.organization_closures AS closure
   WHERE closure.organization_id = target AND closure.closed_at IS NOT NULL;
  IF window_end IS NULL THEN
    RAISE EXCEPTION 'organization_not_closed' USING ERRCODE = '55000';
  END IF;
  IF window_end > pg_catalog.now() THEN
    RAISE EXCEPTION 'recovery_window_open' USING ERRCODE = '55000';
  END IF;
  -- the closure period of 90 days (decision of 19/10/2026, ADR 0081), whatever window the closure had: the owner
  -- can recover it only while the window is open, and the purge never starts before the period is over
  IF closure_requested + interval '90 days' > pg_catalog.now() THEN
    RAISE EXCEPTION 'closure_period_not_elapsed' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.organization_legal_holds AS hold
     WHERE hold.organization_id = target AND hold.released_at IS NULL
  ) THEN
    RAISE EXCEPTION 'legal_hold_active' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.tenant_access_grants AS access_grant
     WHERE access_grant.organization_id = target AND access_grant.revoked_at IS NULL
       AND access_grant.expires_at > pg_catalog.now()
  ) THEN
    RAISE EXCEPTION 'tenant_access_active' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.organization_billing AS billing
     WHERE billing.organization_id = target AND billing.state IN ('trialing', 'active', 'grace')
       AND billing.access_ends_at > pg_catalog.now()
  ) THEN
    RAISE EXCEPTION 'paid_access_running' USING ERRCODE = '55000';
  END IF;
  due := GREATEST(window_end, closure_requested + interval '90 days') + p_delay_seconds * interval '1 second';
  UPDATE public.organizations SET status = 'purge_pending', updated_at = pg_catalog.now()
   WHERE id = target AND status = 'closed';
  -- a purge scheduled again (after a cancellation, or a restore that brought the organization back) starts from
  -- nothing; the reason of an earlier cancellation stays in organization_purge_cancellations
  INSERT INTO public.organization_purges
    (organization_id, scheduled_at, scheduled_by, support_case_id, privacy_case_id, not_before)
  VALUES (target, pg_catalog.now(), p_principal, p_case, privacy_case, due)
  ON CONFLICT (organization_id) DO UPDATE
    SET scheduled_at = EXCLUDED.scheduled_at, scheduled_by = EXCLUDED.scheduled_by,
        support_case_id = EXCLUDED.support_case_id, privacy_case_id = EXCLUDED.privacy_case_id,
        not_before = EXCLUDED.not_before, attempts = 0, locked_until = NULL,
        last_error_code = NULL, purged_at = NULL, swept_at = NULL, storage_touched_at = NULL;
  PERFORM public.admin_record_audit(
    p_principal, 'organization.purge_scheduled', target, p_case, 'organization', target, NULL
  );
  RETURN pg_catalog.jsonb_build_object('changed', true, 'status', 'purge_pending', 'notBefore', due);
END;
$function$;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_admin_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_admin_owner;--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO polaris_purge_owner;--> statement-breakpoint
GRANT polaris_purge_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
SET ROLE polaris_purge_owner;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.organization_purge_blocker(p_organization text)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.organization_legal_holds AS hold
     WHERE hold.organization_id = p_organization AND hold.released_at IS NULL
  ) THEN
    RETURN 'legal_hold_active';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.deletion_ledger AS tombstone
     WHERE tombstone.organization_id = p_organization AND tombstone.entity_type = 'organization'
       AND tombstone.entity_id = p_organization AND tombstone.operation = 'purge'
  ) THEN
    RETURN NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.organization_closures AS closure
     WHERE closure.organization_id = p_organization AND closure.closed_at IS NOT NULL
       AND closure.recover_until <= pg_catalog.now()
       AND closure.requested_at + interval '90 days' <= pg_catalog.now()
  ) THEN
    RETURN 'closure_period_not_elapsed';
  END IF;
  RETURN NULL;
END;
$function$;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_purge_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_purge_owner;
