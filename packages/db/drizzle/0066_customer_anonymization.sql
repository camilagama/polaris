-- Anonymizing a customer for privacy (plan PR102, ADR 0075): the record stays, so every sale that
-- points to it keeps its economic facts, and everything about the person goes. The database requires
-- exactly that of an anonymized row (a fixed name and no phone, e-mail or notes) and refuses any
-- later change to it, so it cannot be undone.
ALTER TABLE "customers" DROP CONSTRAINT "customers_contact_required";--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "anonymized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_anonymized_scrubbed" CHECK (
          "customers"."anonymized_at" IS NULL
          OR (
            "customers"."name" = 'Cliente anonimizado'
            AND "customers"."phone" IS NULL
            AND "customers"."email" IS NULL
            AND "customers"."notes" IS NULL
            AND "customers"."archived_at" IS NOT NULL
          )
        );--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_contact_required" CHECK (
          ("customers"."anonymized_at" IS NOT NULL OR ("customers"."phone" IS NOT NULL OR "customers"."email" IS NOT NULL))
          AND ("customers"."phone" IS NULL OR char_length(btrim("customers"."phone")) >= 1)
          AND ("customers"."email" IS NULL OR char_length(btrim("customers"."email")) >= 1)
        );
--> statement-breakpoint
GRANT UPDATE (anonymized_at) ON TABLE public.customers TO polaris_pr11_runtime;--> statement-breakpoint
CREATE FUNCTION public.guard_customer_anonymization_final()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF OLD.anonymized_at IS NOT NULL THEN
    RAISE EXCEPTION 'an anonymized customer cannot be changed'
      USING ERRCODE = '23514', CONSTRAINT = 'customers_anonymization_final';
  END IF;
  RETURN NEW;
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.guard_customer_anonymization_final() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER customers_anonymization_final
BEFORE UPDATE ON public.customers
FOR EACH ROW
EXECUTE FUNCTION public.guard_customer_anonymization_final();
