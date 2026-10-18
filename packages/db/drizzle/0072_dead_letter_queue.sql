-- The dead-letter queue (plan PR111, ADR 0085): operational incidents (one row per cause, with a count and the
-- first and last occurrence), the outbox events that are dead (so the Admin can send one again), the functions
-- that record them and the Admin's list, detail and retry, and the audit event of a retry. Additive: new tables,
-- policies and functions; the audit CHECK only gains one allowed event.
CREATE TABLE "operational_incidents" (
	"cause" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"kind" text NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_reference" text,
	"occurrence_count" bigint DEFAULT 1 NOT NULL,
	"subject" text NOT NULL,
	CONSTRAINT "operational_incidents_cause_unique" UNIQUE("kind","cause","subject"),
	CONSTRAINT "operational_incidents_kind_allowed" CHECK ("operational_incidents"."kind" IN ('queue_dead_letter', 'outbox_attempts_exhausted')),
	CONSTRAINT "operational_incidents_cause_allowed" CHECK (("operational_incidents"."kind" = 'queue_dead_letter' AND "operational_incidents"."cause" IN ('retries_exhausted', 'invalid_envelope', 'unknown_type', 'wrong_queue'))
        OR ("operational_incidents"."kind" = 'outbox_attempts_exhausted' AND "operational_incidents"."cause" = 'attempts_exhausted')),
	CONSTRAINT "operational_incidents_subject_format" CHECK ("operational_incidents"."subject" = 'unknown' OR ("operational_incidents"."subject" ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$' AND char_length("operational_incidents"."subject") <= 80)),
	CONSTRAINT "operational_incidents_reference_format" CHECK ("operational_incidents"."last_reference" IS NULL OR "operational_incidents"."last_reference" ~ '^[A-Za-z0-9._:-]{1,128}$'),
	CONSTRAINT "operational_incidents_count_positive" CHECK ("operational_incidents"."occurrence_count" >= 1)
);
--> statement-breakpoint
ALTER TABLE "operational_incidents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "queue_dead_letters" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"incident_id" uuid NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"occurrences" integer DEFAULT 1 NOT NULL,
	"organization_id" text NOT NULL,
	"retried_at" timestamp with time zone,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"state" text DEFAULT 'dead' NOT NULL,
	CONSTRAINT "queue_dead_letters_state_allowed" CHECK ("queue_dead_letters"."state" IN ('dead', 'retried')),
	CONSTRAINT "queue_dead_letters_state_coherent" CHECK (("queue_dead_letters"."state" = 'dead') OR ("queue_dead_letters"."state" = 'retried' AND "queue_dead_letters"."retried_at" IS NOT NULL AND "queue_dead_letters"."retry_count" >= 1)),
	CONSTRAINT "queue_dead_letters_event_type_format" CHECK ("queue_dead_letters"."event_type" ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$' AND char_length("queue_dead_letters"."event_type") <= 80),
	CONSTRAINT "queue_dead_letters_counts_allowed" CHECK ("queue_dead_letters"."occurrences" >= 1 AND "queue_dead_letters"."retry_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "queue_dead_letters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "platform_audit_events" DROP CONSTRAINT "platform_audit_events_type_allowed";--> statement-breakpoint
ALTER TABLE "queue_dead_letters" ADD CONSTRAINT "queue_dead_letters_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_dead_letters" ADD CONSTRAINT "queue_dead_letters_incident_id_operational_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."operational_incidents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "queue_dead_letters_incident_idx" ON "queue_dead_letters" USING btree ("incident_id","state","last_seen_at");--> statement-breakpoint
ALTER TABLE "platform_audit_events" ADD CONSTRAINT "platform_audit_events_type_allowed" CHECK ("platform_audit_events"."event_type" IN ('support_case.opened', 'support_case.closed', 'tenant_access.granted', 'tenant_access.revoked', 'tenant_data.customers_read', 'pii.revealed', 'organization.suspended', 'organization.reactivated', 'billing.entitlement_grant_requested', 'billing.entitlement_granted', 'billing.entitlement_revoke_requested', 'billing.entitlement_revoked', 'privacy_case.stage_recorded', 'privacy_case.action_recorded', 'operational_incident.retry'));--> statement-breakpoint
CREATE POLICY "operational_incidents_outbox_owner_all" ON "operational_incidents" AS PERMISSIVE FOR ALL TO "polaris_outbox_owner" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "operational_incidents_admin_owner_select" ON "operational_incidents" AS PERMISSIVE FOR SELECT TO "polaris_admin_owner" USING (true);--> statement-breakpoint
CREATE POLICY "queue_dead_letters_outbox_owner_all" ON "queue_dead_letters" AS PERMISSIVE FOR ALL TO "polaris_outbox_owner" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "queue_dead_letters_admin_owner_select" ON "queue_dead_letters" AS PERMISSIVE FOR SELECT TO "polaris_admin_owner" USING (true);--> statement-breakpoint
REVOKE ALL ON TABLE public.operational_incidents FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_privacy_runtime, polaris_privacy_owner, polaris_outbox_runtime;--> statement-breakpoint
REVOKE ALL ON TABLE public.queue_dead_letters FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_privacy_runtime, polaris_privacy_owner, polaris_outbox_runtime;--> statement-breakpoint
ALTER TABLE "operational_incidents" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "queue_dead_letters" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- nobody deletes an incident or a dead event through a role: the outbox owner records and updates, the Admin owner reads
GRANT SELECT, INSERT, UPDATE ON TABLE public.operational_incidents TO polaris_outbox_owner;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE public.queue_dead_letters TO polaris_outbox_owner;--> statement-breakpoint
GRANT SELECT ON TABLE public.operational_incidents TO polaris_admin_owner;--> statement-breakpoint
GRANT SELECT ON TABLE public.queue_dead_letters TO polaris_admin_owner;--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO polaris_outbox_owner, polaris_admin_owner;--> statement-breakpoint
GRANT polaris_outbox_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
GRANT polaris_admin_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
SET ROLE polaris_outbox_owner;--> statement-breakpoint
-- a message that ended in the dead-letter queue, by its cause (the event type, or "unknown" when the message did not
-- carry a valid one): one incident per cause, counted. When the message names an event the outbox holds (that
-- organization, that type) the event is also kept as dead, so it can be sent again; anything else is only counted.
-- Nothing of the message body gets here: a cause, a type, an opaque reference and the event's own IDs
CREATE FUNCTION public.record_dead_letter(p_cause text, p_subject text, p_reference text, p_event uuid, p_organization text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  incident_id uuid;
  tracked boolean := false;
BEGIN
  IF p_cause IS NULL OR p_cause NOT IN ('retries_exhausted', 'invalid_envelope', 'unknown_type', 'wrong_queue')
     OR p_subject IS NULL
     OR NOT (p_subject = 'unknown' OR (p_subject ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$' AND pg_catalog.char_length(p_subject) <= 80))
     OR (p_reference IS NOT NULL AND p_reference !~ '^[A-Za-z0-9._:-]{1,128}$') THEN
    RAISE EXCEPTION 'invalid_dead_letter' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.operational_incidents AS incident (kind, cause, subject, last_reference)
  VALUES ('queue_dead_letter', p_cause, p_subject, p_reference)
  ON CONFLICT (kind, cause, subject) DO UPDATE
     SET occurrence_count = incident.occurrence_count + 1,
         last_seen_at = pg_catalog.now(),
         last_reference = COALESCE(EXCLUDED.last_reference, incident.last_reference)
  RETURNING incident.id INTO incident_id;
  IF p_event IS NOT NULL AND p_organization IS NOT NULL AND p_subject <> 'unknown' AND EXISTS (
    SELECT 1 FROM public.event_outbox AS outbox_row
     WHERE outbox_row.id = p_event AND outbox_row.organization_id = p_organization AND outbox_row.type = p_subject
  ) THEN
    INSERT INTO public.queue_dead_letters AS dead (event_id, organization_id, event_type, incident_id)
    VALUES (p_event, p_organization, p_subject, incident_id)
    ON CONFLICT (event_id) DO UPDATE
       SET state = 'dead', occurrences = dead.occurrences + 1, last_seen_at = pg_catalog.now(),
           incident_id = EXCLUDED.incident_id
     WHERE dead.organization_id = EXCLUDED.organization_id;
    tracked := true;
  END IF;
  RETURN pg_catalog.jsonb_build_object('incident', incident_id, 'tracked', tracked);
END;
$function$;--> statement-breakpoint
-- an event past the cap of delivery attempts (1000: the dispatcher no longer claims it) is an incident as well, one
-- per event type, and a dead event the Admin can send again. Only events nobody holds now (no live claim) and not
-- already dead; an advisory lock for the whole run keeps two runs from counting one event twice (the second one
-- waits, then sees what the first recorded)
CREATE FUNCTION public.record_exhausted_outbox_events(p_limit integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  picked record;
  incident_id uuid;
  recorded integer := 0;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    RAISE EXCEPTION 'invalid_limit' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('record_exhausted_outbox_events', 0));
  FOR picked IN
    SELECT outbox_row.id, outbox_row.organization_id, outbox_row.type
      FROM public.event_outbox AS outbox_row
     WHERE outbox_row.status = 'pending'
       AND outbox_row.attempts >= 1000
       AND (outbox_row.locked_until IS NULL OR outbox_row.locked_until <= pg_catalog.now())
       AND NOT EXISTS (
         SELECT 1 FROM public.queue_dead_letters AS dead
          WHERE dead.event_id = outbox_row.id AND dead.state = 'dead'
       )
     ORDER BY outbox_row.available_at, outbox_row.id
     LIMIT p_limit
       FOR UPDATE OF outbox_row SKIP LOCKED
  LOOP
    INSERT INTO public.operational_incidents AS incident (kind, cause, subject, last_reference)
    VALUES ('outbox_attempts_exhausted', 'attempts_exhausted', picked.type, picked.id::text)
    ON CONFLICT (kind, cause, subject) DO UPDATE
       SET occurrence_count = incident.occurrence_count + 1,
           last_seen_at = pg_catalog.now(),
           last_reference = EXCLUDED.last_reference
    RETURNING incident.id INTO incident_id;
    INSERT INTO public.queue_dead_letters AS dead (event_id, organization_id, event_type, incident_id)
    VALUES (picked.id, picked.organization_id, picked.type, incident_id)
    ON CONFLICT (event_id) DO UPDATE
       SET state = 'dead', occurrences = dead.occurrences + 1, last_seen_at = pg_catalog.now(),
           incident_id = EXCLUDED.incident_id;
    recorded := recorded + 1;
  END LOOP;
  RETURN recorded;
END;
$function$;--> statement-breakpoint
-- sends a dead event again: the same outbox event goes back to pending (due now) and the dispatcher sends it in its
-- next run; the consumer and the handler absorb a duplicate. Idempotent: an event that is pending already is not
-- touched. One that is past the attempt cap starts its attempts over and forgets its processing record, so the new
-- delivery is not taken for an old one. Refused while a dispatcher run or a consumer holds it. Only the Admin's
-- function calls this one; it deletes nothing but that processing record
CREATE FUNCTION public.retry_dead_letter(p_event uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  item public.queue_dead_letters;
  outbox_row public.event_outbox;
  outcome text;
BEGIN
  -- the locks are taken in the order the recorders take them: the outbox row first, the item after
  SELECT dead.* INTO item FROM public.queue_dead_letters AS dead WHERE dead.event_id = p_event;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('result', 'unknown_item');
  END IF;
  SELECT event_row.* INTO outbox_row FROM public.event_outbox AS event_row
   WHERE event_row.id = p_event AND event_row.organization_id = item.organization_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('result', 'event_gone', 'organizationId', item.organization_id, 'eventType', item.event_type);
  END IF;
  SELECT dead.* INTO item FROM public.queue_dead_letters AS dead WHERE dead.event_id = p_event FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('result', 'unknown_item');
  END IF;
  IF outbox_row.locked_until IS NOT NULL AND outbox_row.locked_until > pg_catalog.now() THEN
    RETURN pg_catalog.jsonb_build_object('result', 'busy', 'organizationId', item.organization_id, 'eventType', item.event_type);
  END IF;
  IF outbox_row.status = 'pending' AND outbox_row.attempts < 1000 THEN
    -- already waiting to be sent (or in its delay): nothing to do, and the retry is satisfied
    outcome := 'already_pending';
  ELSE
    -- a consumer still running the event's last delivery holds it: not now
    IF EXISTS (
      SELECT 1 FROM public.queue_processing AS processing_row
       WHERE processing_row.organization_id = outbox_row.organization_id
         AND processing_row.idempotency_key = outbox_row.idempotency_key
         AND processing_row.state = 'claimed' AND processing_row.lease_until > pg_catalog.now()
    ) THEN
      RETURN pg_catalog.jsonb_build_object('result', 'busy', 'organizationId', item.organization_id, 'eventType', item.event_type);
    END IF;
    IF outbox_row.attempts >= 1000 THEN
      DELETE FROM public.queue_processing AS processing_row
       WHERE processing_row.organization_id = outbox_row.organization_id
         AND processing_row.idempotency_key = outbox_row.idempotency_key;
      UPDATE public.event_outbox SET attempts = 0 WHERE id = p_event;
    END IF;
    UPDATE public.event_outbox
       SET status = 'pending', available_at = pg_catalog.now(), locked_until = NULL
     WHERE id = p_event;
    outcome := 'retried';
  END IF;
  IF item.state = 'dead' OR outcome = 'retried' THEN
    UPDATE public.queue_dead_letters
       SET state = 'retried', retried_at = pg_catalog.now(), retry_count = item.retry_count + 1
     WHERE event_id = p_event;
  END IF;
  RETURN pg_catalog.jsonb_build_object('result', outcome, 'organizationId', item.organization_id, 'eventType', item.event_type);
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.record_dead_letter(text, text, text, uuid, text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.record_exhausted_outbox_events(integer) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.retry_dead_letter(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.record_dead_letter(text, text, text, uuid, text) TO polaris_outbox_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.record_exhausted_outbox_events(integer) TO polaris_outbox_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.retry_dead_letter(uuid) TO polaris_admin_owner;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
SET ROLE polaris_admin_owner;--> statement-breakpoint
-- the incidents, a page at a time, newest first (UUIDv7 order), with how many of their events are still dead
CREATE FUNCTION public.admin_list_operational_incidents(p_limit integer, p_after uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 50 THEN
    RAISE EXCEPTION 'invalid page size' USING ERRCODE = '22023';
  END IF;
  RETURN (
    WITH page AS (
      SELECT incident.* FROM public.operational_incidents AS incident
       WHERE p_after IS NULL OR incident.id < p_after
       ORDER BY incident.id DESC
       LIMIT p_limit + 1
    ),
    shown AS (SELECT page.* FROM page ORDER BY page.id DESC LIMIT p_limit)
    SELECT pg_catalog.jsonb_build_object(
      'incidents', COALESCE((
        SELECT pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'id', shown.id,
            'kind', shown.kind,
            'cause', shown.cause,
            'subject', shown.subject,
            'occurrenceCount', shown.occurrence_count,
            'firstSeenAt', shown.first_seen_at,
            'lastSeenAt', shown.last_seen_at,
            'lastReference', shown.last_reference,
            'deadEvents', (SELECT pg_catalog.count(*) FROM public.queue_dead_letters AS dead
                            WHERE dead.incident_id = shown.id AND dead.state = 'dead')
          ) ORDER BY shown.id DESC
        ) FROM shown
      ), '[]'::jsonb),
      'next', CASE WHEN (SELECT pg_catalog.count(*) FROM page) > p_limit
                   THEN (SELECT shown.id FROM shown ORDER BY shown.id ASC LIMIT 1) END
    )
  );
END;
$function$;--> statement-breakpoint
-- one incident and a page of its events (opaque IDs and counts only), newest ID first
CREATE FUNCTION public.admin_read_operational_incident(p_incident uuid, p_limit integer, p_after uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  incident public.operational_incidents;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 50 THEN
    RAISE EXCEPTION 'invalid page size' USING ERRCODE = '22023';
  END IF;
  SELECT found_row.* INTO incident FROM public.operational_incidents AS found_row WHERE found_row.id = p_incident;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  RETURN (
    WITH page AS (
      SELECT dead.* FROM public.queue_dead_letters AS dead
       WHERE dead.incident_id = p_incident AND (p_after IS NULL OR dead.event_id < p_after)
       ORDER BY dead.event_id DESC
       LIMIT p_limit + 1
    ),
    shown AS (SELECT page.* FROM page ORDER BY page.event_id DESC LIMIT p_limit)
    SELECT pg_catalog.jsonb_build_object(
      'incident', pg_catalog.jsonb_build_object(
        'id', incident.id,
        'kind', incident.kind,
        'cause', incident.cause,
        'subject', incident.subject,
        'occurrenceCount', incident.occurrence_count,
        'firstSeenAt', incident.first_seen_at,
        'lastSeenAt', incident.last_seen_at,
        'lastReference', incident.last_reference
      ),
      'events', COALESCE((
        SELECT pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'eventId', shown.event_id,
            'organizationId', shown.organization_id,
            'eventType', shown.event_type,
            'state', shown.state,
            'occurrences', shown.occurrences,
            'firstSeenAt', shown.first_seen_at,
            'lastSeenAt', shown.last_seen_at,
            'retriedAt', shown.retried_at,
            'retryCount', shown.retry_count
          ) ORDER BY shown.event_id DESC
        ) FROM shown
      ), '[]'::jsonb),
      'next', CASE WHEN (SELECT pg_catalog.count(*) FROM page) > p_limit
                   THEN (SELECT shown.event_id FROM shown ORDER BY shown.event_id ASC LIMIT 1) END
    )
  );
END;
$function$;--> statement-breakpoint
-- sends one dead event of an incident again, with a reason, and writes the audit in the same transaction. The audit
-- records the result as well (a repeat that finds the event pending already is recorded, and changes nothing)
CREATE FUNCTION public.admin_retry_dead_letter(p_principal uuid, p_incident uuid, p_event uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  clean_reason text := pg_catalog.btrim(p_reason);
  retried jsonb;
  outcome text;
BEGIN
  PERFORM public.admin_require_principal(p_principal);
  IF clean_reason IS NULL OR pg_catalog.char_length(clean_reason) < 1 OR pg_catalog.char_length(clean_reason) > 150
     OR clean_reason ~ '[\x01-\x1f\x7f-\x9f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]' THEN
    RAISE EXCEPTION 'invalid_incident_reason' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.queue_dead_letters AS dead WHERE dead.event_id = p_event AND dead.incident_id = p_incident
  ) THEN
    RETURN pg_catalog.jsonb_build_object('result', 'unknown_item');
  END IF;
  retried := public.retry_dead_letter(p_event);
  outcome := retried ->> 'result';
  PERFORM public.admin_record_audit(
    p_principal, 'operational_incident.retry', retried ->> 'organizationId', NULL,
    'queue_dead_letter', p_event::text, 'result=' || outcome || '; reason=' || clean_reason
  );
  RETURN pg_catalog.jsonb_build_object('result', outcome);
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.admin_list_operational_incidents(integer, uuid) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.admin_read_operational_incident(uuid, integer, uuid) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.admin_retry_dead_letter(uuid, uuid, uuid, text) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.admin_list_operational_incidents(integer, uuid) TO polaris_admin_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.admin_read_operational_incident(uuid, integer, uuid) TO polaris_admin_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.admin_retry_dead_letter(uuid, uuid, uuid, text) TO polaris_admin_runtime;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_outbox_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE polaris_admin_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_outbox_owner, polaris_admin_owner;
