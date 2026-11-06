import { Money } from "@polaris/domain/money/money";

/**
 * The exact sum of amounts as the server writes them ("219.90"), in centavos with no float; null when one of them
 * is not a BRL amount, so a screen shows a dash instead of a wrong total.
 */
export function sumBrlAmounts(values: readonly string[]): string | null {
  try {
    let total = Money.fromMinorUnits(0n);
    for (const value of values) {
      total = total.add(Money.from(value));
    }
    return total.toString();
  } catch {
    return null;
  }
}
