CREATE TABLE "sale_return_items" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"item_position" integer NOT NULL,
	"organization_id" text NOT NULL,
	"restocked_quantity" integer NOT NULL,
	"return_id" uuid NOT NULL,
	"returned_quantity" integer NOT NULL,
	"sale_id" uuid NOT NULL,
	CONSTRAINT "sale_return_items_position_nonnegative" CHECK ("sale_return_items"."item_position" >= 0),
	CONSTRAINT "sale_return_items_returned_positive" CHECK ("sale_return_items"."returned_quantity" >= 1),
	CONSTRAINT "sale_return_items_restocked_within_returned" CHECK ("sale_return_items"."restocked_quantity" >= 0 AND "sale_return_items"."restocked_quantity" <= "sale_return_items"."returned_quantity")
);
--> statement-breakpoint
ALTER TABLE "sale_return_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sale_returns" (
	"command_id" uuid NOT NULL,
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"organization_id" text NOT NULL,
	"reason_code" text,
	"reason_note" text,
	"returned_at" timestamp DEFAULT now() NOT NULL,
	"returned_by" text NOT NULL,
	"sale_id" uuid NOT NULL,
	CONSTRAINT "sale_returns_returned_by_not_blank" CHECK (char_length(btrim("sale_returns"."returned_by")) BETWEEN 1 AND 255),
	CONSTRAINT "sale_returns_reason_valid" CHECK (
        ("sale_returns"."reason_code" IS NULL AND "sale_returns"."reason_note" IS NULL)
        OR (
          "sale_returns"."reason_code" IN ('customer_request', 'defective', 'wrong_item', 'other')
          AND (
            "sale_returns"."reason_note" IS NULL
            OR char_length(btrim("sale_returns"."reason_note")) BETWEEN 1 AND 500
          )
          AND ("sale_returns"."reason_code" <> 'other' OR "sale_returns"."reason_note" IS NOT NULL)
        )
      )
);
--> statement-breakpoint
ALTER TABLE "sale_returns" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX "sale_returns_organization_id_id_sale_unique" ON "sale_returns" USING btree ("organization_id","id","sale_id");--> statement-breakpoint
ALTER TABLE "sale_return_items" ADD CONSTRAINT "sale_return_items_organization_return_sale_fk" FOREIGN KEY ("organization_id","return_id","sale_id") REFERENCES "public"."sale_returns"("organization_id","id","sale_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_return_items" ADD CONSTRAINT "sale_return_items_organization_sale_item_fk" FOREIGN KEY ("organization_id","sale_id","item_position") REFERENCES "public"."sale_items"("organization_id","sale_id","position") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_returns" ADD CONSTRAINT "sale_returns_organization_sale_fk" FOREIGN KEY ("organization_id","sale_id") REFERENCES "public"."sales"("organization_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sale_return_items_organization_return_position_unique" ON "sale_return_items" USING btree ("organization_id","return_id","item_position");--> statement-breakpoint
CREATE INDEX "sale_return_items_organization_sale_position_idx" ON "sale_return_items" USING btree ("organization_id","sale_id","item_position");--> statement-breakpoint
CREATE UNIQUE INDEX "sale_returns_organization_command_unique" ON "sale_returns" USING btree ("organization_id","command_id");--> statement-breakpoint
CREATE INDEX "sale_returns_organization_sale_idx" ON "sale_returns" USING btree ("organization_id","sale_id","returned_at");--> statement-breakpoint
CREATE POLICY "sale_return_items_current_tenant_select" ON "sale_return_items" AS PERMISSIVE FOR SELECT TO "polaris_pr11_runtime" USING (
  "sale_return_items"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "sale_return_items"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "sale_return_items"."organization_id"
      AND organization_scope.status = 'active'
  )
);--> statement-breakpoint
CREATE POLICY "sale_return_items_current_tenant_insert" ON "sale_return_items" AS PERMISSIVE FOR INSERT TO "polaris_pr11_runtime" WITH CHECK (
  "sale_return_items"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "sale_return_items"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "sale_return_items"."organization_id"
      AND organization_scope.status = 'active'
  )
);--> statement-breakpoint
CREATE POLICY "sale_returns_current_tenant_select" ON "sale_returns" AS PERMISSIVE FOR SELECT TO "polaris_pr11_runtime" USING (
  "sale_returns"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "sale_returns"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "sale_returns"."organization_id"
      AND organization_scope.status = 'active'
  )
);--> statement-breakpoint
CREATE POLICY "sale_returns_current_tenant_insert" ON "sale_returns" AS PERMISSIVE FOR INSERT TO "polaris_pr11_runtime" WITH CHECK (
        
  "sale_returns"."organization_id" = NULLIF(current_setting('app.organization_id', true), '')
  AND EXISTS (
    SELECT 1
    FROM public.memberships AS membership_scope
    WHERE membership_scope.organization_id = "sale_returns"."organization_id"
      AND membership_scope.user_id = NULLIF(current_setting('app.user_id', true), '')
      AND membership_scope.status = 'active'
  )
  AND EXISTS (
    SELECT 1
    FROM public.organizations AS organization_scope
    WHERE organization_scope.id = "sale_returns"."organization_id"
      AND organization_scope.status = 'active'
  )

        AND "sale_returns"."returned_by" = NULLIF(current_setting('app.user_id', true), '')
      );

--> statement-breakpoint
CREATE FUNCTION public.check_sale_return_complete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_return_id uuid;
  v_return_command uuid;
  v_sale_id uuid;
  v_sale_command uuid;
  v_lines integer;
  v_restock_lines integer;
  v_movements integer;
BEGIN
  IF TG_TABLE_NAME = 'stock_movements' THEN
    IF NEW.command_id IS NULL THEN
      RAISE EXCEPTION 'return stock movement requires its return command'
        USING ERRCODE = '23514', CONSTRAINT = 'stock_movements_sale_return_requires_return';
    END IF;
    SELECT sale_return.id, sale_return.command_id, sale_return.sale_id
    INTO v_return_id, v_return_command, v_sale_id
    FROM public.sale_returns AS sale_return
    WHERE sale_return.organization_id = NEW.organization_id
      AND sale_return.command_id = NEW.command_id;
    IF v_return_id IS NULL THEN
      RAISE EXCEPTION 'return stock movement has no sale return'
        USING ERRCODE = '23514', CONSTRAINT = 'stock_movements_sale_return_requires_return';
    END IF;
  ELSIF TG_TABLE_NAME = 'sale_returns' THEN
    v_return_id := NEW.id;
    v_return_command := NEW.command_id;
    v_sale_id := NEW.sale_id;
  ELSE
    SELECT sale_return.command_id, sale_return.sale_id
    INTO v_return_command, v_sale_id
    FROM public.sale_returns AS sale_return
    WHERE sale_return.organization_id = NEW.organization_id
      AND sale_return.id = NEW.return_id;
    v_return_id := NEW.return_id;
  END IF;

  -- Serialize with the application-level compensation lock (same key) so the
  -- checks below also hold for writers that skip the repository.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('polaris.sale.compensation:' || v_sale_id::text, 0)
  );

  SELECT sale.command_id INTO v_sale_command
  FROM public.sales AS sale
  WHERE sale.organization_id = NEW.organization_id
    AND sale.id = v_sale_id;
  IF NOT FOUND OR v_sale_command = v_return_command THEN
    RAISE EXCEPTION 'return needs its own command distinct from the sale command'
      USING ERRCODE = '23514', CONSTRAINT = 'sale_returns_command_distinct';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.sale_cancellations AS cancellation
    WHERE cancellation.organization_id = NEW.organization_id
      AND cancellation.sale_id = v_sale_id
  ) THEN
    RAISE EXCEPTION 'a cancelled sale cannot have returns'
      USING ERRCODE = '23514', CONSTRAINT = 'sale_returns_sale_not_cancelled';
  END IF;

  SELECT count(*), count(*) FILTER (WHERE return_item.restocked_quantity > 0)
  INTO v_lines, v_restock_lines
  FROM public.sale_return_items AS return_item
  WHERE return_item.organization_id = NEW.organization_id
    AND return_item.return_id = v_return_id;
  IF v_lines = 0 THEN
    RAISE EXCEPTION 'a return needs at least one line'
      USING ERRCODE = '23514', CONSTRAINT = 'sale_returns_items_complete';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.sale_items AS item
    WHERE item.organization_id = NEW.organization_id
      AND item.sale_id = v_sale_id
      AND item.quantity < (
        SELECT COALESCE(sum(return_item.returned_quantity), 0)
        FROM public.sale_return_items AS return_item
        WHERE return_item.organization_id = item.organization_id
          AND return_item.sale_id = item.sale_id
          AND return_item.item_position = item.position
      )
  ) THEN
    RAISE EXCEPTION 'returned quantity cannot exceed the quantity sold'
      USING ERRCODE = '23514', CONSTRAINT = 'sale_returns_quantity_valid';
  END IF;

  SELECT count(*) INTO v_movements
  FROM public.stock_movements AS movement
  WHERE movement.organization_id = NEW.organization_id
    AND movement.command_id = v_return_command;
  IF v_movements <> v_restock_lines OR EXISTS (
    SELECT 1
    FROM public.sale_return_items AS return_item
    JOIN public.sale_items AS item
      ON item.organization_id = return_item.organization_id
     AND item.sale_id = return_item.sale_id
     AND item.position = return_item.item_position
    WHERE return_item.organization_id = NEW.organization_id
      AND return_item.return_id = v_return_id
      AND return_item.restocked_quantity > 0
      AND NOT EXISTS (
        SELECT 1
        FROM public.stock_movements AS movement
        WHERE movement.organization_id = return_item.organization_id
          AND movement.command_id = v_return_command
          AND movement.command_index = return_item.item_position
          AND movement.movement_type = 'sale_return'
          AND movement.product_id = item.product_id
          AND movement.variant_id = item.variant_id
          AND movement.quantity_delta = return_item.restocked_quantity
          AND movement.unit_cost IS NOT DISTINCT FROM item.unit_cost
      )
  ) THEN
    RAISE EXCEPTION 'return stock movements must match the restocked quantities'
      USING ERRCODE = '23514', CONSTRAINT = 'sale_returns_stock_complete';
  END IF;

  RETURN NULL;
END;
$function$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.check_sale_return_complete() FROM PUBLIC;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER sale_returns_complete
AFTER INSERT ON public.sale_returns
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION public.check_sale_return_complete();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER sale_return_items_complete
AFTER INSERT ON public.sale_return_items
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION public.check_sale_return_complete();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER stock_movements_sale_return_requires_return
AFTER INSERT ON public.stock_movements
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
WHEN (NEW.movement_type = 'sale_return')
EXECUTE FUNCTION public.check_sale_return_complete();--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.check_sale_cancellation_complete()
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

  -- Serialize with the application-level compensation lock (same key) so the
  -- checks below also hold for writers that skip the repository.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('polaris.sale.compensation:' || v_sale_id::text, 0)
  );

  SELECT sale.command_id, sale.item_count
  INTO v_sale_command, v_item_count
  FROM public.sales AS sale
  WHERE sale.organization_id = NEW.organization_id
    AND sale.id = v_sale_id;
  IF NOT FOUND OR v_sale_command = v_cancellation_command THEN
    RAISE EXCEPTION 'cancellation needs its own command distinct from the sale command'
      USING ERRCODE = '23514', CONSTRAINT = 'sale_cancellations_command_distinct';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.sale_returns AS sale_return
    WHERE sale_return.organization_id = NEW.organization_id
      AND sale_return.sale_id = v_sale_id
  ) THEN
    RAISE EXCEPTION 'a sale with returns cannot be cancelled as a whole'
      USING ERRCODE = '23514', CONSTRAINT = 'sale_cancellations_sale_has_no_returns';
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
ALTER TABLE public.sale_returns FORCE ROW LEVEL SECURITY;
ALTER TABLE public.sale_return_items FORCE ROW LEVEL SECURITY;--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE public.sale_returns, public.sale_return_items FROM PUBLIC, polaris_pr11_runtime;
GRANT SELECT, INSERT ON TABLE public.sale_returns, public.sale_return_items TO polaris_pr11_runtime;