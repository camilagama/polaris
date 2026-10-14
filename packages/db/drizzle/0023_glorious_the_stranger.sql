ALTER TABLE "products" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER POLICY "product_option_values_current_tenant_insert" ON "product_option_values" TO polaris_pr11_runtime WITH CHECK (
        
  "product_option_values"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "product_option_values"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "product_option_values"."organization_id"
      AND organization_scope.status = 'active'
  )

        AND EXISTS (
          SELECT 1 FROM public.product_options AS option_scope
          INNER JOIN public.products AS product_scope
            ON product_scope.id = option_scope.product_id
           AND product_scope.organization_id = option_scope.organization_id
          WHERE option_scope.id = "product_option_values"."option_id"
            AND option_scope.organization_id = "product_option_values"."organization_id"
            AND option_scope.product_id = "product_option_values"."product_id"
            AND product_scope.variants_configured_at IS NULL
            AND product_scope.deleted_at IS NULL
        )
      );--> statement-breakpoint
ALTER POLICY "product_options_current_tenant_insert" ON "product_options" TO polaris_pr11_runtime WITH CHECK (
        
  "product_options"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "product_options"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "product_options"."organization_id"
      AND organization_scope.status = 'active'
  )

        AND EXISTS (
          SELECT 1 FROM public.products AS product_scope
          WHERE product_scope.id = "product_options"."product_id"
            AND product_scope.organization_id = "product_options"."organization_id"
            AND product_scope.variants_configured_at IS NULL
            AND product_scope.deleted_at IS NULL
        )
      );--> statement-breakpoint
ALTER POLICY "variant_option_values_current_tenant_insert" ON "variant_option_values" TO polaris_pr11_runtime WITH CHECK (
        
  "variant_option_values"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "variant_option_values"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "variant_option_values"."organization_id"
      AND organization_scope.status = 'active'
  )

        AND EXISTS (
          SELECT 1 FROM public.products AS product_scope
          WHERE product_scope.id = "variant_option_values"."product_id"
            AND product_scope.organization_id = "variant_option_values"."organization_id"
            AND product_scope.variants_configured_at IS NULL
            AND product_scope.deleted_at IS NULL
        )
      );--> statement-breakpoint
ALTER POLICY "product_variants_current_tenant_insert" ON "product_variants" TO polaris_pr11_runtime WITH CHECK (
        
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
            AND product_scope.variants_configured_at IS NULL
            AND product_scope.deleted_at IS NULL
        )
      );--> statement-breakpoint
ALTER POLICY "product_variants_current_tenant_delete" ON "product_variants" TO polaris_pr11_runtime USING (
        
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

        AND "product_variants"."is_default"
        AND EXISTS (
          SELECT 1
          FROM public.products AS product_scope
          WHERE product_scope.id = "product_variants"."product_id"
            AND product_scope.organization_id = "product_variants"."organization_id"
            AND product_scope.variants_configured_at IS NULL
            AND product_scope.deleted_at IS NULL
        )
      );--> statement-breakpoint
ALTER POLICY "product_variants_current_tenant_sku_update" ON "product_variants" TO polaris_pr11_runtime USING (
        
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
          AND product_scope.deleted_at IS NULL
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
          AND product_scope.deleted_at IS NULL
        )
      );
--> statement-breakpoint
CREATE FUNCTION public.guard_catalog_product_tombstone()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.deleted_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'tombstoned products are immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'products_tombstone_immutable';
  END IF;

  IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
    IF NEW.category_id IS DISTINCT FROM OLD.category_id
      OR NEW.name IS DISTINCT FROM OLD.name
      OR NEW.description IS DISTINCT FROM OLD.description
      OR NEW.archived_at IS DISTINCT FROM OLD.archived_at
      OR NEW.variants_configured_at IS DISTINCT FROM OLD.variants_configured_at
      OR NEW.version <> OLD.version + 1
    THEN
      RAISE EXCEPTION 'product tombstone must be an isolated versioned transition'
        USING ERRCODE = '23514',
              CONSTRAINT = 'products_tombstone_payload_guard';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM public.inventory_balances AS balance
      WHERE balance.organization_id = OLD.organization_id
        AND balance.product_id = OLD.id
        AND balance.quantity > 0
    ) THEN
      RAISE EXCEPTION 'product with positive stock cannot be tombstoned'
        USING ERRCODE = '23514',
              CONSTRAINT = 'products_tombstone_stock_guard';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER products_tombstone_guard
BEFORE UPDATE ON public.products
FOR EACH ROW
EXECUTE FUNCTION public.guard_catalog_product_tombstone();
--> statement-breakpoint
CREATE FUNCTION public.guard_inventory_product_not_deleted()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  product_deleted_at timestamp;
BEGIN
  SELECT product.deleted_at
  INTO product_deleted_at
  FROM public.products AS product
  WHERE product.id = NEW.product_id
    AND product.organization_id = NEW.organization_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF product_deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'inventory cannot change for a tombstoned product'
      USING ERRCODE = '23514',
            CONSTRAINT = 'inventory_product_tombstone_guard';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER inventory_balances_product_tombstone_guard
BEFORE INSERT OR UPDATE ON public.inventory_balances
FOR EACH ROW
EXECUTE FUNCTION public.guard_inventory_product_not_deleted();
--> statement-breakpoint
CREATE TRIGGER stock_movements_product_tombstone_guard
BEFORE INSERT ON public.stock_movements
FOR EACH ROW
EXECUTE FUNCTION public.guard_inventory_product_not_deleted();