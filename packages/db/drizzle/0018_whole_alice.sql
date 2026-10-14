CREATE TABLE "inventory_balances" (
	"moving_average_cost" numeric,
	"organization_id" text NOT NULL,
	"product_id" uuid NOT NULL,
	"quantity" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"variant_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "inventory_balances_pk" PRIMARY KEY("organization_id","variant_id"),
	CONSTRAINT "inventory_balances_quantity_nonnegative" CHECK ("inventory_balances"."quantity" >= 0),
	CONSTRAINT "inventory_balances_version_positive" CHECK ("inventory_balances"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "inventory_balances" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"created_at" timestamp DEFAULT now() NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"movement_type" text NOT NULL,
	"organization_id" text NOT NULL,
	"product_id" uuid NOT NULL,
	"quantity_delta" integer NOT NULL,
	"variant_id" uuid NOT NULL,
	CONSTRAINT "stock_movements_type_allowed" CHECK ("stock_movements"."movement_type" IN ('receipt', 'write_off', 'inventory_count', 'sale', 'sale_cancellation', 'sale_return')),
	CONSTRAINT "stock_movements_quantity_delta_nonzero" CHECK ("stock_movements"."quantity_delta" <> 0),
	CONSTRAINT "stock_movements_type_direction" CHECK (
        ("stock_movements"."movement_type" = 'receipt' AND "stock_movements"."quantity_delta" > 0)
        OR ("stock_movements"."movement_type" = 'write_off' AND "stock_movements"."quantity_delta" < 0)
        OR ("stock_movements"."movement_type" = 'inventory_count' AND "stock_movements"."quantity_delta" <> 0)
        OR ("stock_movements"."movement_type" = 'sale' AND "stock_movements"."quantity_delta" < 0)
        OR ("stock_movements"."movement_type" = 'sale_cancellation' AND "stock_movements"."quantity_delta" > 0)
        OR ("stock_movements"."movement_type" = 'sale_return' AND "stock_movements"."quantity_delta" > 0)
      )
);
--> statement-breakpoint
ALTER TABLE "stock_movements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "inventory_balances" ADD CONSTRAINT "inventory_balances_variant_fk" FOREIGN KEY ("organization_id","product_id","variant_id") REFERENCES "public"."product_variants"("organization_id","product_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_variant_fk" FOREIGN KEY ("organization_id","product_id","variant_id") REFERENCES "public"."product_variants"("organization_id","product_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inventory_balances_organization_product_idx" ON "inventory_balances" USING btree ("organization_id","product_id");--> statement-breakpoint
CREATE INDEX "stock_movements_organization_variant_created_idx" ON "stock_movements" USING btree ("organization_id","variant_id","created_at");--> statement-breakpoint
CREATE POLICY "inventory_balances_current_tenant_select" ON "inventory_balances" AS PERMISSIVE FOR SELECT TO "polaris_pr11_runtime" USING (

  "inventory_balances"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "inventory_balances"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "inventory_balances"."organization_id"
      AND organization_scope.status = 'active'
  )

  AND EXISTS (
    SELECT 1
    FROM public.product_variants AS variant_scope
    INNER JOIN public.products AS product_scope
      ON product_scope.id = variant_scope.product_id
     AND product_scope.organization_id = variant_scope.organization_id
    WHERE variant_scope.id = "inventory_balances"."variant_id"
      AND variant_scope.organization_id = "inventory_balances"."organization_id"
      AND variant_scope.product_id = "inventory_balances"."product_id"
  )
);--> statement-breakpoint
CREATE POLICY "inventory_balances_current_tenant_insert" ON "inventory_balances" AS PERMISSIVE FOR INSERT TO "polaris_pr11_runtime" WITH CHECK (

  "inventory_balances"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "inventory_balances"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "inventory_balances"."organization_id"
      AND organization_scope.status = 'active'
  )

  AND EXISTS (
    SELECT 1
    FROM public.product_variants AS variant_scope
    INNER JOIN public.products AS product_scope
      ON product_scope.id = variant_scope.product_id
     AND product_scope.organization_id = variant_scope.organization_id
    WHERE variant_scope.id = "inventory_balances"."variant_id"
      AND variant_scope.organization_id = "inventory_balances"."organization_id"
      AND variant_scope.product_id = "inventory_balances"."product_id"
  )
);--> statement-breakpoint
CREATE POLICY "inventory_balances_current_tenant_update" ON "inventory_balances" AS PERMISSIVE FOR UPDATE TO "polaris_pr11_runtime" USING (

  "inventory_balances"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "inventory_balances"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "inventory_balances"."organization_id"
      AND organization_scope.status = 'active'
  )

  AND EXISTS (
    SELECT 1
    FROM public.product_variants AS variant_scope
    INNER JOIN public.products AS product_scope
      ON product_scope.id = variant_scope.product_id
     AND product_scope.organization_id = variant_scope.organization_id
    WHERE variant_scope.id = "inventory_balances"."variant_id"
      AND variant_scope.organization_id = "inventory_balances"."organization_id"
      AND variant_scope.product_id = "inventory_balances"."product_id"
  )
) WITH CHECK (

  "inventory_balances"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "inventory_balances"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "inventory_balances"."organization_id"
      AND organization_scope.status = 'active'
  )

  AND EXISTS (
    SELECT 1
    FROM public.product_variants AS variant_scope
    INNER JOIN public.products AS product_scope
      ON product_scope.id = variant_scope.product_id
     AND product_scope.organization_id = variant_scope.organization_id
    WHERE variant_scope.id = "inventory_balances"."variant_id"
      AND variant_scope.organization_id = "inventory_balances"."organization_id"
      AND variant_scope.product_id = "inventory_balances"."product_id"
  )
);--> statement-breakpoint
CREATE POLICY "stock_movements_current_tenant_select" ON "stock_movements" AS PERMISSIVE FOR SELECT TO "polaris_pr11_runtime" USING (

  "stock_movements"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "stock_movements"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "stock_movements"."organization_id"
      AND organization_scope.status = 'active'
  )

  AND EXISTS (
    SELECT 1
    FROM public.product_variants AS variant_scope
    INNER JOIN public.products AS product_scope
      ON product_scope.id = variant_scope.product_id
     AND product_scope.organization_id = variant_scope.organization_id
    WHERE variant_scope.id = "stock_movements"."variant_id"
      AND variant_scope.organization_id = "stock_movements"."organization_id"
      AND variant_scope.product_id = "stock_movements"."product_id"
  )
);--> statement-breakpoint
CREATE POLICY "stock_movements_current_tenant_insert" ON "stock_movements" AS PERMISSIVE FOR INSERT TO "polaris_pr11_runtime" WITH CHECK (

  "stock_movements"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "stock_movements"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "stock_movements"."organization_id"
      AND organization_scope.status = 'active'
  )

  AND EXISTS (
    SELECT 1
    FROM public.product_variants AS variant_scope
    INNER JOIN public.products AS product_scope
      ON product_scope.id = variant_scope.product_id
     AND product_scope.organization_id = variant_scope.organization_id
    WHERE variant_scope.id = "stock_movements"."variant_id"
      AND variant_scope.organization_id = "stock_movements"."organization_id"
      AND variant_scope.product_id = "stock_movements"."product_id"
  )
);
--> statement-breakpoint
ALTER TABLE public.inventory_balances FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.stock_movements FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL ON TABLE public.inventory_balances FROM polaris_pr11_runtime;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.inventory_balances TO polaris_pr11_runtime;--> statement-breakpoint
GRANT UPDATE (quantity, moving_average_cost, version, updated_at) ON TABLE public.inventory_balances TO polaris_pr11_runtime;--> statement-breakpoint
REVOKE ALL ON TABLE public.stock_movements FROM polaris_pr11_runtime;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.stock_movements TO polaris_pr11_runtime;--> statement-breakpoint
CREATE FUNCTION public.prevent_stock_movement_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'stock_movements are append-only'
    USING ERRCODE = '23514',
          CONSTRAINT = 'stock_movements_append_only';
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.prevent_stock_movement_mutation() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER stock_movements_append_only
BEFORE UPDATE OR DELETE ON public.stock_movements
FOR EACH ROW EXECUTE FUNCTION public.prevent_stock_movement_mutation();
