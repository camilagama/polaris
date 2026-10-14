DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.media_assets) THEN
    RAISE EXCEPTION 'media_assets must be empty before PR34 upload metadata is added; backfill storage metadata before retrying';
  END IF;
END;
$$;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "byte_size" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "content_type" text NOT NULL;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "input_fingerprint" text NOT NULL;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "storage_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "upload_command_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "height" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "width" integer NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "media_assets_organization_upload_command_unique" ON "media_assets" USING btree ("organization_id","upload_command_id");--> statement-breakpoint
CREATE UNIQUE INDEX "media_assets_storage_key_unique" ON "media_assets" USING btree ("storage_key");--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_byte_size_valid" CHECK ("media_assets"."byte_size" BETWEEN 1 AND 20000000);--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_content_type_webp" CHECK ("media_assets"."content_type" = 'image/webp');--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_dimensions_valid" CHECK ("media_assets"."width" BETWEEN 1 AND 1200 AND "media_assets"."height" BETWEEN 1 AND 1200);--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_input_fingerprint_sha256" CHECK ("media_assets"."input_fingerprint" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
CREATE POLICY "media_assets_current_tenant_insert" ON "media_assets" AS PERMISSIVE FOR INSERT TO "polaris_pr11_runtime" WITH CHECK (
  "media_assets"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "media_assets"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "media_assets"."organization_id"
      AND organization_scope.status = 'active'
  )
);--> statement-breakpoint
CREATE POLICY "product_media_current_tenant_live_product_insert" ON "product_media" AS PERMISSIVE FOR INSERT TO "polaris_pr11_runtime" WITH CHECK (

  "product_media"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "product_media"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "product_media"."organization_id"
      AND organization_scope.status = 'active'
  )

        AND EXISTS (
          SELECT 1
          FROM public.products AS product_scope
          WHERE product_scope.id = "product_media"."product_id"
            AND product_scope.organization_id = "product_media"."organization_id"
            AND product_scope.deleted_at IS NULL
        )
      );--> statement-breakpoint
CREATE POLICY "variant_media_current_tenant_live_product_insert" ON "variant_media" AS PERMISSIVE FOR INSERT TO "polaris_pr11_runtime" WITH CHECK (

  "variant_media"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "variant_media"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "variant_media"."organization_id"
      AND organization_scope.status = 'active'
  )

        AND EXISTS (
          SELECT 1
          FROM public.products AS product_scope
          INNER JOIN public.product_variants AS variant_scope
            ON variant_scope.organization_id = product_scope.organization_id
           AND variant_scope.product_id = product_scope.id
          WHERE product_scope.id = "variant_media"."product_id"
            AND product_scope.organization_id = "variant_media"."organization_id"
            AND product_scope.deleted_at IS NULL
            AND variant_scope.id = "variant_media"."variant_id"
        )
      );
--> statement-breakpoint
CREATE FUNCTION public.require_media_asset_product_link()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.product_media
    WHERE organization_id = NEW.organization_id
      AND media_asset_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'media asset must link to its owning product'
      USING ERRCODE = '23514',
            CONSTRAINT = 'media_assets_product_link_required';
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.require_media_asset_product_link() FROM PUBLIC;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER media_assets_product_link_required
AFTER INSERT ON public.media_assets
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION public.require_media_asset_product_link();--> statement-breakpoint
REVOKE ALL ON TABLE public.media_assets, public.product_media, public.variant_media FROM PUBLIC, polaris_pr11_runtime;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.media_assets TO polaris_pr11_runtime;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.product_media TO polaris_pr11_runtime;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.variant_media TO polaris_pr11_runtime;
