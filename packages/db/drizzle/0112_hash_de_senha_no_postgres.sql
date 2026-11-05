-- The hash of a password (ADR 0100, amended). The Worker computes only `k`, the HMAC-SHA-256 (64 lowercase hex digits) of
-- the NFC password with a pepper that lives as a Worker secret, and the bcrypt of `k` (cost 11) runs here, with pgcrypto,
-- so the hash spends no CPU of the Worker. The password itself never reaches the database, and `k` is useless without
-- the pepper: the Worker recomputes it from what is typed.
--
-- pgcrypto lives in a schema of its own that no role can use but the authentication runtime, so no other role gains a
-- cryptographic function. The schema is the barrier: a trusted extension created by a role that is not a superuser
-- (Neon) has its functions owned by the bootstrap superuser, who leaves EXECUTE to PUBLIC, and the REVOKE below only
-- takes where the migrator is a superuser. The two functions below are the whole interface: `auth_password_hash` makes a bcrypt of cost
-- 11 for a `k`, and `auth_password_crypt` recomputes the bcrypt of a `k` with the salt and cost of a stored hash (the Worker
-- compares the two in constant time). Both refuse anything that is not a `k` or a bcrypt hash, so a raw password is never
-- hashed by mistake; the authentication runtime still executes `crypt` and `gen_salt` itself (the functions are invokers),
-- and the barrier against every other role is the schema. They are SECURITY INVOKER: they read no table and the authentication runtime already holds what they call.
-- pgcrypto is a trusted extension, so the owner of the database creates it without being a superuser (Neon). If it already
-- lives in another schema, it moves here (it is relocatable and nothing in the schema of the application calls it).
-- Expand only (ADR 0096): a schema, an extension and two new functions; the previous Worker never calls them.
CREATE SCHEMA IF NOT EXISTS polaris_password;--> statement-breakpoint
REVOKE ALL ON SCHEMA polaris_password FROM PUBLIC;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA polaris_password;--> statement-breakpoint
DO $move$
BEGIN
  IF (SELECT extension_namespace.nspname
        FROM pg_catalog.pg_extension AS extension
        JOIN pg_catalog.pg_namespace AS extension_namespace ON extension_namespace.oid = extension.extnamespace
       WHERE extension.extname = 'pgcrypto') <> 'polaris_password' THEN
    EXECUTE 'ALTER EXTENSION pgcrypto SET SCHEMA polaris_password';
  END IF;
END
$move$;--> statement-breakpoint
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA polaris_password FROM PUBLIC;--> statement-breakpoint
GRANT USAGE ON SCHEMA polaris_password TO polaris_auth_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION polaris_password.crypt(text, text) TO polaris_auth_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION polaris_password.gen_salt(text, integer) TO polaris_auth_runtime;--> statement-breakpoint
-- a `k` that is not 64 lowercase hex digits is a bug of the caller (a raw password, an empty pepper): it raises, so the
-- password is never stored in a form the Worker would not recompute
CREATE FUNCTION public.auth_password_hash(p_key text)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF p_key IS NULL OR p_key !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid password key' USING ERRCODE = '22023';
  END IF;
  RETURN polaris_password.crypt(p_key, polaris_password.gen_salt('bf', 11));
END;
$function$;--> statement-breakpoint
-- the stored hash gives the salt and the cost: a cost from 10 to 14 is accepted, so raising the cost later does not
-- lock out the hashes already stored; any other text raises (the Worker never sends one: it sends only what it stored
-- after the prefix of the version)
CREATE FUNCTION public.auth_password_crypt(p_key text, p_hash text)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF p_key IS NULL OR p_key !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'invalid password key' USING ERRCODE = '22023';
  END IF;
  IF p_hash IS NULL OR p_hash !~ '^\$2a\$1[0-4]\$[./A-Za-z0-9]{53}$' THEN
    RAISE EXCEPTION 'invalid password hash' USING ERRCODE = '22023';
  END IF;
  RETURN polaris_password.crypt(p_key, p_hash);
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.auth_password_hash(text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.auth_password_crypt(text, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.auth_password_hash(text) TO polaris_auth_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.auth_password_crypt(text, text) TO polaris_auth_runtime;
