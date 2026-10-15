CREATE POLICY "product_media_current_tenant_live_product_update" ON "product_media" AS PERMISSIVE FOR UPDATE TO "polaris_pr11_runtime" USING (
        
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
      ) WITH CHECK (
        
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
CREATE POLICY "product_media_current_tenant_live_product_delete" ON "product_media" AS PERMISSIVE FOR DELETE TO "polaris_pr11_runtime" USING (
        
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
CREATE POLICY "variant_media_current_tenant_live_product_delete" ON "variant_media" AS PERMISSIVE FOR DELETE TO "polaris_pr11_runtime" USING (
        
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
          WHERE product_scope.id = "variant_media"."product_id"
            AND product_scope.organization_id = "variant_media"."organization_id"
            AND product_scope.deleted_at IS NULL
        )
      );
--> statement-breakpoint
-- A product's image can be removed and the images reordered. The asset row and
-- its stored object stay (media_assets keeps no DELETE): only the links go, and
-- only the position of a product link may change. The tombstone guard trigger
-- already rejects both on a deleted product and keeps the identity immutable.
GRANT DELETE ON TABLE public.product_media TO polaris_pr11_runtime;--> statement-breakpoint
GRANT DELETE ON TABLE public.variant_media TO polaris_pr11_runtime;--> statement-breakpoint
GRANT UPDATE (position) ON TABLE public.product_media TO polaris_pr11_runtime;
