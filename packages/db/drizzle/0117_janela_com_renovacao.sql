-- The Admin's read of the window of the right of withdrawal (ADR 0104, decision 8) now also says where the renewal
-- stands, so the screen that cancels it or refunds (ADR 0105) shows what the server holds and not a guess: the end of
-- the access already paid for (`accessEndsAt`), whether the renewal is cancelled (`cancelAtPeriodEnd`) and the two
-- columns the product's `billing-store` reads to know a payment was revoked (`revokedThrough`, `revokedReason`). The
-- domain makes the owner's own `PlanViewRecord` of them, so the date the Admin shows to subscribe again is the one
-- the owner's screen shows. Only that: the same row of the same table, no other table read, no new privilege
-- (`polaris_admin_owner` already reads these four columns since 0062), the same audit row and the same refusals.
-- Expand only (ADR 0096): the same signature, so CREATE OR REPLACE keeps the owner and the grants of 0100 (the
-- search_path is restated because a replace without it would clear it, and the REVOKE and the GRANT are repeated so
-- the end state does not depend on that); the previous Worker ignores the extra keys.
GRANT CREATE ON SCHEMA public TO polaris_admin_owner;--> statement-breakpoint
GRANT polaris_admin_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
SET ROLE polaris_admin_owner;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.admin_read_refund_window(p_principal uuid, p_case uuid, p_organization text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  found_state text;
  found_provider text;
  found_first_charge_at timestamptz;
  found_first_charge_amount numeric;
  found_refund_requested_at timestamptz;
  found_access_ends_at timestamptz;
  found_cancel_at_period_end boolean;
  found_revoked_through timestamptz;
  found_revoked_reason text;
BEGIN
  IF p_principal IS NULL OR p_case IS NULL OR p_organization IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM public.platform_principals AS principal
        WHERE principal.id = p_principal AND principal.status = 'active'
     )
     OR NOT EXISTS (
       SELECT 1 FROM public.support_cases AS support_case
        WHERE support_case.id = p_case AND support_case.status = 'open'
          AND support_case.organization_id = p_organization
     ) THEN
    RAISE EXCEPTION 'refund_window_read_refused' USING ERRCODE = '42501';
  END IF;
  SELECT billing.state, billing.provider, billing.first_charge_at, billing.first_charge_amount, billing.refund_requested_at,
         billing.access_ends_at, billing.cancel_at_period_end, billing.revoked_through, billing.revoked_reason
    INTO found_state, found_provider, found_first_charge_at, found_first_charge_amount, found_refund_requested_at,
         found_access_ends_at, found_cancel_at_period_end, found_revoked_through, found_revoked_reason
    FROM public.organization_billing AS billing
   WHERE billing.organization_id = p_organization;
  PERFORM public.admin_record_audit(
    p_principal, 'billing.refund_window_read', p_organization, p_case, 'organization', p_organization,
    'leitura da janela de reembolso'
  );
  RETURN pg_catalog.jsonb_build_object(
    'accessEndsAt', found_access_ends_at,
    'cancelAtPeriodEnd', COALESCE(found_cancel_at_period_end, false),
    'firstChargeAt', found_first_charge_at,
    'firstChargeAmount', found_first_charge_amount::text,
    'method', CASE found_provider WHEN 'asaas' THEN 'card' WHEN 'woovi' THEN 'pix_automatic' END,
    'now', pg_catalog.now(),
    'refundRequestedAt', found_refund_requested_at,
    'revokedReason', found_revoked_reason,
    'revokedThrough', found_revoked_through,
    'state', COALESCE(found_state, 'free')
  );
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.admin_read_refund_window(uuid, uuid, text) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_privacy_runtime, polaris_outbox_runtime, polaris_auth_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.admin_read_refund_window(uuid, uuid, text) TO polaris_admin_runtime;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_admin_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_admin_owner;
