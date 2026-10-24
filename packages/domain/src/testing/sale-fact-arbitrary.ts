import fc from "fast-check";
import type { SaleFact } from "../economics/sale-economics";
import { Money } from "../money/money";

/**
 * Valid sale facts for the economics properties: items with a known or
 * unknown cost, a discount no larger than the subtotal, freight, returns of
 * part of each item (some restocked) and fees that may be unknown.
 */
export const price = fc
  .integer({ max: 100_000, min: 1 })
  .map((cents) => Money.fromMinorUnits(BigInt(cents)).toString());
const cost = fc.option(
  fc.integer({ max: 50_000_000, min: 0 }).map((micros) => {
    const text = micros.toString().padStart(7, "0");
    return `${text.slice(0, -6)}.${text.slice(-6)}`;
  }),
  { nil: null }
);
const fee = fc.option(
  fc
    .integer({ max: 5000, min: 0 })
    .map((cents) => Money.fromMinorUnits(BigInt(cents)).toString()),
  { nil: null }
);

export const saleArbitrary: fc.Arbitrary<SaleFact> = fc
  .record({
    anticipation: fee,
    cancelled: fc.boolean(),
    discountCents: fc.integer({ max: 3000, min: 0 }),
    freightCents: fc.integer({ max: 3000, min: 0 }),
    itemSpecs: fc.array(
      fc.record({
        cost,
        price,
        quantity: fc.integer({ max: 6, min: 1 }),
        restock: fc.double({ max: 1, min: 0, noNaN: true }),
        returned: fc.double({ max: 1, min: 0, noNaN: true }),
      }),
      { maxLength: 5, minLength: 1 }
    ),
    linked: fc.array(price, { maxLength: 3 }),
    processing: fee,
  })
  .map((spec) => {
    const items = spec.itemSpecs.map((item, position) => ({
      chargedUnitPrice: item.price,
      position,
      quantity: item.quantity,
      unitCost: item.cost,
    }));
    const subtotal = items.reduce(
      (total, item) =>
        total +
        BigInt(Math.round(Number(item.chargedUnitPrice) * 100)) *
          BigInt(item.quantity),
      0n
    );
    const discount =
      BigInt(spec.discountCents) > subtotal
        ? subtotal
        : BigInt(spec.discountCents);
    return {
      adjustments: [
        {
          amount: Money.fromMinorUnits(discount).toString(),
          kind: "discount" as const,
        },
        {
          amount: Money.fromMinorUnits(BigInt(spec.freightCents)).toString(),
          kind: "freight" as const,
        },
      ],
      anticipationFee: spec.anticipation,
      cancelled: spec.cancelled,
      items,
      linkedExpenses: spec.linked,
      processingFee: spec.processing,
      returnLines: spec.itemSpecs
        .map((item, position) => {
          const returnedQuantity = Math.floor(item.returned * item.quantity);
          return {
            itemPosition: position,
            restockedQuantity: Math.floor(item.restock * returnedQuantity),
            returnedQuantity,
          };
        })
        .filter((line) => line.returnedQuantity > 0),
    };
  });
