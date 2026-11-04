-- Read-only check before any dump: one line per failure, nothing when the database and the login are the expected ones.
-- psql variables: environment (staging | production) and expected_user. Names only: never a value of the database.
SET search_path = pg_catalog;
WITH readings AS (
  SELECT shobj_description(d.oid, 'pg_database') AS comment,
         coalesce(current_setting('polaris.environment', true), '') AS current,
         (SELECT substring(c, '^polaris\.environment=(.*)$')
            FROM pg_db_role_setting s, unnest(s.setconfig) AS c
           WHERE s.setdatabase = d.oid AND s.setrole = 0 AND c LIKE 'polaris.environment=%'
           LIMIT 1) AS stored
    FROM pg_database d
   WHERE d.datname = current_database()
),
me AS (
  SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
)
SELECT failure FROM (
  SELECT 'marker: the database comment is not exactly polaris.environment=' || :'environment' AS failure
    FROM readings WHERE comment IS DISTINCT FROM 'polaris.environment=' || :'environment'
  UNION ALL
  SELECT 'marker: the session or the stored setting names another environment'
    FROM readings WHERE current NOT IN ('', :'environment') OR coalesce(stored, :'environment') <> :'environment'
  UNION ALL
  SELECT 'login: not ' || :'expected_user' FROM me WHERE rolname <> :'expected_user'
  UNION ALL
  SELECT 'login: superuser' FROM me WHERE rolsuper
  UNION ALL
  SELECT 'login: without BYPASSRLS (pg_dump would refuse a table under forced row security)' FROM me WHERE NOT rolbypassrls
  UNION ALL
  SELECT 'login: default_transaction_read_only is not on'
   WHERE current_setting('default_transaction_read_only') <> 'on'
  UNION ALL
  SELECT 'login: not a member of pg_read_all_data'
   WHERE NOT pg_has_role(current_user, 'pg_read_all_data', 'USAGE')
) AS f
ORDER BY failure;
