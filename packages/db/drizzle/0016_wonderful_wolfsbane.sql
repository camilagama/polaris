CREATE TABLE "product_option_values" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"option_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"position" integer NOT NULL,
	"product_id" uuid NOT NULL,
	CONSTRAINT "product_option_values_name_not_blank" CHECK (char_length(btrim("product_option_values"."name")) >= 1),
	CONSTRAINT "product_option_values_position_nonnegative" CHECK ("product_option_values"."position" >= 0)
);
--> statement-breakpoint
ALTER TABLE "product_option_values" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "product_options" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"organization_id" text NOT NULL,
	"position" integer NOT NULL,
	"product_id" uuid NOT NULL,
	CONSTRAINT "product_options_name_allowed" CHECK ("product_options"."name" IN ('model', 'color', 'size')),
	CONSTRAINT "product_options_position_allowed" CHECK (
        ("product_options"."name" = 'model' AND "product_options"."position" = 0)
        OR ("product_options"."name" = 'color' AND "product_options"."position" = 1)
        OR ("product_options"."name" = 'size' AND "product_options"."position" = 2)
      )
);
--> statement-breakpoint
ALTER TABLE "product_options" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "variant_option_values" (
	"option_id" uuid NOT NULL,
	"option_value_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"product_id" uuid NOT NULL,
	"variant_id" uuid NOT NULL,
	CONSTRAINT "variant_option_values_pk" PRIMARY KEY("organization_id","product_id","variant_id","option_id")
);
--> statement-breakpoint
ALTER TABLE "variant_option_values" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "product_variants" ADD COLUMN "position" integer;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "variants_configured_at" timestamp;--> statement-breakpoint
CREATE UNIQUE INDEX "product_option_values_option_position_unique" ON "product_option_values" USING btree ("organization_id","product_id","option_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "product_option_values_option_id_unique" ON "product_option_values" USING btree ("organization_id","product_id","option_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_option_values_option_name_unique" ON "product_option_values" USING btree ("organization_id","product_id","option_id",lower(btrim("name")));--> statement-breakpoint
CREATE UNIQUE INDEX "product_options_product_name_unique" ON "product_options" USING btree ("organization_id","product_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "product_options_product_position_unique" ON "product_options" USING btree ("organization_id","product_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "product_options_organization_product_id_unique" ON "product_options" USING btree ("organization_id","product_id","id");--> statement-breakpoint
CREATE INDEX "variant_option_values_option_value_idx" ON "variant_option_values" USING btree ("organization_id","product_id","option_id","option_value_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_variants_organization_product_id_unique" ON "product_variants" USING btree ("organization_id","product_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_variants_product_position_unique" ON "product_variants" USING btree ("product_id","position") WHERE "product_variants"."position" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "product_option_values" ADD CONSTRAINT "product_option_values_option_fk" FOREIGN KEY ("organization_id","product_id","option_id") REFERENCES "public"."product_options"("organization_id","product_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_options" ADD CONSTRAINT "product_options_organization_product_fk" FOREIGN KEY ("organization_id","product_id") REFERENCES "public"."products"("organization_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant_option_values" ADD CONSTRAINT "variant_option_values_variant_fk" FOREIGN KEY ("organization_id","product_id","variant_id") REFERENCES "public"."product_variants"("organization_id","product_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant_option_values" ADD CONSTRAINT "variant_option_values_option_fk" FOREIGN KEY ("organization_id","product_id","option_id") REFERENCES "public"."product_options"("organization_id","product_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "variant_option_values" ADD CONSTRAINT "variant_option_values_value_fk" FOREIGN KEY ("organization_id","product_id","option_id","option_value_id") REFERENCES "public"."product_option_values"("organization_id","product_id","option_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_position_nonnegative" CHECK ("product_variants"."position" IS NULL OR "product_variants"."position" >= 0);--> statement-breakpoint
CREATE POLICY "product_variants_current_tenant_delete" ON "product_variants" AS PERMISSIVE FOR DELETE TO "polaris_pr11_runtime" USING (

  "product_variants"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "product_variants"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "product_variants"."organization_id"
      AND organization_scope.status = 'active'
  )

        AND "product_variants"."is_default"
        AND EXISTS (
          SELECT 1
          FROM public.products AS product_scope
          WHERE product_scope.id = "product_variants"."product_id"
            AND product_scope.organization_id = "product_variants"."organization_id"
            AND product_scope.variants_configured_at IS NULL
        )
      );--> statement-breakpoint
CREATE POLICY "product_option_values_current_tenant_select" ON "product_option_values" AS PERMISSIVE FOR SELECT TO "polaris_pr11_runtime" USING (

  "product_option_values"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "product_option_values"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "product_option_values"."organization_id"
      AND organization_scope.status = 'active'
  )

        AND EXISTS (
          SELECT 1 FROM public.product_options AS option_scope
          WHERE option_scope.id = "product_option_values"."option_id"
            AND option_scope.organization_id = "product_option_values"."organization_id"
            AND option_scope.product_id = "product_option_values"."product_id"
        )
      );--> statement-breakpoint
CREATE POLICY "product_option_values_current_tenant_insert" ON "product_option_values" AS PERMISSIVE FOR INSERT TO "polaris_pr11_runtime" WITH CHECK (

  "product_option_values"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "product_option_values"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "product_option_values"."organization_id"
      AND organization_scope.status = 'active'
  )

        AND EXISTS (
          SELECT 1 FROM public.product_options AS option_scope
          INNER JOIN public.products AS product_scope
            ON product_scope.id = option_scope.product_id
           AND product_scope.organization_id = option_scope.organization_id
          WHERE option_scope.id = "product_option_values"."option_id"
            AND option_scope.organization_id = "product_option_values"."organization_id"
            AND option_scope.product_id = "product_option_values"."product_id"
            AND product_scope.variants_configured_at IS NULL
        )
      );--> statement-breakpoint
CREATE POLICY "product_options_current_tenant_select" ON "product_options" AS PERMISSIVE FOR SELECT TO "polaris_pr11_runtime" USING (

  "product_options"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "product_options"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "product_options"."organization_id"
      AND organization_scope.status = 'active'
  )

        AND EXISTS (
          SELECT 1 FROM public.products AS product_scope
          WHERE product_scope.id = "product_options"."product_id"
            AND product_scope.organization_id = "product_options"."organization_id"
        )
      );--> statement-breakpoint
CREATE POLICY "product_options_current_tenant_insert" ON "product_options" AS PERMISSIVE FOR INSERT TO "polaris_pr11_runtime" WITH CHECK (

  "product_options"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "product_options"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "product_options"."organization_id"
      AND organization_scope.status = 'active'
  )

        AND EXISTS (
          SELECT 1 FROM public.products AS product_scope
          WHERE product_scope.id = "product_options"."product_id"
            AND product_scope.organization_id = "product_options"."organization_id"
            AND product_scope.variants_configured_at IS NULL
        )
      );--> statement-breakpoint
CREATE POLICY "variant_option_values_current_tenant_select" ON "variant_option_values" AS PERMISSIVE FOR SELECT TO "polaris_pr11_runtime" USING (

  "variant_option_values"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "variant_option_values"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "variant_option_values"."organization_id"
      AND organization_scope.status = 'active'
  )

        AND EXISTS (
          SELECT 1 FROM public.products AS product_scope
          WHERE product_scope.id = "variant_option_values"."product_id"
            AND product_scope.organization_id = "variant_option_values"."organization_id"
        )
      );--> statement-breakpoint
CREATE POLICY "variant_option_values_current_tenant_insert" ON "variant_option_values" AS PERMISSIVE FOR INSERT TO "polaris_pr11_runtime" WITH CHECK (

  "variant_option_values"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "variant_option_values"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "variant_option_values"."organization_id"
      AND organization_scope.status = 'active'
  )

        AND EXISTS (
          SELECT 1 FROM public.products AS product_scope
          WHERE product_scope.id = "variant_option_values"."product_id"
            AND product_scope.organization_id = "variant_option_values"."organization_id"
            AND product_scope.variants_configured_at IS NULL
        )
      );--> statement-breakpoint
ALTER POLICY "product_variants_current_tenant_insert" ON "product_variants" TO polaris_pr11_runtime WITH CHECK (

  "product_variants"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "product_variants"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "product_variants"."organization_id"
      AND organization_scope.status = 'active'
  )

        AND EXISTS (
          SELECT 1
          FROM public.products AS product_scope
          WHERE product_scope.id = "product_variants"."product_id"
            AND product_scope.organization_id = "product_variants"."organization_id"
            AND product_scope.variants_configured_at IS NULL
        )
      );

ALTER TABLE public.product_options FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.product_option_values FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.variant_option_values FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.product_variants FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.product_options TO polaris_pr11_runtime;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.product_option_values TO polaris_pr11_runtime;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE public.variant_option_values TO polaris_pr11_runtime;--> statement-breakpoint
GRANT DELETE ON TABLE public.product_variants TO polaris_pr11_runtime;--> statement-breakpoint
CREATE FUNCTION public.prevent_product_variant_configuration_reset()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.variants_configured_at IS NOT NULL
     AND NEW.variants_configured_at IS DISTINCT FROM OLD.variants_configured_at THEN
    RAISE EXCEPTION 'product variant configuration is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'products_variant_configuration_immutable';
  END IF;
  RETURN NEW;
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.prevent_product_variant_configuration_reset() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER products_prevent_variant_configuration_reset
BEFORE UPDATE OF variants_configured_at ON public.products
FOR EACH ROW EXECUTE FUNCTION public.prevent_product_variant_configuration_reset();--> statement-breakpoint
CREATE FUNCTION public.enforce_product_variant_configuration()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  product_id_to_check uuid;
  organization_id_to_check text;
  configured_at timestamp;
  variant_count bigint;
  default_variant_count bigint;
  configured_variant_count bigint;
  null_position_count bigint;
  option_count bigint;
BEGIN
  IF TG_TABLE_NAME = 'products' THEN
    product_id_to_check := NEW.id;
    organization_id_to_check := NEW.organization_id;
  ELSIF TG_OP = 'DELETE' THEN
    product_id_to_check := OLD.product_id;
    organization_id_to_check := OLD.organization_id;
  ELSE
    product_id_to_check := NEW.product_id;
    organization_id_to_check := NEW.organization_id;
  END IF;

  SELECT product.variants_configured_at
  INTO configured_at
  FROM public.products AS product
  WHERE product.id = product_id_to_check
    AND product.organization_id = organization_id_to_check;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT count(*)
  INTO variant_count
  FROM public.product_variants AS variant
  WHERE variant.product_id = product_id_to_check
    AND variant.organization_id = organization_id_to_check;

  IF variant_count = 0 THEN
    RAISE EXCEPTION 'product must have at least one variant'
      USING ERRCODE = '23514', CONSTRAINT = 'products_require_variant';
  END IF;
  IF variant_count > 50 THEN
    RAISE EXCEPTION 'product cannot have more than 50 variants'
      USING ERRCODE = '23514', CONSTRAINT = 'product_variants_max_count';
  END IF;

  SELECT
    count(*) FILTER (WHERE variant.is_default),
    count(*) FILTER (WHERE NOT variant.is_default),
    count(*) FILTER (WHERE variant.position IS NULL)
  INTO default_variant_count, configured_variant_count, null_position_count
  FROM public.product_variants AS variant
  WHERE variant.product_id = product_id_to_check
    AND variant.organization_id = organization_id_to_check;

  SELECT count(*)
  INTO option_count
  FROM public.product_options AS option
  WHERE option.product_id = product_id_to_check
    AND option.organization_id = organization_id_to_check;

  IF configured_at IS NULL THEN
    IF option_count <> 0
       OR variant_count <> 1
       OR default_variant_count <> 1
       OR configured_variant_count <> 0
       OR null_position_count <> 1
       OR EXISTS (
         SELECT 1
         FROM public.variant_option_values AS assignment
         WHERE assignment.product_id = product_id_to_check
           AND assignment.organization_id = organization_id_to_check
       ) THEN
      RAISE EXCEPTION 'unconfigured product must retain only its hidden default variant'
        USING ERRCODE = '23514', CONSTRAINT = 'products_variant_configuration_guard';
    END IF;
    RETURN NULL;
  END IF;

  IF option_count < 1
     OR option_count > 3
     OR default_variant_count <> 0
     OR configured_variant_count <> variant_count
     OR null_position_count <> 0 THEN
    RAISE EXCEPTION 'configured product variant state is incomplete'
      USING ERRCODE = '23514', CONSTRAINT = 'products_variant_configuration_guard';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.product_options AS option
    WHERE option.product_id = product_id_to_check
      AND option.organization_id = organization_id_to_check
      AND NOT EXISTS (
        SELECT 1
        FROM public.product_option_values AS option_value
        WHERE option_value.product_id = option.product_id
          AND option_value.organization_id = option.organization_id
          AND option_value.option_id = option.id
      )
  ) THEN
    RAISE EXCEPTION 'every product option must have a value'
      USING ERRCODE = '23514', CONSTRAINT = 'products_variant_configuration_guard';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.product_variants AS variant
    WHERE variant.product_id = product_id_to_check
      AND variant.organization_id = organization_id_to_check
      AND (
        SELECT count(*)
        FROM public.variant_option_values AS assignment
        WHERE assignment.product_id = variant.product_id
          AND assignment.organization_id = variant.organization_id
          AND assignment.variant_id = variant.id
      ) <> option_count
  ) THEN
    RAISE EXCEPTION 'each configured variant must have one value for every selected option'
      USING ERRCODE = '23514', CONSTRAINT = 'products_variant_configuration_guard';
  END IF;

  IF EXISTS (
    SELECT combination.option_value_ids
    FROM (
      SELECT array_agg(assignment.option_value_id ORDER BY assignment.option_id) AS option_value_ids
      FROM public.variant_option_values AS assignment
      WHERE assignment.product_id = product_id_to_check
        AND assignment.organization_id = organization_id_to_check
      GROUP BY assignment.variant_id
    ) AS combination
    GROUP BY combination.option_value_ids
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'product variant combinations must be unique'
      USING ERRCODE = '23514', CONSTRAINT = 'products_variant_configuration_guard';
  END IF;

  RETURN NULL;
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.enforce_product_variant_configuration() FROM PUBLIC;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER products_variant_configuration_guard
AFTER INSERT OR UPDATE OF variants_configured_at ON public.products
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.enforce_product_variant_configuration();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER product_variants_configuration_guard
AFTER INSERT OR DELETE ON public.product_variants
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.enforce_product_variant_configuration();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER product_options_configuration_guard
AFTER INSERT ON public.product_options
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.enforce_product_variant_configuration();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER product_option_values_configuration_guard
AFTER INSERT ON public.product_option_values
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.enforce_product_variant_configuration();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER variant_option_values_configuration_guard
AFTER INSERT ON public.variant_option_values
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.enforce_product_variant_configuration();
--> statement-breakpoint
CREATE FUNCTION public.lock_unconfigured_product_variant_write()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  PERFORM 1
  FROM public.products AS product
  WHERE product.id = NEW.product_id
    AND product.organization_id = NEW.organization_id
    AND product.variants_configured_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'product variants are already configured or product is unavailable'
      USING ERRCODE = '23514', CONSTRAINT = 'products_variant_configuration_immutable';
  END IF;
  RETURN NEW;
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.lock_unconfigured_product_variant_write() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER product_variants_lock_unconfigured_product
BEFORE INSERT ON public.product_variants
FOR EACH ROW EXECUTE FUNCTION public.lock_unconfigured_product_variant_write();--> statement-breakpoint
CREATE TRIGGER product_options_lock_unconfigured_product
BEFORE INSERT ON public.product_options
FOR EACH ROW EXECUTE FUNCTION public.lock_unconfigured_product_variant_write();--> statement-breakpoint
CREATE TRIGGER product_option_values_lock_unconfigured_product
BEFORE INSERT ON public.product_option_values
FOR EACH ROW EXECUTE FUNCTION public.lock_unconfigured_product_variant_write();--> statement-breakpoint
CREATE TRIGGER variant_option_values_lock_unconfigured_product
BEFORE INSERT ON public.variant_option_values
FOR EACH ROW EXECUTE FUNCTION public.lock_unconfigured_product_variant_write();