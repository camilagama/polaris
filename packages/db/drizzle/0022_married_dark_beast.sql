ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_quantity_delta_nonzero";--> statement-breakpoint
ALTER TABLE "stock_movements" DROP CONSTRAINT "stock_movements_type_direction";--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN "expected_version" integer;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN "physical_quantity" integer;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN "valuation_unit_cost" numeric;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_inventory_count_payload_valid" CHECK (
        (
          "stock_movements"."movement_type" = 'inventory_count'
          AND "stock_movements"."command_id" IS NOT NULL
          AND "stock_movements"."command_version" IS NOT NULL
          AND "stock_movements"."occurred_on" IS NOT NULL
          AND "stock_movements"."expected_version" IS NOT NULL
          AND "stock_movements"."expected_version" >= 0
          AND "stock_movements"."physical_quantity" IS NOT NULL
          AND "stock_movements"."physical_quantity" >= 0
          AND (
            "stock_movements"."valuation_unit_cost" IS NULL
            OR "stock_movements"."physical_quantity" > 0
          )
        )
        OR (
          "stock_movements"."movement_type" <> 'inventory_count'
          AND "stock_movements"."expected_version" IS NULL
          AND "stock_movements"."physical_quantity" IS NULL
          AND "stock_movements"."valuation_unit_cost" IS NULL
        )
      ) NOT VALID;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_valuation_unit_cost_allowed" CHECK (
        "stock_movements"."valuation_unit_cost" IS NULL OR (
          "stock_movements"."valuation_unit_cost" >= 0
          AND scale("stock_movements"."valuation_unit_cost") <= 6
          AND "stock_movements"."valuation_unit_cost" < 1000000000000000000
        )
      ) NOT VALID;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_quantity_delta_nonzero" CHECK ("stock_movements"."quantity_delta" <> 0 OR "stock_movements"."movement_type" = 'inventory_count');--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_type_direction" CHECK (
        ("stock_movements"."movement_type" = 'receipt' AND "stock_movements"."quantity_delta" > 0)
        OR ("stock_movements"."movement_type" = 'write_off' AND "stock_movements"."quantity_delta" < 0)
        OR ("stock_movements"."movement_type" = 'inventory_count')
        OR ("stock_movements"."movement_type" = 'sale' AND "stock_movements"."quantity_delta" < 0)
        OR ("stock_movements"."movement_type" = 'sale_cancellation' AND "stock_movements"."quantity_delta" > 0)
        OR ("stock_movements"."movement_type" = 'sale_return' AND "stock_movements"."quantity_delta" > 0)
      );
