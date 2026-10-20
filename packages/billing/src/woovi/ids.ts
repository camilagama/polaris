/**
 * The shapes of the IDs Polaris accepts from Woovi. A `globalID` is base64 of
 * `<Type>:<24 hex>` (a MongoDB ObjectId); it is checked by decoding it, so only
 * a subscription's ID reaches a subscription path and only an installment's an
 * installment path. An ID named in a webhook body goes into a request path, so
 * it is checked first and then encoded (`encodeURIComponent`): a forged `../`
 * or `?` never reaches the URL. `+`, `/` and `=` of base64 are encoded too
 * (sandbox, 20/10/2026: the API reads the encoded ID).
 */

export type WooviGlobalIdKind = "installment" | "subscription";

const TYPE_NAMES: Readonly<Record<WooviGlobalIdKind, string>> = {
  installment: "PaymentSubscriptionInstallment",
  subscription: "PaymentSubscription",
};
const base64Pattern = /^[A-Za-z\d+/]{8,120}={0,2}$/;
const objectIdPattern = /^[\da-f]{24}$/;

function decoded(value: string): string | null {
  try {
    return atob(value);
  } catch {
    return null;
  }
}

/** True when `value` is the `globalID` of a Woovi resource of that kind. */
export function isWooviGlobalId(
  kind: WooviGlobalIdKind,
  value: unknown
): value is string {
  if (
    typeof value !== "string" ||
    !base64Pattern.test(value) ||
    value.length % 4 !== 0
  ) {
    return false;
  }
  const text = decoded(value);
  if (text === null) {
    return false;
  }
  const separator = text.indexOf(":");
  return (
    separator > 0 &&
    text.slice(0, separator) === TYPE_NAMES[kind] &&
    objectIdPattern.test(text.slice(separator + 1)) &&
    // the canonical encoding only: one resource, one spelling of its ID
    btoa(text) === value
  );
}

/**
 * The `globalID` as it goes to a log: decoded (`PaymentSubscription:<24 hex>`).
 * Its base64 form looks like a token to the log's redaction and would be
 * masked, leaving nothing to find the resource by. An ID of another shape gives
 * only its kind.
 */
export function wooviLogId(kind: WooviGlobalIdKind, value: string): string {
  return isWooviGlobalId(kind, value)
    ? (decoded(value) ?? TYPE_NAMES[kind])
    : `${TYPE_NAMES[kind]}:?`;
}

/** A Woovi customer's `correlationID`: the key of `PATCH /api/v1/customer/{id}`. */
const customerCorrelationIdPattern = /^[A-Za-z\d_.:-]{1,100}$/;

const dotsOnly = /^\.+$/;

export function isWooviCustomerCorrelationId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    customerCorrelationIdPattern.test(value) &&
    // `.` and `..` survive `encodeURIComponent` and would be read as a path step
    !dotsOnly.test(value)
  );
}

const digitsOnly = /^\d+$/;

/** A CPF (11 digits) or a CNPJ (14 digits), digits only, as Woovi takes it. */
export function isTaxIdDigits(value: unknown): value is string {
  return (
    typeof value === "string" &&
    digitsOnly.test(value) &&
    (value.length === 11 || value.length === 14)
  );
}
