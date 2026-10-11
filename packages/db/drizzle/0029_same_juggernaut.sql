CREATE TABLE "sale_items" (
	"charged_unit_price" numeric NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"listed_unit_price" numeric NOT NULL,
	"organization_id" text NOT NULL,
	"position" integer NOT NULL,
	"product_id" uuid NOT NULL,
	"product_label" text NOT NULL,
	"quantity" integer NOT NULL,
	"sale_id" uuid NOT NULL,
	"unit_cost" numeric,
	"variant_id" uuid NOT NULL,
	CONSTRAINT "sale_items_position_nonnegative" CHECK ("sale_items"."position" >= 0),
	CONSTRAINT "sale_items_product_label_not_blank" CHECK (char_length(btrim("sale_items"."product_label")) >= 1),
	CONSTRAINT "sale_items_quantity_positive" CHECK ("sale_items"."quantity" >= 1),
	CONSTRAINT "sale_items_listed_unit_price_allowed" CHECK (
        "sale_items"."listed_unit_price" >= 0
        AND scale("sale_items"."listed_unit_price") <= 2
        AND "sale_items"."listed_unit_price" < 1000000000000000000
      ),
	CONSTRAINT "sale_items_charged_unit_price_allowed" CHECK (
        "sale_items"."charged_unit_price" >= 0
        AND scale("sale_items"."charged_unit_price") <= 2
        AND "sale_items"."charged_unit_price" < 1000000000000000000
      ),
	CONSTRAINT "sale_items_unit_cost_allowed" CHECK (
        "sale_items"."unit_cost" IS NULL OR (
          "sale_items"."unit_cost" >= 0
          AND scale("sale_items"."unit_cost") <= 6
          AND "sale_items"."unit_cost" < 1000000000000000000
        )
      )
);
--> statement-breakpoint
ALTER TABLE "sale_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sales" (
	"command_id" uuid NOT NULL,
	"confirmed_at" timestamp DEFAULT now() NOT NULL,
	"currency" text DEFAULT 'BRL' NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" text NOT NULL,
	CONSTRAINT "sales_currency_brl" CHECK ("sales"."currency" = 'BRL')
);
--> statement-breakpoint
ALTER TABLE "sales" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "sales_organization_id_id_unique" ON "sales" USING btree ("organization_id","id");--> statement-breakpoint
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_organization_sale_fk" FOREIGN KEY ("organization_id","sale_id") REFERENCES "public"."sales"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_organization_product_fk" FOREIGN KEY ("organization_id","product_id") REFERENCES "public"."products"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_variant_fk" FOREIGN KEY ("organization_id","product_id","variant_id") REFERENCES "public"."product_variants"("organization_id","product_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sale_items_organization_sale_position_unique" ON "sale_items" USING btree ("organization_id","sale_id","position");--> statement-breakpoint
CREATE INDEX "sale_items_organization_variant_idx" ON "sale_items" USING btree ("organization_id","variant_id","sale_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_organization_command_unique" ON "sales" USING btree ("organization_id","command_id");--> statement-breakpoint
CREATE INDEX "sales_organization_confirmed_idx" ON "sales" USING btree ("organization_id","confirmed_at","id");--> statement-breakpoint
CREATE POLICY "sale_items_current_tenant_select" ON "sale_items" AS PERMISSIVE FOR SELECT TO "polaris_pr11_runtime" USING (
  "sale_items"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "sale_items"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "sale_items"."organization_id"
      AND organization_scope.status = 'active'
  )
);--> statement-breakpoint
CREATE POLICY "sale_items_current_tenant_insert" ON "sale_items" AS PERMISSIVE FOR INSERT TO "polaris_pr11_runtime" WITH CHECK (
  "sale_items"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "sale_items"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "sale_items"."organization_id"
      AND organization_scope.status = 'active'
  )
);--> statement-breakpoint
CREATE POLICY "sales_current_tenant_select" ON "sales" AS PERMISSIVE FOR SELECT TO "polaris_pr11_runtime" USING (
  "sales"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "sales"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "sales"."organization_id"
      AND organization_scope.status = 'active'
  )
);--> statement-breakpoint
CREATE POLICY "sales_current_tenant_insert" ON "sales" AS PERMISSIVE FOR INSERT TO "polaris_pr11_runtime" WITH CHECK (
  "sales"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "sales"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "sales"."organization_id"
      AND organization_scope.status = 'active'
  )
);
--> statement-breakpoint
ALTER TABLE public.sales FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.sale_items FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE public.sales, public.sale_items FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE public.sales, public.sale_items FROM polaris_pr11_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.sales, public.sale_items TO polaris_pr11_runtime;
