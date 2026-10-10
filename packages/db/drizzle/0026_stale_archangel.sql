DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'polaris_media_cleanup_owner') THEN
    EXECUTE 'CREATE ROLE polaris_media_cleanup_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'polaris_media_cleanup_runtime') THEN
    EXECUTE 'CREATE ROLE polaris_media_cleanup_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS';
  END IF;
END
$roles$;
--> statement-breakpoint
CREATE TABLE "media_cleanup_claims" (
  "claimed_at" timestamp DEFAULT now() NOT NULL,
  "storage_key" text PRIMARY KEY NOT NULL,
  CONSTRAINT "media_cleanup_claims_storage_key_valid" CHECK ("media_cleanup_claims"."storage_key" ~ '^media/v2/[^/]+/[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f]{64}/[0-9a-f-]{36}\.webp$')
);
--> statement-breakpoint
ALTER TABLE "media_cleanup_claims" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "media_cleanup_claims_owner_all" ON "media_cleanup_claims" AS PERMISSIVE FOR ALL TO "polaris_media_cleanup_owner" USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE public.media_cleanup_claims FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE public.media_cleanup_claims FROM PUBLIC, polaris_pr11_runtime, polaris_media_cleanup_runtime;--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO polaris_media_cleanup_owner, polaris_media_cleanup_runtime;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.media_cleanup_claims TO polaris_media_cleanup_owner;--> statement-breakpoint
CREATE POLICY media_assets_cleanup_owner_select ON public.media_assets
  AS PERMISSIVE FOR SELECT TO polaris_media_cleanup_owner USING (true);--> statement-breakpoint
GRANT SELECT (storage_key) ON TABLE public.media_assets TO polaris_media_cleanup_owner;--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO polaris_media_cleanup_owner;--> statement-breakpoint
CREATE FUNCTION public.guard_media_storage_key_cleanup_claim()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(NEW.storage_key, 35035)
  );

  IF EXISTS (
    SELECT 1
    FROM public.media_cleanup_claims AS claim
    WHERE claim.storage_key = NEW.storage_key
  ) THEN
    RAISE EXCEPTION 'media storage key is already claimed for cleanup'
      USING ERRCODE = '23514',
            CONSTRAINT = 'media_assets_storage_key_cleanup_claimed';
  END IF;

  RETURN NEW;
END;
$function$;--> statement-breakpoint
ALTER FUNCTION public.guard_media_storage_key_cleanup_claim() OWNER TO polaris_media_cleanup_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.guard_media_storage_key_cleanup_claim() FROM PUBLIC, polaris_pr11_runtime, polaris_media_cleanup_runtime;--> statement-breakpoint
CREATE TRIGGER media_assets_storage_key_cleanup_guard
BEFORE INSERT ON public.media_assets
FOR EACH ROW
EXECUTE FUNCTION public.guard_media_storage_key_cleanup_claim();--> statement-breakpoint
CREATE FUNCTION public.claim_media_storage_key_for_cleanup(p_storage_key text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF p_storage_key !~ '^media/v2/[^/]+/[0-9a-f-]{36}/[0-9a-f-]{36}/[0-9a-f]{64}/[0-9a-f-]{36}[.]webp$' THEN
    RAISE EXCEPTION 'invalid media storage key for cleanup'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.media_assets AS asset
    WHERE asset.storage_key = p_storage_key
  ) THEN
    RETURN false;
  END IF;

  INSERT INTO public.media_cleanup_claims (storage_key)
  VALUES (p_storage_key)
  ON CONFLICT (storage_key) DO NOTHING;

  RETURN true;
END;
$function$;--> statement-breakpoint
ALTER FUNCTION public.claim_media_storage_key_for_cleanup(text) OWNER TO polaris_media_cleanup_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.claim_media_storage_key_for_cleanup(text) FROM PUBLIC, polaris_pr11_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.claim_media_storage_key_for_cleanup(text) TO polaris_media_cleanup_runtime;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_media_cleanup_owner;