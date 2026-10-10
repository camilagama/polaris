ALTER TABLE "stock_movements" ADD COLUMN "command_id" uuid;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN "command_index" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN "command_version" integer;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN "occurred_on" date;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN "unit_cost" numeric;--> statement-breakpoint
CREATE UNIQUE INDEX "stock_movements_command_unique" ON "stock_movements" USING btree ("organization_id","command_id","command_index");--> statement-breakpoint
ALTER TABLE "inventory_balances" ADD CONSTRAINT "inventory_balances_average_cost_allowed" CHECK (
        "inventory_balances"."moving_average_cost" IS NULL OR (
          "inventory_balances"."moving_average_cost" >= 0
          AND scale("inventory_balances"."moving_average_cost") <= 6
          AND "inventory_balances"."moving_average_cost" < 1000000000000000000
        )
      );--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_command_index_nonnegative" CHECK ("stock_movements"."command_index" >= 0);--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_command_metadata_complete" CHECK (
        (
          "stock_movements"."command_id" IS NULL
          AND "stock_movements"."command_version" IS NULL
          AND "stock_movements"."occurred_on" IS NULL
          AND "stock_movements"."command_index" = 0
        )
        OR (
          "stock_movements"."command_id" IS NOT NULL
          AND "stock_movements"."command_version" IS NOT NULL
          AND "stock_movements"."command_version" >= 1
          AND "stock_movements"."occurred_on" IS NOT NULL
        )
      );--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_unit_cost_allowed" CHECK (
        "stock_movements"."unit_cost" IS NULL OR (
          "stock_movements"."unit_cost" >= 0
          AND scale("stock_movements"."unit_cost") <= 6
          AND "stock_movements"."unit_cost" < 1000000000000000000
        )
      );