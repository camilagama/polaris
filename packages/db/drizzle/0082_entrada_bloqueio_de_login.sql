-- The lock of the sign-in by password (ADR 0100, entry screen P2): 5 failures in 15 minutes lock the e-mail typed for 15
-- minutes, whether an account exists or not. One row per e-mail typed; the key is the HMAC-SHA-256 (lowercase hex) of the
-- normalized e-mail, computed by the Worker, so the table never holds an e-mail, a user ID or an IP. Nothing but
-- `polaris_login_lock_owner` has a privilege on it (RLS forced, one policy), and the six functions it owns are the whole
-- interface: the authentication runtime executes them and nothing else reaches the table. Every function takes a transaction
-- advisory lock on the key and reads the database clock (`clock_timestamp()`), so concurrent attempts of one e-mail are
-- counted one at a time and the Worker's clock never matters. The attempt is RESERVED before the password is checked
-- (`auth_login_lock_begin`), so not even a burst of parallel requests gets past 5 checks in a window; a Worker that dies
-- between `begin` and `failed` leaves the attempt counted as a failure (accepted, ADR 0100). A row lives at most one day
-- (`expire_auth_login_lock`, plus the cleanup `begin` does on its own key). New table, new role and new functions only
-- (ADR 0096): the previous Worker never calls them, so it keeps working against this migration. No enum value is added.
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'polaris_login_lock_owner') THEN
    EXECUTE 'CREATE ROLE polaris_login_lock_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
  END IF;
  -- a role that already existed gets the same attributes: this one is never a login
  EXECUTE 'ALTER ROLE polaris_login_lock_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
END
$roles$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO polaris_login_lock_owner;--> statement-breakpoint
CREATE TABLE "auth_login_lock" (
	"attempts" smallint DEFAULT 0 NOT NULL,
	"email_key" text PRIMARY KEY NOT NULL,
	"locked_until" timestamp with time zone,
	"unlock_token_expires_at" timestamp with time zone,
	"unlock_token_sha256" "bytea",
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"window_started_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_login_lock_email_key_format" CHECK ("auth_login_lock"."email_key" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "auth_login_lock_attempts_range" CHECK ("auth_login_lock"."attempts" BETWEEN 0 AND 5),
	CONSTRAINT "auth_login_lock_unlock_token_length" CHECK ("auth_login_lock"."unlock_token_sha256" IS NULL OR octet_length("auth_login_lock"."unlock_token_sha256") = 32),
	CONSTRAINT "auth_login_lock_unlock_token_coherent" CHECK (("auth_login_lock"."unlock_token_sha256" IS NULL) = ("auth_login_lock"."unlock_token_expires_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "auth_login_lock" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_login_lock_unlock_token_idx" ON "auth_login_lock" USING btree ("unlock_token_sha256") WHERE "auth_login_lock"."unlock_token_sha256" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "auth_login_lock_updated_idx" ON "auth_login_lock" USING btree ("updated_at");--> statement-breakpoint
CREATE POLICY "auth_login_lock_owner_all" ON "auth_login_lock" AS PERMISSIVE FOR ALL TO "polaris_login_lock_owner" USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE "auth_login_lock" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE public.auth_login_lock FROM PUBLIC, polaris_pr11_runtime, polaris_auth_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_admin_owner, polaris_privacy_runtime, polaris_privacy_owner, polaris_outbox_runtime, polaris_outbox_owner, polaris_purge_owner, polaris_media_cleanup_runtime, polaris_media_cleanup_owner, polaris_onboarding_runtime, polaris_billing_owner, polaris_catalog_owner, polaris_retention_owner, polaris_device_session_owner, polaris_access_log_owner;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.auth_login_lock TO polaris_login_lock_owner;--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO polaris_login_lock_owner;--> statement-breakpoint
GRANT polaris_login_lock_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
SET ROLE polaris_login_lock_owner;--> statement-breakpoint
-- reserves an attempt before the password is checked. `allowed` is false while the e-mail is locked (the seconds left are
-- `retry_after_seconds`). A lock that ended starts a new window; a window that ended zeroes the count; a count already at 5
-- with no lock (a sixth request of a burst, or one after an attempt whose failure was never recorded) locks, and only that
-- branch answers `newly_locked = true`: with `auth_login_lock_failed` it is how the caller learns that a lock began, so
-- whichever of the two writes the lock reports it, once, and the unlock e-mail goes out for it. Otherwise the attempt is
-- reserved (count + 1) and `allowed` is true.
-- A key that is not 64 lowercase hex digits is a bug of the caller, not an input to answer: it raises, so the sign-in fails closed
CREATE FUNCTION public.auth_login_lock_begin(p_key text)
RETURNS TABLE (allowed boolean, retry_after_seconds integer, newly_locked boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  now_at timestamp with time zone;
  current_row public.auth_login_lock%ROWTYPE;
  row_found boolean;
BEGIN
  IF p_key IS NULL OR p_key !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid login lock key' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('auth_login_lock:' || p_key, 0));
  now_at := pg_catalog.clock_timestamp();
  SELECT * INTO current_row FROM public.auth_login_lock AS lock_row WHERE lock_row.email_key = p_key FOR UPDATE;
  row_found := FOUND;
  IF row_found AND current_row.locked_until IS NOT NULL THEN
    IF current_row.locked_until > now_at THEN
      allowed := false;
      retry_after_seconds := pg_catalog.ceil(pg_catalog.date_part('epoch', current_row.locked_until - now_at))::integer;
      newly_locked := false;
      RETURN NEXT;
      RETURN;
    END IF;
    -- the lock ended: the row goes, and the attempt starts a new window
    DELETE FROM public.auth_login_lock AS lock_row WHERE lock_row.email_key = p_key;
    row_found := false;
  END IF;
  allowed := true;
  retry_after_seconds := 0;
  newly_locked := false;
  IF NOT row_found THEN
    INSERT INTO public.auth_login_lock (email_key, attempts, window_started_at, updated_at)
    VALUES (p_key, 1, now_at, now_at);
  ELSIF current_row.window_started_at + interval '15 minutes' <= now_at THEN
    -- the window ended: a new one, and the token of an earlier lock goes with it
    UPDATE public.auth_login_lock AS lock_row
       SET attempts = 1, window_started_at = now_at, unlock_token_sha256 = NULL,
           unlock_token_expires_at = NULL, updated_at = now_at
     WHERE lock_row.email_key = p_key;
  ELSIF current_row.attempts >= 5 THEN
    allowed := false;
    retry_after_seconds := 900;
    newly_locked := true;
    UPDATE public.auth_login_lock AS lock_row
       SET locked_until = now_at + interval '15 minutes', unlock_token_sha256 = NULL,
           unlock_token_expires_at = NULL, updated_at = now_at
     WHERE lock_row.email_key = p_key;
  ELSE
    UPDATE public.auth_login_lock AS lock_row
       SET attempts = lock_row.attempts + 1, updated_at = now_at
     WHERE lock_row.email_key = p_key;
  END IF;
  RETURN NEXT;
END;
$function$;--> statement-breakpoint
-- records the failure of a checked password: on the 5th of the window it locks the e-mail for 15 minutes and answers true
-- (the caller then sends the unlock e-mail, once, for an account that exists; a lock that `begin` wrote reports itself there). A new lock drops the token of an earlier one,
-- so there is at most one unlock e-mail per lock. Nothing to do (false) when the row is gone or the e-mail is already locked
CREATE FUNCTION public.auth_login_lock_failed(p_key text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  now_at timestamp with time zone;
  current_row public.auth_login_lock%ROWTYPE;
BEGIN
  IF p_key IS NULL OR p_key !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid login lock key' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('auth_login_lock:' || p_key, 0));
  now_at := pg_catalog.clock_timestamp();
  SELECT * INTO current_row FROM public.auth_login_lock AS lock_row WHERE lock_row.email_key = p_key FOR UPDATE;
  IF NOT FOUND OR current_row.attempts < 5
     OR (current_row.locked_until IS NOT NULL AND current_row.locked_until > now_at) THEN
    RETURN false;
  END IF;
  UPDATE public.auth_login_lock AS lock_row
     SET locked_until = now_at + interval '15 minutes', unlock_token_sha256 = NULL,
         unlock_token_expires_at = NULL, updated_at = now_at
   WHERE lock_row.email_key = p_key;
  RETURN true;
END;
$function$;--> statement-breakpoint
-- forgets the e-mail: after a successful sign-in, a 403 EMAIL_NOT_VERIFIED (the password was right) and a password reset
CREATE FUNCTION public.auth_login_lock_clear(p_key text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF p_key IS NULL OR p_key !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid login lock key' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('auth_login_lock:' || p_key, 0));
  DELETE FROM public.auth_login_lock AS lock_row WHERE lock_row.email_key = p_key;
END;
$function$;--> statement-breakpoint
-- stores the SHA-256 of an unlock token (the token never reaches the database), valid for 1 hour, only while the e-mail is
-- locked and no token was issued for this lock: false otherwise, and the caller sends no e-mail
CREATE FUNCTION public.auth_login_lock_issue_unlock(p_key text, p_token_sha256 bytea)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  now_at timestamp with time zone;
  current_row public.auth_login_lock%ROWTYPE;
BEGIN
  IF p_key IS NULL OR p_key !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid login lock key' USING ERRCODE = '22023';
  END IF;
  IF p_token_sha256 IS NULL OR pg_catalog.octet_length(p_token_sha256) <> 32 THEN
    RAISE EXCEPTION 'invalid unlock token hash' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('auth_login_lock:' || p_key, 0));
  now_at := pg_catalog.clock_timestamp();
  SELECT * INTO current_row FROM public.auth_login_lock AS lock_row WHERE lock_row.email_key = p_key FOR UPDATE;
  IF NOT FOUND OR current_row.locked_until IS NULL OR current_row.locked_until <= now_at
     OR current_row.unlock_token_sha256 IS NOT NULL THEN
    RETURN false;
  END IF;
  UPDATE public.auth_login_lock AS lock_row
     SET unlock_token_sha256 = p_token_sha256, unlock_token_expires_at = now_at + interval '1 hour', updated_at = now_at
   WHERE lock_row.email_key = p_key;
  RETURN true;
END;
$function$;--> statement-breakpoint
-- the unlock link: `unlocked` for a token that was issued and is still within its hour, `invalid` for any other (it is public
-- input, so it never raises). It lifts a lock in force and zeroes the count. The token belongs to the lock it was issued for:
-- it stays on the row for its hour, until a new window or a new lock drops it, or until `begin` deletes the row of a lock that
-- ended. Within that time the same token again answers `unlocked` and changes nothing (it never zeroes a count that grew
-- afterwards); after it the answer is `invalid`
CREATE FUNCTION public.auth_login_unlock(p_token_sha256 bytea)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  now_at timestamp with time zone;
  key_found text;
  current_row public.auth_login_lock%ROWTYPE;
BEGIN
  IF p_token_sha256 IS NULL OR pg_catalog.octet_length(p_token_sha256) <> 32 THEN
    RETURN 'invalid';
  END IF;
  SELECT lock_row.email_key INTO key_found
    FROM public.auth_login_lock AS lock_row
   WHERE lock_row.unlock_token_sha256 = p_token_sha256
     AND lock_row.unlock_token_expires_at > pg_catalog.clock_timestamp();
  IF NOT FOUND THEN
    RETURN 'invalid';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('auth_login_lock:' || key_found, 0));
  now_at := pg_catalog.clock_timestamp();
  -- read again under the lock: another request may have moved the row since the lookup
  SELECT * INTO current_row
    FROM public.auth_login_lock AS lock_row
   WHERE lock_row.email_key = key_found AND lock_row.unlock_token_sha256 = p_token_sha256
     AND lock_row.unlock_token_expires_at > now_at
     FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'invalid';
  END IF;
  IF current_row.locked_until IS NOT NULL AND current_row.locked_until > now_at THEN
    UPDATE public.auth_login_lock AS lock_row
       SET locked_until = NULL, attempts = 0, window_started_at = now_at, updated_at = now_at
     WHERE lock_row.email_key = key_found;
  END IF;
  RETURN 'unlocked';
END;
$function$;--> statement-breakpoint
-- removes the rows untouched for a day (the retention class `auth_login_lock`), and answers how many
CREATE FUNCTION public.expire_auth_login_lock()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  removed integer;
BEGIN
  DELETE FROM public.auth_login_lock AS lock_row
   WHERE lock_row.updated_at < pg_catalog.clock_timestamp() - interval '1 day';
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.auth_login_lock_begin(text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.auth_login_lock_failed(text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.auth_login_lock_clear(text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.auth_login_lock_issue_unlock(text, bytea) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.auth_login_unlock(bytea) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.expire_auth_login_lock() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.auth_login_lock_begin(text) TO polaris_auth_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.auth_login_lock_failed(text) TO polaris_auth_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.auth_login_lock_clear(text) TO polaris_auth_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.auth_login_lock_issue_unlock(text, bytea) TO polaris_auth_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.auth_login_unlock(bytea) TO polaris_auth_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.expire_auth_login_lock() TO polaris_auth_runtime;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_login_lock_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_login_lock_owner;
