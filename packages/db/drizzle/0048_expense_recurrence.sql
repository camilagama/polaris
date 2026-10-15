CREATE TABLE "expense_recurring_rules" (
	"amount" numeric NOT NULL,
	"archived_at" timestamp with time zone,
	"category_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"description" text NOT NULL,
	"ends_on" date,
	"frequency" text NOT NULL,
	"generated_count" integer DEFAULT 0 NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" text NOT NULL,
	"payee" text,
	"starts_on" date NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "expense_recurring_rules_amount_allowed" CHECK (
          "expense_recurring_rules"."amount" > 0
          AND scale("expense_recurring_rules"."amount") <= 2
          AND "expense_recurring_rules"."amount" < 1000000000000000000
        ),
	CONSTRAINT "expense_recurring_rules_text_limits" CHECK (
          char_length(btrim("expense_recurring_rules"."description")) >= 1
          AND char_length("expense_recurring_rules"."description") <= 200
          AND ("expense_recurring_rules"."payee" IS NULL OR (char_length(btrim("expense_recurring_rules"."payee")) >= 1 AND char_length("expense_recurring_rules"."payee") <= 120))
        ),
	CONSTRAINT "expense_recurring_rules_frequency_allowed" CHECK ("expense_recurring_rules"."frequency" IN ('weekly', 'monthly', 'yearly')),
	CONSTRAINT "expense_recurring_rules_dates_allowed" CHECK (
          "expense_recurring_rules"."starts_on" >= DATE '2000-01-01'
          AND ("expense_recurring_rules"."ends_on" IS NULL OR "expense_recurring_rules"."ends_on" >= "expense_recurring_rules"."starts_on")
        ),
	CONSTRAINT "expense_recurring_rules_counters_allowed" CHECK ("expense_recurring_rules"."generated_count" >= 0 AND "expense_recurring_rules"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "expense_recurring_rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "recurring_occurrence" integer;--> statement-breakpoint
ALTER TABLE "expenses" ADD COLUMN "recurring_rule_id" uuid;--> statement-breakpoint
ALTER TABLE "expense_recurring_rules" ADD CONSTRAINT "expense_recurring_rules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_recurring_rules" ADD CONSTRAINT "expense_recurring_rules_organization_category_fk" FOREIGN KEY ("organization_id","category_id") REFERENCES "public"."expense_categories"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "expense_recurring_rules_organization_id_id_unique" ON "expense_recurring_rules" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "expense_recurring_rules_organization_list_idx" ON "expense_recurring_rules" USING btree ("organization_id","archived_at","starts_on");--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_organization_recurring_rule_fk" FOREIGN KEY ("organization_id","recurring_rule_id") REFERENCES "public"."expense_recurring_rules"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "expenses_recurring_occurrence_unique" ON "expenses" USING btree ("recurring_rule_id","recurring_occurrence") WHERE "expenses"."recurring_rule_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_recurring_origin_coherent" CHECK (
          ("expenses"."recurring_rule_id" IS NULL AND "expenses"."recurring_occurrence" IS NULL)
          OR ("expenses"."recurring_rule_id" IS NOT NULL AND "expenses"."recurring_occurrence" IS NOT NULL AND "expenses"."recurring_occurrence" >= 0)
        );--> statement-breakpoint
CREATE POLICY "expense_recurring_rules_current_tenant_select" ON "expense_recurring_rules" AS PERMISSIVE FOR SELECT TO "polaris_pr11_runtime" USING (
  "expense_recurring_rules"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "expense_recurring_rules"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "expense_recurring_rules"."organization_id"
      AND organization_scope.status = 'active'
  )
);--> statement-breakpoint
CREATE POLICY "expense_recurring_rules_current_tenant_insert" ON "expense_recurring_rules" AS PERMISSIVE FOR INSERT TO "polaris_pr11_runtime" WITH CHECK (
  "expense_recurring_rules"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "expense_recurring_rules"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "expense_recurring_rules"."organization_id"
      AND organization_scope.status = 'active'
  )
);--> statement-breakpoint
CREATE POLICY "expense_recurring_rules_current_tenant_update" ON "expense_recurring_rules" AS PERMISSIVE FOR UPDATE TO "polaris_pr11_runtime" USING (
  "expense_recurring_rules"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "expense_recurring_rules"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "expense_recurring_rules"."organization_id"
      AND organization_scope.status = 'active'
  )
) WITH CHECK (
  "expense_recurring_rules"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "expense_recurring_rules"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "expense_recurring_rules"."organization_id"
      AND organization_scope.status = 'active'
  )
);
--> statement-breakpoint
ALTER TABLE public.expense_recurring_rules FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE public.expense_recurring_rules FROM PUBLIC;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE public.expense_recurring_rules FROM polaris_pr11_runtime;--> statement-breakpoint
-- No DELETE; frequency, starts_on, id and created_at never change. The
-- occurrence columns of expenses are written once, on insert.
GRANT SELECT, INSERT ON TABLE public.expense_recurring_rules TO polaris_pr11_runtime;--> statement-breakpoint
GRANT UPDATE (amount, category_id, description, payee, ends_on, archived_at, generated_count, updated_at, version)
  ON TABLE public.expense_recurring_rules TO polaris_pr11_runtime;
