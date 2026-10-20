import { ProviderResponseMalformedError } from "../provider-port";
import type { WooviClient } from "./client";
import { isTaxIdDigits, isWooviCustomerCorrelationId } from "./ids";

/**
 * The payer's record at Woovi, aligned before a Pix Automático subscription is
 * created (ADR 0101, emenda Woovi; LGPD art. 6º, V). Woovi keeps one customer
 * per CPF or CNPJ in Polaris's account and reuses it: a subscription created
 * with another name or e-mail for the same CPF keeps the ones stored first
 * (sandbox, 20/10/2026), and the name is what the payer's bank shows. So the
 * customer is looked up by the tax ID first and, when the name or the e-mail
 * differ from what the payer just typed, they are updated; a customer that does
 * not take the update is refused. Nothing of the customer is returned or kept.
 */

export interface WooviPayer {
  email: string;
  name: string;
  /** CPF (11 digits) or CNPJ (14 digits), digits only. */
  taxId: string;
}

/** The customer Woovi holds for this tax ID would not take the payer's name and e-mail. */
export class WooviCustomerMismatchError extends Error {
  readonly code = "payer_data_mismatch";

  constructor() {
    super("payer_data_mismatch");
    this.name = "WooviCustomerMismatchError";
  }
}

const spaces = /\s+/g;

function sameName(left: string, right: string): boolean {
  const normal = (value: string) =>
    value.normalize("NFC").replace(spaces, " ").trim();
  return normal(left) === normal(right);
}

function sameEmail(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

/** The two fields compared and the key to update by; the rest of the customer is not read. */
function pickCustomer(raw: unknown): {
  correlationId: string;
  email: string;
  name: string;
} {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ProviderResponseMalformedError();
  }
  const { correlationID, email, name } = raw as Record<string, unknown>;
  if (
    typeof name !== "string" ||
    !(email === undefined || email === null || typeof email === "string") ||
    !isWooviCustomerCorrelationId(correlationID)
  ) {
    throw new ProviderResponseMalformedError();
  }
  return { correlationId: correlationID, email: email ?? "", name };
}

function matches(
  customer: { email: string; name: string },
  payer: WooviPayer
): boolean {
  return (
    sameName(customer.name, payer.name) &&
    sameEmail(customer.email, payer.email)
  );
}

/**
 * `absent`: Woovi has no customer with this tax ID (the subscription creates
 * it with the payer's data). `matches`: it has one with the same name and
 * e-mail. `updated`: it had other ones and now has the payer's. Throws
 * `WooviCustomerMismatchError` when the update does not hold, and the client's
 * errors as they come (a refused update is a `ProviderRejectedError`).
 */
export async function alignWooviCustomer(
  client: WooviClient,
  payer: WooviPayer
): Promise<"absent" | "matches" | "updated"> {
  if (
    !isTaxIdDigits(payer.taxId) ||
    payer.name.trim().length === 0 ||
    payer.email.trim().length === 0
  ) {
    throw new TypeError("invalid_payer");
  }
  const found = await client.findCustomerByTaxId(payer.taxId);
  if (found === null) {
    return "absent";
  }
  const customer = pickCustomer(found);
  if (matches(customer, payer)) {
    return "matches";
  }
  const updated = pickCustomer(
    await client.updateCustomer(customer.correlationId, {
      email: payer.email.trim(),
      name: payer.name.trim(),
    })
  );
  if (!matches(updated, payer)) {
    throw new WooviCustomerMismatchError();
  }
  return "updated";
}
