-- The recipient of the activation series (ADR 0106, D2): the third role of the series and its function, which answers
-- the address of the person of one notice still owed, and nothing else. Expand only (ADR 0096): a new role, a new
-- function, new policies and column grants; nothing existing is dropped, altered or recreated, and the previous Worker
-- never calls any of it. Nothing sends: the series stays off (D6), and the consumer that will call it comes later.
--
-- * `polaris_activation_recipient_owner` (NOLOGIN, NOINHERIT, NOBYPASSRLS) owns only the recipient's function. It is
--   neither `polaris_activation_notice_owner` (the candidates sweep every store: with the address, one wrong
--   `CREATE OR REPLACE` would answer every address at once) nor `polaris_notice_recipient_owner` (the billing notices'
--   recipient: D1 keeps the two series apart).
-- * What it reads, by column and nothing else: of `activation_notices` the ID, the store, the person and the outcome
--   (`id`, `organization_id`, `user_id`, `sent_at`, `failed_at`, `skipped_reason`), only the notice of the call and only
--   while owed; of `memberships` (`organization_id`, `user_id`, `role`, `status`, `created_at`) the active owners of
--   that notice's store, to find the oldest; of `"user"` (`id`, `email`, `email_verified`) the person of that notice,
--   only verified and only while the oldest active owner of its store. Never `session`, `sales`, `products`,
--   `privacy_cases` nor any other column of `"user"`; it writes nothing.
-- * `activation_notice_recipient(p_organization, p_notice)`, SECURITY DEFINER of that role, EXECUTE to the
--   authentication runtime only (as `billing_notice_recipient`): the address, or null for a notice not owed (sent,
--   failed or skipped), of another store, whose person is not verified, is no longer an active owner or is not the
--   oldest active owner of the store. Whether the notice is still due by the rules of D3 is the consumer's
--   (`noticeStillTrue`), a boolean that never carries the address.
-- The scope of the call (`app.owner_scope.activation_notice_recipient_notice_id`) is written by the function and read
-- by the three policies, so the role sees one notice, the owners of one store and one person per call.
-- Each policy on a busy table takes a lock on it (`"user"` is read by every /get-session): they are all taken first, in
-- one fixed order, and a lock not had in 10 s fails the migration instead of queueing logins.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
LOCK TABLE public.memberships, public."user", public.activation_notices IN ACCESS EXCLUSIVE MODE;--> statement-breakpoint
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'polaris_activation_recipient_owner') THEN
    EXECUTE 'CREATE ROLE polaris_activation_recipient_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
  END IF;
  -- a role that already existed gets the same attributes; NOSUPERUSER is refused to a migrator that is not a superuser
  -- (Neon), so the check below keeps that guarantee
  EXECUTE 'ALTER ROLE polaris_activation_recipient_owner NOLOGIN NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'polaris_activation_recipient_owner' AND rolsuper) THEN
    RAISE EXCEPTION 'polaris_activation_recipient_owner must not be a superuser';
  END IF;
END
$roles$;--> statement-breakpoint
CREATE POLICY "activation_notices_recipient_owner_select_owed" ON "activation_notices" AS PERMISSIVE FOR SELECT TO "polaris_activation_recipient_owner" USING ("activation_notices"."id" = (CASE WHEN pg_catalog.current_setting('app.owner_scope.activation_notice_recipient_notice_id', true) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN pg_catalog.current_setting('app.owner_scope.activation_notice_recipient_notice_id', true)::uuid END) AND "activation_notices"."sent_at" IS NULL AND "activation_notices"."failed_at" IS NULL AND "activation_notices"."skipped_reason" IS NULL);--> statement-breakpoint
CREATE POLICY "user_activation_recipient_owner_select" ON "user" AS PERMISSIVE FOR SELECT TO "polaris_activation_recipient_owner" USING ("user"."email_verified" AND EXISTS (SELECT 1 FROM public.activation_notices AS n WHERE n.id = (CASE WHEN pg_catalog.current_setting('app.owner_scope.activation_notice_recipient_notice_id', true) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN pg_catalog.current_setting('app.owner_scope.activation_notice_recipient_notice_id', true)::uuid END) AND n.user_id = "user"."id" AND n.user_id = (SELECT f.user_id FROM public.memberships AS f WHERE f.organization_id = n.organization_id AND f.role = 'owner' AND f.status = 'active' ORDER BY f.created_at, f.user_id LIMIT 1)));--> statement-breakpoint
-- the active owners of the store of the one notice the role sees (its policy on the notices is the scope)
CREATE POLICY memberships_activation_recipient_owner_select_owner ON public.memberships
  AS PERMISSIVE FOR SELECT TO polaris_activation_recipient_owner
  USING (role = 'owner' AND status = 'active'
    AND EXISTS (SELECT 1 FROM public.activation_notices AS n WHERE n.organization_id = memberships.organization_id));--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO polaris_activation_recipient_owner;--> statement-breakpoint
GRANT SELECT (id, organization_id, user_id, sent_at, failed_at, skipped_reason) ON TABLE public.activation_notices TO polaris_activation_recipient_owner;--> statement-breakpoint
GRANT SELECT (organization_id, user_id, role, status, created_at) ON TABLE public.memberships TO polaris_activation_recipient_owner;--> statement-breakpoint
GRANT SELECT (id, email, email_verified) ON TABLE public."user" TO polaris_activation_recipient_owner;--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO polaris_activation_recipient_owner;--> statement-breakpoint
GRANT polaris_activation_recipient_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
SET ROLE polaris_activation_recipient_owner;--> statement-breakpoint
-- The address of the person of one notice of the series still owed (neither sent, failed nor skipped), by its ID and
-- store, for the consumer that sends it: only while that person is the oldest active owner of the store, read now, and
-- only when the e-mail is verified. Anything else is null, with no reason (the consumer has its own checks). The name
-- is never read, and nothing is written. Volatile, so no cache answers it. The scope is cleared before the answer, so
-- the rest of the caller's transaction finds none.
CREATE FUNCTION public.activation_notice_recipient(p_organization text, p_notice uuid)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  address text;
BEGIN
  PERFORM pg_catalog.set_config('app.owner_scope.activation_notice_recipient_notice_id', COALESCE(p_notice::text, ''), true);
  SELECT account.email INTO address
    FROM public.activation_notices AS notice
    JOIN public."user" AS account ON account.id = notice.user_id
   WHERE notice.id = p_notice AND notice.organization_id = p_organization
     AND notice.sent_at IS NULL AND notice.failed_at IS NULL AND notice.skipped_reason IS NULL
     AND account.email_verified
     AND notice.user_id = (
       SELECT founder.user_id FROM public.memberships AS founder
        WHERE founder.organization_id = notice.organization_id AND founder.role = 'owner' AND founder.status = 'active'
        ORDER BY founder.created_at, founder.user_id
        LIMIT 1
     );
  PERFORM pg_catalog.set_config('app.owner_scope.activation_notice_recipient_notice_id', '', true);
  RETURN address;
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.activation_notice_recipient(text, uuid) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_privacy_runtime, polaris_outbox_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.activation_notice_recipient(text, uuid) TO polaris_auth_runtime;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_activation_recipient_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_activation_recipient_owner;--> statement-breakpoint
-- The end state (a REVOKE or an ALTER without the right is only a WARNING on Neon): the recipient's owner holds exactly
-- the columns above and nothing else (no table privilege, no write, no CREATE), so it reads neither the session, the
-- sales, the products nor the requests about personal data; it has exactly its three policies and owns only its
-- function; it is granted to the authentication runtime only (its ACL, so a login role or a default privilege shows
-- too); no role, the migrator included, can SET or INHERIT it (a member with SET could write the scope itself); and
-- neither of the other two roles of the series reads the address.
DO $end_state$
DECLARE
  held text[];
BEGIN
  SELECT COALESCE(pg_catalog.array_agg(p.entry ORDER BY p.entry COLLATE "C"), '{}')
    INTO held
    FROM (SELECT c.table_name || '.' || c.column_name || ':' || c.privilege_type AS entry
            FROM information_schema.column_privileges AS c
           WHERE c.grantee = 'polaris_activation_recipient_owner') AS p;
  IF held IS DISTINCT FROM ARRAY(SELECT e FROM unnest(ARRAY[
    'activation_notices.failed_at:SELECT', 'activation_notices.id:SELECT', 'activation_notices.organization_id:SELECT',
    'activation_notices.sent_at:SELECT', 'activation_notices.skipped_reason:SELECT', 'activation_notices.user_id:SELECT',
    'memberships.created_at:SELECT', 'memberships.organization_id:SELECT', 'memberships.role:SELECT',
    'memberships.status:SELECT', 'memberships.user_id:SELECT', 'user.email:SELECT', 'user.email_verified:SELECT',
    'user.id:SELECT'
  ]::text[]) AS e ORDER BY e COLLATE "C") THEN
    RAISE EXCEPTION 'the recipient''s owner does not hold exactly its columns: %', held;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.table_privileges AS t WHERE t.grantee = 'polaris_activation_recipient_owner')
     OR pg_catalog.has_any_column_privilege('polaris_activation_recipient_owner', 'public.session', 'SELECT')
     OR pg_catalog.has_any_column_privilege('polaris_activation_recipient_owner', 'public.sales', 'SELECT')
     OR pg_catalog.has_any_column_privilege('polaris_activation_recipient_owner', 'public.products', 'SELECT')
     OR pg_catalog.has_any_column_privilege('polaris_activation_recipient_owner', 'public.privacy_cases', 'SELECT')
     OR pg_catalog.has_schema_privilege('polaris_activation_recipient_owner', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'the recipient''s owner reads more than the notice, the owners and the person';
  END IF;
  IF (SELECT pg_catalog.array_agg(p.tablename || '.' || p.policyname ORDER BY p.tablename || '.' || p.policyname COLLATE "C")
        FROM pg_catalog.pg_policies AS p
       WHERE 'polaris_activation_recipient_owner' = ANY (p.roles))
     IS DISTINCT FROM ARRAY['activation_notices.activation_notices_recipient_owner_select_owed',
                            'memberships.memberships_activation_recipient_owner_select_owner',
                            'user.user_activation_recipient_owner_select'] THEN
    RAISE EXCEPTION 'the recipient''s owner does not have exactly its three policies';
  END IF;
  IF (SELECT pg_catalog.array_agg(p.oid::regprocedure::text) FROM pg_catalog.pg_proc AS p
       WHERE p.proowner = 'polaris_activation_recipient_owner'::regrole)
     IS DISTINCT FROM ARRAY['activation_notice_recipient(text,uuid)'] THEN
    RAISE EXCEPTION 'the recipient''s owner does not own exactly its function';
  END IF;
  IF (SELECT pg_catalog.array_agg(g.name ORDER BY g.name COLLATE "C")
        FROM (SELECT DISTINCT a.grantee::regrole::text AS name
                FROM pg_catalog.pg_proc AS p, pg_catalog.aclexplode(p.proacl) AS a
               WHERE p.oid = 'public.activation_notice_recipient(text, uuid)'::regprocedure) AS g)
     IS DISTINCT FROM ARRAY['polaris_activation_recipient_owner', 'polaris_auth_runtime'] THEN
    RAISE EXCEPTION 'the recipient''s function is granted to someone else than its owner and the authentication runtime';
  END IF;
  IF pg_catalog.has_function_privilege('public', 'public.activation_notice_recipient(text, uuid)', 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('polaris_auth_runtime', 'public.activation_notice_recipient(text, uuid)', 'EXECUTE')
     OR EXISTS (
       SELECT 1 FROM pg_catalog.pg_roles AS r
        WHERE r.rolname LIKE 'polaris\_%' AND NOT r.rolcanlogin
          AND r.rolname NOT IN ('polaris_auth_runtime', 'polaris_activation_recipient_owner')
          AND pg_catalog.has_function_privilege(r.oid, 'public.activation_notice_recipient(text, uuid)', 'EXECUTE')
     ) THEN
    RAISE EXCEPTION 'the recipient''s function does not have its one executor';
  END IF;
  IF pg_catalog.has_column_privilege('polaris_activation_notice_owner', 'public."user"', 'email', 'SELECT')
     OR pg_catalog.has_column_privilege('polaris_activation_owner', 'public."user"', 'email', 'SELECT') THEN
    RAISE EXCEPTION 'another role of the series reads the address';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members AS m
     WHERE m.roleid = 'polaris_activation_recipient_owner'::regrole
       AND (m.set_option OR m.inherit_option)
  ) THEN
    RAISE EXCEPTION 'a role, the migrator included, can SET or INHERIT the recipient''s owner';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles
              WHERE rolname = 'polaris_activation_recipient_owner'
                AND (rolcanlogin OR rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication OR rolinherit)) THEN
    RAISE EXCEPTION 'polaris_activation_recipient_owner has an attribute it must not have';
  END IF;
END
$end_state$;--> statement-breakpoint
-- the migrator runs the pending migrations in one transaction: the timeout of this one stops here
RESET lock_timeout;
