-- The opt-out of the activation series (ADR 0106, D8): the one way to record that a person no longer wants the tips,
-- for the one-click page that comes later. Expand only (ADR 0096): a new policy, a new function, a column grant to the
-- owner of the series and one REVOKE; nothing is dropped, altered or recreated, and the previous Worker never reads nor
-- writes `email_opt_outs` (the consumer that sends the series comes later).
--
-- * `activation_record_opt_out(p_user)`, SECURITY DEFINER of `polaris_activation_notice_owner`, EXECUTE to the billing
--   runtime only (the anonymous page runs on that connection, with no session nor store): it records the person with
--   `INSERT … ON CONFLICT DO NOTHING` and answers nothing. A repeated call keeps the one row and its first instant.
-- * A person that does not exist (an account deleted after the e-mail went out) ends the same way, with no error and
--   no row: the foreign key to `"user"` refuses the row and the function swallows that refusal. It does not look the
--   person up first: the owner of the series sees only the people of the last 14 days' stores (its policy on `"user"`
--   of 0124), so a lookup would answer "does not exist" for an older account, or need a wider policy on `"user"`. The
--   foreign key is checked by PostgreSQL as the owner of `"user"`, past row security, and tells nothing to the caller.
-- * No runtime reads or writes the table directly any more: the SELECT the billing runtime got in 0124 is revoked (no
--   Worker code reads it), so the page can only call the function, and whoever re-reads the opt-out when sending goes
--   through a function of the owner of the series too. The candidates already leave out a person who opted out. The
--   billing runtime's SELECT policy of 0124 stays, with no grant behind it (dropping it is not expand).
-- The policy takes a lock on the table: a lock not had in 10 s fails the migration instead of queueing requests.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
CREATE POLICY "email_opt_outs_owner_insert" ON "email_opt_outs" AS PERMISSIVE FOR INSERT TO "polaris_activation_notice_owner" WITH CHECK (true);--> statement-breakpoint
REVOKE ALL ON TABLE public.email_opt_outs FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_privacy_runtime, polaris_outbox_runtime, polaris_auth_runtime;--> statement-breakpoint
GRANT INSERT (user_id) ON TABLE public.email_opt_outs TO polaris_activation_notice_owner;--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO polaris_activation_notice_owner;--> statement-breakpoint
GRANT polaris_activation_notice_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
SET ROLE polaris_activation_notice_owner;--> statement-breakpoint
-- Records that the person asked not to receive the tips, in every store of theirs, from now on. Writes only, answers
-- nothing, and ends the same for a person already recorded, a person that does not exist and a null argument.
CREATE FUNCTION public.activation_record_opt_out(p_user text)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
BEGIN
  IF p_user IS NULL THEN
    RETURN;
  END IF;
  BEGIN
    INSERT INTO public.email_opt_outs (user_id) VALUES (p_user) ON CONFLICT (user_id) DO NOTHING;
  EXCEPTION WHEN foreign_key_violation THEN
    RETURN;
  END;
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.activation_record_opt_out(text) FROM PUBLIC, polaris_pr11_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_privacy_runtime, polaris_outbox_runtime, polaris_auth_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.activation_record_opt_out(text) TO polaris_billing_runtime;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_activation_notice_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_activation_notice_owner;--> statement-breakpoint
-- The end state (a REVOKE without the right is only a WARNING on Neon): the owner of the series holds the columns of
-- 0124 and 0126 plus INSERT of `email_opt_outs.user_id`, still no table privilege nor CREATE, and owns exactly its two
-- functions; only the billing runtime executes the new one; of PUBLIC and the `polaris_*` groups only the owner of the
-- series reaches `email_opt_outs` (none of the runtimes, not even one column; the purge needs none, the account's
-- foreign key cascades); and the migrator keeps no SET or INHERIT on the owner.
DO $end_state$
DECLARE
  held text[];
BEGIN
  SELECT COALESCE(pg_catalog.array_agg(p.entry ORDER BY p.entry COLLATE "C"), '{}')
    INTO held
    FROM (SELECT c.table_name || '.' || c.column_name || ':' || c.privilege_type AS entry
            FROM information_schema.column_privileges AS c
           WHERE c.grantee = 'polaris_activation_notice_owner' AND c.table_name = 'email_opt_outs') AS p;
  IF held IS DISTINCT FROM ARRAY['email_opt_outs.user_id:INSERT', 'email_opt_outs.user_id:SELECT'] THEN
    RAISE EXCEPTION 'the owner of the series does not hold exactly its columns of email_opt_outs: %', held;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.table_privileges AS t WHERE t.grantee = 'polaris_activation_notice_owner')
     OR pg_catalog.has_schema_privilege('polaris_activation_notice_owner', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'the owner of the series holds more than columns';
  END IF;
  IF (SELECT pg_catalog.array_agg(p.oid::regprocedure::text ORDER BY p.oid::regprocedure::text COLLATE "C")
        FROM pg_catalog.pg_proc AS p
       WHERE p.proowner = 'polaris_activation_notice_owner'::regrole)
     IS DISTINCT FROM ARRAY['activation_notice_candidates(timestamp with time zone,integer)',
                            'activation_record_opt_out(text)'] THEN
    RAISE EXCEPTION 'the owner of the series does not own exactly its two functions';
  END IF;
  IF pg_catalog.has_function_privilege('public', 'public.activation_record_opt_out(text)', 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('polaris_billing_runtime', 'public.activation_record_opt_out(text)', 'EXECUTE')
     OR EXISTS (
       SELECT 1 FROM pg_catalog.pg_roles AS r
        WHERE r.rolname LIKE 'polaris\_%' AND NOT r.rolcanlogin
          AND r.rolname NOT IN ('polaris_billing_runtime', 'polaris_activation_notice_owner')
          AND pg_catalog.has_function_privilege(r.oid, 'public.activation_record_opt_out(text)', 'EXECUTE')
     ) THEN
    RAISE EXCEPTION 'the opt-out function does not have its one executor';
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
     WHERE m.member = (SELECT r.oid FROM pg_catalog.pg_roles AS r WHERE r.rolname = CURRENT_USER)
       AND m.roleid = 'polaris_activation_notice_owner'::regrole
       AND (m.set_option OR m.inherit_option)
  ) THEN
    RAISE EXCEPTION 'the migrator kept SET or INHERIT on the owner of the series';
  END IF;
END
$end_state$;--> statement-breakpoint
-- the migrator runs the pending migrations in one transaction: the timeout of this one stops here
RESET lock_timeout;
