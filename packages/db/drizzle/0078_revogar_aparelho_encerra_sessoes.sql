-- Revoking a device ends the sessions of the browsers that used it (design t051 with the review fixes). A many-to-many
-- link `device_sessions` records which session used which device; the server writes it from the verified session, and
-- only while the device is live (the device row is locked FOR SHARE in the same statement). `end_device_sessions()`
-- runs in the transaction of the revocation and deletes the sessions linked to the revoked device (and, when asked,
-- every other session of the user but the current one), then appends `device_revoked` to the auth audit. The tenant
-- runtime still reads no session: the function belongs to a role of its own that is never a login and can only read
-- the id and user of a session, delete it, read the devices and links of the current user and append the audit.
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'polaris_device_session_owner') THEN
    EXECUTE 'CREATE ROLE polaris_device_session_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
  END IF;
  -- a role that already existed gets the same attributes: it deletes sessions and is never a login
  -- no NOSUPERUSER here: PostgreSQL refuses it to a role that is not a superuser itself (Neon), and a role made by one never is;
  -- the check below keeps the guarantee
  EXECUTE 'ALTER ROLE polaris_device_session_owner NOLOGIN NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'polaris_device_session_owner' AND rolsuper) THEN
    RAISE EXCEPTION 'polaris_device_session_owner must not be a superuser';
  END IF;
END
$roles$;--> statement-breakpoint
-- the plpgsql body below reads the new value only when it runs, which is why it can live in the same migration
ALTER TYPE "public"."auth_security_audit_event_type" ADD VALUE 'device_revoked';--> statement-breakpoint
CREATE TABLE "device_sessions" (
	"device_id" uuid NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"origin" text NOT NULL,
	"session_id" text NOT NULL,
	"user_id" text NOT NULL,
	CONSTRAINT "device_sessions_pk" PRIMARY KEY("device_id","session_id"),
	CONSTRAINT "device_sessions_origin_allowed" CHECK ("device_sessions"."origin" IN ('register', 'use'))
);
--> statement-breakpoint
ALTER TABLE "device_sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "auth_security_audit_event" ADD COLUMN "acting_device_id" uuid;--> statement-breakpoint
ALTER TABLE "auth_security_audit_event" ADD COLUMN "acting_session_id" text;--> statement-breakpoint
ALTER TABLE "auth_security_audit_event" ADD COLUMN "ended_session_count" integer;--> statement-breakpoint
ALTER TABLE "auth_security_audit_event" ADD COLUMN "subject_id" text;--> statement-breakpoint
ALTER TABLE "device_sessions" ADD CONSTRAINT "device_sessions_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_sessions" ADD CONSTRAINT "device_sessions_user_device_fk" FOREIGN KEY ("user_id","device_id") REFERENCES "public"."devices"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "device_sessions_session_idx" ON "device_sessions" USING btree ("session_id");--> statement-breakpoint
CREATE POLICY "devices_session_owner_select" ON "devices" AS PERMISSIVE FOR SELECT TO "polaris_device_session_owner" USING ("devices"."user_id" = NULLIF(current_setting('app.user_id', true), ''));--> statement-breakpoint
CREATE POLICY "device_sessions_current_user_select" ON "device_sessions" AS PERMISSIVE FOR SELECT TO "polaris_pr11_runtime" USING ("device_sessions"."user_id" = NULLIF(current_setting('app.user_id', true), ''));--> statement-breakpoint
CREATE POLICY "device_sessions_current_user_insert" ON "device_sessions" AS PERMISSIVE FOR INSERT TO "polaris_pr11_runtime" WITH CHECK ("device_sessions"."user_id" = NULLIF(current_setting('app.user_id', true), ''));--> statement-breakpoint
CREATE POLICY "device_sessions_session_owner_select" ON "device_sessions" AS PERMISSIVE FOR SELECT TO "polaris_device_session_owner" USING ("device_sessions"."user_id" = NULLIF(current_setting('app.user_id', true), ''));--> statement-breakpoint
ALTER TABLE public.device_sessions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE public.device_sessions FROM PUBLIC;--> statement-breakpoint
-- the tenant runtime reads and appends its own links (row security: the session user); it never changes or deletes one.
-- A link goes away with its session or its device (foreign key cascade); `origin` says whether the session registered
-- the device (its own device) or only used it. The auth runtime gets nothing.
GRANT SELECT, INSERT ON TABLE public.device_sessions TO polaris_pr11_runtime;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO polaris_device_session_owner;--> statement-breakpoint
-- DELETE ... WHERE reads the columns it filters on: the id and the user (and the creation time, for the fresh-session
-- rule of the option), never the token or the IP
GRANT SELECT (id, user_id, created_at), DELETE ON TABLE public.session TO polaris_device_session_owner;--> statement-breakpoint
GRANT SELECT ON TABLE public.devices, public.device_sessions TO polaris_device_session_owner;--> statement-breakpoint
GRANT INSERT ON TABLE public.auth_security_audit_event TO polaris_device_session_owner;--> statement-breakpoint
GRANT USAGE ON TYPE public.auth_security_audit_event_type, public.auth_security_audit_outcome TO polaris_device_session_owner;--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO polaris_device_session_owner;--> statement-breakpoint
GRANT polaris_device_session_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
SET ROLE polaris_device_session_owner;--> statement-breakpoint
-- Ends the sessions of a device the current user (app.user_id) already revoked, in the caller's transaction. Deletes
-- every session of the user linked to the device and, with p_end_other_sessions, every other session of the user but
-- the acting one, which must then have signed in within 15 minutes. The acting session must be a live one of the user
-- (it is the verified session of the request); the acting device is the device that session registered or, failing
-- that, the one it linked last (the links are written by the server from the verified session). Appends one
-- `device_revoked` row to the auth audit whenever the device went from live to revoked in this call
-- (p_newly_revoked), even when no session was linked to it, so a revocation by a stolen session leaves the acting
-- session and device on record; a repeated revocation is audited again only when it ends a session. A caller that
-- passes p_newly_revoked wrongly can only add audit rows about its own user (or skip one). A missing or malformed request id
-- becomes a fresh one, as the auth audit does, so it never fails the revocation.
CREATE FUNCTION public.end_device_sessions(
  p_device_id uuid,
  p_acting_session_id text,
  p_end_other_sessions boolean,
  p_newly_revoked boolean,
  p_request_id text
)
RETURNS TABLE (ended_session_count integer, ended_current_session boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  v_user text := NULLIF(pg_catalog.current_setting('app.user_id', true), '');
  v_acting_device uuid;
  v_acting_created timestamp with time zone;
  v_count integer;
  v_current boolean;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'end_device_sessions: no session user' USING ERRCODE = '42501';
  END IF;
  IF p_device_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.devices AS device
     WHERE device.id = p_device_id AND device.user_id = v_user AND device.revoked_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'end_device_sessions: not a revoked device of the user' USING ERRCODE = '42501';
  END IF;
  IF p_acting_session_id IS NULL THEN
    IF p_end_other_sessions THEN
      RAISE EXCEPTION 'end_device_sessions: ending the other sessions needs the acting session' USING ERRCODE = '22023';
    END IF;
  ELSE
    SELECT acting.created_at INTO v_acting_created
      FROM public.session AS acting
     WHERE acting.id = p_acting_session_id AND acting.user_id = v_user;
    IF NOT FOUND THEN
      -- ended meanwhile (a logout, another revocation) or never the user's: the caller answers as a lost session
      RAISE EXCEPTION 'end_device_sessions: the acting session is not a live session of the user' USING ERRCODE = 'PD001';
    END IF;
    -- ending every other session needs a session signed in within 15 minutes, also here, so the option is not a way
    -- to sign a user out everywhere for whoever can run SQL as the tenant runtime
    IF p_end_other_sessions AND v_acting_created <= pg_catalog.now() - interval '15 minutes' THEN
      RAISE EXCEPTION 'end_device_sessions: ending the other sessions needs a fresh session' USING ERRCODE = 'PD002';
    END IF;
  END IF;
  -- the device the acting session uses: the one it registered (its own browser), otherwise the device it linked last
  SELECT link.device_id INTO v_acting_device
    FROM public.device_sessions AS link
   WHERE link.session_id = p_acting_session_id AND link.user_id = v_user
   ORDER BY (link.origin = 'register') DESC, link.linked_at DESC, link.device_id
   LIMIT 1;
  WITH ended AS (
    DELETE FROM public.session AS ended_session
     WHERE ended_session.user_id = v_user
       AND (
         ended_session.id IN (
           SELECT link.session_id FROM public.device_sessions AS link
            WHERE link.device_id = p_device_id AND link.user_id = v_user
         )
         OR (COALESCE(p_end_other_sessions, false) AND ended_session.id <> p_acting_session_id)
       )
    RETURNING ended_session.id
  )
  SELECT pg_catalog.count(*)::integer,
         COALESCE(pg_catalog.bool_or(ended.id = p_acting_session_id), false)
    INTO v_count, v_current
    FROM ended;
  IF v_count > 0 OR COALESCE(p_newly_revoked, false) THEN
    INSERT INTO public.auth_security_audit_event
      (event_type, outcome, actor_id, request_id, subject_id, ended_session_count, acting_session_id, acting_device_id)
    VALUES (
      'device_revoked', 'succeeded', v_user,
      CASE WHEN p_request_id ~ '^[A-Za-z0-9_-]{1,64}$' THEN p_request_id ELSE pg_catalog.gen_random_uuid()::text END,
      p_device_id::text, v_count, p_acting_session_id, v_acting_device
    );
  END IF;
  RETURN QUERY SELECT v_count, v_current;
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.end_device_sessions(uuid, text, boolean, boolean, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.end_device_sessions(uuid, text, boolean, boolean, text) TO polaris_pr11_runtime;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_device_session_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_device_session_owner;
