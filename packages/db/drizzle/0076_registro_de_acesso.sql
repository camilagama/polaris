-- The record of access to the application (plan POL-80, ADR 0092): date, time and IP of every login, logout, failed
-- login and daily refresh of a session, kept for the 6 months of the Marco Civil da Internet, art. 15. A table of its own
-- (the session row holds the IP only until it expires, and `auth_security_audit_event` holds none), without an
-- organization and without a foreign key to the user, so a row outlives both. Append-only: a trigger refuses UPDATE,
-- DELETE and TRUNCATE for every role. No runtime role has a privilege on the table. The authentication runtime executes
-- one function that appends a row (it returns a result code and never raises on a bad input, so a failed write cannot
-- break a login), and the Admin runtime executes one function that reads it for a court order and writes the platform audit in
-- the same transaction; both belong to a role that is never a login. The audit CHECK only gains one allowed event.
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'polaris_access_log_owner') THEN
    EXECUTE 'CREATE ROLE polaris_access_log_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
  END IF;
  -- a role that already existed gets the same attributes: this one reads the IPs and is never a login
  EXECUTE 'ALTER ROLE polaris_access_log_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
END
$roles$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO polaris_access_log_owner;--> statement-breakpoint
CREATE TABLE "auth_access_log" (
	"event" text NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"ip" "inet" NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"request_id" text NOT NULL,
	"user_id" text,
	CONSTRAINT "auth_access_log_event_allowed" CHECK ("auth_access_log"."event" IN ('login_succeeded', 'login_failed', 'logout', 'session_refreshed')),
	CONSTRAINT "auth_access_log_user_required" CHECK ("auth_access_log"."user_id" IS NOT NULL OR "auth_access_log"."event" = 'login_failed'),
	CONSTRAINT "auth_access_log_user_format" CHECK ("auth_access_log"."user_id" IS NULL OR "auth_access_log"."user_id" ~ '^[A-Za-z0-9_-]{1,64}$'),
	CONSTRAINT "auth_access_log_request_format" CHECK ("auth_access_log"."request_id" ~ '^[A-Za-z0-9_-]{1,64}$')
);
--> statement-breakpoint
ALTER TABLE "auth_access_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "platform_audit_events" DROP CONSTRAINT "platform_audit_events_type_allowed";--> statement-breakpoint
CREATE INDEX "auth_access_log_user_occurred_idx" ON "auth_access_log" USING btree ("user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "auth_access_log_ip_occurred_idx" ON "auth_access_log" USING btree ("ip","occurred_at");--> statement-breakpoint
CREATE INDEX "auth_access_log_occurred_idx" ON "auth_access_log" USING btree ("occurred_at");--> statement-breakpoint
ALTER TABLE "platform_audit_events" ADD CONSTRAINT "platform_audit_events_type_allowed" CHECK ("platform_audit_events"."event_type" IN ('support_case.opened', 'support_case.closed', 'tenant_access.granted', 'tenant_access.revoked', 'tenant_data.customers_read', 'pii.revealed', 'organization.suspended', 'organization.reactivated', 'billing.entitlement_grant_requested', 'billing.entitlement_granted', 'billing.entitlement_revoke_requested', 'billing.entitlement_revoked', 'privacy_case.stage_recorded', 'privacy_case.action_recorded', 'operational_incident.retry', 'organization.purge_scheduled', 'organization.purge_cancelled', 'organization.purge_completed', 'organization.legal_hold_placed', 'organization.legal_hold_released', 'organization.legal_hold_reviewed', 'access_log.read'));--> statement-breakpoint
CREATE POLICY "auth_access_log_owner_insert" ON "auth_access_log" AS PERMISSIVE FOR INSERT TO "polaris_access_log_owner" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "auth_access_log_owner_select" ON "auth_access_log" AS PERMISSIVE FOR SELECT TO "polaris_access_log_owner" USING (true);--> statement-breakpoint
ALTER TABLE "auth_access_log" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE public.auth_access_log FROM PUBLIC, polaris_pr11_runtime, polaris_auth_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_admin_owner, polaris_privacy_runtime, polaris_privacy_owner, polaris_outbox_runtime, polaris_outbox_owner, polaris_purge_owner, polaris_media_cleanup_runtime, polaris_media_cleanup_owner, polaris_onboarding_runtime;--> statement-breakpoint
-- the owner appends and reads; nobody changes or deletes a row (the trigger refuses it for every role as well)
GRANT SELECT, INSERT ON TABLE public.auth_access_log TO polaris_access_log_owner;--> statement-breakpoint
CREATE FUNCTION public.auth_access_log_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  RAISE EXCEPTION 'the access log is append-only'
    USING ERRCODE = '23514';
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.auth_access_log_immutable() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER auth_access_log_no_change
  BEFORE UPDATE OR DELETE ON public.auth_access_log
  FOR EACH ROW EXECUTE FUNCTION public.auth_access_log_immutable();--> statement-breakpoint
CREATE TRIGGER auth_access_log_no_truncate
  BEFORE TRUNCATE ON public.auth_access_log
  FOR EACH STATEMENT EXECUTE FUNCTION public.auth_access_log_immutable();--> statement-breakpoint
-- ALWAYS: they fire also under session_replication_role = replica
ALTER TABLE public.auth_access_log ENABLE ALWAYS TRIGGER auth_access_log_no_change;--> statement-breakpoint
ALTER TABLE public.auth_access_log ENABLE ALWAYS TRIGGER auth_access_log_no_truncate;--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO polaris_access_log_owner;--> statement-breakpoint
GRANT polaris_access_log_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
GRANT polaris_admin_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
-- the Admin's own audit functions are the only ones the reader calls; the owner of the log is a role nobody logs in as
SET ROLE polaris_admin_owner;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.admin_require_principal(uuid) TO polaris_access_log_owner;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.admin_record_audit(uuid, text, text, uuid, text, text, text) TO polaris_access_log_owner;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
SET ROLE polaris_access_log_owner;--> statement-breakpoint
-- appends one row, with the database clock. It validates its input and answers a result code: a bad input is a code, never an
-- exception, so the caller (which runs it outside the transaction of a login, with a short time limit) has nothing to roll back.
-- The IP must be a single address (no network mask); the user is null only for a failed login
CREATE FUNCTION public.record_auth_access(p_event text, p_user text, p_ip inet, p_request text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF p_event IS NULL OR p_event NOT IN ('login_succeeded', 'login_failed', 'logout', 'session_refreshed') THEN
    RETURN 'invalid_event';
  END IF;
  IF p_user IS NULL THEN
    IF p_event <> 'login_failed' THEN
      RETURN 'invalid_user';
    END IF;
  ELSIF p_user !~ '^[A-Za-z0-9_-]{1,64}$' THEN
    RETURN 'invalid_user';
  END IF;
  IF p_ip IS NULL OR pg_catalog.masklen(p_ip) <> (CASE pg_catalog.family(p_ip) WHEN 4 THEN 32 ELSE 128 END) THEN
    RETURN 'invalid_ip';
  END IF;
  IF p_request IS NULL OR p_request !~ '^[A-Za-z0-9_-]{1,64}$' THEN
    RETURN 'invalid_request';
  END IF;
  IF p_event = 'session_refreshed' THEN
    -- a session seen from another IP is recorded when it happens, but not without a limit: the same user and IP within
    -- 10 minutes is one record (`duplicate`), and a user has at most 12 of these an hour (`rate_limited`). The lock
    -- keeps two requests of one user from counting at the same time
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('auth_access_log:' || p_user, 0));
    IF EXISTS (
      SELECT 1 FROM public.auth_access_log AS seen
       WHERE seen.user_id = p_user AND seen.event = 'session_refreshed' AND seen.ip = p_ip
         AND seen.occurred_at > pg_catalog.now() - interval '10 minutes'
    ) THEN
      RETURN 'duplicate';
    END IF;
    IF (
      SELECT pg_catalog.count(*) FROM public.auth_access_log AS seen
       WHERE seen.user_id = p_user AND seen.event = 'session_refreshed'
         AND seen.occurred_at > pg_catalog.now() - interval '1 hour'
    ) >= 12 THEN
      RETURN 'rate_limited';
    END IF;
  END IF;
  -- the instant of the insert (not of the transaction's start): a row that waited for the lock above is not older than
  -- one already committed, so the pages of a read, in the order of (occurred_at, id), miss no row
  INSERT INTO public.auth_access_log (event, user_id, ip, request_id, occurred_at)
  VALUES (p_event, p_user, p_ip, p_request, pg_catalog.clock_timestamp());
  RETURN 'recorded';
END;
$function$;--> statement-breakpoint
-- reads the log for a court order, a page at a time, oldest first. Refuses (with a result code, and nothing is audited) unless:
-- the principal is active; the reference is the number of the case in the CNJ format (NNNNNNN-DD.AAAA.J.TR.OOOO, no free
-- text, check digits right); exactly one filter is given, a user or one IP address; the window is at most 31 days; the page is 1 to 50 rows. A
-- read writes one `access_log.read` audit event in the same transaction: the filter kind, the case number and the row
-- count, the user ID as the entity when the filter is a user, and never the IP (the audit lives for years)
CREATE FUNCTION public.admin_read_auth_access_log(
  p_principal uuid,
  p_legal_reference text,
  p_user text,
  p_ip inet,
  p_from timestamp with time zone,
  p_to timestamp with time zone,
  p_limit integer,
  p_after uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  after_at timestamp with time zone;
  entries jsonb;
  row_count integer;
  has_more boolean;
  next_id uuid;
  filter_kind text;
BEGIN
  PERFORM public.admin_require_principal(p_principal);
  IF p_legal_reference IS NULL
     OR p_legal_reference !~ '^[0-9]{7}-[0-9]{2}\.[0-9]{4}\.[0-9]\.[0-9]{2}\.[0-9]{4}$' THEN
    RETURN pg_catalog.jsonb_build_object('result', 'invalid_reference');
  END IF;
  -- the check digits of the CNJ number (Resolution 65): the 20 digits with the digits DD last leave remainder 1 modulo 97
  IF (pg_catalog.substr(p_legal_reference, 1, 7) || pg_catalog.substr(p_legal_reference, 12, 4)
      || pg_catalog.substr(p_legal_reference, 17, 1) || pg_catalog.substr(p_legal_reference, 19, 2)
      || pg_catalog.substr(p_legal_reference, 22, 4) || pg_catalog.substr(p_legal_reference, 9, 2))::numeric % 97 <> 1 THEN
    RETURN pg_catalog.jsonb_build_object('result', 'invalid_reference');
  END IF;
  IF (p_user IS NULL) = (p_ip IS NULL) THEN
    RETURN pg_catalog.jsonb_build_object('result', 'invalid_filter');
  END IF;
  -- the user ID goes to the audit as the entity: an identifier of the Better Auth shape, never an e-mail, an IP or a document
  IF p_user IS NOT NULL AND p_user !~ '^[A-Za-z0-9_-]{1,64}$' THEN
    RETURN pg_catalog.jsonb_build_object('result', 'invalid_filter');
  END IF;
  IF p_ip IS NOT NULL AND pg_catalog.masklen(p_ip) <> (CASE pg_catalog.family(p_ip) WHEN 4 THEN 32 ELSE 128 END) THEN
    RETURN pg_catalog.jsonb_build_object('result', 'invalid_filter');
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to <= p_from OR p_to - p_from > interval '31 days' THEN
    RETURN pg_catalog.jsonb_build_object('result', 'invalid_window');
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 50 THEN
    RETURN pg_catalog.jsonb_build_object('result', 'invalid_page');
  END IF;
  IF p_after IS NOT NULL THEN
    SELECT log_row.occurred_at INTO after_at FROM public.auth_access_log AS log_row WHERE log_row.id = p_after;
    IF NOT FOUND THEN
      RETURN pg_catalog.jsonb_build_object('result', 'invalid_cursor');
    END IF;
  END IF;
  filter_kind := CASE WHEN p_user IS NOT NULL THEN 'user' ELSE 'ip' END;
  WITH page AS (
    SELECT log_row.id, log_row.occurred_at, log_row.event, log_row.user_id, log_row.ip, log_row.request_id
      FROM public.auth_access_log AS log_row
     WHERE log_row.occurred_at >= p_from AND log_row.occurred_at < p_to
       AND (p_user IS NULL OR log_row.user_id = p_user)
       AND (p_ip IS NULL OR log_row.ip = p_ip)
       AND (p_after IS NULL OR (log_row.occurred_at, log_row.id) > (after_at, p_after))
     ORDER BY log_row.occurred_at, log_row.id
     LIMIT p_limit + 1
  ),
  shown AS (SELECT page.* FROM page ORDER BY page.occurred_at, page.id LIMIT p_limit)
  SELECT
    COALESCE((
      SELECT pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', shown.id,
          'occurredAt', shown.occurred_at,
          'event', shown.event,
          'userId', shown.user_id,
          'ip', pg_catalog.host(shown.ip),
          'requestId', shown.request_id
        ) ORDER BY shown.occurred_at, shown.id
      ) FROM shown
    ), '[]'::jsonb),
    (SELECT pg_catalog.count(*) FROM shown),
    (SELECT pg_catalog.count(*) FROM page) > p_limit,
    (SELECT shown.id FROM shown ORDER BY shown.occurred_at DESC, shown.id DESC LIMIT 1)
    INTO entries, row_count, has_more, next_id;
  PERFORM public.admin_record_audit(
    p_principal, 'access_log.read', NULL, NULL, 'auth_access_log', p_user,
    'filter=' || filter_kind || '; reference=' || p_legal_reference || '; rows=' || row_count::text
  );
  RETURN pg_catalog.jsonb_build_object(
    'result', 'ok',
    'entries', entries,
    'next', CASE WHEN has_more THEN next_id END
  );
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.record_auth_access(text, text, inet, text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.admin_read_auth_access_log(uuid, text, text, inet, timestamp with time zone, timestamp with time zone, integer, uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.record_auth_access(text, text, inet, text) TO polaris_auth_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.admin_read_auth_access_log(uuid, text, text, inet, timestamp with time zone, timestamp with time zone, integer, uuid) TO polaris_admin_runtime;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_access_log_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE polaris_admin_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_access_log_owner;
