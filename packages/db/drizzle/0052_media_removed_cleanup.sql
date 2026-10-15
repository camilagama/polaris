-- Reclaiming the stored objects of images that were removed from a product
-- (ADR 0061). A removed image keeps its asset row and its object; this lets the
-- cleanup role, and only through two SECURITY DEFINER functions, list the assets
-- that nothing links to and finish their cleanup once the object is gone.
-- Same privilege layout as the staging reconciler (migration 0026).
GRANT SELECT (id, organization_id, created_at) ON TABLE public.media_assets TO polaris_media_cleanup_owner;--> statement-breakpoint
GRANT DELETE ON TABLE public.media_assets TO polaris_media_cleanup_owner;--> statement-breakpoint
CREATE POLICY media_assets_cleanup_owner_delete ON public.media_assets
  AS PERMISSIVE FOR DELETE TO polaris_media_cleanup_owner USING (true);--> statement-breakpoint
GRANT SELECT (organization_id, media_asset_id) ON TABLE public.product_media TO polaris_media_cleanup_owner;--> statement-breakpoint
CREATE POLICY product_media_cleanup_owner_select ON public.product_media
  AS PERMISSIVE FOR SELECT TO polaris_media_cleanup_owner USING (true);--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO polaris_media_cleanup_owner;--> statement-breakpoint
CREATE FUNCTION public.list_unlinked_media_for_cleanup(p_limit integer, p_min_age interval, p_exclude uuid[])
RETURNS TABLE (asset_id uuid, storage_key text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 THEN
    RAISE EXCEPTION 'invalid media cleanup batch size'
      USING ERRCODE = '22023';
  END IF;
  IF p_min_age IS NULL OR p_min_age < interval '0 seconds' THEN
    RAISE EXCEPTION 'invalid media cleanup minimum age'
      USING ERRCODE = '22023';
  END IF;

  IF p_exclude IS NOT NULL AND pg_catalog.cardinality(p_exclude) > 1000 THEN
    RAISE EXCEPTION 'too many excluded media assets'
      USING ERRCODE = '22023';
  END IF;

  -- An asset is created together with its link, in one transaction, and a link
  -- is never added to an existing asset: an asset that nothing links to is an
  -- image that was removed from its product.
  RETURN QUERY
  SELECT asset.id, asset.storage_key
  FROM public.media_assets AS asset
  WHERE asset.created_at < pg_catalog.now() - p_min_age
    AND NOT (asset.id = ANY (COALESCE(p_exclude, ARRAY[]::uuid[])))
    AND NOT EXISTS (
      SELECT 1
      FROM public.product_media AS link
      WHERE link.organization_id = asset.organization_id
        AND link.media_asset_id = asset.id
    )
  ORDER BY asset.created_at, asset.id
  LIMIT p_limit;
END;
$function$;--> statement-breakpoint
CREATE FUNCTION public.finalize_unlinked_media_cleanup(p_asset_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  removed_storage_key text;
BEGIN
  -- Run only after the object was deleted from the bucket. One statement both
  -- re-checks that nothing links to the asset and removes its row.
  DELETE FROM public.media_assets AS asset
  WHERE asset.id = p_asset_id
    AND NOT EXISTS (
      SELECT 1
      FROM public.product_media AS link
      WHERE link.organization_id = asset.organization_id
        AND link.media_asset_id = asset.id
    )
  RETURNING asset.storage_key INTO removed_storage_key;

  IF removed_storage_key IS NULL THEN
    RETURN false;
  END IF;

  -- The key stays tombstoned: it can never be used by a new asset.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(removed_storage_key, 35035)
  );
  INSERT INTO public.media_cleanup_claims (storage_key)
  VALUES (removed_storage_key)
  ON CONFLICT (storage_key) DO NOTHING;

  RETURN true;
END;
$function$;--> statement-breakpoint
-- The cleanup treats an asset nothing links to as a removed image, which is only
-- true while a link is never added to an asset that already exists. Enforce it:
-- a product link may only be inserted in the transaction that created its asset
-- (created_at is the transaction start). A restore or move command, or a bug,
-- can then never link an asset the cleanup may already have listed.
CREATE FUNCTION public.require_product_media_link_for_new_asset()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.media_assets AS asset
    WHERE asset.organization_id = NEW.organization_id
      AND asset.id = NEW.media_asset_id
      AND asset.created_at = pg_catalog.now()
  ) THEN
    RAISE EXCEPTION 'a product link can only be added to an asset created in the same transaction'
      USING ERRCODE = '23514',
            CONSTRAINT = 'product_media_new_asset_only';
  END IF;
  RETURN NULL;
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.require_product_media_link_for_new_asset() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER product_media_new_asset_only
AFTER INSERT ON public.product_media
FOR EACH ROW
EXECUTE FUNCTION public.require_product_media_link_for_new_asset();--> statement-breakpoint
GRANT polaris_media_cleanup_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
ALTER FUNCTION public.list_unlinked_media_for_cleanup(integer, interval, uuid[]) OWNER TO polaris_media_cleanup_owner;--> statement-breakpoint
ALTER FUNCTION public.finalize_unlinked_media_cleanup(uuid) OWNER TO polaris_media_cleanup_owner;--> statement-breakpoint
SET ROLE polaris_media_cleanup_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.list_unlinked_media_for_cleanup(integer, interval, uuid[]) FROM PUBLIC, polaris_pr11_runtime, polaris_media_cleanup_runtime;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.finalize_unlinked_media_cleanup(uuid) FROM PUBLIC, polaris_pr11_runtime, polaris_media_cleanup_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.list_unlinked_media_for_cleanup(integer, interval, uuid[]) TO polaris_media_cleanup_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.finalize_unlinked_media_cleanup(uuid) TO polaris_media_cleanup_runtime;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_media_cleanup_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_media_cleanup_owner;
