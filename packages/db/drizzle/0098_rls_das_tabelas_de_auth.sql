-- Row security with FORCE on `"user"`, `account`, `verification` and `auth_security_audit_event` (ADR 0093, amended;
-- design t221). They were the last tables of public a `polaris_*` role holds a privilege on without row security: the only
-- row limit of the owners that read them was the WHERE of their own function, so a defect in a body (an OR out of place, a
-- wrong CREATE OR REPLACE) would read or delete any user. Now each has row security, forced, and one policy per role that
-- holds a grant on it, each `TO <role>`, none TO PUBLIC:
--   - `polaris_auth_runtime` (Better Auth, with no `app.*` setting on its connection): every row of `"user"`, `account` and
--     `verification`, every command, as today; on the audit, INSERT of every type but the two the owners write;
--   - `polaris_unverified_user_owner` (`purge_unverified_users()`): only the users never verified (`NOT email_verified`,
--     the predicate of its candidates) and their accounts and sessions (the policy of `session` of 0097 narrowed with ALTER
--     POLICY), so a body that loses the predicate still deletes no verified user, and the `NOT EXISTS` of a candidate's
--     account or session stays closed; UPDATE only for its `FOR UPDATE SKIP LOCKED` (check false); on the audit, its own
--     type only, succeeded and with no actor;
--   - `polaris_onboarding_owner` (`create_initial_organization()`): only the user of the call, by the setting it already
--     writes (0095), UPDATE only for its `FOR SHARE` (check false);
--   - `polaris_notice_recipient_owner` (`closure_notice_recipient()` and `closure_notice_owner_unverified()`): only the user
--     of the notice of the call, by the setting `app.owner_scope.notice_recipient_notice_id`, which both functions now write
--     from their argument before any read, and only while the notice is owed (the owner sees no other); the second one
--     becomes plpgsql and VOLATILE (same signature and result) because of the set_config, so it is evaluated per row;
--   - `polaris_device_session_owner` (`end_device_sessions()`): on the audit, `device_revoked` only, with the actor of its
--     scope (0097).
-- Every event type of the audit is written by one side only: the auth runtime's check excludes the types of the owners'
-- policies (the DO below checks it). The owner of the tables (the migrator: BYPASSRLS on Neon, a superuser locally and in
-- CI) must keep BYPASSRLS: with FORCE, a data migration of an owner without it would see zero rows and fail silently, so
-- the DO refuses that state, and a backfill stays with the migrator (never after SET ROLE to an owner). Foreign key actions
-- (the cascades from `"user"`) and checks ignore row security, as PostgreSQL defines.
-- Expand only (ADR 0096): new policies, one narrowed, two functions with the same signature and result, and row security
-- turned on last. The previous Worker runs the same queries with the same roles and calls the same functions. Everything
-- commits together: a request sees the old catalog or the new one, never half.
-- CREATE POLICY and ALTER TABLE take an ACCESS EXCLUSIVE lock, and `/get-session` reads `session` and `"user"`: the locks are
-- taken first, in one fixed order, so the migration never holds one table waiting for the next, and it fails at once
-- instead of queueing requests. The timeout is this migration's only (RESET at the end).
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
LOCK TABLE public."user", public.account, public.session, public.verification, public.auth_security_audit_event IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
CREATE POLICY "user_auth_runtime_all" ON "user" AS PERMISSIVE FOR ALL TO "polaris_auth_runtime" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "user_unverified_user_owner_select" ON "user" AS PERMISSIVE FOR SELECT TO "polaris_unverified_user_owner" USING (NOT "user"."email_verified");--> statement-breakpoint
CREATE POLICY "user_unverified_user_owner_lock" ON "user" AS PERMISSIVE FOR UPDATE TO "polaris_unverified_user_owner" USING (NOT "user"."email_verified") WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "user_unverified_user_owner_delete" ON "user" AS PERMISSIVE FOR DELETE TO "polaris_unverified_user_owner" USING (NOT "user"."email_verified");--> statement-breakpoint
CREATE POLICY "user_onboarding_owner_select" ON "user" AS PERMISSIVE FOR SELECT TO "polaris_onboarding_owner" USING ("user"."id" = NULLIF(pg_catalog.current_setting('app.owner_scope.onboarding_user_id', true), ''));--> statement-breakpoint
CREATE POLICY "user_onboarding_owner_lock" ON "user" AS PERMISSIVE FOR UPDATE TO "polaris_onboarding_owner" USING ("user"."id" = NULLIF(pg_catalog.current_setting('app.owner_scope.onboarding_user_id', true), '')) WITH CHECK (false);--> statement-breakpoint
CREATE POLICY "user_notice_recipient_owner_select" ON "user" AS PERMISSIVE FOR SELECT TO "polaris_notice_recipient_owner" USING (EXISTS (SELECT 1 FROM public.closure_notices AS n WHERE n.id::text = NULLIF(pg_catalog.current_setting('app.owner_scope.notice_recipient_notice_id', true), '') AND n.user_id = "user"."id"));--> statement-breakpoint
CREATE POLICY "account_auth_runtime_all" ON "account" AS PERMISSIVE FOR ALL TO "polaris_auth_runtime" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "account_unverified_user_owner_select" ON "account" AS PERMISSIVE FOR SELECT TO "polaris_unverified_user_owner" USING (EXISTS (SELECT 1 FROM public."user" AS u WHERE u.id = "account"."user_id" AND NOT u.email_verified));--> statement-breakpoint
ALTER POLICY "session_unverified_user_owner_select" ON "session" TO polaris_unverified_user_owner USING (EXISTS (SELECT 1 FROM public."user" AS u WHERE u.id = "session"."user_id" AND NOT u.email_verified));--> statement-breakpoint
CREATE POLICY "verification_auth_runtime_all" ON "verification" AS PERMISSIVE FOR ALL TO "polaris_auth_runtime" USING (true) WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "auth_security_audit_event_auth_runtime_insert" ON "auth_security_audit_event" AS PERMISSIVE FOR INSERT TO "polaris_auth_runtime" WITH CHECK ("auth_security_audit_event"."event_type" NOT IN ('device_revoked', 'unverified_user_deleted'));--> statement-breakpoint
CREATE POLICY "auth_security_audit_event_device_session_owner_insert" ON "auth_security_audit_event" AS PERMISSIVE FOR INSERT TO "polaris_device_session_owner" WITH CHECK ("auth_security_audit_event"."event_type" = 'device_revoked' AND "auth_security_audit_event"."actor_id" = NULLIF(pg_catalog.current_setting('app.owner_scope.device_session_user_id', true), ''));--> statement-breakpoint
CREATE POLICY "auth_security_audit_event_unverified_user_owner_insert" ON "auth_security_audit_event" AS PERMISSIVE FOR INSERT TO "polaris_unverified_user_owner" WITH CHECK ("auth_security_audit_event"."event_type" = 'unverified_user_deleted' AND "auth_security_audit_event"."outcome" = 'succeeded' AND "auth_security_audit_event"."actor_id" IS NULL);--> statement-breakpoint
-- The bodies of 0091, plus the line that writes the scope. As the owner (CREATE OR REPLACE needs it), the way 0091 created
-- them: CREATE on public and SET on the role only for the moment, given back at once. CREATE OR REPLACE keeps the grants.
GRANT CREATE ON SCHEMA public TO polaris_notice_recipient_owner;--> statement-breakpoint
GRANT polaris_notice_recipient_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
SET ROLE polaris_notice_recipient_owner;--> statement-breakpoint
-- The address of a closure notice, for the consumer that sends it (condition of the security review of 20/10/2026): only
-- for a notice still owed (neither sent, failed, skipped nor dismissed), by its ID and organization, and only the e-mail of
-- the user it is for, joined with the notice and only while that user is still an owner of the organization (one who
-- left gets nothing, even between the claim and this read): never a free read of the users. A user whose e-mail is not verified gets
-- `{"verified": false}` and no address (the notice is left unresolved, not failed), and the notice keeps the instant
-- (`unverified_at`): the fact, read by the database itself, that the dismissal `email_not_verified` needs; an address
-- found verified later clears it. A notice not owed, null. The name of the user is never read. Volatile, so no cache
-- answers it. Only the authentication runtime executes it. The owner's policy on `"user"` shows only the user of the
-- notice of the scope written first (0098).
CREATE OR REPLACE FUNCTION public.closure_notice_recipient(p_notice uuid, p_organization text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  verified boolean;
  address text;
BEGIN
  -- the owner's policy on "user" sees only the user of this notice
  PERFORM pg_catalog.set_config('app.owner_scope.notice_recipient_notice_id', COALESCE(p_notice::text, ''), true);
  SELECT account.email_verified, account.email INTO verified, address
    FROM public.closure_notices AS notice
    JOIN public."user" AS account ON account.id = notice.user_id
   WHERE notice.id = p_notice AND notice.organization_id = p_organization
     AND NOT notice.skipped AND notice.sent_at IS NULL AND notice.failed_at IS NULL AND notice.dismissed_at IS NULL
     AND EXISTS (
       SELECT 1 FROM public.memberships AS membership
        WHERE membership.organization_id = notice.organization_id AND membership.user_id = notice.user_id
          AND membership.role = 'owner' AND membership.status = 'active'
     );
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF verified THEN
    UPDATE public.closure_notices AS notice SET unverified_at = NULL
     WHERE notice.id = p_notice AND notice.unverified_at IS NOT NULL;
    RETURN pg_catalog.jsonb_build_object('verified', true, 'email', address);
  END IF;
  UPDATE public.closure_notices AS notice SET unverified_at = pg_catalog.now() WHERE notice.id = p_notice;
  RETURN pg_catalog.jsonb_build_object('verified', false);
END;
$function$;--> statement-breakpoint
-- Whether the owner a notice still owed is for has, right now, an e-mail not verified (review of 20/10/2026): the check
-- the dismissal `email_not_verified` makes of the present, not only of the instant a delivery found it so
-- (`unverified_at`), since the owner may have verified it since. Only a boolean, never the address; false for a notice
-- not owed, or for a user who is no longer an owner. Only the owner of the act of the support executes it. plpgsql and
-- volatile since 0098 (it writes the scope of the owner's policy on `"user"`), so a caller that asks about several notices
-- in one statement gets each answered with its own scope.
CREATE OR REPLACE FUNCTION public.closure_notice_owner_unverified(p_notice uuid, p_organization text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
BEGIN
  -- the owner's policy on "user" sees only the user of this notice
  PERFORM pg_catalog.set_config('app.owner_scope.notice_recipient_notice_id', COALESCE(p_notice::text, ''), true);
  RETURN EXISTS (
    SELECT 1
      FROM public.closure_notices AS notice
      JOIN public."user" AS account ON account.id = notice.user_id
     WHERE notice.id = p_notice AND notice.organization_id = p_organization
       AND NOT notice.skipped AND notice.sent_at IS NULL AND notice.failed_at IS NULL AND notice.dismissed_at IS NULL
       AND account.email_verified IS NOT TRUE
       AND EXISTS (
         SELECT 1 FROM public.memberships AS membership
          WHERE membership.organization_id = notice.organization_id AND membership.user_id = notice.user_id
            AND membership.role = 'owner' AND membership.status = 'active'
       )
  );
END;
$function$;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_notice_recipient_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_notice_recipient_owner;--> statement-breakpoint
-- Last, with every policy and the new bodies in place: row security on, and forced.
ALTER TABLE "user" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public."user" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "account" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.account FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "verification" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.verification FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "auth_security_audit_event" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.auth_security_audit_event FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- The end state, as 0097 checks its own (a REVOKE or an ALTER without the right is only a WARNING on Neon).
DO $end_state$
DECLARE
  v_tables regclass[] := ARRAY['public."user"', 'public.account', 'public.verification', 'public.auth_security_audit_event']::regclass[];
  v_found text;
  v_owner_types text[];
  v_runtime_excluded text[];
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_class AS c
     WHERE c.oid = ANY (v_tables) AND NOT (c.relrowsecurity AND c.relforcerowsecurity)
  ) THEN
    RAISE EXCEPTION 'a table of Better Auth or the auth audit does not have row security enabled and forced';
  END IF;
  -- with FORCE, the owner of the tables (and of session, 0097) is bound by the policies too unless it bypasses them: a data
  -- migration of an owner without BYPASSRLS would see zero rows, with no error
  SELECT pg_catalog.string_agg(DISTINCT pg_catalog.pg_get_userbyid(c.relowner), ', ')
    INTO v_found
    FROM pg_catalog.pg_class AS c
    JOIN pg_catalog.pg_roles AS r ON r.oid = c.relowner
   WHERE c.oid = ANY (v_tables || 'public.session'::regclass) AND NOT r.rolsuper AND NOT r.rolbypassrls;
  IF v_found IS NOT NULL THEN
    RAISE EXCEPTION 'the owner of the tables with forced row security is neither a superuser nor BYPASSRLS: %', v_found;
  END IF;
  -- the exact policies of the five tables: name, command, one role each, never PUBLIC, permissive
  SELECT pg_catalog.string_agg(pol.polrelid::regclass::text || '.' || pol.polname || ':' || pol.polcmd::text || ':' || pg_catalog.array_to_string(
           ARRAY(SELECT CASE WHEN r = 0 THEN 'public' ELSE pg_catalog.pg_get_userbyid(r) END FROM pg_catalog.unnest(pol.polroles) AS r), ',')
           || ':' || pol.polpermissive::text, ' ' ORDER BY pol.polrelid::regclass::text COLLATE "C", pol.polname COLLATE "C")
    INTO v_found
    FROM pg_catalog.pg_policy AS pol
   WHERE pol.polrelid = ANY (v_tables || 'public.session'::regclass);
  IF v_found IS DISTINCT FROM
     '"user".user_auth_runtime_all:*:polaris_auth_runtime:true'
     ' "user".user_notice_recipient_owner_select:r:polaris_notice_recipient_owner:true'
     ' "user".user_onboarding_owner_lock:w:polaris_onboarding_owner:true'
     ' "user".user_onboarding_owner_select:r:polaris_onboarding_owner:true'
     ' "user".user_unverified_user_owner_delete:d:polaris_unverified_user_owner:true'
     ' "user".user_unverified_user_owner_lock:w:polaris_unverified_user_owner:true'
     ' "user".user_unverified_user_owner_select:r:polaris_unverified_user_owner:true'
     ' account.account_auth_runtime_all:*:polaris_auth_runtime:true'
     ' account.account_unverified_user_owner_select:r:polaris_unverified_user_owner:true'
     ' auth_security_audit_event.auth_security_audit_event_auth_runtime_insert:a:polaris_auth_runtime:true'
     ' auth_security_audit_event.auth_security_audit_event_device_session_owner_insert:a:polaris_device_session_owner:true'
     ' auth_security_audit_event.auth_security_audit_event_unverified_user_owner_insert:a:polaris_unverified_user_owner:true'
     ' session.session_auth_runtime_all:*:polaris_auth_runtime:true'
     ' session.session_device_session_owner_delete:d:polaris_device_session_owner:true'
     ' session.session_device_session_owner_select:r:polaris_device_session_owner:true'
     ' session.session_unverified_user_owner_select:r:polaris_unverified_user_owner:true'
     ' verification.verification_auth_runtime_all:*:polaris_auth_runtime:true' THEN
    RAISE EXCEPTION 'the policies of the auth tables are not the expected ones: %', v_found;
  END IF;
  -- the purge owner sees only users never verified, in every table it reads, and its UPDATE and the onboarding owner's
  -- change no row (the lock only)
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy AS pol
     WHERE pol.polrelid = ANY (v_tables || 'public.session'::regclass)
       AND pol.polroles = ARRAY['polaris_unverified_user_owner'::regrole::oid]
       AND pol.polcmd IN ('r', 'w', 'd')
       AND pg_catalog.pg_get_expr(pol.polqual, pol.polrelid) NOT LIKE '%NOT %email_verified%'
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy AS pol
     WHERE pol.polrelid = 'public."user"'::regclass AND pol.polcmd = 'w'
       AND pol.polroles <> ARRAY['polaris_auth_runtime'::regrole::oid]
       AND pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid) IS DISTINCT FROM 'false'
  ) THEN
    RAISE EXCEPTION 'a policy of an owner on the auth tables is wider than designed (NOT email_verified, or UPDATE with a check)';
  END IF;
  -- every event type an owner's INSERT policy allows is one the auth runtime's policy excludes, and each owner's policy
  -- names its type: no type is written by both sides
  SELECT pg_catalog.array_agg(DISTINCT m[1] ORDER BY m[1])
    INTO v_owner_types
    FROM pg_catalog.pg_policy AS pol,
         pg_catalog.regexp_matches(pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid), '''([a-z_]+)''::auth_security_audit_event_type', 'g') AS m
   WHERE pol.polrelid = 'public.auth_security_audit_event'::regclass
     AND pol.polroles <> ARRAY['polaris_auth_runtime'::regrole::oid];
  SELECT pg_catalog.array_agg(DISTINCT m[1] ORDER BY m[1])
    INTO v_runtime_excluded
    FROM pg_catalog.pg_policy AS pol,
         pg_catalog.regexp_matches(pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid), '''([a-z_]+)''::auth_security_audit_event_type', 'g') AS m
   WHERE pol.polrelid = 'public.auth_security_audit_event'::regclass
     AND pol.polroles = ARRAY['polaris_auth_runtime'::regrole::oid];
  IF v_owner_types IS DISTINCT FROM ARRAY['device_revoked', 'unverified_user_deleted']
     OR NOT (v_owner_types <@ v_runtime_excluded)
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_policy AS pol
        WHERE pol.polrelid = 'public.auth_security_audit_event'::regclass
          AND pol.polroles = ARRAY['polaris_auth_runtime'::regrole::oid]
          AND pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid) LIKE '%<> ALL%'
     )
     OR EXISTS (
       SELECT 1 FROM pg_catalog.pg_policy AS pol
        WHERE pol.polrelid = 'public.auth_security_audit_event'::regclass
          AND pol.polroles <> ARRAY['polaris_auth_runtime'::regrole::oid]
          AND pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid) NOT LIKE '%event_type = %'
     ) THEN
    RAISE EXCEPTION 'an event type of the auth audit is allowed to an owner and to the auth runtime (owners: %, excluded: %)',
      v_owner_types, v_runtime_excluded;
  END IF;
  -- the exact grants of the four tables to polaris_* roles and to PUBLIC, of the table and of each column (the ones of
  -- before 0098: row security changes no privilege)
  WITH entries AS (
    SELECT c.oid, a.grantee, a.privilege_type, NULL::text AS column_name
      FROM pg_catalog.pg_class AS c, pg_catalog.aclexplode(c.relacl) AS a
     WHERE c.oid = ANY (v_tables)
    UNION
    SELECT c.oid, a.grantee, a.privilege_type, att.attname::text
      FROM pg_catalog.pg_class AS c
      JOIN pg_catalog.pg_attribute AS att ON att.attrelid = c.oid AND att.attnum > 0 AND NOT att.attisdropped,
           pg_catalog.aclexplode(att.attacl) AS a
     WHERE c.oid = ANY (v_tables)
  )
  SELECT pg_catalog.string_agg(e.oid::regclass::text || ' ' || CASE WHEN e.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(e.grantee) END
           || ' ' || e.privilege_type || COALESCE(' (' || e.column_name || ')', ''), ', '
           ORDER BY e.oid::regclass::text COLLATE "C", (CASE WHEN e.grantee = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(e.grantee)::text END) COLLATE "C", e.privilege_type COLLATE "C", e.column_name COLLATE "C")
    INTO v_found
    FROM entries AS e
   WHERE e.grantee = 0 OR pg_catalog.pg_get_userbyid(e.grantee) LIKE 'polaris\_%';
  IF v_found IS DISTINCT FROM
     '"user" polaris_auth_runtime DELETE, "user" polaris_auth_runtime INSERT, "user" polaris_auth_runtime SELECT'
     ', "user" polaris_auth_runtime UPDATE, "user" polaris_notice_recipient_owner SELECT (email), "user" polaris_notice_recipient_owner SELECT (email_verified)'
     ', "user" polaris_notice_recipient_owner SELECT (id), "user" polaris_onboarding_owner SELECT (email_verified), "user" polaris_onboarding_owner SELECT (id)'
     ', "user" polaris_onboarding_owner UPDATE (updated_at), "user" polaris_unverified_user_owner DELETE, "user" polaris_unverified_user_owner SELECT (created_at)'
     ', "user" polaris_unverified_user_owner SELECT (email_verified), "user" polaris_unverified_user_owner SELECT (id), "user" polaris_unverified_user_owner SELECT (verification_link_expires_at)'
     ', "user" polaris_unverified_user_owner UPDATE (updated_at), account polaris_auth_runtime DELETE, account polaris_auth_runtime INSERT'
     ', account polaris_auth_runtime SELECT, account polaris_auth_runtime UPDATE, account polaris_unverified_user_owner SELECT (provider_id)'
     ', account polaris_unverified_user_owner SELECT (user_id), auth_security_audit_event polaris_auth_runtime INSERT, auth_security_audit_event polaris_device_session_owner INSERT'
     ', auth_security_audit_event polaris_unverified_user_owner INSERT (event_type), auth_security_audit_event polaris_unverified_user_owner INSERT (outcome), auth_security_audit_event polaris_unverified_user_owner INSERT (request_id)'
     ', auth_security_audit_event polaris_unverified_user_owner INSERT (subject_id), verification polaris_auth_runtime DELETE, verification polaris_auth_runtime INSERT'
     ', verification polaris_auth_runtime SELECT, verification polaris_auth_runtime UPDATE' THEN
    RAISE EXCEPTION 'the grants of the auth tables are not the ones of before 0098: %', v_found;
  END IF;
  -- row security does not govern TRUNCATE, REFERENCES or TRIGGER: no one but the owner of the table has them
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_class AS c, pg_catalog.aclexplode(c.relacl) AS a
     WHERE c.oid = ANY (v_tables) AND a.grantee <> c.relowner
       AND a.privilege_type IN ('TRUNCATE', 'REFERENCES', 'TRIGGER')
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute AS att, pg_catalog.aclexplode(att.attacl) AS a
     WHERE att.attrelid = ANY (v_tables) AND att.attnum > 0 AND a.privilege_type = 'REFERENCES'
  ) THEN
    RAISE EXCEPTION 'a role other than the owner has TRUNCATE, REFERENCES or TRIGGER on an auth table';
  END IF;
  -- both functions belong to the owner, write its scope, and keep their grants (EXECUTE: the auth runtime for the address,
  -- the privacy owner for the check; never PUBLIC)
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc AS p
       WHERE p.oid IN ('public.closure_notice_recipient(uuid, text)'::regprocedure, 'public.closure_notice_owner_unverified(uuid, text)'::regprocedure)
         AND p.proowner = 'polaris_notice_recipient_owner'::regrole
         AND p.prosecdef AND p.provolatile = 'v'
         AND p.prosrc LIKE '%set_config(''app.owner_scope.notice_recipient_notice_id'', COALESCE(p_notice::text, ''''), true)%') <> 2
     OR pg_catalog.has_function_privilege('public', 'public.closure_notice_recipient(uuid, text)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('public', 'public.closure_notice_owner_unverified(uuid, text)', 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('polaris_auth_runtime', 'public.closure_notice_recipient(uuid, text)', 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('polaris_privacy_owner', 'public.closure_notice_owner_unverified(uuid, text)', 'EXECUTE')
     OR pg_catalog.has_function_privilege('polaris_auth_runtime', 'public.closure_notice_owner_unverified(uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'the functions of the closure notices do not belong to their owner, do not write its scope or lost their grants';
  END IF;
  -- the SET the migrator took for the CREATE OR REPLACE is given back, and the owner kept no CREATE on public
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members AS m
     WHERE m.member = (SELECT r.oid FROM pg_catalog.pg_roles AS r WHERE r.rolname = CURRENT_USER)
       AND m.roleid = 'polaris_notice_recipient_owner'::regrole
       AND (m.set_option OR m.inherit_option)
  ) THEN
    RAISE EXCEPTION 'the migrator kept SET or INHERIT on polaris_notice_recipient_owner';
  END IF;
  IF pg_catalog.has_schema_privilege('polaris_notice_recipient_owner', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'polaris_notice_recipient_owner kept CREATE on schema public';
  END IF;
  -- every role with a privilege (of table or column) on the four tables that row security governs, but their owner, a
  -- superuser or a role with BYPASSRLS, and every role that inherits one, has a permissive policy for that command (TO a
  -- role it inherits, or TO PUBLIC); a privilege of PUBLIC itself needs a policy TO PUBLIC
  WITH granted AS (
    SELECT c.oid, c.relowner, a.grantee, a.privilege_type
      FROM pg_catalog.pg_class AS c, pg_catalog.aclexplode(c.relacl) AS a
     WHERE c.oid = ANY (v_tables)
    UNION
    SELECT c.oid, c.relowner, a.grantee, a.privilege_type
      FROM pg_catalog.pg_class AS c
      JOIN pg_catalog.pg_attribute AS att ON att.attrelid = c.oid AND att.attnum > 0 AND NOT att.attisdropped,
           pg_catalog.aclexplode(att.attacl) AS a
     WHERE c.oid = ANY (v_tables)
  ), affected AS (
    SELECT DISTINCT g.oid, r.oid AS role_oid, r.rolname::text AS role_name, g.privilege_type
      FROM granted AS g
      JOIN pg_catalog.pg_roles AS r ON g.grantee <> 0 AND pg_catalog.pg_has_role(r.oid, g.grantee, 'USAGE')
     WHERE g.privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
       AND NOT r.rolsuper AND NOT r.rolbypassrls
       AND NOT pg_catalog.pg_has_role(r.oid, g.relowner, 'USAGE')
    UNION
    SELECT DISTINCT g.oid, 0::oid, 'public', g.privilege_type
      FROM granted AS g
     WHERE g.grantee = 0 AND g.privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
  )
  SELECT pg_catalog.string_agg(DISTINCT affected.oid::regclass::text || ' ' || affected.role_name || ' ' || affected.privilege_type, ', ')
    INTO v_found
    FROM affected
   WHERE NOT EXISTS (
     SELECT 1 FROM pg_catalog.pg_policy AS pol
      WHERE pol.polrelid = affected.oid AND pol.polpermissive
        AND pol.polcmd IN ('*', CASE affected.privilege_type WHEN 'SELECT' THEN 'r' WHEN 'INSERT' THEN 'a' WHEN 'UPDATE' THEN 'w' ELSE 'd' END)
        AND (0::oid = ANY (pol.polroles)
          OR (affected.role_oid <> 0 AND EXISTS (
            SELECT 1 FROM pg_catalog.unnest(pol.polroles) AS pr(oid) WHERE pg_catalog.pg_has_role(affected.role_oid, pr.oid, 'USAGE'))))
   );
  IF v_found IS NOT NULL THEN
    RAISE EXCEPTION 'roles with a privilege on an auth table and no policy for it: %', v_found;
  END IF;
END
$end_state$;--> statement-breakpoint
RESET lock_timeout;
