-- Row security with FORCE on `public.session` (ADR 0093, amended; design t211, option (a)). Until now the only row limit of
-- `polaris_device_session_owner` on the sessions was the `WHERE ended_session.user_id = v_user` of `end_device_sessions()`:
-- a defect in that body (a misplaced OR, a wrong CREATE OR REPLACE) would delete the sessions of every user. Now the table
-- has row security, forced, and one policy per role that holds a grant on it, each `TO <role>`, none TO PUBLIC:
--   - `polaris_auth_runtime` (Better Auth, with no `app.*` setting on its connection): every row, every command, as today;
--   - `polaris_unverified_user_owner` (`purge_unverified_users()`): SELECT of every row, as today (without it the
--     `NOT EXISTS` of the purge would always be true and a user with a session would be deleted);
--   - `polaris_device_session_owner`: SELECT and DELETE only of the sessions of the user of the call, by the setting
--     `app.owner_scope.device_session_user_id`, which `end_device_sessions()` writes from `app.user_id` right after it
--     checks it and before any read. Without the setting the policies are false: a body that forgets it ends no session.
-- The two policies of the same owner on `devices` and `device_sessions` move to the same setting (ALTER POLICY: same name,
-- role and command), so no policy of an owner reads a setting of the runtime any more and the exception of
-- definer-hardening-checks.ts goes away. A role that gets a grant on `session` one day and no policy sees no row.
-- `"user"`, `account`, `verification` and `auth_security_audit_event` still have no row security: that is the next task.
-- The owner of the table (the migrator: BYPASSRLS on Neon, a superuser locally and in CI) is not limited by FORCE today;
-- if it ever loses BYPASSRLS, a data migration on `session` sees zero rows. Foreign key actions (the cascade from `"user"`,
-- the check of a new `device_sessions` row) ignore row security, as PostgreSQL defines.
-- Expand only (ADR 0096): new policies, the same function with the same signature and result (one more line), two policies
-- of the owner narrowed, and row security turned on last. The previous Worker runs the same queries with the same roles
-- and calls the same function. Everything commits together: a request sees the old catalog or the new one, never half.
-- CREATE POLICY and ALTER TABLE take an ACCESS EXCLUSIVE lock on `session`, which every `/get-session` reads: better to
-- fail and deploy again than to queue requests. The timeout is this migration's only (RESET at the end).
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE POLICY "session_auth_runtime_all" ON "session" AS PERMISSIVE FOR ALL TO "polaris_auth_runtime" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "session_unverified_user_owner_select" ON "session" AS PERMISSIVE FOR SELECT TO "polaris_unverified_user_owner" USING (true);--> statement-breakpoint
CREATE POLICY "session_device_session_owner_select" ON "session" AS PERMISSIVE FOR SELECT TO "polaris_device_session_owner" USING ("session"."user_id" = NULLIF(pg_catalog.current_setting('app.owner_scope.device_session_user_id', true), ''));--> statement-breakpoint
CREATE POLICY "session_device_session_owner_delete" ON "session" AS PERMISSIVE FOR DELETE TO "polaris_device_session_owner" USING ("session"."user_id" = NULLIF(pg_catalog.current_setting('app.owner_scope.device_session_user_id', true), ''));--> statement-breakpoint
ALTER POLICY "devices_session_owner_select" ON "devices" TO polaris_device_session_owner USING ("devices"."user_id" = NULLIF(pg_catalog.current_setting('app.owner_scope.device_session_user_id', true), ''));--> statement-breakpoint
ALTER POLICY "device_sessions_session_owner_select" ON "device_sessions" TO polaris_device_session_owner USING ("device_sessions"."user_id" = NULLIF(pg_catalog.current_setting('app.owner_scope.device_session_user_id', true), ''));--> statement-breakpoint
-- The body of 0078, plus the line that writes the scope. As the owner (CREATE OR REPLACE needs it), the way 0078 created
-- it: CREATE on public and SET on the role only for the moment, given back at once.
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
CREATE OR REPLACE FUNCTION public.end_device_sessions(
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
  -- the owner's policies (session, devices, device_sessions) see only this user's rows
  PERFORM pg_catalog.set_config('app.owner_scope.device_session_user_id', v_user, true);
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
RESET ROLE;--> statement-breakpoint
REVOKE polaris_device_session_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_device_session_owner;--> statement-breakpoint
-- Last, with every policy and the new body in place: row security on, and forced.
ALTER TABLE "session" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.session FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- The end state, as 0095 checks its own (a REVOKE or an ALTER without the right is only a WARNING on Neon).
DO $end_state$
DECLARE
  v_policies text;
  v_uncovered text;
BEGIN
  IF NOT (SELECT c.relrowsecurity AND c.relforcerowsecurity FROM pg_catalog.pg_class AS c WHERE c.oid = 'public.session'::regclass) THEN
    RAISE EXCEPTION 'public.session does not have row security enabled and forced';
  END IF;
  -- the exact policies of session: name, command, one role each, never PUBLIC, permissive
  SELECT pg_catalog.string_agg(pol.polname || ':' || pol.polcmd::text || ':' || pg_catalog.array_to_string(
           ARRAY(SELECT CASE WHEN r = 0 THEN 'public' ELSE pg_catalog.pg_get_userbyid(r) END FROM pg_catalog.unnest(pol.polroles) AS r), ',')
           || ':' || pol.polpermissive::text, ' ' ORDER BY pol.polname)
    INTO v_policies
    FROM pg_catalog.pg_policy AS pol
   WHERE pol.polrelid = 'public.session'::regclass;
  IF v_policies IS DISTINCT FROM
     'session_auth_runtime_all:*:polaris_auth_runtime:true'
     ' session_device_session_owner_delete:d:polaris_device_session_owner:true'
     ' session_device_session_owner_select:r:polaris_device_session_owner:true'
     ' session_unverified_user_owner_select:r:polaris_unverified_user_owner:true' THEN
    RAISE EXCEPTION 'the policies of public.session are not the expected ones: %', v_policies;
  END IF;
  -- no policy of the owner reads a setting of the runtime any more, and the function writes the scope
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_policies AS pol
     WHERE pol.roles @> ARRAY['polaris_device_session_owner']::name[]
       AND (coalesce(pol.qual, '') || coalesce(pol.with_check, '') LIKE '%app.user_id%'
         OR coalesce(pol.qual, '') NOT LIKE '%app.owner_scope.device_session_user_id%')
  ) OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_policies AS pol
         WHERE pol.roles = ARRAY['polaris_device_session_owner']::name[]
           AND pol.qual LIKE '%app.owner_scope.device_session_user_id%') <> 4 THEN
    RAISE EXCEPTION 'a policy of polaris_device_session_owner does not read app.owner_scope.device_session_user_id alone';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc AS p
     WHERE p.oid = 'public.end_device_sessions(uuid, text, boolean, boolean, text)'::regprocedure
       AND p.proowner = 'polaris_device_session_owner'::regrole
       AND p.prosrc LIKE '%set_config(''app.owner_scope.device_session_user_id'', v_user, true)%'
  ) THEN
    RAISE EXCEPTION 'end_device_sessions does not belong to its owner or does not write its scope';
  END IF;
  -- the SET the migrator took for the CREATE OR REPLACE is given back, and the owner kept no CREATE on public
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members AS m
     WHERE m.member = (SELECT r.oid FROM pg_catalog.pg_roles AS r WHERE r.rolname = CURRENT_USER)
       AND m.roleid = 'polaris_device_session_owner'::regrole
       AND (m.set_option OR m.inherit_option)
  ) THEN
    RAISE EXCEPTION 'the migrator kept SET or INHERIT on polaris_device_session_owner';
  END IF;
  -- row security does not govern TRUNCATE, REFERENCES or TRIGGER: no one but the owner of the table has them on session
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_class AS c, pg_catalog.aclexplode(c.relacl) AS a
     WHERE c.oid = 'public.session'::regclass AND a.grantee <> c.relowner
       AND a.privilege_type IN ('TRUNCATE', 'REFERENCES', 'TRIGGER')
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute AS att, pg_catalog.aclexplode(att.attacl) AS a
     WHERE att.attrelid = 'public.session'::regclass AND att.attnum > 0 AND a.privilege_type = 'REFERENCES'
  ) THEN
    RAISE EXCEPTION 'a role other than the owner of public.session has TRUNCATE, REFERENCES or TRIGGER on it';
  END IF;
  IF pg_catalog.has_schema_privilege('polaris_device_session_owner', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'polaris_device_session_owner kept CREATE on schema public';
  END IF;
  -- every role with a privilege (of table or column) on session that row security governs, but its owner, a superuser
  -- or a role with BYPASSRLS, and every role that inherits one, has a permissive policy for that command (TO a role it
  -- inherits, or TO PUBLIC); a privilege of PUBLIC itself needs a policy TO PUBLIC
  WITH granted AS (
    SELECT a.grantee, a.privilege_type
      FROM pg_catalog.pg_class AS c, pg_catalog.aclexplode(c.relacl) AS a
     WHERE c.oid = 'public.session'::regclass
    UNION
    SELECT a.grantee, a.privilege_type
      FROM pg_catalog.pg_attribute AS att, pg_catalog.aclexplode(att.attacl) AS a
     WHERE att.attrelid = 'public.session'::regclass AND att.attnum > 0 AND NOT att.attisdropped
  ), affected AS (
    SELECT DISTINCT r.oid AS role_oid, r.rolname::text AS role_name, g.privilege_type
      FROM granted AS g
      JOIN pg_catalog.pg_roles AS r ON g.grantee <> 0 AND pg_catalog.pg_has_role(r.oid, g.grantee, 'USAGE')
     WHERE g.privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
       AND NOT r.rolsuper AND NOT r.rolbypassrls
       AND NOT pg_catalog.pg_has_role(r.oid, (SELECT c.relowner FROM pg_catalog.pg_class AS c WHERE c.oid = 'public.session'::regclass), 'USAGE')
    UNION
    SELECT DISTINCT 0::oid, 'public', g.privilege_type
      FROM granted AS g
     WHERE g.grantee = 0 AND g.privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
  )
  SELECT pg_catalog.string_agg(DISTINCT affected.role_name || ' ' || affected.privilege_type, ', ')
    INTO v_uncovered
    FROM affected
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_catalog.pg_policy AS pol
      WHERE pol.polrelid = 'public.session'::regclass AND pol.polpermissive
        AND pol.polcmd IN ('*', CASE affected.privilege_type WHEN 'SELECT' THEN 'r' WHEN 'INSERT' THEN 'a' WHEN 'UPDATE' THEN 'w' ELSE 'd' END)
        AND (0::oid = ANY (pol.polroles)
          OR (affected.role_oid <> 0 AND EXISTS (
            SELECT 1 FROM pg_catalog.unnest(pol.polroles) AS pr(oid) WHERE pg_catalog.pg_has_role(affected.role_oid, pr.oid, 'USAGE'))))
   );
  IF v_uncovered IS NOT NULL THEN
    RAISE EXCEPTION 'roles with a privilege on public.session and no policy for it: %', v_uncovered;
  END IF;
END
$end_state$;--> statement-breakpoint
RESET lock_timeout;
