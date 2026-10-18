-- The scheduler framework state (plan PR112, ADR 0086): the table first (generated), then its functions.
CREATE TABLE "scheduled_job_state" (
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"covered_at" timestamp with time zone,
	"job_id" text PRIMARY KEY NOT NULL,
	"last_failure_at" timestamp with time zone,
	"last_started_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"lease_until" timestamp with time zone,
	"token" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scheduled_job_state_job_id_format" CHECK ("scheduled_job_state"."job_id" ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$' AND length("scheduled_job_state"."job_id") <= 64),
	CONSTRAINT "scheduled_job_state_lease_coherent" CHECK (("scheduled_job_state"."token" IS NULL) = ("scheduled_job_state"."lease_until" IS NULL)),
	CONSTRAINT "scheduled_job_state_failures_non_negative" CHECK ("scheduled_job_state"."consecutive_failures" >= 0)
);
--> statement-breakpoint
ALTER TABLE "scheduled_job_state" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "scheduled_job_state_outbox_owner_all" ON "scheduled_job_state" AS PERMISSIVE FOR ALL TO "polaris_outbox_owner" USING (true) WITH CHECK (true);--> statement-breakpoint
-- The scheduler's state (plan PR112, ADR 0086): additive, one table and three functions, in the role the
-- outbox dispatcher already uses (one login, one Hyperdrive). Nothing else changes.
ALTER TABLE "scheduled_job_state" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE public.scheduled_job_state FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_admin_owner, polaris_privacy_runtime, polaris_privacy_owner, polaris_outbox_runtime;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE public.scheduled_job_state TO polaris_outbox_owner;--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO polaris_outbox_owner;--> statement-breakpoint
GRANT polaris_outbox_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
SET ROLE polaris_outbox_owner;--> statement-breakpoint
-- A tick asks for the lease of a job. It is due when the current window of its cadence (whole cadences
-- since the epoch, UTC) is later than the one the last successful run started in; then the lease is
-- taken, with a token, and the run covers every window missed. A live lease is `busy`; one that ended
-- (a run that died) is taken over and reported as `recovered`. The row lock serializes two ticks.
CREATE FUNCTION public.claim_scheduled_job(p_job text, p_cadence_seconds integer, p_lease_seconds integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  state public.scheduled_job_state;
  new_token uuid;
BEGIN
  IF p_job IS NULL OR p_job !~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$' OR pg_catalog.length(p_job) > 64
     OR p_cadence_seconds IS NULL OR p_cadence_seconds < 60 OR p_cadence_seconds > 604800
     OR p_lease_seconds IS NULL OR p_lease_seconds < 60 OR p_lease_seconds > 3600 THEN
    RAISE EXCEPTION 'invalid_claim' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.scheduled_job_state (job_id) VALUES (p_job) ON CONFLICT (job_id) DO NOTHING;
  SELECT job_row.* INTO state FROM public.scheduled_job_state AS job_row WHERE job_row.job_id = p_job FOR UPDATE;
  IF state.lease_until IS NOT NULL AND state.lease_until > pg_catalog.now() THEN
    RETURN pg_catalog.jsonb_build_object('result', 'busy');
  END IF;
  IF state.covered_at IS NOT NULL
     AND pg_catalog.floor(pg_catalog.date_part('epoch', state.covered_at) / p_cadence_seconds)
         >= pg_catalog.floor(pg_catalog.date_part('epoch', pg_catalog.now()) / p_cadence_seconds) THEN
    RETURN pg_catalog.jsonb_build_object('result', 'not_due');
  END IF;
  new_token := pg_catalog.gen_random_uuid();
  UPDATE public.scheduled_job_state
     SET token = new_token,
         lease_until = pg_catalog.now() + p_lease_seconds * interval '1 second',
         last_started_at = pg_catalog.now(),
         updated_at = pg_catalog.now()
   WHERE job_id = p_job;
  RETURN pg_catalog.jsonb_build_object(
    'result', 'claimed',
    'token', new_token,
    'recovered', state.token IS NOT NULL,
    'coveredAt', pg_catalog.date_part('epoch', state.covered_at),
    'startedAt', pg_catalog.date_part('epoch', pg_catalog.now())
  );
END;
$function$;--> statement-breakpoint
-- The run ended well: its start becomes the reference of the windows. Only the holder of the token
-- records it (a run whose lease was taken over records nothing); true when it was recorded.
CREATE FUNCTION public.complete_scheduled_job(p_job text, p_token uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  recorded integer;
BEGIN
  IF p_job IS NULL OR p_token IS NULL THEN
    RAISE EXCEPTION 'invalid_completion' USING ERRCODE = '22023';
  END IF;
  UPDATE public.scheduled_job_state
     SET covered_at = last_started_at,
         last_success_at = pg_catalog.now(),
         lease_until = NULL,
         token = NULL,
         consecutive_failures = 0,
         updated_at = pg_catalog.now()
   WHERE job_id = p_job AND token = p_token;
  GET DIAGNOSTICS recorded = ROW_COUNT;
  RETURN recorded = 1;
END;
$function$;--> statement-breakpoint
-- The run did not finish well, or had nothing to do here: the lease is given back and the windows stay
-- uncovered, so the next tick runs the job again. A failure is counted; a skip is not.
CREATE FUNCTION public.release_scheduled_job(p_job text, p_token uuid, p_failed boolean)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  released integer;
BEGIN
  IF p_job IS NULL OR p_token IS NULL OR p_failed IS NULL THEN
    RAISE EXCEPTION 'invalid_release' USING ERRCODE = '22023';
  END IF;
  UPDATE public.scheduled_job_state
     SET lease_until = NULL,
         token = NULL,
         consecutive_failures = CASE WHEN p_failed THEN consecutive_failures + 1 ELSE consecutive_failures END,
         last_failure_at = CASE WHEN p_failed THEN pg_catalog.now() ELSE last_failure_at END,
         updated_at = pg_catalog.now()
   WHERE job_id = p_job AND token = p_token;
  GET DIAGNOSTICS released = ROW_COUNT;
  RETURN released = 1;
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.claim_scheduled_job(text, integer, integer) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.complete_scheduled_job(text, uuid) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.release_scheduled_job(text, uuid, boolean) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.claim_scheduled_job(text, integer, integer) TO polaris_outbox_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.complete_scheduled_job(text, uuid) TO polaris_outbox_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.release_scheduled_job(text, uuid, boolean) TO polaris_outbox_runtime;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_outbox_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_outbox_owner;
