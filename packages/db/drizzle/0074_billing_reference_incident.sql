ALTER TABLE "operational_incidents" DROP CONSTRAINT "operational_incidents_kind_allowed";--> statement-breakpoint
ALTER TABLE "operational_incidents" DROP CONSTRAINT "operational_incidents_cause_allowed";--> statement-breakpoint
ALTER TABLE "operational_incidents" ADD CONSTRAINT "operational_incidents_kind_allowed" CHECK ("operational_incidents"."kind" IN ('queue_dead_letter', 'outbox_attempts_exhausted', 'billing_reference_mismatch'));--> statement-breakpoint
ALTER TABLE "operational_incidents" ADD CONSTRAINT "operational_incidents_cause_allowed" CHECK (("operational_incidents"."kind" = 'queue_dead_letter' AND "operational_incidents"."cause" IN ('retries_exhausted', 'invalid_envelope', 'unknown_type', 'wrong_queue'))
        OR ("operational_incidents"."kind" = 'outbox_attempts_exhausted' AND "operational_incidents"."cause" = 'attempts_exhausted')
        OR ("operational_incidents"."kind" = 'billing_reference_mismatch' AND "operational_incidents"."cause" IN ('reference_mismatch', 'reference_unresolved')));--> statement-breakpoint
-- A billing fact whose subscription reference did not match the record's, or that never found a subscription (plan
-- POL-21, ADR 0087), is an operational incident, one per cause and fact type, counted; it was a silent
-- `reference_mismatch` or `unknown_organization` in the inbox only. The function is the outbox owner's (the owner of
-- the incident table), and the billing login only executes it, in the same transaction that records the event's
-- outcome. It takes a cause, a fact type and the opaque ID of the event: no reference of the provider, no
-- organization, nothing a person typed.
GRANT CREATE ON SCHEMA public TO polaris_outbox_owner;--> statement-breakpoint
GRANT polaris_outbox_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
SET ROLE polaris_outbox_owner;--> statement-breakpoint
CREATE FUNCTION public.record_billing_reference_incident(p_cause text, p_fact_type text, p_event uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF p_cause IS NULL OR p_cause NOT IN ('reference_mismatch', 'reference_unresolved')
     OR p_event IS NULL
     OR p_fact_type IS NULL OR p_fact_type NOT IN (
       'trial_method_ready', 'charge_succeeded', 'charge_failed', 'subscription_cancelled', 'cycle_change_scheduled',
       'charge_refunded', 'charge_disputed', 'dispute_reversed'
     ) THEN
    RAISE EXCEPTION 'invalid_billing_reference_incident' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.operational_incidents AS incident (kind, cause, subject, last_reference)
  VALUES ('billing_reference_mismatch', p_cause, 'billing.' || p_fact_type, p_event::text)
  ON CONFLICT (kind, cause, subject) DO UPDATE
     SET occurrence_count = incident.occurrence_count + 1,
         last_seen_at = pg_catalog.now(),
         last_reference = EXCLUDED.last_reference;
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.record_billing_reference_incident(text, text, uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.record_billing_reference_incident(text, text, uuid) TO polaris_billing_runtime;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_outbox_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_outbox_owner;
