-- Temporary entitlement grants (ADR 0067): who gave a grant and from when it counts,
-- the end of a grant that was revoked, and the only writer of grants: the billing
-- role (an organization never grants itself anything; the tenant only reads).
ALTER TABLE "entitlement_grants" ADD COLUMN "granted_by" text DEFAULT 'migration' NOT NULL;--> statement-breakpoint
ALTER TABLE "entitlement_grants" ALTER COLUMN "granted_by" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "entitlement_grants" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "entitlement_grants" ADD COLUMN "revoked_by" text;--> statement-breakpoint
ALTER TABLE "entitlement_grants" ADD COLUMN "starts_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
UPDATE "entitlement_grants" SET "starts_at" = LEAST("created_at", "expires_at" - interval '1 second');--> statement-breakpoint
CREATE INDEX "entitlement_grants_expiry_idx" ON "entitlement_grants" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "entitlement_grants" ADD CONSTRAINT "entitlement_grants_actor_allowed" CHECK (char_length("entitlement_grants"."granted_by") BETWEEN 1 AND 128 AND ("entitlement_grants"."revoked_by" IS NULL OR char_length("entitlement_grants"."revoked_by") BETWEEN 1 AND 128));--> statement-breakpoint
ALTER TABLE "entitlement_grants" ADD CONSTRAINT "entitlement_grants_period_allowed" CHECK ("entitlement_grants"."starts_at" < "entitlement_grants"."expires_at" AND "entitlement_grants"."expires_at" - "entitlement_grants"."starts_at" <= interval '366 days');--> statement-breakpoint
ALTER TABLE "entitlement_grants" ADD CONSTRAINT "entitlement_grants_revocation_coherent" CHECK (("entitlement_grants"."revoked_at" IS NULL AND "entitlement_grants"."revoked_by" IS NULL) OR ("entitlement_grants"."revoked_at" IS NOT NULL AND "entitlement_grants"."revoked_by" IS NOT NULL));--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.entitlement_grants TO polaris_billing_runtime;--> statement-breakpoint
-- a grant is never edited: it can only be ended early
GRANT UPDATE (expires_at, revoked_at, revoked_by) ON TABLE public.entitlement_grants TO polaris_billing_runtime;--> statement-breakpoint
CREATE POLICY entitlement_grants_billing_runtime_select ON public.entitlement_grants
  AS PERMISSIVE FOR SELECT TO polaris_billing_runtime USING (true);--> statement-breakpoint
CREATE POLICY entitlement_grants_billing_runtime_insert ON public.entitlement_grants
  AS PERMISSIVE FOR INSERT TO polaris_billing_runtime WITH CHECK (true);--> statement-breakpoint
CREATE POLICY entitlement_grants_billing_runtime_update ON public.entitlement_grants
  AS PERMISSIVE FOR UPDATE TO polaris_billing_runtime USING (true) WITH CHECK (true);--> statement-breakpoint
-- a grant can only be ended early, never extended or un-revoked, by anyone
CREATE FUNCTION public.entitlement_grants_shorten_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF NEW.expires_at > OLD.expires_at THEN
    RAISE EXCEPTION 'a grant can only be shortened'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.revoked_at IS NOT NULL
     AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.revoked_by IS DISTINCT FROM OLD.revoked_by) THEN
    RAISE EXCEPTION 'a revoked grant stays revoked'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;--> statement-breakpoint
-- a trigger function is checked for EXECUTE when the trigger is created, not when it fires
REVOKE ALL ON FUNCTION public.entitlement_grants_shorten_only() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER entitlement_grants_shorten_only
  BEFORE UPDATE ON public.entitlement_grants
  FOR EACH ROW EXECUTE FUNCTION public.entitlement_grants_shorten_only();--> statement-breakpoint
-- which Free limits the organization holds more than (the same counts the writes enforce, ADR 0058),
-- by key, so the end of a grant for one limit is not hidden by a grant for another that still runs
GRANT CREATE ON SCHEMA public TO polaris_billing_owner;--> statement-breakpoint
CREATE FUNCTION public.organization_free_limit_excess(p_organization_id text)
RETURNS text[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  variants_limit integer;
  images_limit integer;
  per_product_limit integer;
  goals_limit integer;
BEGIN
  SELECT
    max(limit_value) FILTER (WHERE key = 'variants.active.max'),
    max(limit_value) FILTER (WHERE key = 'images.active.max'),
    max(limit_value) FILTER (WHERE key = 'images.per_product.max'),
    max(limit_value) FILTER (WHERE key = 'goals.active.max')
  INTO variants_limit, images_limit, per_product_limit, goals_limit
  FROM public.plan_entitlements
  WHERE plan_id = 'free';

  IF variants_limit IS NULL OR images_limit IS NULL OR per_product_limit IS NULL OR goals_limit IS NULL THEN
    RAISE EXCEPTION 'the free plan limits are incomplete'
      USING ERRCODE = '22023';
  END IF;

  RETURN ARRAY(
    SELECT excess.key
    FROM (
      VALUES
        ('variants.active.max'::text, (
          SELECT pg_catalog.count(*)
          FROM public.product_variants AS variant
          JOIN public.products AS product
            ON product.organization_id = variant.organization_id
           AND product.id = variant.product_id
          WHERE variant.organization_id = p_organization_id
            AND product.deleted_at IS NULL
        ) > variants_limit),
        ('images.active.max'::text, (
          SELECT pg_catalog.count(*)
          FROM public.product_media AS link
          JOIN public.products AS product
            ON product.organization_id = link.organization_id
           AND product.id = link.product_id
          WHERE link.organization_id = p_organization_id
            AND product.deleted_at IS NULL
        ) > images_limit),
        ('images.per_product.max'::text, EXISTS (
          SELECT 1
          FROM public.product_media AS link
          JOIN public.products AS product
            ON product.organization_id = link.organization_id
           AND product.id = link.product_id
          WHERE link.organization_id = p_organization_id
            AND product.deleted_at IS NULL
          GROUP BY link.product_id
          HAVING pg_catalog.count(*) > per_product_limit
        )),
        ('goals.active.max'::text, (
          SELECT pg_catalog.count(*)
          FROM public.goals AS goal
          WHERE goal.organization_id = p_organization_id
            AND goal.status = 'active'
        ) > goals_limit)
    ) AS excess(key, over_limit)
    WHERE excess.over_limit
    ORDER BY excess.key
  );
END;
$function$;--> statement-breakpoint
GRANT polaris_billing_owner TO CURRENT_USER WITH SET TRUE, INHERIT FALSE, ADMIN FALSE;--> statement-breakpoint
ALTER FUNCTION public.organization_free_limit_excess(text) OWNER TO polaris_billing_owner;--> statement-breakpoint
SET ROLE polaris_billing_owner;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.organization_free_limit_excess(text) FROM PUBLIC, polaris_pr11_runtime, polaris_billing_runtime;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION public.organization_free_limit_excess(text) TO polaris_billing_runtime;--> statement-breakpoint
RESET ROLE;--> statement-breakpoint
REVOKE polaris_billing_owner FROM CURRENT_USER;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM polaris_billing_owner;
