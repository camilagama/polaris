ALTER TABLE "product_variants" ADD COLUMN "sku" text;--> statement-breakpoint
CREATE UNIQUE INDEX "product_variants_organization_sku_unique" ON "product_variants" USING btree ("organization_id",lower(btrim("sku"))) WHERE "product_variants"."sku" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_sku_canonical" CHECK (
        "product_variants"."sku" IS NULL OR (
          "product_variants"."sku" <> ''
          AND "product_variants"."sku" = btrim("product_variants"."sku")
          AND "product_variants"."sku" !~ '^[[:space:]]|[[:space:]]$'
        )
      );--> statement-breakpoint
CREATE POLICY "product_variants_current_tenant_sku_update" ON "product_variants" AS PERMISSIVE FOR UPDATE TO "polaris_pr11_runtime" USING (

  "product_variants"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "product_variants"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "product_variants"."organization_id"
      AND organization_scope.status = 'active'
  )

        AND EXISTS (
          SELECT 1
          FROM public.products AS product_scope
          WHERE product_scope.id = "product_variants"."product_id"
            AND product_scope.organization_id = "product_variants"."organization_id"
        )
      ) WITH CHECK (

  "product_variants"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "product_variants"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "product_variants"."organization_id"
      AND organization_scope.status = 'active'
  )

        AND EXISTS (
          SELECT 1
          FROM public.products AS product_scope
          WHERE product_scope.id = "product_variants"."product_id"
            AND product_scope.organization_id = "product_variants"."organization_id"
        )
      );
--> statement-breakpoint
GRANT UPDATE (sku) ON TABLE public.product_variants TO polaris_pr11_runtime;
--> statement-breakpoint
CREATE FUNCTION public.prevent_product_variant_sku_loss()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.is_default
     AND OLD.sku IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM public.products AS product
       WHERE product.id = OLD.product_id
         AND product.organization_id = OLD.organization_id
         AND product.variants_configured_at IS NULL
     ) THEN
    RAISE EXCEPTION 'clear the default variant SKU before configuring product variants'
      USING ERRCODE = '23514',
            CONSTRAINT = 'product_variants_default_sku_guard';
  END IF;
  RETURN OLD;
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.prevent_product_variant_sku_loss() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER product_variants_prevent_default_sku_loss
BEFORE DELETE ON public.product_variants
FOR EACH ROW EXECUTE FUNCTION public.prevent_product_variant_sku_loss();
