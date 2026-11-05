-- The charge of the period in force (ADR 0104 §7 amended, ADR 0105 amended): the amount of the latest period paid on the
-- current link, so the Admin and the owner stop reading the first charge or the checkout's price as if it were the
-- charge in force (a renewal at another amount, after an edit at the provider, kept the old one).
-- Expand only (ADR 0096): three new nullable columns, a new check, two wider checks of the incidents, a new function and
-- one recreated with the same signature. Nothing is dropped, renamed or made NOT NULL; the previous Worker never writes
-- the new columns, ignores the extra key of `admin_read_refund_window` and never records the new incident.
-- * `organization_billing.current_charge_*`: the amount, the end of the period and the ledger row of the applied
--   `charge_succeeded` with the latest end of period on the link (`processEvent`, only forward). `UPDATE` only to
--   `polaris_billing_runtime` (its SELECT on the whole table comes from 0053); the Admin owner reads only the amount;
--   nothing to the tenant (its column grant of 0059 leaves them invisible). No personal data: they survive the purge as
--   `first_charge_*` do.
-- * `record_billing_amount_mismatch_incident`: a recorded amount in force that is not the provider's becomes an
--   operational incident (ADR 0085), one row with a counter, no store, no amount, no reference of the provider.
-- * `admin_read_refund_window` also answers `currentChargeAmount`.
-- * The backfill, after the last RESET ROLE (the migrator bypasses the forced row security; never under SET ROLE).
-- The new check and the wider ones are added NOT VALID and validated apart: the strong lock is not held while reading.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
ALTER TABLE "operational_incidents" DROP CONSTRAINT "operational_incidents_kind_allowed";--> statement-breakpoint
ALTER TABLE "operational_incidents" DROP CONSTRAINT "operational_incidents_cause_allowed";--> statement-breakpoint
ALTER TABLE "organization_billing" ADD COLUMN "current_charge_amount" numeric;--> statement-breakpoint
ALTER TABLE "organization_billing" ADD COLUMN "current_charge_event_id" uuid;--> statement-breakpoint
ALTER TABLE "organization_billing" ADD COLUMN "current_charge_period_ends_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organization_billing" ADD CONSTRAINT "organization_billing_current_charge_coherent" CHECK (("organization_billing"."current_charge_period_ends_at" IS NOT NULL OR ("organization_billing"."current_charge_amount" IS NULL AND "organization_billing"."current_charge_event_id" IS NULL))
        AND ("organization_billing"."current_charge_amount" IS NULL OR ("organization_billing"."current_charge_amount" > 0 AND scale("organization_billing"."current_charge_amount") = 2))) NOT VALID;--> statement-breakpoint
ALTER TABLE "operational_incidents" ADD CONSTRAINT "operational_incidents_kind_allowed" CHECK ("operational_incidents"."kind" IN ('queue_dead_letter', 'outbox_attempts_exhausted', 'billing_reference_mismatch', 'billing_refund_pending', 'billing_amount_mismatch')) NOT VALID;--> statement-breakpoint
ALTER TABLE "operational_incidents" ADD CONSTRAINT "operational_incidents_cause_allowed" CHECK (("operational_incidents"."kind" = 'queue_dead_letter' AND "operational_incidents"."cause" IN ('retries_exhausted', 'invalid_envelope', 'unknown_type', 'wrong_queue'))
        OR ("operational_incidents"."kind" = 'outbox_attempts_exhausted' AND "operational_incidents"."cause" = 'attempts_exhausted')
        OR ("operational_incidents"."kind" = 'billing_reference_mismatch' AND "operational_incidents"."cause" IN ('reference_mismatch', 'reference_unresolved'))
        OR ("operational_incidents"."kind" = 'billing_refund_pending' AND "operational_incidents"."cause" IN ('refund_not_completed', 'refund_rearm_exhausted'))
        OR ("operational_incidents"."kind" = 'billing_amount_mismatch' AND "operational_incidents"."cause" = 'amount_mismatch')) NOT VALID;--> statement-breakpointALTER TABLE "organization_billing" VALIDATE CONSTRAINT "organization_billing_current_charge_coherent";--> statement-breakpoint
ALTER TABLE "operational_incidents" VALIDATE CONSTRAINT "operational_incidents_kind_allowed";--> statement-breakpoint
ALTER TABLE "operational_incidents" VALIDATE CONSTRAINT "operational_incidents_cause_allowed";--> statement-breakpoint
-- only the billing role writes the charge in force, under the record's lock in `processEvent`
GRANT UPDATE (current_charge_amount, current_charge_period_ends_at, current_charge_event_id) ON TABLE public.organization_billing TO polaris_billing_runtime;--> statement-breakpoint
-- the Admin owner reads the amount alone, for `admin_read_refund_window` below (granted before the function is replaced)
GRANT SELECT (current_charge_amount) ON TABLE public.organization_billing TO polaris_admin_owner;--> statement-breakpoint
-- the incident of an amount in force that is not the provider's (ADR 0105, ADR 0085): the outbox owner owns the table
GRANT CREATE ON SCHEMA public TO polaris_outbox_owner;--> statement-breakpoint
GRANT polaris_outbox_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
SET ROLE polaris_outbox_owner;--> statement-breakpoint
-- One row for the cause, as every incident: each refund the server refuses because the amount it holds for the charge
-- in force is not the one the provider has adds one occurrence and moves `last_reference` to that store's
-- `current_charge_event_id`, the ledger row that names the store. No store, no amount, no reference of the provider here.
CREATE FUNCTION public.record_billing_amount_mismatch_incident(p_event uuid, p_cause text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
BEGIN
  IF p_event IS NULL OR p_cause IS NULL OR p_cause <> 'amount_mismatch' THEN
    RAISE EXCEPTION 'invalid_billing_amount_mismatch_incident' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.operational_incidents AS incident (kind, cause, subject, last_reference)
  VALUES ('billing_amount_mismatch', p_cause, 'billing.current_charge', p_event::text)
  ON CONFLICT (kind, cause, subject) DO UPDATE
     SET occurrence_count = incident.occurrence_count + 1,
         last_seen_at = pg_catalog.now(),
         last_reference = EXCLUDED.last_reference;
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.record_billing_amount_mismatch_incident(uuid, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.record_billing_amount_mismatch_incident(uuid, text) TO polaris_billing_runtime;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_outbox_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_outbox_owner;--> statement-breakpoint
-- The Admin's read of the window also says the amount of the charge in force, the one a refund of the current period
-- sends as `expectedAmount` (ADR 0105); the server still reads the charge again at the provider. The same signature,
-- so CREATE OR REPLACE keeps the owner; the search_path, the REVOKE and the GRANT of 0117 are restated.
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
  found_current_charge_amount numeric;
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
  SELECT billing.state, billing.provider, billing.first_charge_at, billing.first_charge_amount,
         billing.current_charge_amount, billing.refund_requested_at,
         billing.access_ends_at, billing.cancel_at_period_end, billing.revoked_through, billing.revoked_reason
    INTO found_state, found_provider, found_first_charge_at, found_first_charge_amount,
         found_current_charge_amount, found_refund_requested_at,
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
    'currentChargeAmount', found_current_charge_amount::text,
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
REVOKE CREATE ON SCHEMA public FROM polaris_admin_owner;--> statement-breakpoint
-- the end state, as 0100 checks its own (a REVOKE or an ALTER without the right is only a WARNING on Neon)
DO $end_state$
BEGIN
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS p
       WHERE (p.oid = 'public.record_billing_amount_mismatch_incident(uuid, text)'::regprocedure AND p.proowner = 'polaris_outbox_owner'::regrole)
          OR (p.oid = 'public.admin_read_refund_window(uuid, uuid, text)'::regprocedure AND p.proowner = 'polaris_admin_owner'::regrole)) <> 2 THEN
    RAISE EXCEPTION 'the functions do not have their owners';
  END IF;
  IF pg_catalog.has_schema_privilege('polaris_outbox_owner', 'public', 'CREATE')
     OR pg_catalog.has_schema_privilege('polaris_admin_owner', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'an owner role kept CREATE on schema public';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members AS m
     WHERE m.member = (SELECT r.oid FROM pg_catalog.pg_roles AS r WHERE r.rolname = CURRENT_USER)
       AND m.roleid IN ('polaris_outbox_owner'::regrole, 'polaris_admin_owner'::regrole)
       AND (m.set_option OR m.inherit_option)
  ) THEN
    RAISE EXCEPTION 'the migrator kept SET or INHERIT on an owner role';
  END IF;
END
$end_state$;--> statement-breakpoint
-- The backfill (scripts/current-charge-reconcile-sql.ts, the same statement as `billing:current-charge-reconcile`), as
-- the migrator and after the RESET ROLE above: the charge in force of every record with a link, from its ledger.
WITH charges AS (
  SELECT billing.organization_id, charge.id AS event_id, charge.received_at,
         CASE
           WHEN (charge.fact ->> 'periodEndsAt') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
                AND pg_catalog.pg_input_is_valid(charge.fact ->> 'periodEndsAt', 'timestamptz')
           THEN (charge.fact ->> 'periodEndsAt')::timestamptz
         END AS period_ends_at,
         CASE
           WHEN charge.fact ->> 'currency' = 'BRL' AND (charge.fact ->> 'amount') ~ '^[0-9]{1,12}[.][0-9]{2}$'
                AND (charge.fact ->> 'amount') !~ '^0+[.]00$'
           THEN (charge.fact ->> 'amount')::numeric
           WHEN charge.id = billing.first_charge_event_id THEN billing.first_charge_amount
         END AS amount
    FROM public.organization_billing AS billing
    JOIN public.billing_events AS charge
      ON charge.organization_id = billing.organization_id
     AND charge.provider = billing.provider
     AND charge.provider_ref = billing.provider_ref
   WHERE billing.provider IS NOT NULL
     AND billing.provider_ref IS NOT NULL
     AND charge.status = 'applied'
     AND charge.fact_type = 'charge_succeeded'
),
latest AS (
  SELECT DISTINCT ON (charges.organization_id)
         charges.organization_id, charges.event_id, charges.period_ends_at, charges.amount
    FROM charges
   WHERE charges.period_ends_at IS NOT NULL
   ORDER BY charges.organization_id, charges.period_ends_at DESC, charges.amount IS NULL, charges.received_at, charges.event_id
),
decided AS (
  SELECT latest.organization_id,
         CASE WHEN kept.kept THEN COALESCE(billing.current_charge_amount, latest.amount) ELSE latest.amount END AS amount,
         CASE WHEN kept.kept THEN billing.current_charge_period_ends_at ELSE latest.period_ends_at END AS period_ends_at,
         CASE WHEN kept.kept THEN billing.current_charge_event_id ELSE latest.event_id END AS event_id
    FROM latest
    JOIN public.organization_billing AS billing ON billing.organization_id = latest.organization_id
   CROSS JOIN LATERAL (
     SELECT billing.current_charge_event_id IS NOT NULL
            AND billing.current_charge_period_ends_at >= latest.period_ends_at - interval '1 day' AS kept
   ) AS kept
)
UPDATE public.organization_billing AS billing
   SET current_charge_amount = decided.amount,
       current_charge_period_ends_at = decided.period_ends_at,
       current_charge_event_id = decided.event_id
  FROM decided
 WHERE billing.organization_id = decided.organization_id
   AND (billing.current_charge_amount, billing.current_charge_period_ends_at, billing.current_charge_event_id)
       IS DISTINCT FROM (decided.amount, decided.period_ends_at, decided.event_id);--> statement-breakpoint
-- the migrator runs the pending migrations in one transaction: the timeout of this one stops here
RESET lock_timeout;
