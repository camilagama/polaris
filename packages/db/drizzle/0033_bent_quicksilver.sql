CREATE TABLE "payment_profile_rules" (
	"archived_at" timestamp,
	"anticipation_fee_fixed_amount" numeric,
	"anticipation_fee_mode" text NOT NULL,
	"anticipation_fee_percentage" numeric,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"expected_settlement_days" integer,
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"installment_plan" text,
	"installments" integer,
	"method" text NOT NULL,
	"organization_id" text NOT NULL,
	"payment_profile_id" uuid NOT NULL,
	"processing_fee_fixed_amount" numeric,
	"processing_fee_mode" text NOT NULL,
	"processing_fee_percentage" numeric,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "payment_profile_rules_method_allowed" CHECK ("payment_profile_rules"."method" IN ('pix', 'cash', 'credit_card', 'debit_card', 'bank_transfer', 'other')),
	CONSTRAINT "payment_profile_rules_installments_allowed" CHECK (
        (
          "payment_profile_rules"."method" = 'credit_card'
          AND "payment_profile_rules"."installment_plan" IS NOT NULL
          AND "payment_profile_rules"."installment_plan" IN ('merchant', 'issuer')
          AND "payment_profile_rules"."installments" IS NOT NULL
          AND "payment_profile_rules"."installments" >= 1
        )
        OR (
          "payment_profile_rules"."method" <> 'credit_card'
          AND "payment_profile_rules"."installment_plan" IS NULL
          AND "payment_profile_rules"."installments" IS NULL
        )
      ),
	CONSTRAINT "payment_profile_rules_expected_settlement_days_nonnegative" CHECK ("payment_profile_rules"."expected_settlement_days" IS NULL OR "payment_profile_rules"."expected_settlement_days" >= 0),
	CONSTRAINT "payment_profile_rules_processing_fee_valid" CHECK (
    (
      "payment_profile_rules"."processing_fee_mode" IN ('unknown', 'none')
      AND "payment_profile_rules"."processing_fee_fixed_amount" IS NULL
      AND "payment_profile_rules"."processing_fee_percentage" IS NULL
    )
    OR (
      "payment_profile_rules"."processing_fee_mode" = 'fixed'
      AND "payment_profile_rules"."processing_fee_fixed_amount" IS NOT NULL
      AND "payment_profile_rules"."processing_fee_fixed_amount" >= 0
      AND scale("payment_profile_rules"."processing_fee_fixed_amount") <= 2
      AND "payment_profile_rules"."processing_fee_fixed_amount" < 1000000000000000000
      AND "payment_profile_rules"."processing_fee_percentage" IS NULL
    )
    OR (
      "payment_profile_rules"."processing_fee_mode" = 'percentage'
      AND "payment_profile_rules"."processing_fee_fixed_amount" IS NULL
      AND "payment_profile_rules"."processing_fee_percentage" IS NOT NULL
      AND "payment_profile_rules"."processing_fee_percentage" >= 0
      AND scale("payment_profile_rules"."processing_fee_percentage") <= 6
      AND "payment_profile_rules"."processing_fee_percentage" < 'Infinity'
    )
    OR (
      "payment_profile_rules"."processing_fee_mode" = 'fixed_and_percentage'
      AND "payment_profile_rules"."processing_fee_fixed_amount" IS NOT NULL
      AND "payment_profile_rules"."processing_fee_fixed_amount" >= 0
      AND scale("payment_profile_rules"."processing_fee_fixed_amount") <= 2
      AND "payment_profile_rules"."processing_fee_fixed_amount" < 1000000000000000000
      AND "payment_profile_rules"."processing_fee_percentage" IS NOT NULL
      AND "payment_profile_rules"."processing_fee_percentage" >= 0
      AND scale("payment_profile_rules"."processing_fee_percentage") <= 6
      AND "payment_profile_rules"."processing_fee_percentage" < 'Infinity'
    )
  ),
	CONSTRAINT "payment_profile_rules_anticipation_fee_valid" CHECK (
    (
      "payment_profile_rules"."anticipation_fee_mode" IN ('unknown', 'none')
      AND "payment_profile_rules"."anticipation_fee_fixed_amount" IS NULL
      AND "payment_profile_rules"."anticipation_fee_percentage" IS NULL
    )
    OR (
      "payment_profile_rules"."anticipation_fee_mode" = 'fixed'
      AND "payment_profile_rules"."anticipation_fee_fixed_amount" IS NOT NULL
      AND "payment_profile_rules"."anticipation_fee_fixed_amount" >= 0
      AND scale("payment_profile_rules"."anticipation_fee_fixed_amount") <= 2
      AND "payment_profile_rules"."anticipation_fee_fixed_amount" < 1000000000000000000
      AND "payment_profile_rules"."anticipation_fee_percentage" IS NULL
    )
    OR (
      "payment_profile_rules"."anticipation_fee_mode" = 'percentage'
      AND "payment_profile_rules"."anticipation_fee_fixed_amount" IS NULL
      AND "payment_profile_rules"."anticipation_fee_percentage" IS NOT NULL
      AND "payment_profile_rules"."anticipation_fee_percentage" >= 0
      AND scale("payment_profile_rules"."anticipation_fee_percentage") <= 6
      AND "payment_profile_rules"."anticipation_fee_percentage" < 'Infinity'
    )
    OR (
      "payment_profile_rules"."anticipation_fee_mode" = 'fixed_and_percentage'
      AND "payment_profile_rules"."anticipation_fee_fixed_amount" IS NOT NULL
      AND "payment_profile_rules"."anticipation_fee_fixed_amount" >= 0
      AND scale("payment_profile_rules"."anticipation_fee_fixed_amount") <= 2
      AND "payment_profile_rules"."anticipation_fee_fixed_amount" < 1000000000000000000
      AND "payment_profile_rules"."anticipation_fee_percentage" IS NOT NULL
      AND "payment_profile_rules"."anticipation_fee_percentage" >= 0
      AND scale("payment_profile_rules"."anticipation_fee_percentage") <= 6
      AND "payment_profile_rules"."anticipation_fee_percentage" < 'Infinity'
    )
  )
);
--> statement-breakpoint
ALTER TABLE "payment_profile_rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "payment_profiles" (
	"archived_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"organization_id" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "payment_profiles_name_valid" CHECK (char_length(btrim("payment_profiles"."name")) BETWEEN 1 AND 100),
	CONSTRAINT "payment_profiles_version_positive" CHECK ("payment_profiles"."version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "payment_profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_profiles_organization_id_id_unique" ON "payment_profiles" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_profile_rules_organization_profile_id_unique" ON "payment_profile_rules" USING btree ("organization_id","payment_profile_id","id");--> statement-breakpoint
ALTER TABLE "sale_payments" DROP CONSTRAINT "sale_payments_installments_allowed";--> statement-breakpoint
ALTER TABLE "sale_payments" ADD COLUMN "anticipation_fee_amount_snapshot" numeric DEFAULT '0.00';--> statement-breakpoint
ALTER TABLE "sale_payments" ADD COLUMN "anticipation_fee_fixed_amount_snapshot" numeric;--> statement-breakpoint
ALTER TABLE "sale_payments" ADD COLUMN "anticipation_fee_mode_snapshot" text DEFAULT 'not_applicable' NOT NULL;--> statement-breakpoint
ALTER TABLE "sale_payments" ADD COLUMN "anticipation_fee_percentage_snapshot" numeric;--> statement-breakpoint
ALTER TABLE "sale_payments" ADD COLUMN "anticipation_requested" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sale_payments" ADD COLUMN "expected_settlement_days_snapshot" integer;--> statement-breakpoint
ALTER TABLE "sale_payments" ADD COLUMN "installment_plan" text;--> statement-breakpoint
ALTER TABLE "sale_payments" ADD COLUMN "installment_plan_unknown" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sale_payments" ADD COLUMN "payment_profile_id" uuid;--> statement-breakpoint
ALTER TABLE "sale_payments" ADD COLUMN "payment_profile_name_snapshot" text;--> statement-breakpoint
ALTER TABLE "sale_payments" ADD COLUMN "payment_profile_rule_id_snapshot" uuid;--> statement-breakpoint
ALTER TABLE "sale_payments" ADD COLUMN "payment_profile_version_snapshot" integer;--> statement-breakpoint
UPDATE "sale_payments"
SET "installment_plan_unknown" = true
WHERE "method" = 'credit_card' AND "installment_plan" IS NULL;
--> statement-breakpoint
ALTER TABLE "sale_payments" ADD COLUMN "processing_fee_amount_snapshot" numeric;--> statement-breakpoint
ALTER TABLE "sale_payments" ADD COLUMN "processing_fee_fixed_amount_snapshot" numeric;--> statement-breakpoint
ALTER TABLE "sale_payments" ADD COLUMN "processing_fee_mode_snapshot" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "sale_payments" ADD COLUMN "processing_fee_percentage_snapshot" numeric;--> statement-breakpoint
ALTER TABLE "payment_profile_rules" ADD CONSTRAINT "payment_profile_rules_organization_profile_fk" FOREIGN KEY ("organization_id","payment_profile_id") REFERENCES "public"."payment_profiles"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_profiles" ADD CONSTRAINT "payment_profiles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_profile_rules_credit_card_key_unique" ON "payment_profile_rules" USING btree ("organization_id","payment_profile_id","installment_plan","installments") WHERE "payment_profile_rules"."method" = 'credit_card' AND "payment_profile_rules"."archived_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_profile_rules_other_method_key_unique" ON "payment_profile_rules" USING btree ("organization_id","payment_profile_id","method") WHERE "payment_profile_rules"."method" <> 'credit_card' AND "payment_profile_rules"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "payment_profile_rules_organization_profile_archive_idx" ON "payment_profile_rules" USING btree ("organization_id","payment_profile_id","archived_at","method","installments");--> statement-breakpoint
CREATE INDEX "payment_profiles_organization_archive_name_idx" ON "payment_profiles" USING btree ("organization_id","archived_at","name","id");--> statement-breakpoint
ALTER TABLE "sale_payments" ADD CONSTRAINT "sale_payments_organization_profile_fk" FOREIGN KEY ("organization_id","payment_profile_id") REFERENCES "public"."payment_profiles"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_payments" ADD CONSTRAINT "sale_payments_profile_rule_snapshot_fk" FOREIGN KEY ("organization_id","payment_profile_id","payment_profile_rule_id_snapshot") REFERENCES "public"."payment_profile_rules"("organization_id","payment_profile_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_payments" ADD CONSTRAINT "sale_payments_profile_snapshot_valid" CHECK (
        (
          "sale_payments"."payment_profile_id" IS NULL
          AND "sale_payments"."payment_profile_name_snapshot" IS NULL
          AND "sale_payments"."payment_profile_version_snapshot" IS NULL
          AND "sale_payments"."payment_profile_rule_id_snapshot" IS NULL
        )
        OR (
          "sale_payments"."payment_profile_id" IS NOT NULL
          AND "sale_payments"."payment_profile_name_snapshot" IS NOT NULL
          AND char_length(btrim("sale_payments"."payment_profile_name_snapshot")) >= 1
          AND "sale_payments"."payment_profile_version_snapshot" IS NOT NULL
          AND "sale_payments"."payment_profile_version_snapshot" >= 1
        )
      );--> statement-breakpoint
ALTER TABLE "sale_payments" ADD CONSTRAINT "sale_payments_fee_snapshot_requires_profile_rule" CHECK (
        "sale_payments"."payment_profile_rule_id_snapshot" IS NOT NULL
        OR (
          "sale_payments"."processing_fee_mode_snapshot" = 'unknown'
          AND "sale_payments"."expected_settlement_days_snapshot" IS NULL
          AND (
            "sale_payments"."anticipation_requested" = false
            OR "sale_payments"."anticipation_fee_mode_snapshot" = 'unknown'
          )
        )
      );--> statement-breakpoint
ALTER TABLE "sale_payments" ADD CONSTRAINT "sale_payments_processing_fee_snapshot_valid" CHECK (
    (
      "sale_payments"."processing_fee_mode_snapshot" = 'unknown'
      AND "sale_payments"."processing_fee_amount_snapshot" IS NULL
      AND "sale_payments"."processing_fee_fixed_amount_snapshot" IS NULL
      AND "sale_payments"."processing_fee_percentage_snapshot" IS NULL
    )
    OR (
      "sale_payments"."processing_fee_mode_snapshot" = 'none'
      AND "sale_payments"."processing_fee_amount_snapshot" = 0
      AND "sale_payments"."processing_fee_fixed_amount_snapshot" IS NULL
      AND "sale_payments"."processing_fee_percentage_snapshot" IS NULL
    )
    OR (
      "sale_payments"."processing_fee_mode_snapshot" = 'fixed'
      AND "sale_payments"."processing_fee_amount_snapshot" IS NOT NULL
      AND "sale_payments"."processing_fee_amount_snapshot" >= 0
      AND scale("sale_payments"."processing_fee_amount_snapshot") <= 2
      AND "sale_payments"."processing_fee_amount_snapshot" < 1000000000000000000
      AND "sale_payments"."processing_fee_fixed_amount_snapshot" IS NOT NULL
      AND "sale_payments"."processing_fee_fixed_amount_snapshot" >= 0
      AND scale("sale_payments"."processing_fee_fixed_amount_snapshot") <= 2
      AND "sale_payments"."processing_fee_fixed_amount_snapshot" < 1000000000000000000
      AND "sale_payments"."processing_fee_percentage_snapshot" IS NULL
    )
    OR (
      "sale_payments"."processing_fee_mode_snapshot" = 'percentage'
      AND "sale_payments"."processing_fee_amount_snapshot" IS NOT NULL
      AND "sale_payments"."processing_fee_amount_snapshot" >= 0
      AND scale("sale_payments"."processing_fee_amount_snapshot") <= 2
      AND "sale_payments"."processing_fee_amount_snapshot" < 1000000000000000000
      AND "sale_payments"."processing_fee_fixed_amount_snapshot" IS NULL
      AND "sale_payments"."processing_fee_percentage_snapshot" IS NOT NULL
      AND "sale_payments"."processing_fee_percentage_snapshot" >= 0
      AND scale("sale_payments"."processing_fee_percentage_snapshot") <= 6
      AND "sale_payments"."processing_fee_percentage_snapshot" < 'Infinity'
    )
    OR (
      "sale_payments"."processing_fee_mode_snapshot" = 'fixed_and_percentage'
      AND "sale_payments"."processing_fee_amount_snapshot" IS NOT NULL
      AND "sale_payments"."processing_fee_amount_snapshot" >= 0
      AND scale("sale_payments"."processing_fee_amount_snapshot") <= 2
      AND "sale_payments"."processing_fee_amount_snapshot" < 1000000000000000000
      AND "sale_payments"."processing_fee_fixed_amount_snapshot" IS NOT NULL
      AND "sale_payments"."processing_fee_fixed_amount_snapshot" >= 0
      AND scale("sale_payments"."processing_fee_fixed_amount_snapshot") <= 2
      AND "sale_payments"."processing_fee_fixed_amount_snapshot" < 1000000000000000000
      AND "sale_payments"."processing_fee_percentage_snapshot" IS NOT NULL
      AND "sale_payments"."processing_fee_percentage_snapshot" >= 0
      AND scale("sale_payments"."processing_fee_percentage_snapshot") <= 6
      AND "sale_payments"."processing_fee_percentage_snapshot" < 'Infinity'
    )

  );--> statement-breakpoint
ALTER TABLE "sale_payments" ADD CONSTRAINT "sale_payments_anticipation_fee_snapshot_valid" CHECK (
    (
      "sale_payments"."anticipation_fee_mode_snapshot" = 'unknown'
      AND "sale_payments"."anticipation_fee_amount_snapshot" IS NULL
      AND "sale_payments"."anticipation_fee_fixed_amount_snapshot" IS NULL
      AND "sale_payments"."anticipation_fee_percentage_snapshot" IS NULL
    )
    OR (
      "sale_payments"."anticipation_fee_mode_snapshot" = 'none'
      AND "sale_payments"."anticipation_fee_amount_snapshot" = 0
      AND "sale_payments"."anticipation_fee_fixed_amount_snapshot" IS NULL
      AND "sale_payments"."anticipation_fee_percentage_snapshot" IS NULL
    )
    OR (
      "sale_payments"."anticipation_fee_mode_snapshot" = 'fixed'
      AND "sale_payments"."anticipation_fee_amount_snapshot" IS NOT NULL
      AND "sale_payments"."anticipation_fee_amount_snapshot" >= 0
      AND scale("sale_payments"."anticipation_fee_amount_snapshot") <= 2
      AND "sale_payments"."anticipation_fee_amount_snapshot" < 1000000000000000000
      AND "sale_payments"."anticipation_fee_fixed_amount_snapshot" IS NOT NULL
      AND "sale_payments"."anticipation_fee_fixed_amount_snapshot" >= 0
      AND scale("sale_payments"."anticipation_fee_fixed_amount_snapshot") <= 2
      AND "sale_payments"."anticipation_fee_fixed_amount_snapshot" < 1000000000000000000
      AND "sale_payments"."anticipation_fee_percentage_snapshot" IS NULL
    )
    OR (
      "sale_payments"."anticipation_fee_mode_snapshot" = 'percentage'
      AND "sale_payments"."anticipation_fee_amount_snapshot" IS NOT NULL
      AND "sale_payments"."anticipation_fee_amount_snapshot" >= 0
      AND scale("sale_payments"."anticipation_fee_amount_snapshot") <= 2
      AND "sale_payments"."anticipation_fee_amount_snapshot" < 1000000000000000000
      AND "sale_payments"."anticipation_fee_fixed_amount_snapshot" IS NULL
      AND "sale_payments"."anticipation_fee_percentage_snapshot" IS NOT NULL
      AND "sale_payments"."anticipation_fee_percentage_snapshot" >= 0
      AND scale("sale_payments"."anticipation_fee_percentage_snapshot") <= 6
      AND "sale_payments"."anticipation_fee_percentage_snapshot" < 'Infinity'
    )
    OR (
      "sale_payments"."anticipation_fee_mode_snapshot" = 'fixed_and_percentage'
      AND "sale_payments"."anticipation_fee_amount_snapshot" IS NOT NULL
      AND "sale_payments"."anticipation_fee_amount_snapshot" >= 0
      AND scale("sale_payments"."anticipation_fee_amount_snapshot") <= 2
      AND "sale_payments"."anticipation_fee_amount_snapshot" < 1000000000000000000
      AND "sale_payments"."anticipation_fee_fixed_amount_snapshot" IS NOT NULL
      AND "sale_payments"."anticipation_fee_fixed_amount_snapshot" >= 0
      AND scale("sale_payments"."anticipation_fee_fixed_amount_snapshot") <= 2
      AND "sale_payments"."anticipation_fee_fixed_amount_snapshot" < 1000000000000000000
      AND "sale_payments"."anticipation_fee_percentage_snapshot" IS NOT NULL
      AND "sale_payments"."anticipation_fee_percentage_snapshot" >= 0
      AND scale("sale_payments"."anticipation_fee_percentage_snapshot") <= 6
      AND "sale_payments"."anticipation_fee_percentage_snapshot" < 'Infinity'
    )
    OR (
      "sale_payments"."anticipation_fee_mode_snapshot" = 'not_applicable'
      AND "sale_payments"."anticipation_fee_amount_snapshot" = 0
      AND "sale_payments"."anticipation_fee_fixed_amount_snapshot" IS NULL
      AND "sale_payments"."anticipation_fee_percentage_snapshot" IS NULL
    )
  );--> statement-breakpoint
ALTER TABLE "sale_payments" ADD CONSTRAINT "sale_payments_anticipation_snapshot_matches_request" CHECK (
        (
          "sale_payments"."anticipation_requested" = true
          AND "sale_payments"."method" = 'credit_card'
          AND "sale_payments"."anticipation_fee_mode_snapshot" <> 'not_applicable'
        )
        OR (
          "sale_payments"."anticipation_requested" = false
          AND "sale_payments"."anticipation_fee_mode_snapshot" = 'not_applicable'
          AND "sale_payments"."anticipation_fee_amount_snapshot" = 0
        )
      );--> statement-breakpoint
ALTER TABLE "sale_payments" ADD CONSTRAINT "sale_payments_expected_settlement_days_nonnegative" CHECK ("sale_payments"."expected_settlement_days_snapshot" IS NULL OR "sale_payments"."expected_settlement_days_snapshot" >= 0);--> statement-breakpoint
ALTER TABLE "sale_payments" ADD CONSTRAINT "sale_payments_installments_allowed" CHECK (
        (
          "sale_payments"."method" = 'credit_card'
          AND "sale_payments"."installments" IS NOT NULL
          AND "sale_payments"."installments" >= 1
          AND (
            (
              "sale_payments"."installment_plan" IS NOT NULL
              AND "sale_payments"."installment_plan" IN ('merchant', 'issuer')
              AND "sale_payments"."installment_plan_unknown" = false
            )
            OR (
              "sale_payments"."installment_plan" IS NULL
              AND "sale_payments"."installment_plan_unknown" = true
            )
          )
        )
        OR (
          "sale_payments"."method" <> 'credit_card'
          AND "sale_payments"."installments" IS NULL
          AND "sale_payments"."installment_plan" IS NULL
          AND "sale_payments"."installment_plan_unknown" = false
          AND "sale_payments"."anticipation_requested" = false
        )
      );--> statement-breakpoint
CREATE POLICY "payment_profile_rules_current_tenant_select" ON "payment_profile_rules" AS PERMISSIVE FOR SELECT TO "polaris_pr11_runtime" USING (
  "payment_profile_rules"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "payment_profile_rules"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "payment_profile_rules"."organization_id"
      AND organization_scope.status = 'active'
  )
);--> statement-breakpoint
CREATE POLICY "payment_profile_rules_current_tenant_insert" ON "payment_profile_rules" AS PERMISSIVE FOR INSERT TO "polaris_pr11_runtime" WITH CHECK (
  "payment_profile_rules"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "payment_profile_rules"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "payment_profile_rules"."organization_id"
      AND organization_scope.status = 'active'
  )
);--> statement-breakpoint
CREATE POLICY "payment_profile_rules_current_tenant_update" ON "payment_profile_rules" AS PERMISSIVE FOR UPDATE TO "polaris_pr11_runtime" USING (
  "payment_profile_rules"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "payment_profile_rules"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "payment_profile_rules"."organization_id"
      AND organization_scope.status = 'active'
  )
) WITH CHECK (
  "payment_profile_rules"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "payment_profile_rules"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "payment_profile_rules"."organization_id"
      AND organization_scope.status = 'active'
  )
);--> statement-breakpoint
CREATE POLICY "payment_profiles_current_tenant_select" ON "payment_profiles" AS PERMISSIVE FOR SELECT TO "polaris_pr11_runtime" USING (
  "payment_profiles"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "payment_profiles"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "payment_profiles"."organization_id"
      AND organization_scope.status = 'active'
  )
);--> statement-breakpoint
CREATE POLICY "payment_profiles_current_tenant_insert" ON "payment_profiles" AS PERMISSIVE FOR INSERT TO "polaris_pr11_runtime" WITH CHECK (
  "payment_profiles"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "payment_profiles"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "payment_profiles"."organization_id"
      AND organization_scope.status = 'active'
  )
);--> statement-breakpoint
CREATE POLICY "payment_profiles_current_tenant_update" ON "payment_profiles" AS PERMISSIVE FOR UPDATE TO "polaris_pr11_runtime" USING (
  "payment_profiles"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "payment_profiles"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "payment_profiles"."organization_id"
      AND organization_scope.status = 'active'
  )
) WITH CHECK (
  "payment_profiles"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "payment_profiles"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "payment_profiles"."organization_id"
      AND organization_scope.status = 'active'
  )
);
--> statement-breakpoint
ALTER TABLE public.payment_profiles FORCE ROW LEVEL SECURITY;
ALTER TABLE public.payment_profile_rules FORCE ROW LEVEL SECURITY;
ALTER TABLE public.sale_payments FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE public.payment_profiles, public.payment_profile_rules FROM PUBLIC, polaris_pr11_runtime;
GRANT SELECT, INSERT, UPDATE ON TABLE public.payment_profiles, public.payment_profile_rules TO polaris_pr11_runtime;
REVOKE ALL PRIVILEGES ON TABLE public.sale_payments FROM PUBLIC, polaris_pr11_runtime;
GRANT SELECT ON TABLE public.sale_payments TO polaris_pr11_runtime;
