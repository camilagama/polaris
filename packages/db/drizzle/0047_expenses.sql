CREATE TABLE "expense_categories" (
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"group_key" text NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"organization_id" text NOT NULL,
	"system_key" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "expense_categories_group_allowed" CHECK ("expense_categories"."group_key" IN ('commercial', 'operational', 'financial', 'taxes', 'other')),
	CONSTRAINT "expense_categories_name_allowed" CHECK (char_length(btrim("expense_categories"."name")) >= 1 AND char_length("expense_categories"."name") <= 100),
	CONSTRAINT "expense_categories_version_positive" CHECK ("expense_categories"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "expense_categories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "expenses" (
	"amount" numeric NOT NULL,
	"category_id" uuid NOT NULL,
	"competence_on" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"description" text NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" text NOT NULL,
	"payee" text,
	"sale_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"voided_at" timestamp with time zone,
	CONSTRAINT "expenses_amount_allowed" CHECK (
          "expenses"."amount" > 0
          AND scale("expenses"."amount") <= 2
          AND "expenses"."amount" < 1000000000000000000
        ),
	CONSTRAINT "expenses_text_limits" CHECK (
          char_length(btrim("expenses"."description")) >= 1
          AND char_length("expenses"."description") <= 200
          AND ("expenses"."payee" IS NULL OR (char_length(btrim("expenses"."payee")) >= 1 AND char_length("expenses"."payee") <= 120))
        ),
	CONSTRAINT "expenses_competence_allowed" CHECK ("expenses"."competence_on" >= DATE '2000-01-01'),
	CONSTRAINT "expenses_version_positive" CHECK ("expenses"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "expenses" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
-- The composite foreign key of expenses needs this unique index to exist first.
CREATE UNIQUE INDEX "expense_categories_organization_id_id_unique" ON "expense_categories" USING btree ("organization_id","id");--> statement-breakpoint
ALTER TABLE "expense_categories" ADD CONSTRAINT "expense_categories_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_organization_category_fk" FOREIGN KEY ("organization_id","category_id") REFERENCES "public"."expense_categories"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_organization_sale_fk" FOREIGN KEY ("organization_id","sale_id") REFERENCES "public"."sales"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "expense_categories_organization_name_unique" ON "expense_categories" USING btree ("organization_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "expense_categories_organization_system_key_unique" ON "expense_categories" USING btree ("organization_id","system_key") WHERE "expense_categories"."system_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "expense_categories_organization_list_idx" ON "expense_categories" USING btree ("organization_id","archived_at","group_key","name");--> statement-breakpoint
CREATE UNIQUE INDEX "expenses_organization_id_id_unique" ON "expenses" USING btree ("organization_id","id");--> statement-breakpoint
CREATE INDEX "expenses_organization_competence_idx" ON "expenses" USING btree ("organization_id","competence_on","id");--> statement-breakpoint
CREATE INDEX "expenses_organization_category_idx" ON "expenses" USING btree ("organization_id","category_id");--> statement-breakpoint
CREATE INDEX "expenses_organization_sale_idx" ON "expenses" USING btree ("organization_id","sale_id") WHERE "expenses"."sale_id" IS NOT NULL;--> statement-breakpoint
CREATE POLICY "expense_categories_current_tenant_select" ON "expense_categories" AS PERMISSIVE FOR SELECT TO "polaris_pr11_runtime" USING (
  "expense_categories"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "expense_categories"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "expense_categories"."organization_id"
      AND organization_scope.status = 'active'
  )
);--> statement-breakpoint
CREATE POLICY "expense_categories_current_tenant_insert" ON "expense_categories" AS PERMISSIVE FOR INSERT TO "polaris_pr11_runtime" WITH CHECK (
  "expense_categories"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "expense_categories"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "expense_categories"."organization_id"
      AND organization_scope.status = 'active'
  )
);--> statement-breakpoint
CREATE POLICY "expense_categories_current_tenant_update" ON "expense_categories" AS PERMISSIVE FOR UPDATE TO "polaris_pr11_runtime" USING (
  "expense_categories"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "expense_categories"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "expense_categories"."organization_id"
      AND organization_scope.status = 'active'
  )
) WITH CHECK (
  "expense_categories"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "expense_categories"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "expense_categories"."organization_id"
      AND organization_scope.status = 'active'
  )
);--> statement-breakpoint
CREATE POLICY "expenses_current_tenant_select" ON "expenses" AS PERMISSIVE FOR SELECT TO "polaris_pr11_runtime" USING (
  "expenses"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "expenses"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "expenses"."organization_id"
      AND organization_scope.status = 'active'
  )
);--> statement-breakpoint
CREATE POLICY "expenses_current_tenant_insert" ON "expenses" AS PERMISSIVE FOR INSERT TO "polaris_pr11_runtime" WITH CHECK (
  "expenses"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "expenses"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "expenses"."organization_id"
      AND organization_scope.status = 'active'
  )
);--> statement-breakpoint
CREATE POLICY "expenses_current_tenant_update" ON "expenses" AS PERMISSIVE FOR UPDATE TO "polaris_pr11_runtime" USING (
  "expenses"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "expenses"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "expenses"."organization_id"
      AND organization_scope.status = 'active'
  )
) WITH CHECK (
  "expenses"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "expenses"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "expenses"."organization_id"
      AND organization_scope.status = 'active'
  )
);
--> statement-breakpoint
ALTER TABLE public.expense_categories FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.expenses FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE public.expense_categories FROM PUBLIC;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE public.expense_categories FROM polaris_pr11_runtime;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE public.expenses FROM PUBLIC;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE public.expenses FROM polaris_pr11_runtime;--> statement-breakpoint
-- No DELETE anywhere, and UPDATE only on the columns the repositories set: id,
-- organization_id, group_key, system_key and created_at never change.
GRANT SELECT, INSERT ON TABLE public.expense_categories TO polaris_pr11_runtime;--> statement-breakpoint
GRANT UPDATE (name, archived_at, updated_at, version)
  ON TABLE public.expense_categories TO polaris_pr11_runtime;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.expenses TO polaris_pr11_runtime;--> statement-breakpoint
GRANT UPDATE (amount, category_id, competence_on, description, payee, sale_id, voided_at, updated_at, version)
  ON TABLE public.expenses TO polaris_pr11_runtime;
