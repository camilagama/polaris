-- The owner's billing self-service, the database part (ADR 0104, PR B of design t268 v2: §5, §7 and §8 "0100").
-- Expand only (ADR 0096): new nullable columns, a new table, new roles and functions, wider checks, a new trigger and a
-- generated column whose expression takes more types. Nothing is dropped, renamed or made NOT NULL, and no function the
-- previous Worker calls is recreated: it never writes the new columns and never writes the new audit types.
--
-- * `organization_billing` gains what the billing role records for the owner (§7): the price the checkout sent and the
--   day of the first charge (`attachProvider`), the moment, amount and ledger row of the first charge (`processEvent`,
--   `first_charge_at` = the provider's `occurredAt`), the anchor of the owner's refund request and its request ID, the
--   counter of the owner's limit (1 per 30 s, 10 per hour) and the back-off of the hourly safety net. `UPDATE` only to
--   `polaris_billing_runtime`; nothing to the tenant (its column grant of 0059 leaves them invisible); the Admin owner
--   reads only `first_charge_at`, `first_charge_amount` and `refund_requested_at`, through its new function.
-- * `billing_cancellation_feedback`: the optional reason of a cancelled renewal, with no store and no person, forced row
--   security; `INSERT` to the billing role, `SELECT` to the Admin owner, and the privacy owner reads and deletes only
--   what is past 12 months (`expire_billing_cancellation_feedback`, run by the privacy maintenance). Outside the purge.
-- * Seven tenant audit types of the owner's requests (the check and the class are built from the domain registry), a
--   unique index per request ID and type, and the cap of 10 per type, store and hour on the three refusal types: a
--   `BEFORE INSERT` trigger of its own owner (`polaris_billing_audit_owner`), which reads only those three types and
--   takes an advisory lock per store and type before counting. It never looks at an accepted request.
-- * `admin_read_refund_window`: what the operator reads to check the window of a Pix refund asked by e-mail (ADR 0104,
--   decision 8), under an open case of the same store, audited in the same transaction (`billing.refund_window_read`).
-- * `record_billing_refund_pending_incident`: an owner's refund still not completed 24 hours after the request is an
--   operational incident (ADR 0085), one occurrence per store and request, counted on one row.
-- Each new policy and trigger takes an ACCESS EXCLUSIVE lock on a busy table: better to fail and deploy again than to queue.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE "billing_cancellation_feedback" (
	"cycle_months" integer,
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"reason" text NOT NULL,
	"recorded_on" date DEFAULT ((now() AT TIME ZONE 'America/Sao_Paulo'))::date NOT NULL,
	"state" text NOT NULL,
	CONSTRAINT "billing_cancellation_feedback_reason_length" CHECK (char_length("billing_cancellation_feedback"."reason") BETWEEN 1 AND 500),
	CONSTRAINT "billing_cancellation_feedback_state_allowed" CHECK ("billing_cancellation_feedback"."state" IN ('trialing', 'active', 'grace')),
	CONSTRAINT "billing_cancellation_feedback_cycle_allowed" CHECK ("billing_cancellation_feedback"."cycle_months" IS NULL OR "billing_cancellation_feedback"."cycle_months" IN (1, 6, 12))
);
--> statement-breakpoint
ALTER TABLE "billing_cancellation_feedback" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "operational_incidents" DROP CONSTRAINT "operational_incidents_kind_allowed";--> statement-breakpoint
ALTER TABLE "operational_incidents" DROP CONSTRAINT "operational_incidents_cause_allowed";--> statement-breakpoint
ALTER TABLE "platform_audit_events" DROP CONSTRAINT "platform_audit_events_type_allowed";--> statement-breakpoint
ALTER TABLE "tenant_audit_event" DROP CONSTRAINT "tenant_audit_event_type_registered";--> statement-breakpoint
-- the class of the new types (ADR 0081 amended, ADR 0104): the generated column takes the registry's new list in place,
-- never dropped and added again (the retention policy and the old Worker keep reading it)
ALTER TABLE "tenant_audit_event" ALTER COLUMN "event_class" SET EXPRESSION AS (CASE WHEN event_type IN ('billing.checkout_started', 'billing.command_in_progress', 'billing.command_rate_limited', 'billing.command_refused', 'billing.owner_renewal_cancel_requested', 'billing.refund_requested', 'customer.anonymized', 'data_export.downloaded', 'data_export.failed', 'data_export.ready', 'data_export.requested', 'offline_grant.issued', 'offline_grant.revoked', 'organization.closure_recovered', 'organization.closure_requested', 'organization.created', 'product.published_to_catalog', 'product.unpublished_from_catalog', 'public_catalog.profile_created', 'public_catalog.profile_updated', 'public_catalog.published', 'public_catalog.unpublished') THEN 'security' ELSE 'operational' END);--> statement-breakpoint
ALTER TABLE "organization_billing" ADD COLUMN "first_charge_amount" numeric;--> statement-breakpoint
ALTER TABLE "organization_billing" ADD COLUMN "first_charge_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organization_billing" ADD COLUMN "first_charge_event_id" uuid;--> statement-breakpoint
ALTER TABLE "organization_billing" ADD COLUMN "first_charge_on" date;--> statement-breakpoint
ALTER TABLE "organization_billing" ADD COLUMN "price_amount" numeric;--> statement-breakpoint
ALTER TABLE "organization_billing" ADD COLUMN "price_id" text;--> statement-breakpoint
ALTER TABLE "organization_billing" ADD COLUMN "provider_command_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organization_billing" ADD COLUMN "provider_commands_hour" smallint;--> statement-breakpoint
ALTER TABLE "organization_billing" ADD COLUMN "provider_commands_hour_start" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organization_billing" ADD COLUMN "refund_rearm_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organization_billing" ADD COLUMN "refund_rearm_attempts" smallint;--> statement-breakpoint
ALTER TABLE "organization_billing" ADD COLUMN "refund_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organization_billing" ADD COLUMN "refund_request_id" uuid;--> statement-breakpoint
CREATE INDEX "billing_cancellation_feedback_recorded_idx" ON "billing_cancellation_feedback" USING btree ("recorded_on");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_audit_event_billing_request_unique" ON "tenant_audit_event" USING btree ("organization_id","event_type","entity_id") WHERE "tenant_audit_event"."event_type" IN ('billing.owner_renewal_cancel_requested', 'billing.refund_requested', 'billing.overdue_payment_opened', 'billing.command_rate_limited', 'billing.command_in_progress', 'billing.command_refused');--> statement-breakpoint
ALTER TABLE "organization_billing" ADD CONSTRAINT "organization_billing_price_coherent" CHECK (("organization_billing"."price_amount" IS NULL) = ("organization_billing"."price_id" IS NULL)
        AND ("organization_billing"."price_amount" IS NULL OR ("organization_billing"."price_amount" > 0 AND scale("organization_billing"."price_amount") = 2 AND "organization_billing"."price_amount" < 1000000))
        AND ("organization_billing"."price_id" IS NULL OR char_length("organization_billing"."price_id") BETWEEN 1 AND 64));--> statement-breakpoint
ALTER TABLE "organization_billing" ADD CONSTRAINT "organization_billing_first_charge_coherent" CHECK (("organization_billing"."first_charge_at" IS NOT NULL OR ("organization_billing"."first_charge_amount" IS NULL AND "organization_billing"."first_charge_event_id" IS NULL))
        AND ("organization_billing"."first_charge_amount" IS NULL OR ("organization_billing"."first_charge_amount" > 0 AND scale("organization_billing"."first_charge_amount") = 2)));--> statement-breakpoint
ALTER TABLE "organization_billing" ADD CONSTRAINT "organization_billing_refund_request_coherent" CHECK ("organization_billing"."refund_request_id" IS NULL OR "organization_billing"."refund_requested_at" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "organization_billing" ADD CONSTRAINT "organization_billing_provider_commands_coherent" CHECK (("organization_billing"."provider_commands_hour_start" IS NULL) = ("organization_billing"."provider_commands_hour" IS NULL)
        AND ("organization_billing"."provider_commands_hour" IS NULL OR "organization_billing"."provider_commands_hour" BETWEEN 1 AND 10));--> statement-breakpoint
ALTER TABLE "organization_billing" ADD CONSTRAINT "organization_billing_refund_rearm_coherent" CHECK (("organization_billing"."refund_rearm_attempts" IS NULL) = ("organization_billing"."refund_rearm_at" IS NULL)
        AND ("organization_billing"."refund_rearm_attempts" IS NULL OR "organization_billing"."refund_rearm_attempts" BETWEEN 1 AND 10));--> statement-breakpoint
ALTER TABLE "operational_incidents" ADD CONSTRAINT "operational_incidents_kind_allowed" CHECK ("operational_incidents"."kind" IN ('queue_dead_letter', 'outbox_attempts_exhausted', 'billing_reference_mismatch', 'billing_refund_pending'));--> statement-breakpoint
ALTER TABLE "operational_incidents" ADD CONSTRAINT "operational_incidents_cause_allowed" CHECK (("operational_incidents"."kind" = 'queue_dead_letter' AND "operational_incidents"."cause" IN ('retries_exhausted', 'invalid_envelope', 'unknown_type', 'wrong_queue'))
        OR ("operational_incidents"."kind" = 'outbox_attempts_exhausted' AND "operational_incidents"."cause" = 'attempts_exhausted')
        OR ("operational_incidents"."kind" = 'billing_reference_mismatch' AND "operational_incidents"."cause" IN ('reference_mismatch', 'reference_unresolved'))
        OR ("operational_incidents"."kind" = 'billing_refund_pending' AND "operational_incidents"."cause" = 'refund_not_completed'));--> statement-breakpoint
ALTER TABLE "platform_audit_events" ADD CONSTRAINT "platform_audit_events_type_allowed" CHECK ("platform_audit_events"."event_type" IN ('support_case.opened', 'support_case.closed', 'tenant_access.granted', 'tenant_access.revoked', 'tenant_data.customers_read', 'pii.revealed', 'organization.suspended', 'organization.reactivated', 'billing.entitlement_grant_requested', 'billing.entitlement_granted', 'billing.entitlement_revoke_requested', 'billing.entitlement_revoked', 'privacy_case.stage_recorded', 'privacy_case.action_recorded', 'operational_incident.retry', 'organization.purge_scheduled', 'organization.purge_cancelled', 'organization.purge_completed', 'organization.legal_hold_placed', 'organization.legal_hold_released', 'organization.legal_hold_reviewed', 'access_log.read', 'closure_notice.reissued', 'closure_notice.dismissed', 'billing.refund_window_read'));--> statement-breakpoint
ALTER TABLE "tenant_audit_event" ADD CONSTRAINT "tenant_audit_event_type_registered" CHECK ("tenant_audit_event"."event_type" IN ('billing.checkout_started', 'billing.command_in_progress', 'billing.command_rate_limited', 'billing.command_refused', 'billing.owner_renewal_cancel_requested', 'billing.refund_requested', 'customer.anonymized', 'data_export.downloaded', 'data_export.failed', 'data_export.ready', 'data_export.requested', 'offline_grant.issued', 'offline_grant.revoked', 'organization.closure_recovered', 'organization.closure_requested', 'organization.created', 'product.published_to_catalog', 'product.unpublished_from_catalog', 'public_catalog.profile_created', 'public_catalog.profile_updated', 'public_catalog.published', 'public_catalog.unpublished', 'billing.overdue_payment_opened', 'category.archived', 'category.created', 'category.deleted', 'category.renamed', 'category.restored', 'customer.archived', 'customer.created', 'customer.restored', 'customer.updated', 'expense.created', 'expense.restored', 'expense.updated', 'expense.voided', 'expense_category.archived', 'expense_category.created', 'expense_category.renamed', 'expense_category.restored', 'expense_rule.archived', 'expense_rule.created', 'expense_rule.generated', 'expense_rule.restored', 'expense_rule.updated', 'goal.cancelled', 'goal.completed', 'goal.created', 'goal.missed', 'goal.target_changed', 'goal.updated', 'inventory.movement_recorded', 'operational_selection.changed', 'payment_profile.archived', 'payment_profile.created', 'payment_profile.restored', 'payment_profile.updated', 'product.archived', 'product.created', 'product.deleted', 'product.media_removed', 'product.media_reordered', 'product.media_uploaded', 'product.restored', 'product.updated', 'product.variants_configured', 'product_variant.list_price_changed', 'product_variant.sku_changed', 'sale.cancelled', 'sale.confirmed', 'sale.returned', 'sale_customer_link.assigned', 'sale_customer_link.reassigned', 'sale_customer_link.unassigned'));--> statement-breakpoint
CREATE POLICY "billing_cancellation_feedback_billing_runtime_insert" ON "billing_cancellation_feedback" AS PERMISSIVE FOR INSERT TO "polaris_billing_runtime" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "billing_cancellation_feedback_admin_owner_select" ON "billing_cancellation_feedback" AS PERMISSIVE FOR SELECT TO "polaris_admin_owner" USING (true);--> statement-breakpoint
CREATE POLICY "billing_cancellation_feedback_privacy_owner_select" ON "billing_cancellation_feedback" AS PERMISSIVE FOR SELECT TO "polaris_privacy_owner" USING ("billing_cancellation_feedback"."recorded_on" < ((now() AT TIME ZONE 'America/Sao_Paulo')::date - interval '12 months'));--> statement-breakpoint
CREATE POLICY "billing_cancellation_feedback_privacy_owner_delete" ON "billing_cancellation_feedback" AS PERMISSIVE FOR DELETE TO "polaris_privacy_owner" USING ("billing_cancellation_feedback"."recorded_on" < ((now() AT TIME ZONE 'America/Sao_Paulo')::date - interval '12 months'));--> statement-breakpoint
-- the reason of a cancelled renewal: forced row security, nobody else
ALTER TABLE public.billing_cancellation_feedback FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE public.billing_cancellation_feedback FROM PUBLIC, polaris_pr11_runtime;--> statement-breakpoint
-- the billing role writes the text, the state and the cycle (the ID and the day are the defaults) and reads nothing back
GRANT INSERT (reason, state, cycle_months) ON TABLE public.billing_cancellation_feedback TO polaris_billing_runtime;--> statement-breakpoint
GRANT SELECT (id, recorded_on, reason, state, cycle_months) ON TABLE public.billing_cancellation_feedback TO polaris_admin_owner;--> statement-breakpoint
GRANT SELECT (id, recorded_on), DELETE ON TABLE public.billing_cancellation_feedback TO polaris_privacy_owner;--> statement-breakpoint
-- what the billing role records on the record for the owner (§7 of design t268): only it writes the new columns
GRANT UPDATE (
  price_amount, price_id, first_charge_on, first_charge_at, first_charge_amount, first_charge_event_id,
  refund_requested_at, refund_request_id, provider_command_at, provider_commands_hour_start, provider_commands_hour,
  refund_rearm_attempts, refund_rearm_at
) ON TABLE public.organization_billing TO polaris_billing_runtime;--> statement-breakpoint
-- the Admin owner reads three of them, for `admin_read_refund_window` (ADR 0104, decision 8), and no other
GRANT SELECT (first_charge_at, first_charge_amount, refund_requested_at) ON TABLE public.organization_billing TO polaris_admin_owner;--> statement-breakpoint
-- the owner of the cap on the audit of the owner's refused requests: it reads only those three types of the audit
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'polaris_billing_audit_owner') THEN
    EXECUTE 'CREATE ROLE polaris_billing_audit_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
  END IF;
  -- a role that already existed gets the same attributes: it counts audit rows and is never a login
  -- no NOSUPERUSER here: PostgreSQL refuses it to a role that is not a superuser itself (Neon), and a role made by one never is;
  -- the check below keeps the guarantee
  EXECUTE 'ALTER ROLE polaris_billing_audit_owner NOLOGIN NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'polaris_billing_audit_owner' AND rolsuper) THEN
    RAISE EXCEPTION 'polaris_billing_audit_owner must not be a superuser';
  END IF;
END
$roles$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO polaris_billing_audit_owner;--> statement-breakpoint
GRANT SELECT (organization_id, event_type, created_at) ON TABLE public.tenant_audit_event TO polaris_billing_audit_owner;--> statement-breakpoint
CREATE POLICY tenant_audit_event_billing_audit_owner_select ON public.tenant_audit_event
  AS PERMISSIVE FOR SELECT TO polaris_billing_audit_owner
  USING (event_type IN ('billing.command_rate_limited', 'billing.command_in_progress', 'billing.command_refused'));--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO polaris_billing_audit_owner;--> statement-breakpoint
GRANT polaris_billing_audit_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
SET ROLE polaris_billing_audit_owner;--> statement-breakpoint
-- At most 10 rows per type, store and hour of the three refusal types of the owner's requests (ADR 0104, decision 3):
-- above that the row is dropped in silence (NULL), so an `INSERT … ON CONFLICT DO NOTHING` without RETURNING just
-- writes nothing. The advisory lock of (store, type), in the two-integer form with a class of its own (never the
-- one-key lock of `withOrganizationLock`), makes the count exact under concurrency: a second insert waits for the
-- first to commit and then counts it. An accepted request is never looked at: the trigger fires only for the three.
CREATE FUNCTION public.cap_billing_command_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  recent bigint;
BEGIN
  IF NEW.event_type IS NULL
     OR NEW.event_type NOT IN ('billing.command_rate_limited', 'billing.command_in_progress', 'billing.command_refused') THEN
    RETURN NEW;
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(104003, pg_catalog.hashtext(NEW.organization_id || ':' || NEW.event_type));
  SELECT pg_catalog.count(*) INTO recent
    FROM public.tenant_audit_event AS audit
   WHERE audit.organization_id = NEW.organization_id
     AND audit.event_type = NEW.event_type
     AND audit.created_at > pg_catalog.now() - interval '1 hour';
  IF recent >= 10 THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.cap_billing_command_audit() FROM PUBLIC;--> statement-breakpoint
-- the migrator creates the trigger below (42501 on Neon without it), as 0095 does for the sync triggers
GRANT EXECUTE ON FUNCTION public.cap_billing_command_audit() TO SESSION_USER;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_billing_audit_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_billing_audit_owner;--> statement-breakpoint
CREATE TRIGGER tenant_audit_event_billing_command_cap
  BEFORE INSERT ON public.tenant_audit_event
  FOR EACH ROW
  WHEN (NEW.event_type IN ('billing.command_rate_limited', 'billing.command_in_progress', 'billing.command_refused'))
  EXECUTE FUNCTION public.cap_billing_command_audit();--> statement-breakpoint
-- like the guards of 0080: it fires under session_replication_role = replica too
ALTER TABLE public.tenant_audit_event ENABLE ALWAYS TRIGGER tenant_audit_event_billing_command_cap;--> statement-breakpoint
-- the operational incident of a refund still pending (ADR 0104, decision 6; ADR 0085): the outbox owner owns the table
GRANT CREATE ON SCHEMA public TO polaris_outbox_owner;--> statement-breakpoint
GRANT polaris_outbox_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
SET ROLE polaris_outbox_owner;--> statement-breakpoint
-- One row for the cause, as every incident: each store whose refund is still not completed 24 hours after the owner's
-- request adds one occurrence (the billing role calls this once per store and request, after writing that request's
-- ledger row) and moves `last_reference` to that ledger row, which names the store. No store, no amount, no reference
-- of the provider here.
CREATE FUNCTION public.record_billing_refund_pending_incident(p_event uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
BEGIN
  IF p_event IS NULL THEN
    RAISE EXCEPTION 'invalid_billing_refund_pending_incident' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.operational_incidents AS incident (kind, cause, subject, last_reference)
  VALUES ('billing_refund_pending', 'refund_not_completed', 'billing.refund_pending', p_event::text)
  ON CONFLICT (kind, cause, subject) DO UPDATE
     SET occurrence_count = incident.occurrence_count + 1,
         last_seen_at = pg_catalog.now(),
         last_reference = EXCLUDED.last_reference;
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.record_billing_refund_pending_incident(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.record_billing_refund_pending_incident(uuid) TO polaris_billing_runtime;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_outbox_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_outbox_owner;--> statement-breakpoint
-- the reasons past 12 months leave with the privacy maintenance (retention class `billing_cancellation_feedback`)
GRANT CREATE ON SCHEMA public TO polaris_privacy_owner;--> statement-breakpoint
GRANT polaris_privacy_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
SET ROLE polaris_privacy_owner;--> statement-breakpoint
-- The day counts in São Paulo, as `recorded_on` is written: a reason recorded on 10/10/2025 leaves on 11/10/2026.
CREATE FUNCTION public.expire_billing_cancellation_feedback(p_limit integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  removed integer;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 10000 THEN
    RAISE EXCEPTION 'invalid_limit' USING ERRCODE = '22023';
  END IF;
  WITH due AS (
    SELECT feedback.id
      FROM public.billing_cancellation_feedback AS feedback
     WHERE feedback.recorded_on < (pg_catalog.timezone('America/Sao_Paulo', pg_catalog.now()))::date - interval '12 months'
     ORDER BY feedback.recorded_on, feedback.id
     LIMIT p_limit
  )
  DELETE FROM public.billing_cancellation_feedback AS feedback
   USING due
   WHERE feedback.id = due.id;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.expire_billing_cancellation_feedback(integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.expire_billing_cancellation_feedback(integer) TO polaris_privacy_runtime;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_privacy_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_privacy_owner;--> statement-breakpoint
-- the operator's read of the window of a refund (ADR 0104, decision 8)
GRANT CREATE ON SCHEMA public TO polaris_admin_owner;--> statement-breakpoint
GRANT polaris_admin_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
SET ROLE polaris_admin_owner;--> statement-breakpoint
-- What the operator checks a refund asked by e-mail against (Pix, rule (b) of decision 8): the first charge, its
-- amount, the owner's request, the state, the method and the database's clock, and nothing else (no reference or ID of
-- the provider, no price ID, no payer, no e-mail) and no verdict: the Admin computes the window with the same
-- `refundWindowOf` as the product. Only an active operator, under an open case of the same store; a closed case, a
-- case of another store and an inactive operator get the same refusal (42501) and leave no audit row. An exception to
-- "a diagnosis is not audited" (ADR 0071): the read decides money, so it is tied to a case and audited in the same
-- transaction.
CREATE FUNCTION public.admin_read_refund_window(p_principal uuid, p_case uuid, p_organization text)
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
  SELECT billing.state, billing.provider, billing.first_charge_at, billing.first_charge_amount, billing.refund_requested_at
    INTO found_state, found_provider, found_first_charge_at, found_first_charge_amount, found_refund_requested_at
    FROM public.organization_billing AS billing
   WHERE billing.organization_id = p_organization;
  PERFORM public.admin_record_audit(
    p_principal, 'billing.refund_window_read', p_organization, p_case, 'organization', p_organization,
    'leitura da janela de reembolso'
  );
  RETURN pg_catalog.jsonb_build_object(
    'firstChargeAt', found_first_charge_at,
    'firstChargeAmount', found_first_charge_amount::text,
    'method', CASE found_provider WHEN 'asaas' THEN 'card' WHEN 'woovi' THEN 'pix_automatic' END,
    'now', pg_catalog.now(),
    'refundRequestedAt', found_refund_requested_at,
    'state', COALESCE(found_state, 'free')
  );
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.admin_read_refund_window(uuid, uuid, text) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_privacy_runtime, polaris_outbox_runtime, polaris_auth_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.admin_read_refund_window(uuid, uuid, text) TO polaris_admin_runtime;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_admin_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_admin_owner;--> statement-breakpoint
-- The end state, as 0095 checks its own (a REVOKE or an ALTER without the right is only a WARNING on Neon): the four new
-- functions have their owners, no owner keeps CREATE on public, and the migrator keeps no SET or INHERIT on them.
DO $end_state$
BEGIN
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS p
       WHERE (p.oid = 'public.cap_billing_command_audit()'::regprocedure AND p.proowner = 'polaris_billing_audit_owner'::regrole)
          OR (p.oid = 'public.record_billing_refund_pending_incident(uuid)'::regprocedure AND p.proowner = 'polaris_outbox_owner'::regrole)
          OR (p.oid = 'public.expire_billing_cancellation_feedback(integer)'::regprocedure AND p.proowner = 'polaris_privacy_owner'::regrole)
          OR (p.oid = 'public.admin_read_refund_window(uuid, uuid, text)'::regprocedure AND p.proowner = 'polaris_admin_owner'::regrole)) <> 4 THEN
    RAISE EXCEPTION 'the new functions do not have their owners';
  END IF;
  IF pg_catalog.has_schema_privilege('polaris_billing_audit_owner', 'public', 'CREATE')
     OR pg_catalog.has_schema_privilege('polaris_outbox_owner', 'public', 'CREATE')
     OR pg_catalog.has_schema_privilege('polaris_privacy_owner', 'public', 'CREATE')
     OR pg_catalog.has_schema_privilege('polaris_admin_owner', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'an owner role kept CREATE on schema public';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members AS m
     WHERE m.member = (SELECT r.oid FROM pg_catalog.pg_roles AS r WHERE r.rolname = CURRENT_USER)
       AND m.roleid IN ('polaris_billing_audit_owner'::regrole, 'polaris_outbox_owner'::regrole,
                        'polaris_privacy_owner'::regrole, 'polaris_admin_owner'::regrole)
       AND (m.set_option OR m.inherit_option)
  ) THEN
    RAISE EXCEPTION 'the migrator kept SET or INHERIT on an owner role';
  END IF;
END
$end_state$;--> statement-breakpoint
-- the migrator runs the pending migrations in one transaction: the timeout of this one stops here
RESET lock_timeout;
