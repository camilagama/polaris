-- A chargeback won before the chargeback arrives is remembered on an active
-- subscription too (ADR 0066), so the chargeback, when it comes, changes nothing.
ALTER TABLE "organization_billing" DROP CONSTRAINT "organization_billing_revoked_coherent";--> statement-breakpoint
ALTER TABLE "organization_billing" ADD CONSTRAINT "organization_billing_revoked_coherent" CHECK (
        ("organization_billing"."revoked_through" IS NULL AND "organization_billing"."revoked_reason" IS NULL AND "organization_billing"."revoked_cycle_months" IS NULL AND NOT "organization_billing"."revoked_cancel_at_period_end")
        OR (
          "organization_billing"."revoked_through" IS NOT NULL
          AND "organization_billing"."revoked_reason" IN ('refund', 'chargeback', 'won')
          AND ("organization_billing"."state" NOT IN ('active', 'grace') OR "organization_billing"."revoked_reason" = 'won')
          AND ("organization_billing"."revoked_cycle_months" IS NULL OR "organization_billing"."revoked_cycle_months" IN (1, 6, 12))
        )
      );
