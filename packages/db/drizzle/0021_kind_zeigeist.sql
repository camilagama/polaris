ALTER TABLE "stock_movements" ADD COLUMN "reason_code" text;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD COLUMN "reason_note" text;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_write_off_reason_valid" CHECK (
        (
          "stock_movements"."movement_type" <> 'write_off'
          AND "stock_movements"."reason_code" IS NULL
          AND "stock_movements"."reason_note" IS NULL
        )
        OR (
          "stock_movements"."movement_type" = 'write_off'
          AND "stock_movements"."reason_code" IS NOT NULL
          AND "stock_movements"."reason_code" IN (
            'damaged', 'expired', 'lost', 'stolen', 'internal_use', 'other'
          )
          AND (
            "stock_movements"."reason_note" IS NULL
            OR (
              "stock_movements"."reason_note" = btrim(
                "stock_movements"."reason_note",

  ' ' || chr(9) || chr(10) || chr(11) || chr(12) || chr(13) ||
  chr(160) || chr(5760) ||
  chr(8192) || chr(8193) || chr(8194) || chr(8195) || chr(8196) ||
  chr(8197) || chr(8198) || chr(8199) || chr(8200) || chr(8201) ||
  chr(8202) || chr(8232) || chr(8233) || chr(8239) || chr(8287) ||
  chr(12288) || chr(65279)

              )
              AND btrim(
                "stock_movements"."reason_note",

  ' ' || chr(9) || chr(10) || chr(11) || chr(12) || chr(13) ||
  chr(160) || chr(5760) ||
  chr(8192) || chr(8193) || chr(8194) || chr(8195) || chr(8196) ||
  chr(8197) || chr(8198) || chr(8199) || chr(8200) || chr(8201) ||
  chr(8202) || chr(8232) || chr(8233) || chr(8239) || chr(8287) ||
  chr(12288) || chr(65279)

              ) <> ''
              AND char_length("stock_movements"."reason_note") <= 500
            )
          )
          AND (
            "stock_movements"."reason_code" <> 'other'
            OR "stock_movements"."reason_note" IS NOT NULL
          )
        )
      ) NOT VALID;
