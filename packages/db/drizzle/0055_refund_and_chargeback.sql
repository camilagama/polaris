-- Refunds and chargebacks (ADR 0066): the facts a provider reports about money
-- taken back, and the record of the payment that was taken back, so its late
-- confirmation cannot revive the access and a reversed chargeback can restore it.
ALTER TABLE "billing_events" DROP CONSTRAINT "billing_events_fact_type_allowed";--> statement-breakpoint
ALTER TABLE "organization_billing" ADD COLUMN "revoked_cancel_at_period_end" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_billing" ADD COLUMN "revoked_cycle_months" integer;--> statement-breakpoint
ALTER TABLE "organization_billing" ADD COLUMN "revoked_reason" text;--> statement-breakpoint
ALTER TABLE "organization_billing" ADD COLUMN "revoked_through" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "billing_events" ADD CONSTRAINT "billing_events_fact_type_allowed" CHECK ("billing_events"."fact_type" IN ('trial_method_ready', 'charge_succeeded', 'charge_failed', 'subscription_cancelled', 'cycle_change_scheduled', 'charge_refunded', 'charge_disputed', 'dispute_reversed', 'time_elapsed', 'command'));--> statement-breakpoint
ALTER TABLE "organization_billing" ADD CONSTRAINT "organization_billing_revoked_coherent" CHECK (
        ("organization_billing"."revoked_through" IS NULL AND "organization_billing"."revoked_reason" IS NULL AND "organization_billing"."revoked_cycle_months" IS NULL AND NOT "organization_billing"."revoked_cancel_at_period_end")
        OR (
          "organization_billing"."revoked_through" IS NOT NULL
          AND "organization_billing"."revoked_reason" IN ('refund', 'chargeback', 'won')
          AND "organization_billing"."state" NOT IN ('active', 'grace')
          AND ("organization_billing"."revoked_cycle_months" IS NULL OR "organization_billing"."revoked_cycle_months" IN (1, 6, 12))
        )
      );--> statement-breakpoint
-- the billing writer records and clears what was taken back
GRANT UPDATE (revoked_through, revoked_reason, revoked_cycle_months, revoked_cancel_at_period_end) ON TABLE public.organization_billing TO polaris_billing_runtime;
