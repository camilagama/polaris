CREATE TABLE "media_assets" (
	"created_at" timestamp DEFAULT now() NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "media_assets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "media_assets_organization_id_unique" ON "media_assets" USING btree ("organization_id","id");--> statement-breakpoint
CREATE TABLE "product_media" (
	"created_at" timestamp DEFAULT now() NOT NULL,
	"media_asset_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"position" integer NOT NULL,
	"product_id" uuid NOT NULL,
	CONSTRAINT "product_media_pk" PRIMARY KEY("organization_id","product_id","media_asset_id"),
	CONSTRAINT "product_media_position_nonnegative" CHECK ("product_media"."position" >= 0)
);
--> statement-breakpoint
ALTER TABLE "product_media" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "variant_media" (
	"created_at" timestamp DEFAULT now() NOT NULL,
	"media_asset_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"position" integer NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	CONSTRAINT "variant_media_pk" PRIMARY KEY("organization_id","product_id","variant_id","media_asset_id"),
	CONSTRAINT "variant_media_position_nonnegative" CHECK ("variant_media"."position" >= 0)
);
--> statement-breakpoint
ALTER TABLE "variant_media" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_media" ADD CONSTRAINT "product_media_product_fk" FOREIGN KEY ("organization_id","product_id") REFERENCES "public"."products"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_media" ADD CONSTRAINT "product_media_asset_fk" FOREIGN KEY ("organization_id","media_asset_id") REFERENCES "public"."media_assets"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant_media" ADD CONSTRAINT "variant_media_variant_fk" FOREIGN KEY ("organization_id","product_id","variant_id") REFERENCES "public"."product_variants"("organization_id","product_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant_media" ADD CONSTRAINT "variant_media_product_asset_fk" FOREIGN KEY ("organization_id","product_id","media_asset_id") REFERENCES "public"."product_media"("organization_id","product_id","media_asset_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "product_media_asset_one_product_unique" ON "product_media" USING btree ("organization_id","media_asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_media_product_position_unique" ON "product_media" USING btree ("organization_id","product_id","position");--> statement-breakpoint
CREATE INDEX "variant_media_organization_asset_idx" ON "variant_media" USING btree ("organization_id","media_asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "variant_media_variant_position_unique" ON "variant_media" USING btree ("organization_id","product_id","variant_id","position");--> statement-breakpoint
CREATE POLICY "media_assets_current_tenant_select" ON "media_assets" AS PERMISSIVE FOR SELECT TO "polaris_pr11_runtime" USING (
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
CREATE POLICY "product_media_current_tenant_select" ON "product_media" AS PERMISSIVE FOR SELECT TO "polaris_pr11_runtime" USING (
        
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
        )
      );--> statement-breakpoint
CREATE POLICY "variant_media_current_tenant_select" ON "variant_media" AS PERMISSIVE FOR SELECT TO "polaris_pr11_runtime" USING (
        
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
            AND variant_scope.id = "variant_media"."variant_id"
        )
      );--> statement-breakpoint
ALTER TABLE public.media_assets FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.product_media FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.variant_media FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE public.media_assets FROM PUBLIC, polaris_pr11_runtime;--> statement-breakpoint
REVOKE ALL ON TABLE public.product_media FROM PUBLIC, polaris_pr11_runtime;--> statement-breakpoint
REVOKE ALL ON TABLE public.variant_media FROM PUBLIC, polaris_pr11_runtime;--> statement-breakpoint
GRANT SELECT ON TABLE public.media_assets TO polaris_pr11_runtime;--> statement-breakpoint
GRANT SELECT ON TABLE public.product_media TO polaris_pr11_runtime;--> statement-breakpoint
GRANT SELECT ON TABLE public.variant_media TO polaris_pr11_runtime;--> statement-breakpoint
CREATE FUNCTION public.guard_media_link_product_not_deleted()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  target_organization_id text;
  target_product_id uuid;
  product_deleted_at timestamp;
BEGIN
  IF TG_OP = 'UPDATE' AND (
    OLD.organization_id IS DISTINCT FROM NEW.organization_id
    OR OLD.product_id IS DISTINCT FROM NEW.product_id
    OR OLD.media_asset_id IS DISTINCT FROM NEW.media_asset_id
    OR OLD.created_at IS DISTINCT FROM NEW.created_at
    OR (
      TG_TABLE_NAME = 'variant_media'
      AND (to_jsonb(OLD) ->> 'variant_id') IS DISTINCT FROM
          (to_jsonb(NEW) ->> 'variant_id')
    )
  ) THEN
    RAISE EXCEPTION 'media association identity is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'media_association_identity_guard';
  END IF;

  IF TG_OP = 'DELETE' THEN
    target_organization_id := OLD.organization_id;
    target_product_id := OLD.product_id;
  ELSE
    target_organization_id := NEW.organization_id;
    target_product_id := NEW.product_id;
  END IF;

  SELECT product.deleted_at
  INTO product_deleted_at
  FROM public.products AS product
  WHERE product.organization_id = target_organization_id
    AND product.id = target_product_id
  FOR UPDATE;

  IF FOUND AND product_deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'media associations cannot change for a tombstoned product'
      USING ERRCODE = '23514',
            CONSTRAINT = 'media_product_tombstone_guard';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.guard_media_link_product_not_deleted() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER product_media_tombstone_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.product_media
FOR EACH ROW
EXECUTE FUNCTION public.guard_media_link_product_not_deleted();--> statement-breakpoint
CREATE TRIGGER variant_media_tombstone_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.variant_media
FOR EACH ROW
EXECUTE FUNCTION public.guard_media_link_product_not_deleted();