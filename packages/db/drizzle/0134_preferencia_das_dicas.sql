-- The preference of the tips for the person's own session (ADR 0106, D8): read whether the tips are on and how many went
-- out, and turn them on or off, on the same `email_opt_outs` row the one-click page of 0129 writes. Expand only
-- (ADR 0096): a new policy, a table grant, two new functions; nothing is dropped, altered or recreated, and the previous
-- Worker never calls them.
--
-- * `activation_email_preference(p_user)` answers `{"tips": boolean, "sent": integer}`: `tips` is false when the person
--   has a row in `email_opt_outs`; `sent` counts the person's notices that went out (`sent_at` set; the outcome check of
--   0124 allows one outcome per notice), in every store of theirs.
-- * `activation_set_tips(p_user, p_on)` turns the tips off with `INSERT … ON CONFLICT DO NOTHING` (a repeat keeps the
--   first instant) and on with `DELETE` of the person's row, and answers the state after, in the shape of the read.
--   Both are idempotent. A person that does not exist ends the way 0129 ends it (the foreign key refusal is swallowed,
--   no row) and answers the state of a person with no row and no notice. A null person or a null switch is an error: the
--   caller passes the ID of its session, never a value of the client.
-- * Neither reads `"user"`: the owner of the series sees only the people of the last 14 days' stores there (0124), and
--   the functions touch only `email_opt_outs.user_id` and `activation_notices.user_id`, so they work for an old account
--   and the policy on `"user"` is not widened.
-- * Owner: `polaris_activation_notice_owner`, the one owner of `email_opt_outs`. It gets the table privilege DELETE (a
--   column-less privilege) and a DELETE policy of its own; `SELECT (user_id)` it already holds, which the `WHERE` of the
--   DELETE needs. No runtime holds any privilege on the table.
-- * EXECUTE only to the tenant runtime, the role of the session that serves "Seus dados" (`HYPERDRIVE`, the one of
--   `dataExport`); never the billing runtime nor the anonymous page's connection. The billing runtime keeps only
--   `activation_record_opt_out`.
-- The policy and the grant take a lock on the table: a lock not had in 10 s fails the migration instead of queueing
-- requests.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE POLICY "email_opt_outs_owner_delete" ON "email_opt_outs" AS PERMISSIVE FOR DELETE TO "polaris_activation_notice_owner" USING (true);--> statement-breakpoint
GRANT DELETE ON TABLE public.email_opt_outs TO polaris_activation_notice_owner;--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO polaris_activation_notice_owner;--> statement-breakpoint
GRANT polaris_activation_notice_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
SET ROLE polaris_activation_notice_owner;--> statement-breakpoint
-- Whether the person gets the tips and how many went out to them, in every store.
CREATE FUNCTION public.activation_email_preference(p_user text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
BEGIN
  IF p_user IS NULL THEN
    RAISE EXCEPTION 'invalid_user' USING ERRCODE = '22023';
  END IF;
  RETURN pg_catalog.jsonb_build_object(
    'tips', NOT EXISTS (SELECT 1 FROM public.email_opt_outs AS opt_out WHERE opt_out.user_id = p_user),
    'sent', (SELECT pg_catalog.count(*)::integer FROM public.activation_notices AS notice
              WHERE notice.user_id = p_user AND notice.sent_at IS NOT NULL)
  );
END;
$function$;--> statement-breakpoint
-- Turns the tips of the person off (a row in `email_opt_outs`) or on (no row), and answers the state after.
CREATE FUNCTION public.activation_set_tips(p_user text, p_on boolean)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
BEGIN
  IF p_user IS NULL OR p_on IS NULL THEN
    RAISE EXCEPTION 'invalid_argument' USING ERRCODE = '22023';
  END IF;
  IF p_on THEN
    DELETE FROM public.email_opt_outs WHERE user_id = p_user;
  ELSE
    BEGIN
      INSERT INTO public.email_opt_outs (user_id) VALUES (p_user) ON CONFLICT (user_id) DO NOTHING;
    EXCEPTION WHEN foreign_key_violation THEN
      NULL;
    END;
  END IF;
  RETURN public.activation_email_preference(p_user);
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.activation_email_preference(text) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_privacy_runtime, polaris_outbox_runtime, polaris_auth_runtime;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.activation_set_tips(text, boolean) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_privacy_runtime, polaris_outbox_runtime, polaris_auth_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.activation_email_preference(text) TO polaris_pr11_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.activation_set_tips(text, boolean) TO polaris_pr11_runtime;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_activation_notice_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_activation_notice_owner;--> statement-breakpoint
-- The end state (a REVOKE without the right is only a WARNING on Neon): the owner of the series holds, on
-- `email_opt_outs`, the INSERT and SELECT of `user_id` and the table privilege DELETE, and still no other table
-- privilege nor CREATE; it owns exactly its five functions; the tenant runtime alone executes the two new ones and the
-- billing runtime alone the opt-out; none of the runtimes nor PUBLIC reaches the table; and no role, the migrator
-- included, can SET or INHERIT the owner, which would write the table past the functions.
DO $end_state$
DECLARE
  held text[];
  fn text;
BEGIN
  SELECT COALESCE(pg_catalog.array_agg(p.entry ORDER BY p.entry COLLATE "C"), '{}')
    INTO held
    FROM (SELECT c.table_name || '.' || c.column_name || ':' || c.privilege_type AS entry
            FROM information_schema.column_privileges AS c
           WHERE c.grantee = 'polaris_activation_notice_owner' AND c.table_name = 'email_opt_outs') AS p;
  IF held IS DISTINCT FROM ARRAY['email_opt_outs.user_id:INSERT', 'email_opt_outs.user_id:SELECT'] THEN
    RAISE EXCEPTION 'the owner of the series does not hold exactly its columns of email_opt_outs: %', held;
  END IF;
  SELECT COALESCE(pg_catalog.array_agg(t.table_name || ':' || t.privilege_type
                                       ORDER BY t.table_name || ':' || t.privilege_type COLLATE "C"), '{}')
    INTO held
    FROM information_schema.table_privileges AS t
   WHERE t.grantee = 'polaris_activation_notice_owner';
  IF held IS DISTINCT FROM ARRAY['email_opt_outs:DELETE']
     OR pg_catalog.has_schema_privilege('polaris_activation_notice_owner', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'the owner of the series holds more than its columns and the DELETE of email_opt_outs: %', held;
  END IF;
  IF (SELECT pg_catalog.array_agg(p.oid::regprocedure::text ORDER BY p.oid::regprocedure::text COLLATE "C")
        FROM pg_catalog.pg_proc AS p
       WHERE p.proowner = 'polaris_activation_notice_owner'::regrole)
     IS DISTINCT FROM ARRAY['activation_email_preference(text)',
                            'activation_notice_candidates(timestamp with time zone,integer)',
                            'activation_notice_still_owed(text,uuid,timestamp with time zone)',
                            'activation_record_opt_out(text)',
                            'activation_set_tips(text,boolean)'] THEN
    RAISE EXCEPTION 'the owner of the series does not own exactly its five functions';
  END IF;
  FOREACH fn IN ARRAY ARRAY['public.activation_email_preference(text)', 'public.activation_set_tips(text, boolean)'] LOOP
    IF pg_catalog.has_function_privilege('public', fn, 'EXECUTE')
       OR NOT pg_catalog.has_function_privilege('polaris_pr11_runtime', fn, 'EXECUTE')
       OR EXISTS (
         SELECT 1 FROM pg_catalog.pg_roles AS r
          WHERE r.rolname LIKE 'polaris\_%' AND NOT r.rolcanlogin
            AND r.rolname NOT IN ('polaris_pr11_runtime', 'polaris_activation_notice_owner')
            AND pg_catalog.has_function_privilege(r.oid, fn, 'EXECUTE')
       ) THEN
      RAISE EXCEPTION 'the preference function % does not have its one executor', fn;
    END IF;
  END LOOP;
  IF pg_catalog.has_function_privilege('public', 'public.activation_record_opt_out(text)', 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('polaris_billing_runtime', 'public.activation_record_opt_out(text)', 'EXECUTE')
     OR EXISTS (
       SELECT 1 FROM pg_catalog.pg_roles AS r
        WHERE r.rolname LIKE 'polaris\_%' AND NOT r.rolcanlogin
          AND r.rolname NOT IN ('polaris_billing_runtime', 'polaris_activation_notice_owner')
          AND pg_catalog.has_function_privilege(r.oid, 'public.activation_record_opt_out(text)', 'EXECUTE')
     ) THEN
    RAISE EXCEPTION 'the opt-out function does not keep its one executor';
  END IF;
  IF EXISTS (
    SELECT 1 FROM (
       SELECT 'public'::text AS role
       UNION ALL
       SELECT r.rolname::text FROM pg_catalog.pg_roles AS r WHERE r.rolname LIKE 'polaris\_%' AND NOT r.rolcanlogin
     ) AS r
     WHERE r.role <> 'polaris_activation_notice_owner'
       AND (pg_catalog.has_table_privilege(r.role, 'public.email_opt_outs', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
            OR pg_catalog.has_any_column_privilege(r.role, 'public.email_opt_outs', 'SELECT, INSERT, UPDATE, REFERENCES'))
  ) THEN
    RAISE EXCEPTION 'a role other than the owner of the series reaches email_opt_outs';
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
