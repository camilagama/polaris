-- An operator reveals at most 30 fields of personal data per hour: `admin_reveal_customer_field` counts the operator's
-- `pii.revealed` rows of the last hour (a repeat of the same field counts again: the value left the screen and showing
-- it again is another exposure), whatever the case or the store, and the 31st is refused with
-- `operator_reveal_rate_limited` before the customer is read, so nothing is shown and nothing is recorded. A lock per
-- operator, with a key of its own, keeps two requests from counting the same free slot. A customer that is not found
-- still returns NULL and leaves no row, so it does not use a slot either.
--
-- Expand only (ADR 0096): the signature, the owner, the grants and the search_path are the ones of the previous
-- version; the previous Worker only receives the new refusal as a generic error until the Admin of this version runs.
-- The index serves this count and the one of the operator's refunds, which read the audit by operator and type.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE INDEX "platform_audit_events_principal_event_idx" ON "platform_audit_events" USING btree ("principal_id","event_type","created_at");--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO polaris_admin_owner;--> statement-breakpoint
GRANT polaris_admin_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
SET ROLE polaris_admin_owner;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.admin_reveal_customer_field(p_principal uuid, p_case uuid, p_customer uuid, p_field text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  target_organization text;
  revealed text;
  found boolean;
  recent_reveals integer;
BEGIN
  target_organization := public.admin_require_grant(p_principal, p_case);
  IF p_field IS NULL OR p_field NOT IN ('name', 'email', 'phone', 'notes') THEN
    RAISE EXCEPTION 'invalid_field' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('admin_operator_reveal:' || p_principal::text, 0)
  );
  SELECT pg_catalog.count(*)::integer INTO recent_reveals
    FROM public.platform_audit_events AS audit
   WHERE audit.principal_id = p_principal AND audit.event_type = 'pii.revealed'
     AND audit.created_at > pg_catalog.now() - interval '1 hour';
  IF recent_reveals >= 30 THEN
    RAISE EXCEPTION 'operator_reveal_rate_limited' USING ERRCODE = '22023';
  END IF;
  SELECT true,
         CASE p_field
           WHEN 'name' THEN customer.name
           WHEN 'email' THEN customer.email
           WHEN 'phone' THEN customer.phone
           ELSE customer.notes
         END
    INTO found, revealed
    FROM public.customers AS customer
   WHERE customer.id = p_customer AND customer.organization_id = target_organization;
  IF found IS NOT TRUE THEN
    RETURN NULL;
  END IF;
  PERFORM public.admin_record_audit(
    p_principal, 'pii.revealed', target_organization, p_case,
    'customer', p_customer::text, p_field
  );
  RETURN pg_catalog.jsonb_build_object('customerId', p_customer, 'field', p_field, 'value', revealed);
END;
$function$;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_admin_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_admin_owner;--> statement-breakpoint
RESET lock_timeout;
