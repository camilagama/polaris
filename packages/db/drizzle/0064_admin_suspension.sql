-- Suspending and reactivating an organization, and the audit that brackets a billing command
-- (plan PR99 and PR100, ADR 0073). Both go through functions that need an open support case
-- and write the administrative audit in the same transaction.
ALTER TABLE "platform_audit_events" DROP CONSTRAINT "platform_audit_events_type_allowed";--> statement-breakpoint
ALTER TABLE "platform_audit_events" ADD CONSTRAINT "platform_audit_events_type_allowed" CHECK ("platform_audit_events"."event_type" IN ('support_case.opened', 'support_case.closed', 'tenant_access.granted', 'tenant_access.revoked', 'tenant_data.customers_read', 'pii.revealed', 'organization.suspended', 'organization.reactivated', 'billing.entitlement_grant_requested', 'billing.entitlement_granted', 'billing.entitlement_revoke_requested', 'billing.entitlement_revoked'));--> statement-breakpoint
-- What suspending an organization changes, and only that (plan PR100): its status, the
-- authorization epoch of its memberships and its live offline leases. Billing is not touched:
-- the plan, the subscription and the grants stay exactly as they are.
GRANT SELECT (user_id) ON TABLE public.memberships TO polaris_admin_owner;--> statement-breakpoint
GRANT UPDATE (authorization_epoch, updated_at) ON TABLE public.memberships TO polaris_admin_owner;--> statement-breakpoint
CREATE POLICY memberships_admin_owner_update ON public.memberships
  AS PERMISSIVE FOR UPDATE TO polaris_admin_owner USING (true) WITH CHECK (true);--> statement-breakpoint
GRANT UPDATE (status, updated_at) ON TABLE public.organizations TO polaris_admin_owner;--> statement-breakpoint
CREATE POLICY organizations_admin_owner_update ON public.organizations
  AS PERMISSIVE FOR UPDATE TO polaris_admin_owner USING (true) WITH CHECK (true);--> statement-breakpoint
GRANT UPDATE (revoked_at, revoked_reason) ON TABLE public.offline_grants TO polaris_admin_owner;--> statement-breakpoint
CREATE POLICY offline_grants_admin_owner_update ON public.offline_grants
  AS PERMISSIVE FOR UPDATE TO polaris_admin_owner USING (true) WITH CHECK (true);--> statement-breakpoint
-- the case that justifies an action on an organization: it must exist, be open and name that organization
CREATE FUNCTION public.admin_require_open_case(p_case uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  found_organization text;
BEGIN
  SELECT support_case.organization_id INTO found_organization
    FROM public.support_cases AS support_case
   WHERE support_case.id = p_case AND support_case.status = 'open';
  IF found_organization IS NULL THEN
    RAISE EXCEPTION 'case_not_open' USING ERRCODE = '22023';
  END IF;
  RETURN found_organization;
END;
$function$;--> statement-breakpoint
CREATE FUNCTION public.admin_suspend_organization(p_principal uuid, p_case uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  target text;
  revoked_count integer;
BEGIN
  PERFORM public.admin_require_principal(p_principal);
  target := public.admin_require_open_case(p_case);
  -- the same key lease issuance takes per user, so a lease is either issued before this and revoked by it,
  -- or after it and refused (the organization is no longer active)
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('authorization-epoch:' || membership.user_id, 0)
  )
  FROM (
    SELECT member.user_id FROM public.memberships AS member
     WHERE member.organization_id = target ORDER BY member.user_id
  ) AS membership;
  UPDATE public.organizations SET status = 'suspended', updated_at = pg_catalog.now()
   WHERE id = target AND status = 'active';
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('changed', false, 'status', (SELECT status FROM public.organizations WHERE id = target));
  END IF;
  UPDATE public.memberships
     SET authorization_epoch = authorization_epoch + 1, updated_at = pg_catalog.now()
   WHERE organization_id = target;
  UPDATE public.offline_grants
     SET revoked_at = pg_catalog.now(), revoked_reason = 'organization_suspended'
   WHERE organization_id = target AND revoked_at IS NULL;
  GET DIAGNOSTICS revoked_count = ROW_COUNT;
  PERFORM public.admin_record_audit(
    p_principal, 'organization.suspended', target, p_case,
    'organization', target, 'leases=' || revoked_count
  );
  RETURN pg_catalog.jsonb_build_object('changed', true, 'status', 'suspended', 'revokedLeases', revoked_count);
END;
$function$;--> statement-breakpoint
CREATE FUNCTION public.admin_reactivate_organization(p_principal uuid, p_case uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  target text;
BEGIN
  PERFORM public.admin_require_principal(p_principal);
  target := public.admin_require_open_case(p_case);
  -- only a suspension is undone here: a closed organization stays closed (closure is its own process)
  UPDATE public.organizations SET status = 'active', updated_at = pg_catalog.now()
   WHERE id = target AND status = 'suspended';
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('changed', false, 'status', (SELECT status FROM public.organizations WHERE id = target));
  END IF;
  PERFORM public.admin_record_audit(
    p_principal, 'organization.reactivated', target, p_case,
    'organization', target, NULL
  );
  RETURN pg_catalog.jsonb_build_object('changed', true, 'status', 'active');
END;
$function$;--> statement-breakpoint
-- the record kept before and after a billing command, which the billing role carries out (it alone writes billing)
CREATE FUNCTION public.admin_audit_billing_command(
  p_principal uuid,
  p_case uuid,
  p_event text,
  p_entity_id text,
  p_detail text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  target text;
BEGIN
  PERFORM public.admin_require_principal(p_principal);
  IF p_event IS NULL OR p_event NOT IN (
    'billing.entitlement_grant_requested', 'billing.entitlement_granted',
    'billing.entitlement_revoke_requested', 'billing.entitlement_revoked'
  ) THEN
    RAISE EXCEPTION 'invalid_audit_event' USING ERRCODE = '22023';
  END IF;
  IF p_detail IS NOT NULL AND pg_catalog.char_length(p_detail) > 200 THEN
    RAISE EXCEPTION 'invalid_audit_event' USING ERRCODE = '22023';
  END IF;
  target := public.admin_require_open_case(p_case);
  PERFORM public.admin_record_audit(
    p_principal, p_event, target, p_case, 'entitlement_grant', p_entity_id, p_detail
  );
  RETURN target;
END;
$function$;--> statement-breakpoint
GRANT polaris_admin_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO polaris_admin_owner;--> statement-breakpoint
ALTER FUNCTION public.admin_require_open_case(uuid) OWNER TO polaris_admin_owner;--> statement-breakpoint
ALTER FUNCTION public.admin_suspend_organization(uuid, uuid) OWNER TO polaris_admin_owner;--> statement-breakpoint
ALTER FUNCTION public.admin_reactivate_organization(uuid, uuid) OWNER TO polaris_admin_owner;--> statement-breakpoint
ALTER FUNCTION public.admin_audit_billing_command(uuid, uuid, text, text, text) OWNER TO polaris_admin_owner;--> statement-breakpoint
SET ROLE polaris_admin_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.admin_require_open_case(uuid) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.admin_suspend_organization(uuid, uuid) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.admin_reactivate_organization(uuid, uuid) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.admin_audit_billing_command(uuid, uuid, text, text, text) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.admin_suspend_organization(uuid, uuid) TO polaris_admin_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.admin_reactivate_organization(uuid, uuid) TO polaris_admin_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.admin_audit_billing_command(uuid, uuid, text, text, text) TO polaris_admin_runtime;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_admin_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_admin_owner;
