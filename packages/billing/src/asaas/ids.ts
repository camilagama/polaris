/**
 * The shapes of the IDs Polaris accepts from Asaas. An ID named in a webhook
 * body goes into a request path, so it is checked against its shape first and
 * then encoded (`encodeURIComponent`): a forged `../` or `?` never reaches the URL.
 */

const asaasIdPattern = /^(pay|sub)_[A-Za-z\d]{1,64}$/;
/** `evt_<hex>&<digits>` in the documentation; kept loose but bounded (the column holds 160). */
const asaasEventIdPattern = /^evt_[A-Za-z\d&_-]{1,150}$/;
/**
 * The opaque reference Polaris still sends in the checkout's `externalReference`.
 * The provider does not carry it to the subscription (S1.3), so no fact depends on it.
 */
const polarisReferencePattern =
  /^pol_[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/;

export function isAsaasId(prefix: "pay" | "sub", value: unknown): boolean {
  return (
    typeof value === "string" &&
    asaasIdPattern.test(value) &&
    value.startsWith(`${prefix}_`)
  );
}

export function isAsaasEventId(value: unknown): value is string {
  return typeof value === "string" && asaasEventIdPattern.test(value);
}

/** The ID of a hosted checkout, which Asaas also writes in `checkoutSession` of its subscription and charges. */
const checkoutIdPattern =
  /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;

/** A checkout ID, lowercase (Asaas writes it so; the comparison never depends on case). */
export function normalizeCheckoutId(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const lower = value.toLowerCase();
  return checkoutIdPattern.test(lower) ? lower : null;
}

function isPolarisReference(value: unknown): value is string {
  return typeof value === "string" && polarisReferencePattern.test(value);
}

export function newPolarisReference(uuid: string): string {
  const reference = `pol_${uuid.toLowerCase()}`;
  if (!isPolarisReference(reference)) {
    throw new TypeError("invalid_reference_uuid");
  }
  return reference;
}
