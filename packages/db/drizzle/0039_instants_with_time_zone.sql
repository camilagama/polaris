-- Every instant column becomes timestamptz. Until now they were `timestamp`
-- (no zone) holding UTC wall-clock values: Drizzle wrote UTC, but DEFAULT now()
-- and clock_timestamp() converted through the session TimeZone, so a role or
-- pooler with a non-UTC TimeZone would silently shift instants. The values are
-- reinterpreted explicitly as UTC (`AT TIME ZONE 'UTC'`), never through the
-- session setting.
--
-- Policies (of any table: a policy can mention another table's column) and the
-- column-specific triggers (UPDATE OF ..., WHEN ...) of the affected tables block
-- ALTER COLUMN TYPE, so they are captured (pg_policies, pg_get_triggerdef),
-- dropped, and recreated verbatim in the same transaction.
DO $migration$
DECLARE
  v_column record;
  v_policy record;
  v_trigger record;
  v_trigger_definitions text[] := ARRAY[]::text[];
  v_statements text[] := ARRAY[]::text[];
  v_statement text;
BEGIN
  FOR v_trigger IN
    SELECT trigger_info.oid AS trigger_oid, trigger_info.tgname, class_info.relname
    FROM pg_trigger AS trigger_info
    JOIN pg_class AS class_info ON class_info.oid = trigger_info.tgrelid
    JOIN pg_namespace AS namespace_info ON namespace_info.oid = class_info.relnamespace
    WHERE namespace_info.nspname = 'public'
      AND NOT trigger_info.tgisinternal
      AND (trigger_info.tgattr::text <> '' OR trigger_info.tgqual IS NOT NULL)
      AND class_info.relname IN (
        SELECT DISTINCT column_info.table_name
        FROM information_schema.columns AS column_info
        WHERE column_info.table_schema = 'public'
          AND column_info.data_type = 'timestamp without time zone'
      )
    ORDER BY class_info.relname, trigger_info.tgname
  LOOP
    v_trigger_definitions := array_append(
      v_trigger_definitions,
      pg_get_triggerdef(v_trigger.trigger_oid)
    );
    EXECUTE format('DROP TRIGGER %I ON public.%I', v_trigger.tgname, v_trigger.relname);
  END LOOP;
  FOR v_policy IN
    SELECT policy.schemaname, policy.tablename, policy.policyname, policy.permissive,
           policy.roles, policy.cmd, policy.qual, policy.with_check
    FROM pg_policies AS policy
    WHERE policy.schemaname = 'public'
  LOOP
    v_statements := array_append(
      v_statements,
      format(
        'CREATE POLICY %I ON %I.%I AS %s FOR %s TO %s%s%s',
        v_policy.policyname,
        v_policy.schemaname,
        v_policy.tablename,
        v_policy.permissive,
        v_policy.cmd,
        (
          SELECT string_agg(
            CASE WHEN role_name = 'public' THEN 'PUBLIC' ELSE quote_ident(role_name) END,
            ', '
          )
          FROM unnest(v_policy.roles) AS role_name
        ),
        CASE WHEN v_policy.qual IS NULL THEN '' ELSE format(' USING (%s)', v_policy.qual) END,
        CASE WHEN v_policy.with_check IS NULL THEN '' ELSE format(' WITH CHECK (%s)', v_policy.with_check) END
      )
    );
    EXECUTE format(
      'DROP POLICY %I ON %I.%I',
      v_policy.policyname, v_policy.schemaname, v_policy.tablename
    );
  END LOOP;

  FOR v_column IN
    SELECT column_info.table_name, column_info.column_name
    FROM information_schema.columns AS column_info
    JOIN information_schema.tables AS table_info
      ON table_info.table_schema = column_info.table_schema
     AND table_info.table_name = column_info.table_name
     AND table_info.table_type = 'BASE TABLE'
    WHERE column_info.table_schema = 'public'
      AND column_info.data_type = 'timestamp without time zone'
    ORDER BY column_info.table_name, column_info.ordinal_position
  LOOP
    EXECUTE format(
      'ALTER TABLE public.%I ALTER COLUMN %I SET DATA TYPE timestamp with time zone USING %I AT TIME ZONE ''UTC''',
      v_column.table_name, v_column.column_name, v_column.column_name
    );
  END LOOP;

  FOREACH v_statement IN ARRAY v_statements LOOP
    EXECUTE v_statement;
  END LOOP;

  FOREACH v_statement IN ARRAY v_trigger_definitions LOOP
    EXECUTE v_statement;
  END LOOP;
END
$migration$;
