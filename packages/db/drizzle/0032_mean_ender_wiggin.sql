CREATE TABLE "sale_payments" (
	"amount" numeric NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"installments" integer,
	"method" text NOT NULL,
	"organization_id" text NOT NULL,
	"sale_id" uuid NOT NULL,
	CONSTRAINT "sale_payments_method_allowed" CHECK ("sale_payments"."method" IN ('pix', 'cash', 'credit_card', 'debit_card', 'bank_transfer', 'other')),
	CONSTRAINT "sale_payments_amount_allowed" CHECK (
        "sale_payments"."amount" >= 0
        AND scale("sale_payments"."amount") <= 2
        AND "sale_payments"."amount" < 1000000000000000000
      ),
	CONSTRAINT "sale_payments_installments_allowed" CHECK (
        (
          "sale_payments"."method" = 'credit_card'
          AND "sale_payments"."installments" IS NOT NULL
          AND "sale_payments"."installments" >= 1
        )
        OR (
          "sale_payments"."method" <> 'credit_card'
          AND "sale_payments"."installments" IS NULL
        )
      )
);
--> statement-breakpoint
ALTER TABLE "sale_payments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sale_payments" ADD CONSTRAINT "sale_payments_organization_sale_fk" FOREIGN KEY ("organization_id","sale_id") REFERENCES "public"."sales"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sale_payments_organization_sale_unique" ON "sale_payments" USING btree ("organization_id","sale_id");--> statement-breakpoint
CREATE POLICY "sale_payments_current_tenant_select" ON "sale_payments" AS PERMISSIVE FOR SELECT TO "polaris_pr11_runtime" USING (
  "sale_payments"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "sale_payments"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "sale_payments"."organization_id"
      AND organization_scope.status = 'active'
  )
);
--> statement-breakpoint
ALTER TABLE public.sale_payments FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE public.sale_payments FROM PUBLIC, polaris_pr11_runtime;
--> statement-breakpoint
GRANT SELECT ON TABLE public.sale_payments TO polaris_pr11_runtime;
