import { Money } from "@polaris/domain/money/money";
import { ProviderResponseMalformedError } from "./provider-port";

/**
 * JSON with exact numbers (money.md). Asaas writes amounts as JSON numbers
 * (`49.9`); `JSON.parse` would turn them into binary floating point. Here every
 * number keeps the text it was written with, read through the reviver's
 * `context.source` (ES2025 JSON.parse source text access, in V8 and in workerd),
 * and an amount sent to the provider is written from its decimal text, never
 * from a `number`.
 */

/** A JSON number as the provider wrote it. */
export class JsonNumber {
  readonly source: string;

  constructor(source: string) {
    this.source = source;
  }
}

interface ReviverContext {
  source?: string;
}

/** Parses provider JSON; a number comes back as a `JsonNumber`. Throws `ProviderResponseMalformedError`. */
export function parseProviderJson(text: string): unknown {
  try {
    return JSON.parse(
      text,
      (_key: string, value: unknown, context?: ReviverContext) => {
        if (typeof value !== "number") {
          return value;
        }
        if (typeof context?.source !== "string") {
          // a runtime without source text access would silently round an amount
          throw new Error("json_source_text_unavailable");
        }
        return new JsonNumber(context.source);
      }
    );
  } catch {
    // biome-ignore lint/style/useErrorCause: The cause would carry the provider's text.
    throw new ProviderResponseMalformedError();
  }
}

/** The amount of a provider number, normalized as `money.md` writes it (`"49.90"`), or null. */
export function moneyFromJsonNumber(value: unknown): string | null {
  if (!(value instanceof JsonNumber)) {
    return null;
  }
  try {
    return Money.from(value.source).toString();
  } catch {
    return null;
  }
}

/** Stands for the amount in a request body until it is written out by `stringifyWithAmount`. */
export const AMOUNT_PLACEHOLDER = "\u0000polaris-amount\u0000";

/**
 * Serializes a request body whose one `AMOUNT_PLACEHOLDER` must go out as a
 * JSON number: the positive decimal text of `amount` is written as is (Asaas,
 * `"24.90"` → `24.90`), or as integer cents with `unit: "cents"` (Woovi,
 * `"24.90"` → `2490`). Never through `number`.
 */
export function stringifyWithAmount(
  body: Record<string, unknown>,
  amount: string,
  unit: "cents" | "decimal" = "decimal"
): string {
  const money = Money.from(amount);
  if (money.minorUnits <= 0n) {
    throw new RangeError("amount_not_positive");
  }
  const text = JSON.stringify(body);
  const quoted = JSON.stringify(AMOUNT_PLACEHOLDER);
  if (text.split(quoted).length !== 2) {
    throw new Error("amount_placeholder_misplaced");
  }
  return text.replace(
    quoted,
    unit === "cents" ? money.minorUnits.toString() : money.toString()
  );
}
