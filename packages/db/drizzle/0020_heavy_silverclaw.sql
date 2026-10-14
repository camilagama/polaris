ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_receipt_cost_and_command_required" CHECK (
        "stock_movements"."movement_type" <> 'receipt'
        OR (
          "stock_movements"."unit_cost" IS NOT NULL
          AND "stock_movements"."command_id" IS NOT NULL
        )
      ) NOT VALID;
