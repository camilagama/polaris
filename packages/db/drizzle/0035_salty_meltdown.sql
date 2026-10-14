CREATE TABLE "sale_customer_links" (
	"action" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"customer_id" uuid,
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" text NOT NULL,
	"sale_id" uuid NOT NULL,
	"version" integer NOT NULL,
	CONSTRAINT "sale_customer_links_action_allowed" CHECK ("sale_customer_links"."action" IN ('assign', 'reassign', 'unassign')),
	CONSTRAINT "sale_customer_links_version_positive" CHECK ("sale_customer_links"."version" >= 1),
	CONSTRAINT "sale_customer_links_customer_matches_action" CHECK (
        ("sale_customer_links"."action" = 'unassign' AND "sale_customer_links"."customer_id" IS NULL)
        OR ("sale_customer_links"."action" <> 'unassign' AND "sale_customer_links"."customer_id" IS NOT NULL)
      ),
	CONSTRAINT "sale_customer_links_first_version_assigns" CHECK ("sale_customer_links"."version" > 1 OR "sale_customer_links"."action" = 'assign')
);
--> statement-breakpoint
ALTER TABLE "sale_customer_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sale_customer_links" ADD CONSTRAINT "sale_customer_links_organization_sale_fk" FOREIGN KEY ("organization_id","sale_id") REFERENCES "public"."sales"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_customer_links" ADD CONSTRAINT "sale_customer_links_organization_customer_fk" FOREIGN KEY ("organization_id","customer_id") REFERENCES "public"."customers"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sale_customer_links_organization_sale_version_unique" ON "sale_customer_links" USING btree ("organization_id","sale_id","version");--> statement-breakpoint
CREATE INDEX "sale_customer_links_organization_customer_idx" ON "sale_customer_links" USING btree ("organization_id","customer_id","sale_id");--> statement-breakpoint
CREATE POLICY "sale_customer_links_current_tenant_select" ON "sale_customer_links" AS PERMISSIVE FOR SELECT TO "polaris_pr11_runtime" USING (
  "sale_customer_links"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "sale_customer_links"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "sale_customer_links"."organization_id"
      AND organization_scope.status = 'active'
  )
);--> statement-breakpoint
CREATE POLICY "sale_customer_links_current_tenant_insert" ON "sale_customer_links" AS PERMISSIVE FOR INSERT TO "polaris_pr11_runtime" WITH CHECK (
  "sale_customer_links"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "sale_customer_links"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "sale_customer_links"."organization_id"
      AND organization_scope.status = 'active'
  )
);
--> statement-breakpoint
CREATE FUNCTION public.guard_sale_customer_link_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_prev_version integer;
  v_prev_customer uuid;
BEGIN
  SELECT link.version, link.customer_id
  INTO v_prev_version, v_prev_customer
  FROM public.sale_customer_links AS link
  WHERE link.organization_id = NEW.organization_id
    AND link.sale_id = NEW.sale_id
  ORDER BY link.version DESC
  LIMIT 1;

  IF NEW.version <> COALESCE(v_prev_version, 0) + 1 THEN
    RAISE EXCEPTION 'sale customer link versions must be consecutive'
      USING ERRCODE = '23514', CONSTRAINT = 'sale_customer_links_version_sequence';
  END IF;

  IF (NEW.action = 'assign' AND v_prev_customer IS NOT NULL)
    OR (NEW.action = 'reassign' AND (v_prev_customer IS NULL OR v_prev_customer = NEW.customer_id))
    OR (NEW.action = 'unassign' AND v_prev_customer IS NULL) THEN
    RAISE EXCEPTION 'sale customer link action does not fit the current attribution'
      USING ERRCODE = '23514', CONSTRAINT = 'sale_customer_links_transition_valid';
  END IF;

  IF NEW.action <> 'unassign' AND NOT EXISTS (
    SELECT 1
    FROM public.customers AS customer
    WHERE customer.organization_id = NEW.organization_id
      AND customer.id = NEW.customer_id
      AND customer.archived_at IS NULL
  ) THEN
    RAISE EXCEPTION 'only an active customer can be newly linked to a sale'
      USING ERRCODE = '23514', CONSTRAINT = 'sale_customer_links_customer_active';
  END IF;

  RETURN NEW;
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.guard_sale_customer_link_transition() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER sale_customer_links_transition_guard
BEFORE INSERT ON public.sale_customer_links
FOR EACH ROW
EXECUTE FUNCTION public.guard_sale_customer_link_transition();--> statement-breakpoint
ALTER TABLE public.sale_customer_links FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE public.sale_customer_links FROM PUBLIC, polaris_pr11_runtime;
GRANT SELECT, INSERT ON TABLE public.sale_customer_links TO polaris_pr11_runtime;