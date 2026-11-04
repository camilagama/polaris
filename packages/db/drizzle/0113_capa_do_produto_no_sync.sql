-- The cover of a product (`coverAssetId`) is its image of lowest position. The read model computes it on every read (no
-- column, no backfill), so the device only needs to learn that the product changed when an image is added, moved or
-- removed. Triggers on `product_media` write that change to the sync log, without touching `products.version`: a
-- reorder must not conflict with an offline edit of the product (ADR 0030, amended).
--
-- `record_sync_change` fires per row and reads only NEW: a DELETE would raise, and a reorder (two UPDATEs over every
-- image of the product: move aside, then settle) would write two changes per image. The triggers here fire once per
-- statement, read the transition tables (OLD on a DELETE) and write one change per product the statement touched. The
-- move aside of a reorder (every new position at or above 1,000,000, `REORDER_OFFSET` of media-repository.ts) keeps
-- the order and is always followed by the statement that settles it, in the same transaction, so it writes nothing:
-- an upload, a reorder and a removal each leave exactly one change. No position at or above that offset survives a
-- command.
--
-- It belongs to `polaris_sync_owner` like the other two triggers of the log (ADR 0093, amendment of 0095): the same
-- scope line before the write, the same pinned search_path, EXECUTE only for the owner and the migrator (for CREATE
-- TRIGGER), and no privilege more: it reads only the transition tables, never `sync_changes`.
-- Expand only (ADR 0096): a new function and three new triggers; the previous Worker writes product_media as before and
-- the log gains rows it already knows how to pull (`product`).
-- CREATE TRIGGER takes a SHARE ROW EXCLUSIVE lock on product_media: better to fail and deploy again than to queue uploads.
SET LOCAL lock_timeout = '10s';--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO polaris_sync_owner;--> statement-breakpoint
GRANT polaris_sync_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
SET ROLE polaris_sync_owner;--> statement-breakpoint
CREATE FUNCTION public.record_product_media_sync_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
  v_products jsonb;
  v_product jsonb;
BEGIN
  -- each branch names only the transition tables its event has
  IF TG_OP = 'INSERT' THEN
    SELECT jsonb_agg(DISTINCT jsonb_build_object('organization', organization_id, 'product', product_id))
      INTO v_products FROM inserted_media;
  ELSIF TG_OP = 'DELETE' THEN
    SELECT jsonb_agg(DISTINCT jsonb_build_object('organization', organization_id, 'product', product_id))
      INTO v_products FROM deleted_media;
  ELSE
    -- the move aside of a reorder: the statement that settles it follows in the same transaction
    IF NOT EXISTS (SELECT 1 FROM moved_media WHERE position < 1000000) THEN
      RETURN NULL;
    END IF;
    SELECT jsonb_agg(DISTINCT jsonb_build_object('organization', touched.organization_id, 'product', touched.product_id))
      INTO v_products
      FROM (
        SELECT organization_id, product_id FROM moved_media
        UNION
        SELECT organization_id, product_id FROM unmoved_media
      ) AS touched;
  END IF;
  FOR v_product IN SELECT value FROM jsonb_array_elements(coalesce(v_products, '[]'::jsonb)) LOOP
    IF v_product ->> 'organization' IS NULL OR v_product ->> 'product' IS NULL THEN
      RAISE EXCEPTION 'sync change without organization or entity (product_media.product_id)'
        USING ERRCODE = 'P0001';
    END IF;
    -- the owner's policies see only this organization
    PERFORM pg_catalog.set_config('app.owner_scope.sync_organization_id', v_product ->> 'organization', true);
    INSERT INTO public.sync_changes (organization_id, entity_type, entity_id)
    VALUES (v_product ->> 'organization', 'product', (v_product ->> 'product')::uuid);
  END LOOP;
  RETURN NULL;
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.record_product_media_sync_change() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.record_product_media_sync_change() TO SESSION_USER;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_sync_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_sync_owner;--> statement-breakpoint
CREATE TRIGGER sync_record_product_media_insert AFTER INSERT ON public.product_media
  REFERENCING NEW TABLE AS inserted_media
  FOR EACH STATEMENT EXECUTE FUNCTION public.record_product_media_sync_change();--> statement-breakpoint
CREATE TRIGGER sync_record_product_media_update AFTER UPDATE ON public.product_media
  REFERENCING OLD TABLE AS unmoved_media NEW TABLE AS moved_media
  FOR EACH STATEMENT EXECUTE FUNCTION public.record_product_media_sync_change();--> statement-breakpoint
CREATE TRIGGER sync_record_product_media_delete AFTER DELETE ON public.product_media
  REFERENCING OLD TABLE AS deleted_media
  FOR EACH STATEMENT EXECUTE FUNCTION public.record_product_media_sync_change();--> statement-breakpoint
RESET lock_timeout;
