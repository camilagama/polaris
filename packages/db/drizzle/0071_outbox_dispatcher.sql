-- The outbox dispatcher and sweeper (plan PR110, ADR 0084): the dispatcher's roles, the columns it needs
-- to hold an event while it sends it, the queue consumer's durable processing record, the body keys of
-- each event type in the tenant policy, and the data export's side: a claim by ID, a delay before a failed
-- export is tried again, and the re-arm of an export event whose work is still owed. Additive: new roles,
-- columns, table, policies and functions; two export functions are replaced with the same signature.
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'polaris_outbox_owner') THEN
    EXECUTE 'CREATE ROLE polaris_outbox_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'polaris_outbox_runtime') THEN
    EXECUTE 'CREATE ROLE polaris_outbox_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
  END IF;
END
$roles$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO polaris_outbox_owner, polaris_outbox_runtime;--> statement-breakpoint
CREATE TABLE "queue_processing" (
	"attempt" integer NOT NULL,
	"event_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"lease_until" timestamp with time zone,
	"organization_id" text NOT NULL,
	"state" text NOT NULL,
	"token" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "queue_processing_organization_id_idempotency_key_pk" PRIMARY KEY("organization_id","idempotency_key"),
	CONSTRAINT "queue_processing_state_coherent" CHECK (("queue_processing"."state" = 'claimed' AND "queue_processing"."token" IS NOT NULL AND "queue_processing"."lease_until" IS NOT NULL)
        OR ("queue_processing"."state" = 'done' AND "queue_processing"."token" IS NULL AND "queue_processing"."lease_until" IS NULL)),
	CONSTRAINT "queue_processing_attempt_allowed" CHECK ("queue_processing"."attempt" BETWEEN 1 AND 1000),
	CONSTRAINT "queue_processing_key_format" CHECK ("queue_processing"."idempotency_key" ~ '^[A-Za-z0-9._:-]{1,128}$')
);
--> statement-breakpoint
ALTER TABLE "queue_processing" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "event_outbox" ADD COLUMN "dispatched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "event_outbox" ADD COLUMN "locked_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "queue_processing" ADD CONSTRAINT "queue_processing_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "queue_processing_done_idx" ON "queue_processing" USING btree ("updated_at") WHERE "queue_processing"."state" = 'done';--> statement-breakpoint
CREATE POLICY "event_outbox_outbox_owner_select" ON "event_outbox" AS PERMISSIVE FOR SELECT TO "polaris_outbox_owner" USING (true);--> statement-breakpoint
CREATE POLICY "event_outbox_outbox_owner_update" ON "event_outbox" AS PERMISSIVE FOR UPDATE TO "polaris_outbox_owner" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "event_outbox_privacy_owner_select" ON "event_outbox" AS PERMISSIVE FOR SELECT TO "polaris_privacy_owner" USING ("event_outbox"."type" = 'data_export.requested');--> statement-breakpoint
CREATE POLICY "event_outbox_privacy_owner_rearm" ON "event_outbox" AS PERMISSIVE FOR UPDATE TO "polaris_privacy_owner" USING ("event_outbox"."type" = 'data_export.requested' AND "event_outbox"."status" = 'dispatched') WITH CHECK ("event_outbox"."type" = 'data_export.requested' AND "event_outbox"."status" = 'pending');--> statement-breakpoint
CREATE POLICY "queue_processing_outbox_owner_all" ON "queue_processing" AS PERMISSIVE FOR ALL TO "polaris_outbox_owner" USING (true) WITH CHECK (true);--> statement-breakpoint
ALTER POLICY "event_outbox_tenant_insert" ON "event_outbox" TO polaris_pr11_runtime WITH CHECK (
        "event_outbox"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
        AND "event_outbox"."type" IN ('data_export.requested')
        AND "event_outbox"."status" = 'pending'
        AND "event_outbox"."attempts" = 0
        AND "event_outbox"."idempotency_key" = "event_outbox"."type" || ':' || ("event_outbox"."event" ->> 'exportId')
        AND ("event_outbox"."event" - 'exportId') = '{}'::jsonb
        AND EXISTS (
          SELECT 1
          FROM public.data_exports AS export_scope
          WHERE export_scope.id::text = "event_outbox"."event" ->> 'exportId'
            AND export_scope.organization_id = "event_outbox"."organization_id"
            AND export_scope.requested_by_user_id = NULLIF(current_setting('app.user_id', true), '')
        )
        AND EXISTS (
          SELECT 1
          FROM public.memberships AS membership_scope
          WHERE membership_scope.organization_id = "event_outbox"."organization_id"
            AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
            AND membership_scope.status = 'active'
        )
        AND EXISTS (
          SELECT 1
          FROM public.organizations AS organization_scope
          WHERE organization_scope.id = "event_outbox"."organization_id"
            AND organization_scope.status = 'active'
        ));--> statement-breakpoint
ALTER TABLE "queue_processing" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE public.queue_processing FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_admin_owner, polaris_privacy_runtime, polaris_privacy_owner, polaris_outbox_runtime;--> statement-breakpoint
REVOKE ALL ON TABLE public.event_outbox FROM polaris_outbox_runtime, polaris_admin_owner;--> statement-breakpoint
-- the dispatcher's owner reads every event and moves only its delivery state; it owns the processing record
GRANT SELECT ON TABLE public.event_outbox TO polaris_outbox_owner;--> statement-breakpoint
GRANT UPDATE (status, attempts, available_at, locked_until, dispatched_at) ON TABLE public.event_outbox TO polaris_outbox_owner;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.queue_processing TO polaris_outbox_owner;--> statement-breakpoint
-- the privacy owner sees the export events (the policy limits it to their type) and sends one back to pending
GRANT SELECT (id, organization_id, type, event, status, dispatched_at) ON TABLE public.event_outbox TO polaris_privacy_owner;--> statement-breakpoint
GRANT UPDATE (status, available_at) ON TABLE public.event_outbox TO polaris_privacy_owner;--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO polaris_outbox_owner, polaris_privacy_owner;--> statement-breakpoint
GRANT polaris_outbox_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
GRANT polaris_privacy_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
SET ROLE polaris_outbox_owner;--> statement-breakpoint
-- a run takes the due events of every organization, oldest first, and holds them while it sends; a claim
-- that outlived its run (lease over) is taken again: that is the sweep, and the event may arrive twice
CREATE FUNCTION public.claim_outbox_events(p_limit integer, p_lease_seconds integer)
RETURNS TABLE (id uuid, organization_id text, type text, event jsonb, idempotency_key text, correlation_id text, attempts integer, recovered boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 OR p_lease_seconds IS NULL OR p_lease_seconds < 60 OR p_lease_seconds > 3600 THEN
    RAISE EXCEPTION 'invalid_claim' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    WITH picked AS (
      SELECT outbox_row.id, outbox_row.locked_until IS NOT NULL AS was_held
        FROM public.event_outbox AS outbox_row
       WHERE outbox_row.status = 'pending'
         AND outbox_row.attempts < 1000
         AND ((outbox_row.locked_until IS NULL AND outbox_row.available_at <= pg_catalog.now())
              OR outbox_row.locked_until <= pg_catalog.now())
       ORDER BY outbox_row.available_at, outbox_row.id
       LIMIT p_limit
         FOR UPDATE OF outbox_row SKIP LOCKED
    )
    UPDATE public.event_outbox AS target
       SET attempts = target.attempts + 1,
           locked_until = pg_catalog.now() + p_lease_seconds * interval '1 second'
      FROM picked
     WHERE target.id = picked.id
    RETURNING target.id, target.organization_id, target.type, target.event, target.idempotency_key,
              target.correlation_id, target.attempts, picked.was_held;
END;
$function$;--> statement-breakpoint
-- only after the queue accepted them; the attempts are the fence: a run whose claim was taken again
-- marks nothing (the other run will), and a row the purge removed is simply not there
CREATE FUNCTION public.mark_outbox_events_dispatched(p_ids uuid[], p_attempts integer[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  marked integer;
BEGIN
  IF p_ids IS NULL OR p_attempts IS NULL OR pg_catalog.cardinality(p_ids) <> pg_catalog.cardinality(p_attempts)
     OR pg_catalog.cardinality(p_ids) > 100 THEN
    RAISE EXCEPTION 'invalid_batch' USING ERRCODE = '22023';
  END IF;
  UPDATE public.event_outbox AS target
     SET status = 'dispatched', dispatched_at = pg_catalog.now(), locked_until = NULL
    FROM unnest(p_ids, p_attempts) AS sent(id, attempts)
   WHERE target.id = sent.id AND target.attempts = sent.attempts
     AND target.status = 'pending' AND target.locked_until IS NOT NULL;
  GET DIAGNOSTICS marked = ROW_COUNT;
  RETURN marked;
END;
$function$;--> statement-breakpoint
-- a send that failed gives the event back, due again after its delay, with the same fence
CREATE FUNCTION public.release_outbox_events(p_ids uuid[], p_attempts integer[], p_delays integer[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  released integer;
BEGIN
  IF p_ids IS NULL OR p_attempts IS NULL OR p_delays IS NULL
     OR pg_catalog.cardinality(p_ids) <> pg_catalog.cardinality(p_attempts)
     OR pg_catalog.cardinality(p_ids) <> pg_catalog.cardinality(p_delays)
     OR pg_catalog.cardinality(p_ids) > 100
     OR EXISTS (SELECT 1 FROM pg_catalog.unnest(p_delays) AS delay(seconds) WHERE delay.seconds IS NULL OR delay.seconds < 0 OR delay.seconds > 86400) THEN
    RAISE EXCEPTION 'invalid_batch' USING ERRCODE = '22023';
  END IF;
  UPDATE public.event_outbox AS target
     SET locked_until = NULL, available_at = pg_catalog.now() + failed.seconds * interval '1 second'
    FROM unnest(p_ids, p_attempts, p_delays) AS failed(id, attempts, seconds)
   WHERE target.id = failed.id AND target.attempts = failed.attempts
     AND target.status = 'pending' AND target.locked_until IS NOT NULL;
  GET DIAGNOSTICS released = ROW_COUNT;
  RETURN released;
END;
$function$;--> statement-breakpoint
-- the consumer takes an event's key before it runs the handler: only for an event the outbox holds with
-- that organization, key and type, sent at most that many times (anything else is a forged, misrouted or
-- purged message); a delivery of an attempt already done is a duplicate; a later attempt runs again
CREATE FUNCTION public.claim_queue_processing(p_organization text, p_key text, p_type text, p_event uuid, p_attempt integer, p_lease_seconds integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  current_row public.queue_processing;
  new_token uuid := pg_catalog.gen_random_uuid();
BEGIN
  IF p_attempt IS NULL OR p_attempt < 1 OR p_attempt > 1000 OR p_lease_seconds IS NULL OR p_lease_seconds < 60 OR p_lease_seconds > 3600 THEN
    RAISE EXCEPTION 'invalid_claim' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.event_outbox AS outbox_row
     WHERE outbox_row.id = p_event AND outbox_row.organization_id = p_organization
       AND outbox_row.idempotency_key = p_key AND outbox_row.type = p_type
       AND outbox_row.attempts >= p_attempt
  ) THEN
    RETURN pg_catalog.jsonb_build_object('result', 'unknown');
  END IF;
  INSERT INTO public.queue_processing (organization_id, idempotency_key, event_id, attempt, state, token, lease_until)
  VALUES (p_organization, p_key, p_event, p_attempt, 'claimed', new_token, pg_catalog.now() + p_lease_seconds * interval '1 second')
  ON CONFLICT (organization_id, idempotency_key) DO NOTHING;
  IF FOUND THEN
    RETURN pg_catalog.jsonb_build_object('result', 'claimed', 'token', new_token);
  END IF;
  SELECT processing_row.* INTO current_row FROM public.queue_processing AS processing_row
   WHERE processing_row.organization_id = p_organization AND processing_row.idempotency_key = p_key
     FOR UPDATE;
  IF NOT FOUND OR current_row.event_id <> p_event THEN
    RETURN pg_catalog.jsonb_build_object('result', 'unknown');
  END IF;
  IF current_row.state = 'done' AND current_row.attempt >= p_attempt THEN
    RETURN pg_catalog.jsonb_build_object('result', 'done');
  END IF;
  IF current_row.state = 'claimed' AND current_row.lease_until > pg_catalog.now() THEN
    RETURN pg_catalog.jsonb_build_object('result', 'busy');
  END IF;
  UPDATE public.queue_processing
     SET state = 'claimed', token = new_token, attempt = GREATEST(current_row.attempt, p_attempt),
         lease_until = pg_catalog.now() + p_lease_seconds * interval '1 second', updated_at = pg_catalog.now()
   WHERE organization_id = p_organization AND idempotency_key = p_key;
  RETURN pg_catalog.jsonb_build_object('result', 'claimed', 'token', new_token);
END;
$function$;--> statement-breakpoint
-- the work is done: recorded for good, whoever holds the claim now
CREATE FUNCTION public.complete_queue_processing(p_organization text, p_key text, p_event uuid, p_attempt integer)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF p_attempt IS NULL OR p_attempt < 1 OR p_attempt > 1000 THEN
    RAISE EXCEPTION 'invalid_claim' USING ERRCODE = '22023';
  END IF;
  -- only a claim in progress, of this attempt or an older one (a late consumer of an older attempt does
  -- not close a newer claim), and only for an attempt the dispatcher has made: nobody records "done" ahead
  UPDATE public.queue_processing AS processing_row
     SET state = 'done', token = NULL, lease_until = NULL,
         attempt = GREATEST(processing_row.attempt, p_attempt), updated_at = pg_catalog.now()
   WHERE processing_row.organization_id = p_organization AND processing_row.idempotency_key = p_key
     AND processing_row.event_id = p_event AND processing_row.state = 'claimed'
     AND processing_row.attempt <= p_attempt
     AND EXISTS (
       SELECT 1 FROM public.event_outbox AS outbox_row
        WHERE outbox_row.id = p_event AND outbox_row.organization_id = p_organization
          AND outbox_row.attempts >= p_attempt
     );
  RETURN FOUND;
END;
$function$;--> statement-breakpoint
-- a failure gives the key back, but only the holder's claim: a slow consumer does not free another's
CREATE FUNCTION public.release_queue_processing(p_organization text, p_key text, p_token uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  DELETE FROM public.queue_processing AS processing_row
   WHERE processing_row.organization_id = p_organization AND processing_row.idempotency_key = p_key
     AND processing_row.state = 'claimed' AND processing_row.token = p_token;
  RETURN FOUND;
END;
$function$;--> statement-breakpoint
-- retention (class queue_processing): what is done, or a claim whose consumer died long ago, goes after a while
CREATE FUNCTION public.expire_queue_processing(p_keep_hours integer, p_limit integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  removed integer;
BEGIN
  IF p_keep_hours IS NULL OR p_keep_hours < 48 OR p_keep_hours > 720 OR p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'invalid_limit' USING ERRCODE = '22023';
  END IF;
  WITH due AS (
    SELECT processing_row.organization_id, processing_row.idempotency_key
      FROM public.queue_processing AS processing_row
     WHERE (processing_row.state = 'done' AND processing_row.updated_at <= pg_catalog.now() - p_keep_hours * interval '1 hour')
        OR (processing_row.state = 'claimed' AND processing_row.lease_until <= pg_catalog.now() - p_keep_hours * interval '1 hour')
     ORDER BY processing_row.updated_at
     LIMIT p_limit
       FOR UPDATE SKIP LOCKED
  )
  DELETE FROM public.queue_processing AS target
   USING due
   WHERE target.organization_id = due.organization_id AND target.idempotency_key = due.idempotency_key;
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.claim_outbox_events(integer, integer) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.mark_outbox_events_dispatched(uuid[], integer[]) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.release_outbox_events(uuid[], integer[], integer[]) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.claim_queue_processing(text, text, text, uuid, integer, integer) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.complete_queue_processing(text, text, uuid, integer) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.release_queue_processing(text, text, uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.expire_queue_processing(integer, integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.claim_outbox_events(integer, integer) TO polaris_outbox_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.mark_outbox_events_dispatched(uuid[], integer[]) TO polaris_outbox_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.release_outbox_events(uuid[], integer[], integer[]) TO polaris_outbox_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.claim_queue_processing(text, text, text, uuid, integer, integer) TO polaris_outbox_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.complete_queue_processing(text, text, uuid, integer) TO polaris_outbox_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.release_queue_processing(text, text, uuid) TO polaris_outbox_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.expire_queue_processing(integer, integer) TO polaris_outbox_runtime;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
SET ROLE polaris_privacy_owner;--> statement-breakpoint
-- a requested export is not taken before its delay (a failed run set it): a burst of messages cannot use
-- its three attempts in seconds; otherwise as before
CREATE OR REPLACE FUNCTION public.claim_data_export(p_lease_seconds integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  picked public.data_exports;
BEGIN
  IF p_lease_seconds IS NULL OR p_lease_seconds < 30 OR p_lease_seconds > 3600 THEN
    RAISE EXCEPTION 'invalid_lease' USING ERRCODE = '22023';
  END IF;
  SELECT export_row.* INTO picked
    FROM public.data_exports AS export_row
   WHERE ((export_row.status = 'requested' AND (export_row.locked_until IS NULL OR export_row.locked_until <= pg_catalog.now()))
          OR (export_row.status = 'running' AND export_row.locked_until <= pg_catalog.now()))
     AND export_row.attempts < 3
   ORDER BY export_row.requested_at, export_row.id
   LIMIT 1
     FOR UPDATE OF export_row SKIP LOCKED;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  -- a run that is tried again starts from nothing: what the one before left is not kept
  DELETE FROM public.data_export_files WHERE export_id = picked.id;
  UPDATE public.data_exports
     SET status = 'running', attempts = picked.attempts + 1, started_at = pg_catalog.now(),
         locked_until = pg_catalog.now() + p_lease_seconds * interval '1 second'
   WHERE id = picked.id;
  RETURN pg_catalog.jsonb_build_object(
    'id', picked.id, 'organizationId', picked.organization_id, 'requestedBy', picked.requested_by_user_id,
    'formats', pg_catalog.to_jsonb(picked.formats), 'attempt', picked.attempts + 1
  );
END;
$function$;--> statement-breakpoint
-- the queue consumer takes the one export its event names, by ID and organization, under the same rules
CREATE FUNCTION public.claim_data_export_by_id(p_export uuid, p_organization text, p_lease_seconds integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  picked public.data_exports;
BEGIN
  IF p_lease_seconds IS NULL OR p_lease_seconds < 30 OR p_lease_seconds > 3600 THEN
    RAISE EXCEPTION 'invalid_lease' USING ERRCODE = '22023';
  END IF;
  SELECT export_row.* INTO picked
    FROM public.data_exports AS export_row
   WHERE export_row.id = p_export AND export_row.organization_id = p_organization
     AND ((export_row.status = 'requested' AND (export_row.locked_until IS NULL OR export_row.locked_until <= pg_catalog.now()))
          OR (export_row.status = 'running' AND export_row.locked_until <= pg_catalog.now()))
     AND export_row.attempts < 3
     FOR UPDATE OF export_row SKIP LOCKED;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  DELETE FROM public.data_export_files WHERE export_id = picked.id;
  UPDATE public.data_exports
     SET status = 'running', attempts = picked.attempts + 1, started_at = pg_catalog.now(),
         locked_until = pg_catalog.now() + p_lease_seconds * interval '1 second'
   WHERE id = picked.id;
  RETURN pg_catalog.jsonb_build_object(
    'id', picked.id, 'organizationId', picked.organization_id, 'requestedBy', picked.requested_by_user_id,
    'formats', pg_catalog.to_jsonb(picked.formats), 'attempt', picked.attempts + 1
  );
END;
$function$;--> statement-breakpoint
-- a run that failed is tried again, until it has used its attempts or the failure is final; the next
-- try waits (15 minutes after the first failure, an hour after the second), whoever asks for it
CREATE OR REPLACE FUNCTION public.fail_data_export(p_export uuid, p_code text, p_final boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  target public.data_exports;
  final_failure boolean;
BEGIN
  IF p_code IS NULL OR p_code !~ '^[a-z][a-z0-9_]{0,63}$' THEN
    RAISE EXCEPTION 'invalid_error_code' USING ERRCODE = '22023';
  END IF;
  SELECT export_row.* INTO target FROM public.data_exports AS export_row
   WHERE export_row.id = p_export AND export_row.status = 'running' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'export_not_running' USING ERRCODE = '22023';
  END IF;
  final_failure := COALESCE(p_final, false) OR target.attempts >= 3;
  IF final_failure THEN
    UPDATE public.data_exports SET status = 'failed', error_code = p_code, locked_until = NULL WHERE id = p_export;
    INSERT INTO public.tenant_audit_event (organization_id, actor_user_id, entity_type, entity_id, event_type)
    VALUES (target.organization_id, target.requested_by_user_id, 'data_export', p_export::text, 'data_export.failed');
  ELSE
    UPDATE public.data_exports
       SET status = 'requested', error_code = p_code,
           locked_until = pg_catalog.now() + (15 * pg_catalog.power(4, GREATEST(target.attempts, 1) - 1))::integer * interval '1 minute'
     WHERE id = p_export;
  END IF;
  RETURN pg_catalog.jsonb_build_object('final', final_failure);
END;
$function$;--> statement-breakpoint
-- the safety net of the queue path: an export event already dispatched whose export is still owed and may
-- be taken now (a message lost or used up, or the delay of a failed run over) goes back to pending, once
-- it has had time to be delivered; the dispatcher sends it again as a new attempt
CREATE FUNCTION public.rearm_data_export_events(p_min_age_seconds integer, p_limit integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  rearmed integer;
BEGIN
  IF p_min_age_seconds IS NULL OR p_min_age_seconds < 900 OR p_min_age_seconds > 86400 OR p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'invalid_limit' USING ERRCODE = '22023';
  END IF;
  WITH owed AS (
    SELECT outbox_row.id
      FROM public.event_outbox AS outbox_row
      JOIN public.data_exports AS export_row
        ON export_row.id::text = outbox_row.event ->> 'exportId'
       AND export_row.organization_id = outbox_row.organization_id
     WHERE outbox_row.type = 'data_export.requested' AND outbox_row.status = 'dispatched'
       AND outbox_row.dispatched_at <= pg_catalog.now() - p_min_age_seconds * interval '1 second'
       AND export_row.attempts < 3
       AND ((export_row.status = 'requested' AND (export_row.locked_until IS NULL OR export_row.locked_until <= pg_catalog.now()))
            OR (export_row.status = 'running' AND export_row.locked_until <= pg_catalog.now()))
     ORDER BY outbox_row.dispatched_at, outbox_row.id
     LIMIT p_limit
       FOR UPDATE OF outbox_row SKIP LOCKED
  )
  UPDATE public.event_outbox AS target
     SET status = 'pending', available_at = pg_catalog.now()
    FROM owed
   WHERE target.id = owed.id;
  GET DIAGNOSTICS rearmed = ROW_COUNT;
  RETURN rearmed;
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.claim_data_export_by_id(uuid, text, integer) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_privacy_runtime, polaris_outbox_runtime;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.rearm_data_export_events(integer, integer) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_privacy_runtime, polaris_outbox_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.claim_data_export_by_id(uuid, text, integer) TO polaris_privacy_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.rearm_data_export_events(integer, integer) TO polaris_privacy_runtime;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_outbox_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE polaris_privacy_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_outbox_owner, polaris_privacy_owner;