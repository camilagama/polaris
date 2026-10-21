-- The purge of a user who never verified the e-mail (ADR 0100 amended; design t085, P10, Q-D2, and the risk the ADR 0044
-- left open): someone creates an account by password with another person's e-mail, never verifies it, and with that
-- blocks the Google sign-in of the owner of the address (`disableImplicitLinking`). The link of the e-mail dies in a day, so
-- the account has no use after it. `purge_unverified_users(p_limit)` deletes at most `p_limit` users that meet ALL these
-- conditions together, and nobody else: the e-mail is not verified, no account other than `credential` (no Google; a
-- user with no account at all, left by a sign-up that stopped halfway, counts as credential-only), no session (of any
-- age), no membership (of any status) and created more than 24 hours ago by the database clock. One audit row per user
-- (`unverified_user_deleted` in `auth_security_audit_event`, the retention class `auth_unverified_user`): the ID of the
-- deleted user and the ID of the run, never the e-mail, the name or the IP.
-- The function belongs to a role of its own, never a login, with the least it needs: three columns of the user to choose
-- and DELETE, the column `updated_at` to take the row lock, the keys of the account, the session and the membership to
-- count them, and the insert of the audit. The accounts, sessions, devices, trial claims and closure notices of the
-- deleted user go through the foreign keys (cascade); a membership would stop the delete (restrict), and the function
-- already refuses before it. The authentication runtime is the only role that executes it (the job `auth.unverified_user_purge`
-- of the Worker): it already writes these tables for Better Auth, and the function is what holds the conditions of the job.
-- Concurrency: the candidates are chosen and locked (FOR UPDATE SKIP LOCKED) in one statement, and the conditions are read
-- AGAIN in the DELETE, a statement of its own that starts after the locks, so a session or a membership that was committed
-- in between is seen; one that comes later waits for the lock and then fails on the foreign key. Running it again changes
-- nothing: what was deleted is gone and the rest does not meet the conditions.
-- Expand only (ADR 0096): one new role, one policy, grants and a function; no table or column changes, and the previous
-- Worker never calls it. The enum value it writes was added by the previous migration, a transaction before it is used.
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'polaris_unverified_user_owner') THEN
    EXECUTE 'CREATE ROLE polaris_unverified_user_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
  END IF;
  -- a role that already existed gets the same attributes: it deletes users and is never a login
  EXECUTE 'ALTER ROLE polaris_unverified_user_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
END
$roles$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO polaris_unverified_user_owner;--> statement-breakpoint
-- the user: the three columns the conditions read, the lock of the row, and the delete (never the e-mail, never the name)
GRANT SELECT (id, email_verified, created_at), DELETE ON TABLE public."user" TO polaris_unverified_user_owner;--> statement-breakpoint
GRANT UPDATE (updated_at) ON TABLE public."user" TO polaris_unverified_user_owner;--> statement-breakpoint
GRANT SELECT (user_id, provider_id) ON TABLE public.account TO polaris_unverified_user_owner;--> statement-breakpoint
GRANT SELECT (user_id) ON TABLE public.session TO polaris_unverified_user_owner;--> statement-breakpoint
GRANT SELECT (user_id) ON TABLE public.memberships TO polaris_unverified_user_owner;--> statement-breakpoint
-- row security of the memberships: the owner reads the user of every row (one column), to know whether the user has any
CREATE POLICY memberships_unverified_user_owner_select ON public.memberships
  AS PERMISSIVE FOR SELECT TO polaris_unverified_user_owner
  USING (true);--> statement-breakpoint
GRANT INSERT (event_type, outcome, request_id, subject_id) ON TABLE public.auth_security_audit_event TO polaris_unverified_user_owner;--> statement-breakpoint
GRANT USAGE ON TYPE public.auth_security_audit_event_type, public.auth_security_audit_outcome TO polaris_unverified_user_owner;--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO polaris_unverified_user_owner;--> statement-breakpoint
GRANT polaris_unverified_user_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
SET ROLE polaris_unverified_user_owner;--> statement-breakpoint
-- Deletes at most `p_limit` (1 to 1000) users that meet every condition above, oldest first, and answers how many. A limit
-- outside the range is a bug of the caller and raises, so the job fails closed
CREATE FUNCTION public.purge_unverified_users(p_limit integer)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  v_ids text[];
  v_run text := 'unverified-user-purge:' || pg_catalog.gen_random_uuid()::text;
  v_deleted integer;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'invalid purge limit' USING ERRCODE = '22023';
  END IF;
  -- the candidates, locked in one statement; a row another transaction holds is left for the next run
  SELECT pg_catalog.array_agg(picked.id ORDER BY picked.created_at, picked.id) INTO v_ids
    FROM (
      SELECT candidate.id, candidate.created_at
        FROM public."user" AS candidate
       WHERE NOT candidate.email_verified
         AND candidate.created_at < pg_catalog.clock_timestamp() - interval '24 hours'
         AND NOT EXISTS (SELECT 1 FROM public.account AS other WHERE other.user_id = candidate.id AND other.provider_id <> 'credential')
         AND NOT EXISTS (SELECT 1 FROM public.session AS live WHERE live.user_id = candidate.id)
         AND NOT EXISTS (SELECT 1 FROM public.memberships AS member WHERE member.user_id = candidate.id)
       ORDER BY candidate.created_at, candidate.id
       LIMIT p_limit
         FOR UPDATE OF candidate SKIP LOCKED
    ) AS picked;
  IF v_ids IS NULL THEN
    RETURN 0;
  END IF;
  -- the conditions again, in a statement that starts after the locks, then the audit of exactly the rows deleted
  WITH deleted AS (
    DELETE FROM public."user" AS doomed
     WHERE doomed.id = ANY (v_ids)
       AND NOT doomed.email_verified
       AND doomed.created_at < pg_catalog.clock_timestamp() - interval '24 hours'
       AND NOT EXISTS (SELECT 1 FROM public.account AS other WHERE other.user_id = doomed.id AND other.provider_id <> 'credential')
       AND NOT EXISTS (SELECT 1 FROM public.session AS live WHERE live.user_id = doomed.id)
       AND NOT EXISTS (SELECT 1 FROM public.memberships AS member WHERE member.user_id = doomed.id)
    RETURNING doomed.id
  )
  INSERT INTO public.auth_security_audit_event (event_type, outcome, request_id, subject_id)
  SELECT 'unverified_user_deleted', 'succeeded', v_run, deleted.id FROM deleted;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.purge_unverified_users(integer) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_privacy_runtime, polaris_outbox_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.purge_unverified_users(integer) TO polaris_auth_runtime;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_unverified_user_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_unverified_user_owner;
