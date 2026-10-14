CREATE TABLE "product_variants" (
	"created_at" timestamp DEFAULT now() NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"is_default" boolean DEFAULT true NOT NULL,
	"organization_id" text NOT NULL,
	"product_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "product_variants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "products" (
	"archived_at" timestamp,
	"category_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"description" text,
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"organization_id" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "products_name_not_blank" CHECK (char_length(btrim("products"."name")) >= 1),
	CONSTRAINT "products_version_positive" CHECK ("products"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "products" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "products_organization_id_id_unique" ON "products" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "categories_organization_id_id_unique" ON "categories" USING btree ("organization_id","id");--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_organization_product_fk" FOREIGN KEY ("organization_id","product_id") REFERENCES "public"."products"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_organization_category_fk" FOREIGN KEY ("organization_id","category_id") REFERENCES "public"."categories"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "product_variants_organization_product_idx" ON "product_variants" USING btree ("organization_id","product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_variants_one_default_per_product_unique" ON "product_variants" USING btree ("product_id") WHERE "product_variants"."is_default";--> statement-breakpoint
CREATE INDEX "products_organization_archive_name_idx" ON "products" USING btree ("organization_id","archived_at","name","id");--> statement-breakpoint
CREATE POLICY "product_variants_current_tenant_select" ON "product_variants" AS PERMISSIVE FOR SELECT TO "polaris_pr11_runtime" USING (

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
      );--> statement-breakpoint
CREATE POLICY "product_variants_current_tenant_insert" ON "product_variants" AS PERMISSIVE FOR INSERT TO "polaris_pr11_runtime" WITH CHECK (

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
      );--> statement-breakpoint
CREATE POLICY "products_current_tenant_select" ON "products" AS PERMISSIVE FOR SELECT TO "polaris_pr11_runtime" USING (
  "products"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "products"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "products"."organization_id"
      AND organization_scope.status = 'active'
  )
);--> statement-breakpoint
CREATE POLICY "products_current_tenant_insert" ON "products" AS PERMISSIVE FOR INSERT TO "polaris_pr11_runtime" WITH CHECK (
  "products"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "products"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "products"."organization_id"
      AND organization_scope.status = 'active'
  )
);--> statement-breakpoint
CREATE POLICY "products_current_tenant_update" ON "products" AS PERMISSIVE FOR UPDATE TO "polaris_pr11_runtime" USING (
  "products"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "products"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "products"."organization_id"
      AND organization_scope.status = 'active'
  )
) WITH CHECK (
  "products"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "products"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "products"."organization_id"
      AND organization_scope.status = 'active'
  )
);
--> statement-breakpoint
ALTER TABLE public.products FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.product_variants FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE public.products TO polaris_pr11_runtime;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.product_variants TO polaris_pr11_runtime;--> statement-breakpoint
CREATE FUNCTION public.enforce_product_has_variant()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  product_id_to_check uuid;
BEGIN
  IF TG_TABLE_NAME = 'products' THEN
    product_id_to_check := NEW.id;
  ELSE
    product_id_to_check := OLD.product_id;
  END IF;

  IF EXISTS (
       SELECT 1 FROM public.products AS product
       WHERE product.id = product_id_to_check
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.product_variants AS variant
       WHERE variant.product_id = product_id_to_check
     ) THEN
    RAISE EXCEPTION 'product must have at least one variant'
      USING ERRCODE = '23514', CONSTRAINT = 'products_require_variant';
  END IF;
  RETURN NULL;
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.enforce_product_has_variant() FROM PUBLIC;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER products_require_variant
AFTER INSERT ON public.products
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.enforce_product_has_variant();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER product_variants_preserve_parent
AFTER DELETE ON public.product_variants
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.enforce_product_has_variant();--> statement-breakpoint
CREATE FUNCTION public.require_active_product_category()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.category_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.category_id IS NOT DISTINCT FROM OLD.category_id
     AND NEW.organization_id IS NOT DISTINCT FROM OLD.organization_id THEN
    RETURN NEW;
  END IF;

  PERFORM 1
  FROM public.categories AS category
  WHERE category.id = NEW.category_id
    AND category.organization_id = NEW.organization_id
    AND category.archived_at IS NULL
    AND category.deleted_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'product category is not active in organization'
      USING ERRCODE = '23503', CONSTRAINT = 'products_active_category_guard';
  END IF;
  RETURN NEW;
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.require_active_product_category() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER products_require_active_category
BEFORE INSERT OR UPDATE OF category_id, organization_id ON public.products
FOR EACH ROW EXECUTE FUNCTION public.require_active_product_category();--> statement-breakpoint
CREATE FUNCTION public.prevent_category_tombstone_with_products()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.products AS product
    WHERE product.organization_id = OLD.organization_id
      AND product.category_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'category still has products'
      USING ERRCODE = '23503', CONSTRAINT = 'categories_products_tombstone_guard';
  END IF;
  RETURN NEW;
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.prevent_category_tombstone_with_products() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER categories_prevent_tombstone_with_products
BEFORE UPDATE OF deleted_at ON public.categories
FOR EACH ROW
WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
EXECUTE FUNCTION public.prevent_category_tombstone_with_products();
