CREATE TABLE "sale_adjustments" (
	"amount" numeric NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"kind" text NOT NULL,
	"organization_id" text NOT NULL,
	"percentage" numeric,
	"position" integer NOT NULL,
	"sale_id" uuid NOT NULL,
	"value_type" text NOT NULL,
	CONSTRAINT "sale_adjustments_kind_allowed" CHECK ("sale_adjustments"."kind" IN ('discount', 'surcharge', 'freight', 'payment_surcharge')),
	CONSTRAINT "sale_adjustments_value_type_allowed" CHECK ("sale_adjustments"."value_type" IN ('fixed', 'percentage')),
	CONSTRAINT "sale_adjustments_position_nonnegative" CHECK ("sale_adjustments"."position" >= 0),
	CONSTRAINT "sale_adjustments_amount_allowed" CHECK (
        "sale_adjustments"."amount" >= 0
        AND scale("sale_adjustments"."amount") <= 2
        AND "sale_adjustments"."amount" < 1000000000000000000
      ),
	CONSTRAINT "sale_adjustments_value_allowed" CHECK (
        (
          "sale_adjustments"."value_type" = 'fixed'
          AND "sale_adjustments"."percentage" IS NULL
        )
        OR (
          "sale_adjustments"."value_type" = 'percentage'
          AND "sale_adjustments"."kind" IN ('discount', 'surcharge')
          AND "sale_adjustments"."percentage" IS NOT NULL
          AND "sale_adjustments"."percentage" >= 0
          AND scale("sale_adjustments"."percentage") <= 6
          AND "sale_adjustments"."percentage" < 'Infinity'
        )
      )
);
--> statement-breakpoint
ALTER TABLE "sale_adjustments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sale_adjustments" ADD CONSTRAINT "sale_adjustments_organization_sale_fk" FOREIGN KEY ("organization_id","sale_id") REFERENCES "public"."sales"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sale_adjustments_organization_sale_position_unique" ON "sale_adjustments" USING btree ("organization_id","sale_id","position");--> statement-breakpoint
CREATE POLICY "sale_adjustments_current_tenant_select" ON "sale_adjustments" AS PERMISSIVE FOR SELECT TO "polaris_pr11_runtime" USING (
  "sale_adjustments"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "sale_adjustments"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "sale_adjustments"."organization_id"
      AND organization_scope.status = 'active'
  )
);
--> statement-breakpoint
ALTER TABLE public.sale_adjustments FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE public.sale_adjustments FROM PUBLIC, polaris_pr11_runtime;
--> statement-breakpoint
GRANT SELECT ON TABLE public.sale_adjustments TO polaris_pr11_runtime;
