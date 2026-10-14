CREATE TABLE "sync_changes" (
	"change_kind" text DEFAULT 'upsert' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"entity_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" text NOT NULL,
	"seq" bigint,
	CONSTRAINT "sync_changes_entity_type_allowed" CHECK ("sync_changes"."entity_type" IN ('category', 'customer', 'inventory_balance', 'payment_profile', 'product', 'sale')),
	CONSTRAINT "sync_changes_change_kind_allowed" CHECK ("sync_changes"."change_kind" = 'upsert'),
	CONSTRAINT "sync_changes_seq_positive" CHECK ("sync_changes"."seq" IS NULL OR "sync_changes"."seq" > 0)
);
--> statement-breakpoint
ALTER TABLE "sync_changes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sync_cursors" (
	"last_seq" bigint DEFAULT 0 NOT NULL,
	"organization_id" text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sync_cursors" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sync_changes" ADD CONSTRAINT "sync_changes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_cursors" ADD CONSTRAINT "sync_cursors_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sync_changes_organization_seq_unique" ON "sync_changes" USING btree ("organization_id","seq") WHERE "sync_changes"."seq" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "sync_changes_organization_entity_idx" ON "sync_changes" USING btree ("organization_id","entity_type","entity_id");--> statement-breakpoint
CREATE POLICY "sync_changes_current_tenant_select" ON "sync_changes" AS PERMISSIVE FOR SELECT TO "polaris_pr11_runtime" USING (
        "sync_changes"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
        AND EXISTS (
          SELECT 1
          FROM public.memberships AS membership_scope
          WHERE membership_scope.organization_id = "sync_changes"."organization_id"
            AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
            AND membership_scope.status = 'active'
        )
        AND EXISTS (
          SELECT 1
          FROM public.organizations AS organization_scope
          WHERE organization_scope.id = "sync_changes"."organization_id"
            AND organization_scope.status = 'active'
        )
      );
--> statement-breakpoint
ALTER TABLE public.sync_changes FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.sync_cursors FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE public.sync_changes, public.sync_cursors FROM PUBLIC;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE public.sync_changes, public.sync_cursors FROM polaris_pr11_runtime;--> statement-breakpoint
-- The runtime reads the log and nothing else: it can neither forge nor edit a
-- change, and it never touches the cursor counters.
GRANT SELECT ON TABLE public.sync_changes TO polaris_pr11_runtime;--> statement-breakpoint
-- Written by the domain tables' triggers, in the writer's transaction.
CREATE FUNCTION public.record_sync_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_row jsonb := to_jsonb(NEW);
  v_organization_id text := v_row ->> 'organization_id';
  v_entity_id text := v_row ->> TG_ARGV[1];
BEGIN
  IF v_organization_id IS NULL OR v_entity_id IS NULL THEN
    RAISE EXCEPTION 'sync change without organization or entity (%.%)', TG_TABLE_NAME, TG_ARGV[1]
      USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO public.sync_changes (organization_id, entity_type, entity_id)
  VALUES (v_organization_id, TG_ARGV[0], v_entity_id::uuid);
  RETURN NULL;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.record_sync_change() FROM PUBLIC;--> statement-breakpoint
-- Numbers the transaction's pending changes at COMMIT. The per-organization
-- counter row is locked until the commit completes, so sequence order is commit
-- order: a reader at sequence N has already seen every change numbered below it.
CREATE FUNCTION public.assign_sync_change_sequence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_pending integer;
  v_last bigint;
BEGIN
  -- Only this transaction's own rows are still unnumbered and visible.
  SELECT count(*)::integer INTO v_pending
    FROM public.sync_changes
   WHERE organization_id = NEW.organization_id AND seq IS NULL;
  IF v_pending = 0 THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.sync_cursors (organization_id, last_seq)
  VALUES (NEW.organization_id, v_pending)
  ON CONFLICT (organization_id)
  DO UPDATE SET last_seq = public.sync_cursors.last_seq + v_pending
  RETURNING last_seq INTO v_last;

  UPDATE public.sync_changes AS change
     SET seq = v_last - v_pending + numbered.position
    FROM (
      SELECT id, row_number() OVER (ORDER BY id) AS position
        FROM public.sync_changes
       WHERE organization_id = NEW.organization_id AND seq IS NULL
    ) AS numbered
   WHERE change.id = numbered.id;
  RETURN NULL;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.assign_sync_change_sequence() FROM PUBLIC;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER sync_changes_assign_sequence
  AFTER INSERT ON public.sync_changes
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.seq IS NULL)
  EXECUTE FUNCTION public.assign_sync_change_sequence();--> statement-breakpoint
-- A change is append-only: the only update it ever gets is its sequence number.
CREATE FUNCTION public.guard_sync_change_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF OLD.seq IS NOT NULL
     OR NEW.seq IS NULL
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.entity_type IS DISTINCT FROM OLD.entity_type
     OR NEW.entity_id IS DISTINCT FROM OLD.entity_id
     OR NEW.change_kind IS DISTINCT FROM OLD.change_kind THEN
    RAISE EXCEPTION 'a sync change is append-only'
      USING ERRCODE = '23514', CONSTRAINT = 'sync_changes_append_only';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.guard_sync_change_update() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER sync_changes_append_only
  BEFORE UPDATE ON public.sync_changes
  FOR EACH ROW EXECUTE FUNCTION public.guard_sync_change_update();--> statement-breakpoint
CREATE TRIGGER sync_record_category AFTER INSERT OR UPDATE ON public.categories
  FOR EACH ROW EXECUTE FUNCTION public.record_sync_change('category', 'id');--> statement-breakpoint
CREATE TRIGGER sync_record_product AFTER INSERT OR UPDATE ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.record_sync_change('product', 'id');--> statement-breakpoint
CREATE TRIGGER sync_record_product_variant AFTER INSERT OR UPDATE ON public.product_variants
  FOR EACH ROW EXECUTE FUNCTION public.record_sync_change('product', 'product_id');--> statement-breakpoint
CREATE TRIGGER sync_record_inventory_balance AFTER INSERT OR UPDATE ON public.inventory_balances
  FOR EACH ROW EXECUTE FUNCTION public.record_sync_change('inventory_balance', 'variant_id');--> statement-breakpoint
CREATE TRIGGER sync_record_customer AFTER INSERT OR UPDATE ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public.record_sync_change('customer', 'id');--> statement-breakpoint
CREATE TRIGGER sync_record_payment_profile AFTER INSERT OR UPDATE ON public.payment_profiles
  FOR EACH ROW EXECUTE FUNCTION public.record_sync_change('payment_profile', 'id');--> statement-breakpoint
CREATE TRIGGER sync_record_payment_profile_rule AFTER INSERT OR UPDATE ON public.payment_profile_rules
  FOR EACH ROW EXECUTE FUNCTION public.record_sync_change('payment_profile', 'payment_profile_id');--> statement-breakpoint
CREATE TRIGGER sync_record_sale AFTER INSERT OR UPDATE ON public.sales
  FOR EACH ROW EXECUTE FUNCTION public.record_sync_change('sale', 'id');--> statement-breakpoint
CREATE TRIGGER sync_record_sale_cancellation AFTER INSERT ON public.sale_cancellations
  FOR EACH ROW EXECUTE FUNCTION public.record_sync_change('sale', 'sale_id');--> statement-breakpoint
CREATE TRIGGER sync_record_sale_return AFTER INSERT ON public.sale_returns
  FOR EACH ROW EXECUTE FUNCTION public.record_sync_change('sale', 'sale_id');--> statement-breakpoint
CREATE TRIGGER sync_record_sale_customer_link AFTER INSERT OR UPDATE ON public.sale_customer_links
  FOR EACH ROW EXECUTE FUNCTION public.record_sync_change('sale', 'sale_id');
