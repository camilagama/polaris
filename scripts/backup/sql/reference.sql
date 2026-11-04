-- What a restore must reproduce, read in one statement so that the backup takes it inside the snapshot of the dump and
-- the restore reads the same shape from the restored database (scripts/backup/restore.mjs compares the two). One jsonb
-- line: row counts per table, migrations, and the catalog readings of docs/runbooks/deletion-ledger-restore.md
-- (steps 2, 2b and 5). Counts, hashes and role names only: no row of the business ever leaves the database here.
-- Needs a login that bypasses row security, or the counts are those of the rows the login sees.
SET search_path = pg_catalog;
SELECT jsonb_build_object(
  'tables', (
    SELECT coalesce(jsonb_object_agg(t.name, t.rows), '{}'::jsonb)
      FROM (
        SELECT n.nspname || '.' || c.relname AS name,
               (xpath('/row/c/text()',
                      query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname), false, true, '')))[1]::text::bigint AS rows
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relkind IN ('r', 'p')
           AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\_%'
           AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
      ) AS t
  ),
  'migrations', (
    SELECT jsonb_build_object(
             'count', count(*),
             'last_hash', (SELECT m.hash FROM drizzle.__drizzle_migrations m ORDER BY m.created_at DESC, m.id DESC LIMIT 1),
             'last_created_at', max(created_at))
      FROM drizzle.__drizzle_migrations
  ),
  'owner_roles', (SELECT count(*) FROM pg_roles WHERE rolname LIKE 'polaris\_%\_owner'),
  'foreign_owner_definers', (
    SELECT count(*)
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.prosecdef
       AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\_toast%'
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
       AND pg_get_userbyid(p.proowner) NOT LIKE 'polaris\_%\_owner'
  ),
  'public_executable_definers', (
    SELECT count(*)
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.prosecdef AND n.nspname = 'public'
       AND has_function_privilege('public', p.oid, 'EXECUTE')
  ),
  'function_acl_hash', (
    SELECT md5(string_agg(
             n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') '
             || pg_get_userbyid(p.proowner) || ' '
             || array_to_string(ARRAY(SELECT x::text FROM unnest(coalesce(p.proacl, acldefault('f', p.proowner))) AS x ORDER BY x::text COLLATE "C"), ','),
             E'\n' ORDER BY n.nspname COLLATE "C", p.proname COLLATE "C", pg_get_function_identity_arguments(p.oid) COLLATE "C"))
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\_toast%'
       AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
  ),
  'purge_functions', (
    SELECT jsonb_agg(jsonb_build_object(
             'function', f.nome,
             'owner', pg_get_userbyid(p.proowner),
             'public_execute', has_function_privilege('public', p.oid, 'EXECUTE'),
             'runtimes_with_execute', (SELECT string_agg(r.rolname, ',' ORDER BY r.rolname)
                                         FROM pg_roles r
                                        WHERE r.rolname LIKE 'polaris\_%\_runtime'
                                          AND has_function_privilege(r.rolname, p.oid, 'EXECUTE')))
             ORDER BY f.nome COLLATE "C")
      FROM unnest(ARRAY['public.count_purges_held_back()',
                        'public.count_purges_stalled_without_progress(integer, integer)']) AS f(nome)
      LEFT JOIN pg_proc p ON p.oid = to_regprocedure(f.nome)
  ),
  'public_schema_acl', (
    SELECT array_to_string(ARRAY(SELECT x::text FROM unnest(nspacl) x ORDER BY x::text COLLATE "C"), ',')
      FROM pg_namespace WHERE nspname = 'public'
  ),
  'rls_tables', (
    SELECT jsonb_build_object(
             'tables', count(*),
             'forced', count(*) FILTER (WHERE c.relrowsecurity AND c.relforcerowsecurity),
             'hash', md5(string_agg(
                       n.nspname || '.' || c.relname || ' ' || c.relrowsecurity::text || ' ' || c.relforcerowsecurity::text,
                       E'\n' ORDER BY n.nspname COLLATE "C", c.relname COLLATE "C")))
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
  ),
  'policies', (
    SELECT jsonb_build_object(
             'count', count(*),
             'hash', md5(string_agg(
                       tablename || '.' || policyname || ' ' || permissive || ' '
                       || array_to_string(roles, ',') || ' ' || cmd || ' '
                       || coalesce(qual, '') || ' ' || coalesce(with_check, ''),
                       E'\n' ORDER BY tablename COLLATE "C", policyname COLLATE "C")))
      FROM pg_policies
     WHERE schemaname = 'public'
  ),
  'permissive_public_policies', (
    SELECT count(*)
      FROM pg_policies
     WHERE schemaname = 'public' AND permissive = 'PERMISSIVE'
       AND 'public' = ANY (roles::text[])
  ),
  'polaris_roles_bypassing_rls', (
    SELECT coalesce(jsonb_agg(rolname ORDER BY rolname), '[]'::jsonb)
      FROM pg_roles
     WHERE rolname LIKE 'polaris\_%' AND rolname <> 'polaris_backup_reader' AND (rolbypassrls OR rolsuper)
  ),
  'ledger_not_reapplied', (
    SELECT count(*) FROM (
      SELECT l.entity_id
        FROM public.deletion_ledger AS l
        JOIN public.customers AS c
          ON c.id::text = l.entity_id AND c.organization_id = l.organization_id
       WHERE l.entity_type = 'customer' AND l.operation = 'anonymize'
         AND c.anonymized_at IS NULL
      UNION ALL
      SELECT l.entity_id
        FROM public.deletion_ledger AS l
        JOIN public.organizations AS o ON o.id = l.entity_id
       WHERE l.entity_type = 'organization' AND l.operation = 'purge'
         AND o.status <> 'purged'
    ) AS pending
  ),
  'ledger_rows', (SELECT count(*) FROM public.deletion_ledger)
)::text;
