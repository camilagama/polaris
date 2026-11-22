import { type SQL, sql } from "drizzle-orm";

/**
 * The rule of what a return gives back, in SQL, written once for the Resultado (`economics-repository`, every sale of
 * a period at a time) and for the customer summary (`customer-repository`, one sale at a time). Each returned item
 * gives back its charged price times the units returned minus its share of the sale's discounts: the discount is
 * split among the items by value in whole cents (largest remainder, ties by position) and the share of the returned
 * units is `round half up (allocation x returned / quantity)`. Surcharges, freight and the payment surcharge are never
 * given back.
 *
 * The fragments read the names of the statement they are placed in: `line` (`unit_cents`, `value_cents`, `position`,
 * `quantity`), `gross.cents`, `split` (the output of `discountSplitColumns`), `returned` (`quantity`) and
 * `allocation.cents`. The shape of each statement (one CTE over many sales, or a scalar subquery per sale) stays with
 * its repository.
 */

/** The cents of an item line, from the item's alias: the unit price and the price of all its units. */
export function itemCentsColumns(item: SQL) {
  return sql`${item}.charged_unit_price * 100 AS unit_cents,
        ${item}.charged_unit_price * ${item}.quantity * 100 AS value_cents`;
}

/**
 * The columns of the split of a sale's discount among its lines: the whole cents of each share (`floor_cents`), what
 * is left to hand out one cent at a time (`leftover`) and the order of the hand-out (`rank`). `partitionBy` is the key
 * of a statement that splits many sales at once; a statement over a single sale passes none.
 */
export function discountSplitColumns(discountCents: SQL, partitionBy?: SQL) {
  const partition = partitionBy ? sql`PARTITION BY ${partitionBy}` : sql``;
  return sql`div(${discountCents} * line.value_cents, gross.cents) AS floor_cents,
          ${discountCents}
            - sum(div(${discountCents} * line.value_cents, gross.cents))
            OVER (${partition}) AS leftover,
          row_number() OVER (
            ${partition}
            ORDER BY mod(${discountCents} * line.value_cents, gross.cents) DESC,
              line.position
          ) AS rank`;
}

/** The share of the discount of one line in whole cents, from `split` (the columns above). */
export const discountShareCents = sql`split.floor_cents
          + CASE WHEN split.rank <= split.leftover THEN 1 ELSE 0 END`;

/** What a returned item gives back in cents; a line the sale does not have is the caller's to refuse. */
export const givenBackCents = sql`returned.quantity * line.unit_cents
          - div(
              coalesce(allocation.cents, 0) * returned.quantity * 2 + line.quantity,
              line.quantity::numeric * 2
            )`;
