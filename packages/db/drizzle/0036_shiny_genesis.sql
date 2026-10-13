CREATE TABLE "sale_cancellations" (
	"cancelled_at" timestamp DEFAULT now() NOT NULL,
	"cancelled_by" text NOT NULL,
	"command_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" text NOT NULL,
	"reason_code" text,
	"reason_note" text,
	"sale_id" uuid NOT NULL,
	CONSTRAINT "sale_cancellations_cancelled_by_not_blank" CHECK (char_length(btrim("sale_cancellations"."cancelled_by")) BETWEEN 1 AND 255),
	CONSTRAINT "sale_cancellations_reason_valid" CHECK (
        ("sale_cancellations"."reason_code" IS NULL AND "sale_cancellations"."reason_note" IS NULL)
        OR (
          "sale_cancellations"."reason_code" IN ('customer_request', 'entry_error', 'payment_issue', 'other')
          AND (
            "sale_cancellations"."reason_note" IS NULL
            OR char_length(btrim("sale_cancellations"."reason_note")) BETWEEN 1 AND 500
          )
          AND ("sale_cancellations"."reason_code" <> 'other' OR "sale_cancellations"."reason_note" IS NOT NULL)
        )
      )
);
--> statement-breakpoint
ALTER TABLE "sale_cancellations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sale_cancellations" ADD CONSTRAINT "sale_cancellations_organization_sale_fk" FOREIGN KEY ("organization_id","sale_id") REFERENCES "public"."sales"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sale_cancellations_organization_sale_unique" ON "sale_cancellations" USING btree ("organization_id","sale_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sale_cancellations_organization_command_unique" ON "sale_cancellations" USING btree ("organization_id","command_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sale_cancellations_organization_id_id_unique" ON "sale_cancellations" USING btree ("organization_id","id");--> statement-breakpoint
CREATE POLICY "sale_cancellations_current_tenant_select" ON "sale_cancellations" AS PERMISSIVE FOR SELECT TO "polaris_pr11_runtime" USING (
  "sale_cancellations"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "sale_cancellations"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "sale_cancellations"."organization_id"
      AND organization_scope.status = 'active'
  )
);--> statement-breakpoint
CREATE POLICY "sale_cancellations_current_tenant_insert" ON "sale_cancellations" AS PERMISSIVE FOR INSERT TO "polaris_pr11_runtime" WITH CHECK (
        
  "sale_cancellations"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "sale_cancellations"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "sale_cancellations"."organization_id"
      AND organization_scope.status = 'active'
  )

        AND "sale_cancellations"."cancelled_by" = NULLIF(current_setting('app.user_id', true), '')
      );
--> statement-breakpoint
CREATE FUNCTION public.check_sale_cancellation_complete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_cancellation_id uuid;
  v_cancellation_command uuid;
  v_sale_id uuid;
  v_sale_command uuid;
  v_item_count integer;
  v_movements integer;
BEGIN
  IF TG_TABLE_NAME = 'stock_movements' THEN
    IF NEW.command_id IS NULL THEN
      RAISE EXCEPTION 'cancellation stock movement requires its cancellation command'
        USING ERRCODE = '23514', CONSTRAINT = 'stock_movements_sale_cancellation_requires_cancellation';
    END IF;
    SELECT cancellation.id, cancellation.command_id, cancellation.sale_id
    INTO v_cancellation_id, v_cancellation_command, v_sale_id
    FROM public.sale_cancellations AS cancellation
    WHERE cancellation.organization_id = NEW.organization_id
      AND cancellation.command_id = NEW.command_id;
    IF v_cancellation_id IS NULL THEN
      RAISE EXCEPTION 'cancellation stock movement has no sale cancellation'
        USING ERRCODE = '23514', CONSTRAINT = 'stock_movements_sale_cancellation_requires_cancellation';
    END IF;
  ELSE
    v_cancellation_id := NEW.id;
    v_cancellation_command := NEW.command_id;
    v_sale_id := NEW.sale_id;
  END IF;

  SELECT sale.command_id, sale.item_count
  INTO v_sale_command, v_item_count
  FROM public.sales AS sale
  WHERE sale.organization_id = NEW.organization_id
    AND sale.id = v_sale_id;
  IF NOT FOUND OR v_sale_command = v_cancellation_command THEN
    RAISE EXCEPTION 'cancellation needs its own command distinct from the sale command'
      USING ERRCODE = '23514', CONSTRAINT = 'sale_cancellations_command_distinct';
  END IF;

  SELECT count(*) INTO v_movements
  FROM public.stock_movements AS movement
  WHERE movement.organization_id = NEW.organization_id
    AND movement.command_id = v_cancellation_command;
  IF v_movements <> v_item_count OR EXISTS (
    SELECT 1
    FROM public.sale_items AS item
    WHERE item.organization_id = NEW.organization_id
      AND item.sale_id = v_sale_id
      AND NOT EXISTS (
        SELECT 1
        FROM public.stock_movements AS movement
        WHERE movement.organization_id = item.organization_id
          AND movement.command_id = v_cancellation_command
          AND movement.command_index = item.position
          AND movement.movement_type = 'sale_cancellation'
          AND movement.product_id = item.product_id
          AND movement.variant_id = item.variant_id
          AND movement.quantity_delta = item.quantity
          AND movement.unit_cost IS NOT DISTINCT FROM item.unit_cost
      )
  ) THEN
    RAISE EXCEPTION 'sale cancellation stock movements must invert every sale item'
      USING ERRCODE = '23514', CONSTRAINT = 'sale_cancellations_stock_complete';
  END IF;

  RETURN NULL;
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.check_sale_cancellation_complete() FROM PUBLIC;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER sale_cancellations_complete
AFTER INSERT ON public.sale_cancellations
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION public.check_sale_cancellation_complete();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER stock_movements_sale_cancellation_requires_cancellation
AFTER INSERT ON public.stock_movements
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (NEW.movement_type = 'sale_cancellation')
EXECUTE FUNCTION public.check_sale_cancellation_complete();--> statement-breakpoint
ALTER TABLE public.sale_cancellations FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE public.sale_cancellations FROM PUBLIC, polaris_pr11_runtime;
GRANT SELECT, INSERT ON TABLE public.sale_cancellations TO polaris_pr11_runtime;