-- The record of acceptance of the terms of use and of the privacy policy (ADR 0100, entry screen P4): one row for each
-- document version a user accepted, with the SHA-256 of the text, the database clock, where it was accepted and the request
-- ID, and NO IP and no browser. Per user, not per organization, and without a foreign key to the user, so a row outlives the
-- deletion of the account (kept 10 years after it; the retention class `legal_acceptance`). Append-only: triggers refuse
-- UPDATE, DELETE and TRUNCATE for every role, `ENABLE ALWAYS` like the access log and the audits. Nothing but
-- `polaris_legal_acceptance_owner` (NOLOGIN) has a privilege on the table (RLS forced, an INSERT and a SELECT policy, no
-- UPDATE or DELETE), and the two functions it owns are the whole interface, executed by the authentication runtime and nothing
-- else: `record_legal_acceptance` appends (idempotent, and a bad input is a result code, never an exception) and
-- `legal_acceptance_versions` answers the highest version of each document a user accepted. New table, new role and new
-- functions only (ADR 0096): the previous Worker never calls them, so it keeps working against this migration. No enum
-- value is added, and `purge_organization_data` and the other purge functions are left as they are (the table has no
-- organization).
DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'polaris_legal_acceptance_owner') THEN
    EXECUTE 'CREATE ROLE polaris_legal_acceptance_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
  END IF;
  -- a role that already existed gets the same attributes: this one is never a login
  EXECUTE 'ALTER ROLE polaris_legal_acceptance_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
END
$roles$;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO polaris_legal_acceptance_owner;--> statement-breakpoint
CREATE TABLE "legal_acceptance" (
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"document" text NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"origin" text NOT NULL,
	"request_id" text NOT NULL,
	"text_sha256" text NOT NULL,
	"user_id" text NOT NULL,
	"version" integer NOT NULL,
	CONSTRAINT "legal_acceptance_user_document_version_key" UNIQUE("user_id","document","version"),
	CONSTRAINT "legal_acceptance_user_format" CHECK ("legal_acceptance"."user_id" ~ '^[A-Za-z0-9_-]{1,64}$'),
	CONSTRAINT "legal_acceptance_document_allowed" CHECK ("legal_acceptance"."document" IN ('terms', 'privacy')),
	CONSTRAINT "legal_acceptance_version_range" CHECK ("legal_acceptance"."version" BETWEEN 1 AND 1000),
	CONSTRAINT "legal_acceptance_sha256_format" CHECK ("legal_acceptance"."text_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "legal_acceptance_origin_allowed" CHECK ("legal_acceptance"."origin" IN ('signup', 'reaceite')),
	CONSTRAINT "legal_acceptance_request_format" CHECK ("legal_acceptance"."request_id" ~ '^[A-Za-z0-9_-]{1,64}$')
);
--> statement-breakpoint
ALTER TABLE "legal_acceptance" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "legal_acceptance_owner_insert" ON "legal_acceptance" AS PERMISSIVE FOR INSERT TO "polaris_legal_acceptance_owner" WITH CHECK (true);--> statement-breakpoint
CREATE POLICY "legal_acceptance_owner_select" ON "legal_acceptance" AS PERMISSIVE FOR SELECT TO "polaris_legal_acceptance_owner" USING (true);--> statement-breakpoint
ALTER TABLE "legal_acceptance" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE public.legal_acceptance FROM PUBLIC, polaris_pr11_runtime, polaris_auth_runtime, polaris_billing_runtime, polaris_catalog_runtime, polaris_admin_runtime, polaris_admin_owner, polaris_privacy_runtime, polaris_privacy_owner, polaris_outbox_runtime, polaris_outbox_owner, polaris_purge_owner, polaris_media_cleanup_runtime, polaris_media_cleanup_owner, polaris_onboarding_runtime, polaris_billing_owner, polaris_catalog_owner, polaris_retention_owner, polaris_device_session_owner, polaris_access_log_owner, polaris_login_lock_owner;--> statement-breakpoint
-- the owner appends and reads; nobody changes or deletes a row (the triggers refuse it for every role as well)
GRANT SELECT, INSERT ON TABLE public.legal_acceptance TO polaris_legal_acceptance_owner;--> statement-breakpoint
CREATE FUNCTION public.legal_acceptance_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'the record of legal acceptance is append-only'
    USING ERRCODE = '23514';
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.legal_acceptance_immutable() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER legal_acceptance_no_change
  BEFORE UPDATE OR DELETE ON public.legal_acceptance
  FOR EACH ROW EXECUTE FUNCTION public.legal_acceptance_immutable();--> statement-breakpoint
CREATE TRIGGER legal_acceptance_no_truncate
  BEFORE TRUNCATE ON public.legal_acceptance
  FOR EACH STATEMENT EXECUTE FUNCTION public.legal_acceptance_immutable();--> statement-breakpoint
-- ALWAYS: they fire also under session_replication_role = replica
ALTER TABLE public.legal_acceptance ENABLE ALWAYS TRIGGER legal_acceptance_no_change;--> statement-breakpoint
ALTER TABLE public.legal_acceptance ENABLE ALWAYS TRIGGER legal_acceptance_no_truncate;--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO polaris_legal_acceptance_owner;--> statement-breakpoint
GRANT polaris_legal_acceptance_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
SET ROLE polaris_legal_acceptance_owner;--> statement-breakpoint
-- appends the acceptance of one version of one document, with the database clock, and answers a result code: `recorded`,
-- `already_accepted` (the same user, document and version again, with the same text hash: nothing is written, so the
-- acceptance is idempotent, also for two requests at once, by ON CONFLICT DO NOTHING) or `invalid_*`. A bad input is a code,
-- never an exception, so the caller has nothing to roll back; the same version with a text hash different from the stored one
-- is `invalid_hash` (the proof of the first acceptance is not replaced and is not confirmed for another text). It assumes READ
-- COMMITTED, the default: the read of the stored hash after a conflict has to see the row the other request just committed
CREATE FUNCTION public.record_legal_acceptance(
  p_user text,
  p_document text,
  p_version integer,
  p_sha256 text,
  p_origin text,
  p_request text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  inserted integer;
  stored_sha256 text;
BEGIN
  IF p_user IS NULL OR p_user !~ '^[A-Za-z0-9_-]{1,64}$' THEN
    RETURN 'invalid_user';
  END IF;
  IF p_document IS NULL OR p_document NOT IN ('terms', 'privacy') THEN
    RETURN 'invalid_document';
  END IF;
  -- the cap of the CHECK (1 to 1000): a huge version would pass every future minimum and cannot be taken back
  IF p_version IS NULL OR p_version < 1 OR p_version > 1000 THEN
    RETURN 'invalid_version';
  END IF;
  IF p_sha256 IS NULL OR p_sha256 !~ '^[0-9a-f]{64}$' THEN
    RETURN 'invalid_hash';
  END IF;
  IF p_origin IS NULL OR p_origin NOT IN ('signup', 'reaceite') THEN
    RETURN 'invalid_origin';
  END IF;
  IF p_request IS NULL OR p_request !~ '^[A-Za-z0-9_-]{1,64}$' THEN
    RETURN 'invalid_request';
  END IF;
  INSERT INTO public.legal_acceptance (user_id, document, version, text_sha256, origin, request_id, accepted_at)
  VALUES (p_user, p_document, p_version, p_sha256, p_origin, p_request, pg_catalog.clock_timestamp())
  ON CONFLICT ON CONSTRAINT legal_acceptance_user_document_version_key DO NOTHING;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  IF inserted = 1 THEN
    RETURN 'recorded';
  END IF;
  SELECT accepted.text_sha256 INTO stored_sha256
    FROM public.legal_acceptance AS accepted
   WHERE accepted.user_id = p_user AND accepted.document = p_document AND accepted.version = p_version;
  IF stored_sha256 IS DISTINCT FROM p_sha256 THEN
    RETURN 'invalid_hash';
  END IF;
  RETURN 'already_accepted';
END;
$function$;--> statement-breakpoint
-- the highest version of each document the user accepted (a document never accepted has no row). The caller compares it with
-- the minimum accepted version of the code. A user ID that is not of the Better Auth shape is a bug of the caller, not an
-- input to answer: it raises, so the access control fails closed
CREATE FUNCTION public.legal_acceptance_versions(p_user text)
RETURNS TABLE (document text, version integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF p_user IS NULL OR p_user !~ '^[A-Za-z0-9_-]{1,64}$' THEN
    RAISE EXCEPTION 'invalid legal acceptance user' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT accepted.document, pg_catalog.max(accepted.version)::integer
      FROM public.legal_acceptance AS accepted
     WHERE accepted.user_id = p_user
     GROUP BY accepted.document
     ORDER BY accepted.document;
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.record_legal_acceptance(text, text, integer, text, text, text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.legal_acceptance_versions(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.record_legal_acceptance(text, text, integer, text, text, text) TO polaris_auth_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.legal_acceptance_versions(text) TO polaris_auth_runtime;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_legal_acceptance_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_legal_acceptance_owner;
