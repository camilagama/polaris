-- The stop of the activation series after a complaint, the inbox of the provider's webhook and the suppression kept by
-- functions of the owner (ADR 0106, D7, D8 and D11): the database part of the Item 9, before the webhook that calls it
-- (the previous Worker never calls any of it, and `STOP_ENFORCED` stays false). Expand only (ADR 0096): three new
-- tables, one nullable column, new policies and grants, three new functions (and the trigger function of the stop's
-- guard, owned by the migrator) and two `CREATE OR REPLACE` that keep their
-- signature, owner and privileges; nothing is dropped or renamed. The runtime of billing loses the direct privileges on
-- `activation_email_suppressions` (nothing writes the table yet and the previous Worker reads it only with the series
-- switched on, which no environment does): the order of the deploy is the migration before the Worker, and a Worker
-- that calls `activation_address_suppressed` before it exists reads "function does not exist" as suppressed.
--
-- * `activation_series_stops`: a state, not an event. One row per stop and at most one active (partial unique index), so
--   a second complaint with a stop standing opens nothing. A trigger lets `released_at` go from null to a value only
--   when a row of `activation_series_stop_releases` for the same stop and the same instant exists, so not even a direct
--   UPDATE releases without the record; rows are never deleted. The candidates and the re-read read it first, before
--   the switch (`enabled_since`) and before anything else, so turning the switch off and on does not release it.
-- * `activation_series_stop_releases`: append-only (triggers refuse UPDATE, DELETE and TRUNCATE to every role, the owner
--   of the table included). `released_by` is the `session_user` of the connection, a DEFAULT the function cannot set:
--   inside SECURITY DEFINER `current_user` is always the owner; the identity of the decision is in the note.
-- * `activation_email_events`: the `svix-id` of each bounce or complaint recorded. The provider can resend an old event
--   from its panel with the same `svix-id`; without this row the complaint would stop the series again after a
--   release. The `svix-id` is an opaque identifier, not personal data, so nothing purges the table.
-- * `activation_email_suppressions.key_id`: the first 8 hexadecimal characters of an HMAC of the key's purpose, written
--   with every row so that "no row left under the old key" can be counted before the old secret leaves the Worker.
-- * `activation_record_email_event(p_event_id, p_kind, p_key_id, p_hmacs)`, billing runtime only: in one transaction,
--   the event once (a repeat answers `{"duplicate": true}` and changes nothing), one suppression per HMAC (an
--   expired row of the same address is renewed, a valid one keeps its date) and, for a complaint, the stop. An empty
--   list of HMACs (an address that cannot be normalized) still stops the series on a complaint.
-- * `activation_address_suppressed(p_current, p_current_key_id, p_previous, p_previous_key_id, p_now)`, billing runtime
--   only: whether the address is suppressed and still in force (12 months from `recorded_at`, in UTC, with the clock of
--   the caller replaced by the database's when more than 10 minutes apart, as in 0131). A row found only under the
--   previous key moves to the current one keeping its date; when both exist the older date stays and the old row goes.
--   `22023` for a current HMAC that is not 32 bytes, equal key IDs, or a malformed key ID, so a caller cannot move a row
--   to garbage in one call (a hostile Worker that holds an address's old HMAC can still move it and a hostile Worker
--   already holds the provider's key and sends without the database: this reduces the surface and the cost of a code
--   error, it does not close the door).
-- * `activation_release_stop(p_stop_id, p_note)`: executed by no role of the application, only by the owner of the
--   database through the owner of the series (the runbook). The note has 10 to 200 characters without "@" nor control
--   characters (`22023` otherwise); an id that is unknown or of a stop already released answers false.
-- * The owner of the series now owns exactly eight functions: the five of 0134 and these three.
-- Each statement on a table takes a lock: a lock not had in 10 s fails the migration instead of queueing requests.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE TABLE "activation_email_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activation_email_events_event_id_format" CHECK ("activation_email_events"."event_id" ~ '^[A-Za-z0-9_-]{8,100}$'),
	CONSTRAINT "activation_email_events_kind_allowed" CHECK ("activation_email_events"."kind" IN ('bounce', 'complaint'))
);
--> statement-breakpoint
ALTER TABLE "activation_email_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "activation_series_stop_releases" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"note" text NOT NULL,
	"released_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_by" text DEFAULT session_user NOT NULL,
	"stop_id" uuid NOT NULL,
	CONSTRAINT "activation_series_stop_releases_stop_unique" UNIQUE("stop_id"),
	CONSTRAINT "activation_series_stop_releases_note_format" CHECK (char_length("activation_series_stop_releases"."note") BETWEEN 10 AND 200 AND "activation_series_stop_releases"."note" !~ '[[:cntrl:]@]'),
	CONSTRAINT "activation_series_stop_releases_by_format" CHECK (char_length("activation_series_stop_releases"."released_by") BETWEEN 1 AND 128 AND "activation_series_stop_releases"."released_by" !~ '@')
);
--> statement-breakpoint
ALTER TABLE "activation_series_stop_releases" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "activation_series_stops" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"reason" text NOT NULL,
	"released_at" timestamp with time zone,
	"stopped_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activation_series_stops_reason_allowed" CHECK ("activation_series_stops"."reason" IN ('complaint'))
);
--> statement-breakpoint
ALTER TABLE "activation_series_stops" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "activation_email_suppressions" ADD COLUMN "key_id" text;--> statement-breakpoint
ALTER TABLE "activation_series_stop_releases" ADD CONSTRAINT "activation_series_stop_releases_stop_id_activation_series_stops_id_fk" FOREIGN KEY ("stop_id") REFERENCES "public"."activation_series_stops"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "activation_series_stops_one_active" ON "activation_series_stops" USING btree ((true)) WHERE "activation_series_stops"."released_at" IS NULL;--> statement-breakpoint
ALTER TABLE "activation_email_suppressions" ADD CONSTRAINT "activation_email_suppressions_key_id_format" CHECK ("activation_email_suppressions"."key_id" IS NULL OR "activation_email_suppressions"."key_id" ~ '^[0-9a-f]{8}$');--> statement-breakpoint
CREATE POLICY "activation_email_suppressions_owner_select" ON "activation_email_suppressions" AS PERMISSIVE FOR SELECT TO "polaris_activation_notice_owner" USING (true);--> statement-breakpoint
CREATE POLICY "activation_email_suppressions_owner_insert" ON "activation_email_suppressions" AS PERMISSIVE FOR INSERT TO "polaris_activation_notice_owner" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "activation_email_suppressions_owner_update" ON "activation_email_suppressions" AS PERMISSIVE FOR UPDATE TO "polaris_activation_notice_owner" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "activation_email_suppressions_owner_delete" ON "activation_email_suppressions" AS PERMISSIVE FOR DELETE TO "polaris_activation_notice_owner" USING (true);--> statement-breakpoint
CREATE POLICY "activation_email_events_owner_select" ON "activation_email_events" AS PERMISSIVE FOR SELECT TO "polaris_activation_notice_owner" USING (true);--> statement-breakpoint
CREATE POLICY "activation_email_events_owner_insert" ON "activation_email_events" AS PERMISSIVE FOR INSERT TO "polaris_activation_notice_owner" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "activation_series_stop_releases_owner_select" ON "activation_series_stop_releases" AS PERMISSIVE FOR SELECT TO "polaris_activation_notice_owner" USING (true);--> statement-breakpoint
CREATE POLICY "activation_series_stop_releases_owner_insert" ON "activation_series_stop_releases" AS PERMISSIVE FOR INSERT TO "polaris_activation_notice_owner" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "activation_series_stops_owner_select" ON "activation_series_stops" AS PERMISSIVE FOR SELECT TO "polaris_activation_notice_owner" USING (true);--> statement-breakpoint
CREATE POLICY "activation_series_stops_owner_insert" ON "activation_series_stops" AS PERMISSIVE FOR INSERT TO "polaris_activation_notice_owner" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "activation_series_stops_owner_update" ON "activation_series_stops" AS PERMISSIVE FOR UPDATE TO "polaris_activation_notice_owner" USING (true) WITH CHECK (true);--> statement-breakpoint
-- as the other tables of the series: the policies bind the owner of the table too
ALTER TABLE public.activation_email_events FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.activation_series_stop_releases FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.activation_series_stops FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- the guard of the stop: the instant it leaves the active state needs the record of the release, made at that same
-- instant (the function runs as the caller, the owner of the series, which reads the two columns of the release)
CREATE FUNCTION public.activation_series_stop_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $function$
BEGIN
  IF OLD.released_at IS NOT NULL OR NEW.released_at IS NULL
     OR NEW.id IS DISTINCT FROM OLD.id OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.stopped_at IS DISTINCT FROM OLD.stopped_at
     OR NOT EXISTS (SELECT 1 FROM public.activation_series_stop_releases AS release
                     WHERE release.stop_id = OLD.id AND release.released_at = NEW.released_at) THEN
    RAISE EXCEPTION 'a stop of the series is released only by activation_release_stop'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.activation_series_stop_guard() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER activation_series_stops_guard
  BEFORE UPDATE ON public.activation_series_stops
  FOR EACH ROW EXECUTE FUNCTION public.activation_series_stop_guard();--> statement-breakpoint
CREATE TRIGGER activation_series_stops_no_delete
  BEFORE DELETE ON public.activation_series_stops
  FOR EACH ROW EXECUTE FUNCTION public.audit_record_is_immutable();--> statement-breakpoint
CREATE TRIGGER activation_series_stops_no_truncate
  BEFORE TRUNCATE ON public.activation_series_stops
  FOR EACH STATEMENT EXECUTE FUNCTION public.audit_record_is_immutable();--> statement-breakpoint
CREATE TRIGGER activation_series_stop_releases_no_change
  BEFORE UPDATE OR DELETE ON public.activation_series_stop_releases
  FOR EACH ROW EXECUTE FUNCTION public.audit_record_is_immutable();--> statement-breakpoint
CREATE TRIGGER activation_series_stop_releases_no_truncate
  BEFORE TRUNCATE ON public.activation_series_stop_releases
  FOR EACH STATEMENT EXECUTE FUNCTION public.audit_record_is_immutable();--> statement-breakpoint
ALTER TABLE public.activation_series_stops ENABLE ALWAYS TRIGGER activation_series_stops_guard;--> statement-breakpoint
ALTER TABLE public.activation_series_stops ENABLE ALWAYS TRIGGER activation_series_stops_no_delete;--> statement-breakpoint
ALTER TABLE public.activation_series_stops ENABLE ALWAYS TRIGGER activation_series_stops_no_truncate;--> statement-breakpoint
ALTER TABLE public.activation_series_stop_releases ENABLE ALWAYS TRIGGER activation_series_stop_releases_no_change;--> statement-breakpoint
ALTER TABLE public.activation_series_stop_releases ENABLE ALWAYS TRIGGER activation_series_stop_releases_no_truncate;--> statement-breakpoint
REVOKE ALL ON TABLE public.activation_email_events, public.activation_series_stop_releases, public.activation_series_stops FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_privacy_runtime, polaris_outbox_runtime, polaris_auth_runtime;--> statement-breakpoint
-- the billing runtime no longer reads, records or re-keys the suppressions itself: the functions of the owner do (its
-- policies of 0124 stay, with no privilege behind them: dropping a policy is not an expand)
REVOKE ALL ON TABLE public.activation_email_suppressions FROM polaris_billing_runtime;--> statement-breakpoint
GRANT SELECT (address_hmac, reason, recorded_at, key_id) ON TABLE public.activation_email_suppressions TO polaris_activation_notice_owner;--> statement-breakpoint
GRANT INSERT (address_hmac, reason, key_id) ON TABLE public.activation_email_suppressions TO polaris_activation_notice_owner;--> statement-breakpoint
GRANT UPDATE (address_hmac, recorded_at, key_id) ON TABLE public.activation_email_suppressions TO polaris_activation_notice_owner;--> statement-breakpoint
GRANT DELETE ON TABLE public.activation_email_suppressions TO polaris_activation_notice_owner;--> statement-breakpoint
GRANT SELECT (id, stopped_at, reason, released_at) ON TABLE public.activation_series_stops TO polaris_activation_notice_owner;--> statement-breakpoint
GRANT INSERT (reason) ON TABLE public.activation_series_stops TO polaris_activation_notice_owner;--> statement-breakpoint
GRANT UPDATE (released_at) ON TABLE public.activation_series_stops TO polaris_activation_notice_owner;--> statement-breakpoint
GRANT SELECT (id, stop_id, released_at) ON TABLE public.activation_series_stop_releases TO polaris_activation_notice_owner;--> statement-breakpoint
GRANT INSERT (stop_id, note) ON TABLE public.activation_series_stop_releases TO polaris_activation_notice_owner;--> statement-breakpoint
GRANT SELECT (event_id) ON TABLE public.activation_email_events TO polaris_activation_notice_owner;--> statement-breakpoint
GRANT INSERT (event_id, kind) ON TABLE public.activation_email_events TO polaris_activation_notice_owner;--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO polaris_activation_notice_owner;--> statement-breakpoint
GRANT polaris_activation_notice_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
SET ROLE polaris_activation_notice_owner;--> statement-breakpoint
-- The candidates keep their body: the stop is read first, before the lock of the cap and the switch, so a stop that
-- stands answers nothing whatever `enabled_since` says.
CREATE OR REPLACE FUNCTION public.activation_notice_candidates(p_now timestamptz, p_limit integer)
RETURNS TABLE (organization_id text, user_id text, step text, due_at timestamptz, outcome text, truncated boolean)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  enabled timestamptz;
  local_now timestamp;
  counted integer;
BEGIN
  IF p_now IS NULL THEN
    RAISE EXCEPTION 'invalid_now' USING ERRCODE = '22023';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 50 THEN
    RAISE EXCEPTION 'invalid_limit' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.activation_series_stops AS stop WHERE stop.released_at IS NULL) THEN
    RETURN;
  END IF;
  -- one sweep at a time reads and spends the cap: the lock lasts until the caller has recorded what this returns, and
  -- a second sweep does not wait for it holding a connection of the billing role
  IF NOT pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('activation_notice_candidates', 0)) THEN
    RETURN;
  END IF;
  SELECT state.enabled_since INTO enabled FROM public.activation_series_state AS state;
  IF enabled IS NULL OR enabled > p_now THEN
    RETURN;
  END IF;
  local_now := p_now AT TIME ZONE 'America/Sao_Paulo';
  IF pg_catalog.date_part('hour', local_now) < 8 OR pg_catalog.date_part('hour', local_now) >= 12 THEN
    RETURN;
  END IF;
  SELECT pg_catalog.count(*)::integer INTO counted
    FROM public.activation_notices AS notice
   WHERE notice.skipped_reason IS NULL
     AND notice.recorded_at >= (pg_catalog.date_trunc('day', local_now) AT TIME ZONE 'America/Sao_Paulo')
     AND notice.recorded_at < ((pg_catalog.date_trunc('day', local_now) + interval '1 day') AT TIME ZONE 'America/Sao_Paulo');
  RETURN QUERY
  WITH person AS (
    SELECT store.id AS organization_id, store.created_at, founder.user_id,
           (SELECT pg_catalog.min(product.created_at) FROM public.products AS product
             WHERE product.organization_id = store.id AND product.deleted_at IS NULL) AS first_product
      FROM public.organizations AS store
      CROSS JOIN LATERAL (
        SELECT membership.user_id, membership.created_at
          FROM public.memberships AS membership
         WHERE membership.organization_id = store.id AND membership.role = 'owner' AND membership.status = 'active'
         ORDER BY membership.created_at, membership.user_id
         LIMIT 1
      ) AS founder
     WHERE store.status = 'active'
       AND store.created_at > p_now - interval '14 days' AND store.created_at <= p_now
       AND NOT EXISTS (
         SELECT 1 FROM public.memberships AS earlier
          WHERE earlier.user_id = founder.user_id AND earlier.organization_id <> store.id
            AND earlier.role = 'owner' AND earlier.status = 'active'
            AND (earlier.created_at, earlier.organization_id) < (founder.created_at, store.id)
       )
       AND NOT EXISTS (SELECT 1 FROM public.sales AS sale WHERE sale.organization_id = store.id)
       AND NOT EXISTS (
         SELECT 1 FROM public.organization_billing AS billing
          WHERE billing.organization_id = store.id
            AND (billing.trial_started_at IS NOT NULL OR billing.state <> 'free')
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.platform_internal_organizations AS internal WHERE internal.organization_id = store.id
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.support_cases AS support_case
           JOIN public.privacy_cases AS privacy_case ON privacy_case.support_case_id = support_case.id
          WHERE support_case.organization_id = store.id AND privacy_case.resolved_at IS NULL
       )
       AND NOT EXISTS (SELECT 1 FROM public.email_opt_outs AS opt_out WHERE opt_out.user_id = founder.user_id)
       AND EXISTS (SELECT 1 FROM public."user" AS account WHERE account.id = founder.user_id AND account.email_verified)
  ),
  steps AS (
    SELECT p.organization_id, p.user_id, p.created_at, 'a1'::text AS step, p.created_at + interval '24 hours' AS due_at
      FROM person AS p
     WHERE p.first_product IS NULL
    UNION ALL
    SELECT p.organization_id, p.user_id, p.created_at, 'a2'::text,
           COALESCE(p.first_product + interval '3 days', p.created_at + interval '4 days')
      FROM person AS p
    UNION ALL
    SELECT p.organization_id, p.user_id, p.created_at, 'a3'::text, p.created_at + interval '10 days'
      FROM person AS p
     WHERE EXISTS (
       SELECT 1 FROM public.activation_notices AS sent
        WHERE sent.user_id = p.user_id AND sent.step = 'a2' AND sent.sent_at IS NOT NULL
     )
  ),
  owed AS (
    SELECT s.organization_id, s.user_id, s.created_at, s.step, s.due_at,
           CASE WHEN s.created_at < enabled THEN 'series_off'
                WHEN p_now >= s.due_at + interval '3 days' THEN 'expired'
                ELSE 'due' END AS outcome
      FROM steps AS s
     WHERE s.due_at <= p_now
       AND NOT EXISTS (
         SELECT 1 FROM public.activation_notices AS recorded
          WHERE recorded.user_id = s.user_id AND recorded.step = s.step
       )
  ),
  ranked AS (
    SELECT o.*,
           pg_catalog.count(*) OVER () AS owed_count,
           CASE WHEN o.outcome = 'due' THEN pg_catalog.row_number() OVER (
             PARTITION BY o.outcome ORDER BY o.due_at, o.created_at, o.organization_id, o.step
           ) END AS due_rank
      FROM owed AS o
  ),
  kept AS (
    SELECT r.*, pg_catalog.count(*) OVER () AS kept_count
      FROM ranked AS r
     WHERE r.outcome <> 'due' OR r.due_rank <= GREATEST(60 - counted, 0)
  )
  SELECT k.organization_id, k.user_id, k.step, k.due_at, k.outcome, k.owed_count > LEAST(k.kept_count, p_limit)
    FROM kept AS k
   ORDER BY k.due_at, k.created_at, k.organization_id, k.step
   LIMIT p_limit;
END;
$function$;--> statement-breakpoint
-- The re-read keeps its body: `series_stopped` is the first code, before `expired`, once the notice is found owed.
CREATE OR REPLACE FUNCTION public.activation_notice_still_owed(p_organization text, p_notice uuid, p_now timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  clock timestamptz;
  owed_user text;
  owed_step text;
  owed_due timestamptz;
  store_created timestamptz;
  store_status text;
  store_name text;
  founder_user text;
  founder_since timestamptz;
  has_product boolean;
BEGIN
  IF p_now IS NULL THEN
    RAISE EXCEPTION 'invalid_now' USING ERRCODE = '22023';
  END IF;
  IF p_organization IS NULL OR p_notice IS NULL THEN
    RETURN NULL;
  END IF;
  clock := CASE WHEN p_now BETWEEN pg_catalog.now() - interval '10 minutes' AND pg_catalog.now() + interval '10 minutes'
                THEN p_now ELSE pg_catalog.now() END;
  SELECT notice.user_id, notice.step, notice.due_at INTO owed_user, owed_step, owed_due
    FROM public.activation_notices AS notice
   WHERE notice.id = p_notice AND notice.organization_id = p_organization
     AND notice.sent_at IS NULL AND notice.failed_at IS NULL AND notice.skipped_reason IS NULL;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM public.activation_series_stops AS stop WHERE stop.released_at IS NULL) THEN
    RETURN pg_catalog.jsonb_build_object('skip', 'series_stopped');
  END IF;
  IF clock >= owed_due + interval '3 days' THEN
    RETURN pg_catalog.jsonb_build_object('skip', 'expired');
  END IF;
  SELECT store.created_at, store.status, store.name INTO store_created, store_status, store_name
    FROM public.organizations AS store
   WHERE store.id = p_organization;
  -- a store of 14 days or more of the database's clock is out of the role's sight
  IF NOT FOUND OR store_created <= clock - interval '14 days' THEN
    RETURN pg_catalog.jsonb_build_object('skip', 'series_window_passed');
  END IF;
  IF EXISTS (SELECT 1 FROM public.sales AS sale WHERE sale.organization_id = p_organization) THEN
    RETURN pg_catalog.jsonb_build_object('skip', 'activated');
  END IF;
  IF EXISTS (SELECT 1 FROM public.email_opt_outs AS opt_out WHERE opt_out.user_id = owed_user) THEN
    RETURN pg_catalog.jsonb_build_object('skip', 'opted_out');
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.organization_billing AS billing
     WHERE billing.organization_id = p_organization
       AND (billing.trial_started_at IS NOT NULL OR billing.state <> 'free')
  ) THEN
    RETURN pg_catalog.jsonb_build_object('skip', 'billing_relation');
  END IF;
  IF store_status <> 'active' THEN
    RETURN pg_catalog.jsonb_build_object('skip', 'store_not_active');
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.support_cases AS support_case
      JOIN public.privacy_cases AS privacy_case ON privacy_case.support_case_id = support_case.id
     WHERE support_case.organization_id = p_organization AND privacy_case.resolved_at IS NULL
  ) THEN
    RETURN pg_catalog.jsonb_build_object('skip', 'privacy_request_open');
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.platform_internal_organizations AS internal WHERE internal.organization_id = p_organization
  ) THEN
    RETURN pg_catalog.jsonb_build_object('skip', 'internal_store');
  END IF;
  SELECT membership.user_id, membership.created_at INTO founder_user, founder_since
    FROM public.memberships AS membership
   WHERE membership.organization_id = p_organization AND membership.role = 'owner' AND membership.status = 'active'
   ORDER BY membership.created_at, membership.user_id
   LIMIT 1;
  IF founder_user IS DISTINCT FROM owed_user OR EXISTS (
    SELECT 1 FROM public.memberships AS earlier
     WHERE earlier.user_id = owed_user AND earlier.organization_id <> p_organization
       AND earlier.role = 'owner' AND earlier.status = 'active'
       AND (earlier.created_at, earlier.organization_id) < (founder_since, p_organization)
  ) THEN
    RETURN pg_catalog.jsonb_build_object('skip', 'not_first_owner');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public."user" AS account WHERE account.id = owed_user AND account.email_verified) THEN
    RETURN pg_catalog.jsonb_build_object('skip', 'email_not_verified');
  END IF;
  has_product := EXISTS (
    SELECT 1 FROM public.products AS product
     WHERE product.organization_id = p_organization AND product.deleted_at IS NULL
  );
  IF (owed_step = 'a1' AND has_product) OR (owed_step = 'a3' AND NOT EXISTS (
    SELECT 1 FROM public.activation_notices AS sent
     WHERE sent.user_id = owed_user AND sent.step = 'a2' AND sent.sent_at IS NOT NULL
  )) THEN
    RETURN pg_catalog.jsonb_build_object('skip', 'state_changed');
  END IF;
  RETURN pg_catalog.jsonb_build_object('step', owed_step, 'hasProduct', has_product, 'store', store_name);
END;
$function$;--> statement-breakpoint
-- Records a bounce or a complaint delivered by the provider's webhook: the event once, the suppression of each address
-- (HMAC) and, for a complaint, the stop of the series.
CREATE FUNCTION public.activation_record_email_event(p_event_id text, p_kind text, p_key_id text, p_hmacs bytea[])
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  recorded_event text;
  suppressed_count integer;
  opened_stop uuid;
  expired_before timestamptz := ((pg_catalog.now() AT TIME ZONE 'UTC') - interval '12 months') AT TIME ZONE 'UTC';
BEGIN
  IF p_event_id IS NULL OR p_event_id !~ '^[A-Za-z0-9_-]{8,100}$'
     OR p_kind IS NULL OR p_kind NOT IN ('bounce', 'complaint')
     OR p_key_id IS NULL OR p_key_id !~ '^[0-9a-f]{8}$'
     OR p_hmacs IS NULL OR pg_catalog.cardinality(p_hmacs) > 50
     OR EXISTS (SELECT 1 FROM pg_catalog.unnest(p_hmacs) AS hmac WHERE hmac IS NULL OR pg_catalog.octet_length(hmac) <> 32) THEN
    RAISE EXCEPTION 'invalid_email_event' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.activation_email_events (event_id, kind) VALUES (p_event_id, p_kind)
    ON CONFLICT (event_id) DO NOTHING
    RETURNING event_id INTO recorded_event;
  IF recorded_event IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('duplicate', true);
  END IF;
  WITH written AS (
    INSERT INTO public.activation_email_suppressions AS suppression (address_hmac, reason, key_id)
    SELECT DISTINCT hmac, p_kind, p_key_id FROM pg_catalog.unnest(p_hmacs) AS hmac
    ON CONFLICT (address_hmac, reason) DO UPDATE
      SET recorded_at = pg_catalog.now(), key_id = EXCLUDED.key_id
      WHERE suppression.recorded_at <= expired_before
    RETURNING 1
  )
  SELECT pg_catalog.count(*)::integer INTO suppressed_count FROM written;
  IF p_kind = 'complaint' THEN
    INSERT INTO public.activation_series_stops (reason) VALUES ('complaint')
      ON CONFLICT DO NOTHING
      RETURNING id INTO opened_stop;
  END IF;
  RETURN pg_catalog.jsonb_build_object(
    'duplicate', false, 'suppressed', suppressed_count, 'stopped', opened_stop IS NOT NULL
  );
END;
$function$;--> statement-breakpoint
-- Whether the address (its HMAC under the current key, and under the previous one while it is set) is suppressed and
-- still in force at `p_now`, re-keying under the current key what it finds under the previous one.
CREATE FUNCTION public.activation_address_suppressed(p_current bytea, p_current_key_id text, p_previous bytea, p_previous_key_id text, p_now timestamptz)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  clock timestamptz;
  expired_before timestamptz;
  old_row record;
BEGIN
  IF p_now IS NULL OR p_current IS NULL OR pg_catalog.octet_length(p_current) <> 32
     OR p_current_key_id IS NULL OR p_current_key_id !~ '^[0-9a-f]{8}$'
     OR (p_previous IS NULL) <> (p_previous_key_id IS NULL)
     OR (p_previous IS NOT NULL AND (
           pg_catalog.octet_length(p_previous) <> 32 OR p_previous_key_id !~ '^[0-9a-f]{8}$'
           OR p_previous_key_id = p_current_key_id OR p_previous = p_current)) THEN
    RAISE EXCEPTION 'invalid_address' USING ERRCODE = '22023';
  END IF;
  clock := CASE WHEN p_now BETWEEN pg_catalog.now() - interval '10 minutes' AND pg_catalog.now() + interval '10 minutes'
                THEN p_now ELSE pg_catalog.now() END;
  expired_before := ((clock AT TIME ZONE 'UTC') - interval '12 months') AT TIME ZONE 'UTC';
  IF p_previous IS NOT NULL THEN
    FOR old_row IN
      SELECT suppression.reason, suppression.recorded_at
        FROM public.activation_email_suppressions AS suppression
       WHERE suppression.address_hmac = p_previous AND suppression.recorded_at > expired_before
         FOR UPDATE
    LOOP
      UPDATE public.activation_email_suppressions AS current_row
         SET recorded_at = CASE WHEN current_row.recorded_at > expired_before
                                THEN LEAST(current_row.recorded_at, old_row.recorded_at)
                                ELSE old_row.recorded_at END,
             key_id = p_current_key_id
       WHERE current_row.address_hmac = p_current AND current_row.reason = old_row.reason;
      IF FOUND THEN
        DELETE FROM public.activation_email_suppressions AS previous_row
         WHERE previous_row.address_hmac = p_previous AND previous_row.reason = old_row.reason;
      ELSE
        UPDATE public.activation_email_suppressions AS previous_row
           SET address_hmac = p_current, key_id = p_current_key_id
         WHERE previous_row.address_hmac = p_previous AND previous_row.reason = old_row.reason;
      END IF;
    END LOOP;
  END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.activation_email_suppressions AS suppression
     WHERE suppression.address_hmac = p_current AND suppression.recorded_at > expired_before
  );
END;
$function$;--> statement-breakpoint
-- The one way out of a stop: the active stop `p_stop_id` and a note of 10 to 200 characters. The record of the release
-- takes the login of the connection (`session_user`) by default. The suppression of whoever complained is not touched.
CREATE FUNCTION public.activation_release_stop(p_stop_id uuid, p_note text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  locked_stop uuid;
BEGIN
  IF p_stop_id IS NULL THEN
    RETURN false;
  END IF;
  IF p_note IS NULL OR pg_catalog.char_length(p_note) NOT BETWEEN 10 AND 200 OR p_note ~ '[[:cntrl:]@]' THEN
    RAISE EXCEPTION 'invalid_note' USING ERRCODE = '22023';
  END IF;
  SELECT stop.id INTO locked_stop
    FROM public.activation_series_stops AS stop
   WHERE stop.id = p_stop_id AND stop.released_at IS NULL
     FOR UPDATE;
  IF locked_stop IS NULL THEN
    RETURN false;
  END IF;
  INSERT INTO public.activation_series_stop_releases (stop_id, note) VALUES (p_stop_id, p_note);
  UPDATE public.activation_series_stops SET released_at = pg_catalog.now() WHERE id = p_stop_id;
  RETURN true;
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.activation_record_email_event(text, text, text, bytea[]) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_privacy_runtime, polaris_outbox_runtime, polaris_auth_runtime;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.activation_address_suppressed(bytea, text, bytea, text, timestamptz) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_privacy_runtime, polaris_outbox_runtime, polaris_auth_runtime;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.activation_release_stop(uuid, text) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_privacy_runtime, polaris_outbox_runtime, polaris_auth_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.activation_record_email_event(text, text, text, bytea[]) TO polaris_billing_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.activation_address_suppressed(bytea, text, bytea, text, timestamptz) TO polaris_billing_runtime;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_activation_notice_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_activation_notice_owner;--> statement-breakpoint
-- The end state (a REVOKE without the right is only a WARNING on Neon). The owner of the series holds, on the four
-- tables above, exactly the columns granted here, and as table privileges only the DELETE of the suppressions and the
-- one of 0134, and no CREATE; it owns exactly eight functions; the billing runtime alone executes the two that record
-- and find, and nobody but the owner executes the release; no role other than the owner reaches the three new tables
-- or, besides the owner, the suppressions; the guards are `ALWAYS` triggers; and no role, the migrator included, can SET
-- or INHERIT the owner.
DO $end_state$
DECLARE
  held text[];
  fn text;
BEGIN
  SELECT COALESCE(pg_catalog.array_agg(p.entry ORDER BY p.entry COLLATE "C"), '{}')
    INTO held
    FROM (SELECT c.table_name || '.' || c.column_name || ':' || c.privilege_type AS entry
            FROM information_schema.column_privileges AS c
           WHERE c.grantee = 'polaris_activation_notice_owner'
             AND c.table_name IN ('activation_email_events', 'activation_email_suppressions',
                                  'activation_series_stop_releases', 'activation_series_stops')) AS p;
  IF held IS DISTINCT FROM ARRAY(SELECT e FROM unnest(ARRAY[
    'activation_email_events.event_id:INSERT', 'activation_email_events.event_id:SELECT',
    'activation_email_events.kind:INSERT',
    'activation_email_suppressions.address_hmac:INSERT', 'activation_email_suppressions.address_hmac:SELECT',
    'activation_email_suppressions.address_hmac:UPDATE', 'activation_email_suppressions.key_id:INSERT',
    'activation_email_suppressions.key_id:SELECT', 'activation_email_suppressions.key_id:UPDATE',
    'activation_email_suppressions.reason:INSERT', 'activation_email_suppressions.reason:SELECT',
    'activation_email_suppressions.recorded_at:SELECT', 'activation_email_suppressions.recorded_at:UPDATE',
    'activation_series_stop_releases.id:SELECT', 'activation_series_stop_releases.note:INSERT',
    'activation_series_stop_releases.released_at:SELECT', 'activation_series_stop_releases.stop_id:INSERT',
    'activation_series_stop_releases.stop_id:SELECT',
    'activation_series_stops.id:SELECT', 'activation_series_stops.reason:INSERT',
    'activation_series_stops.reason:SELECT', 'activation_series_stops.released_at:SELECT',
    'activation_series_stops.released_at:UPDATE', 'activation_series_stops.stopped_at:SELECT'
  ]::text[]) AS e ORDER BY e COLLATE "C") THEN
    RAISE EXCEPTION 'the owner of the series does not hold exactly its columns of the new tables: %', held;
  END IF;
  SELECT COALESCE(pg_catalog.array_agg(t.table_name || ':' || t.privilege_type
                                       ORDER BY t.table_name || ':' || t.privilege_type COLLATE "C"), '{}')
    INTO held
    FROM information_schema.table_privileges AS t
   WHERE t.grantee = 'polaris_activation_notice_owner';
  IF held IS DISTINCT FROM ARRAY['activation_email_suppressions:DELETE', 'email_opt_outs:DELETE']
     OR pg_catalog.has_schema_privilege('polaris_activation_notice_owner', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'the owner of the series holds more than its columns and the two DELETE: %', held;
  END IF;
  IF (SELECT pg_catalog.array_agg(p.oid::regprocedure::text ORDER BY p.oid::regprocedure::text COLLATE "C")
        FROM pg_catalog.pg_proc AS p
       WHERE p.proowner = 'polaris_activation_notice_owner'::regrole)
     IS DISTINCT FROM ARRAY(SELECT e FROM unnest(ARRAY[
       'activation_address_suppressed(bytea,text,bytea,text,timestamp with time zone)',
       'activation_email_preference(text)',
       'activation_notice_candidates(timestamp with time zone,integer)',
       'activation_notice_still_owed(text,uuid,timestamp with time zone)',
       'activation_record_email_event(text,text,text,bytea[])',
       'activation_record_opt_out(text)',
       'activation_release_stop(uuid,text)',
       'activation_set_tips(text,boolean)'
     ]::text[]) AS e ORDER BY e COLLATE "C") THEN
    RAISE EXCEPTION 'the owner of the series does not own exactly its eight functions';
  END IF;
  FOREACH fn IN ARRAY ARRAY['public.activation_record_email_event(text, text, text, bytea[])',
                            'public.activation_address_suppressed(bytea, text, bytea, text, timestamptz)'] LOOP
    IF pg_catalog.has_function_privilege('public', fn, 'EXECUTE')
       OR NOT pg_catalog.has_function_privilege('polaris_billing_runtime', fn, 'EXECUTE')
       OR EXISTS (
         SELECT 1 FROM pg_catalog.pg_roles AS r
          WHERE r.rolname LIKE 'polaris\_%' AND NOT r.rolcanlogin
            AND r.rolname NOT IN ('polaris_billing_runtime', 'polaris_activation_notice_owner')
            AND pg_catalog.has_function_privilege(r.oid, fn, 'EXECUTE')
       ) THEN
      RAISE EXCEPTION 'the function % does not have its one executor', fn;
    END IF;
  END LOOP;
  IF pg_catalog.has_function_privilege('public', 'public.activation_release_stop(uuid, text)', 'EXECUTE')
     OR EXISTS (
       SELECT 1 FROM pg_catalog.pg_roles AS r
        WHERE r.rolname LIKE 'polaris\_%' AND NOT r.rolcanlogin
          AND r.rolname <> 'polaris_activation_notice_owner'
          AND pg_catalog.has_function_privilege(r.oid, 'public.activation_release_stop(uuid, text)', 'EXECUTE')
     ) THEN
    RAISE EXCEPTION 'the release of a stop is executed by a role other than the owner of the series';
  END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(ARRAY['activation_email_events', 'activation_series_stop_releases', 'activation_series_stops',
                               'activation_email_suppressions']) AS t (name)
     CROSS JOIN (
       SELECT 'public'::text AS role
       UNION ALL
       SELECT r.rolname::text FROM pg_catalog.pg_roles AS r
        WHERE r.rolname LIKE 'polaris\_%' AND NOT r.rolcanlogin
          AND r.rolname <> 'polaris_activation_notice_owner'
     ) AS r
     WHERE pg_catalog.has_table_privilege(r.role, 'public.' || t.name, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
        OR pg_catalog.has_any_column_privilege(r.role, 'public.' || t.name, 'SELECT, INSERT, UPDATE, REFERENCES')
  ) THEN
    RAISE EXCEPTION 'a role other than the owner of the series reaches the stop, its releases, the inbox or the suppressions';
  END IF;
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger AS g
       WHERE g.tgname IN ('activation_series_stops_guard', 'activation_series_stops_no_delete',
                          'activation_series_stops_no_truncate', 'activation_series_stop_releases_no_change',
                          'activation_series_stop_releases_no_truncate')
         AND g.tgenabled = 'A') <> 5 THEN
    RAISE EXCEPTION 'the guards of the stop and of its releases are not all ALWAYS triggers';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members AS m
     WHERE m.roleid = 'polaris_activation_notice_owner'::regrole
       AND (m.set_option OR m.inherit_option)
  ) THEN
    RAISE EXCEPTION 'a role, the migrator included, can SET or INHERIT the owner of the series';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles
              WHERE rolname = 'polaris_activation_notice_owner'
                AND (rolcanlogin OR rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication OR rolinherit)) THEN
    RAISE EXCEPTION 'polaris_activation_notice_owner has an attribute it must not have';
  END IF;
END
$end_state$;--> statement-breakpoint
-- the migrator runs the pending migrations in one transaction: the timeout of this one stops here
RESET lock_timeout;
