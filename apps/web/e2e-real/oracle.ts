const TWO_PLACE_NUMERIC = /^(-)?(\d+)(?:\.(\d{1,2})0*)?$/;
const BRL_DIGITS = /^(\d{1,3}(?:\.\d{3})*|\d+)(?:[,.](\d{1,2}))?$/;
const MINUS_SIGN = /[-−]/;
/**
 * The oracle of the journeys (T-125a), written by hand with integers: it does NOT import `Money` nor
 * packages/domain, so a defect there cannot hide behind the same code on both sides. Rule source:
 * docs/business-rules/money.md (each percentage adjustment uses the negotiated subtotal as the same base and
 * rounds half-up once to cents; percentages do not compose).
 */

/** "R$ 1.234,56", "1234,56", "1234.56" or "-R$ 0,10" → integer cents. */
export function cents(text: string): number {
  const negative = MINUS_SIGN.test(text);
  const digits = text.replace(/[^\d,.]/g, "");
  const match = BRL_DIGITS.exec(digits);
  if (!match) {
    throw new Error(`Not a money value: ${text}`);
  }
  const whole = Number((match[1] as string).replaceAll(".", ""));
  const fraction = Number(`${match[2] ?? "0"}0`.slice(0, 2));
  const value = whole * 100 + fraction;
  return negative ? -value : value;
}

/** PostgreSQL `numeric` read as text ("12.30", "0.1", "15") → integer cents; refuses more than two places. */
export function numericCents(value: string): number {
  const match = TWO_PLACE_NUMERIC.exec(value);
  if (!match) {
    throw new Error(`Not a two-place numeric: ${value}`);
  }
  const result =
    Number(match[2]) * 100 + Number(`${match[3] ?? "0"}0`.slice(0, 2));
  return match[1] ? -result : result;
}

/**
 * `base × percent / 100` rounded half-up to cents (ties away from zero), with the percentage as text
 * ("10", "2.5", "12,345678"): integers only.
 */
export function percentOfCents(baseCents: number, percent: string): number {
  const [whole = "0", fraction = ""] = percent.replace(",", ".").split(".");
  const scale = 10 ** fraction.length;
  const numerator =
    BigInt(baseCents) * BigInt(Number(whole) * scale + Number(fraction || "0"));
  const denominator = BigInt(100 * scale);
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return Number(remainder * 2n >= denominator ? quotient + 1n : quotient);
}

export interface SaleLine {
  quantity: number;
  chargedCents: number;
}

/** Subtotal, each percentage discount rounded once on the same base, and the total due. */
export function saleTotals(lines: SaleLine[], discountPercents: string[]) {
  const subtotal = lines.reduce(
    (sum, line) => sum + line.quantity * line.chargedCents,
    0
  );
  const discounts = discountPercents.map((percent) =>
    percentOfCents(subtotal, percent)
  );
  const discount = discounts.reduce((sum, value) => sum + value, 0);
  return { discount, discounts, subtotal, total: subtotal - discount };
}

/** Text for a money input of the app ("12,34"). */
export function moneyInput(valueCents: number): string {
  return `${Math.trunc(valueCents / 100)},${String(valueCents % 100).padStart(2, "0")}`;
}
