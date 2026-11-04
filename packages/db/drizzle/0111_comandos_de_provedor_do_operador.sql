-- The operator's provider commands in the Admin (cancel the renewal, refund the period in force): the four audit
-- types of their request and outcome, and the record of a request through `admin_audit_billing_command`, which takes
-- them. The request of a refund is limited per operator: at most 3 distinct commands in the last hour (a repeat of the
-- same command ID on the same case and organization after an unknown result does not count again); one more is refused with `operator_refund_rate_limited`
-- and nothing is recorded or done. A lock per operator keeps two requests from counting at the same time. The command
-- ID is the entity of the four types and must be a UUID.
--
-- Expand only (ADR 0096): the CHECK gains values (the Worker of the previous version writes none of them, and every row
-- it writes still passes), and the function keeps its signature, its owner and its grants. The constraint is added NOT
-- VALID and validated apart, so the scan of the table does not hold the strong lock.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "platform_audit_events" DROP CONSTRAINT "platform_audit_events_type_allowed";--> statement-breakpoint
ALTER TABLE "platform_audit_events" ADD CONSTRAINT "platform_audit_events_type_allowed" CHECK ("platform_audit_events"."event_type" IN ('support_case.opened', 'support_case.closed', 'tenant_access.granted', 'tenant_access.revoked', 'tenant_data.customers_read', 'pii.revealed', 'organization.suspended', 'organization.reactivated', 'billing.entitlement_grant_requested', 'billing.entitlement_granted', 'billing.entitlement_revoke_requested', 'billing.entitlement_revoked', 'privacy_case.stage_recorded', 'privacy_case.action_recorded', 'operational_incident.retry', 'organization.purge_scheduled', 'organization.purge_cancelled', 'organization.purge_completed', 'organization.legal_hold_placed', 'organization.legal_hold_released', 'organization.legal_hold_reviewed', 'access_log.read', 'closure_notice.reissued', 'closure_notice.dismissed', 'billing.refund_window_read', 'organization.marked_internal', 'organization.unmarked_internal', 'activation_funnel.read', 'billing.operator_renewal_cancel_requested', 'billing.operator_renewal_cancel_recorded', 'billing.operator_refund_requested', 'billing.operator_refund_recorded')) NOT VALID;--> statement-breakpoint
ALTER TABLE "platform_audit_events" VALIDATE CONSTRAINT "platform_audit_events_type_allowed";--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO polaris_admin_owner;--> statement-breakpoint
GRANT polaris_admin_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
SET ROLE polaris_admin_owner;--> statement-breakpoint
-- the record kept before and after a billing command, which the billing role carries out (it alone writes billing)
CREATE OR REPLACE FUNCTION public.admin_audit_billing_command(
  p_principal uuid,
  p_case uuid,
  p_event text,
  p_entity_id text,
  p_detail text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  target text;
  v_entity_type text := 'entitlement_grant';
  recent_refunds integer;
BEGIN
  PERFORM public.admin_require_principal(p_principal);
  IF p_event IS NULL OR p_event NOT IN (
    'billing.entitlement_grant_requested', 'billing.entitlement_granted',
    'billing.entitlement_revoke_requested', 'billing.entitlement_revoked',
    'billing.operator_renewal_cancel_requested', 'billing.operator_renewal_cancel_recorded',
    'billing.operator_refund_requested', 'billing.operator_refund_recorded'
  ) THEN
    RAISE EXCEPTION 'invalid_audit_event' USING ERRCODE = '22023';
  END IF;
  IF p_detail IS NOT NULL AND pg_catalog.char_length(p_detail) > 200 THEN
    RAISE EXCEPTION 'invalid_audit_event' USING ERRCODE = '22023';
  END IF;
  IF p_event LIKE 'billing.operator\_%' THEN
    -- the operator's provider commands: the entity is the command ID the page made
    IF p_entity_id IS NULL
       OR p_entity_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'invalid_audit_event' USING ERRCODE = '22023';
    END IF;
    v_entity_type := 'billing_command';
  END IF;
  target := public.admin_require_open_case(p_case);
  IF p_event = 'billing.operator_refund_requested' THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('admin_operator_refund:' || p_principal::text, 0)
    );
    IF NOT EXISTS (
      SELECT 1 FROM public.platform_audit_events AS audit
       WHERE audit.principal_id = p_principal AND audit.event_type = p_event
         AND audit.support_case_id = p_case AND audit.organization_id = target
         AND audit.entity_id = p_entity_id AND audit.created_at > pg_catalog.now() - interval '1 hour'
    ) THEN
      -- the command ID is the client's: a repeat is the same command only on the same case and organization,
      -- so the same ID on another case counts as another refund
      SELECT pg_catalog.count(
               DISTINCT (audit.support_case_id, audit.organization_id, audit.entity_id)
             )::integer INTO recent_refunds
        FROM public.platform_audit_events AS audit
       WHERE audit.principal_id = p_principal AND audit.event_type = p_event
         AND audit.created_at > pg_catalog.now() - interval '1 hour';
      IF recent_refunds >= 3 THEN
        RAISE EXCEPTION 'operator_refund_rate_limited' USING ERRCODE = '22023';
      END IF;
    END IF;
  END IF;
  PERFORM public.admin_record_audit(
    p_principal, p_event, target, p_case, v_entity_type, p_entity_id, p_detail
  );
  RETURN target;
END;
$function$;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_admin_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_admin_owner;--> statement-breakpoint
RESET lock_timeout;
