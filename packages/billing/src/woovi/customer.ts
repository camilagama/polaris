import {
  ProviderRejectedError,
  ProviderResponseMalformedError,
} from "../provider-port";
import type { WooviClient } from "./client";
import { isTaxIdDigits, isWooviPayerCorrelationId } from "./ids";

/**
 * The payer's record at Woovi, checked before a Pix Automático subscription is
 * created (ADR 0101, emenda do PR 6; LGPD art. 6º, V). Woovi keeps one
 * customer per CPF or CNPJ in Polaris's account and reuses it: a subscription
 * created with another name or e-mail for the same CPF keeps the ones stored
 * first (sandbox), and the name is what the payer's bank shows.
 * Polaris creates the customer under its own key (`correlationID`, an HMAC of
 * the document) and reads it back by that key, one request, never a list of
 * the account. A customer whose name or e-mail differ from what the payer just
 * typed (beyond case, composition and extra spaces; an e-mail beyond case and
 * trim: Woovi's notices go to the e-mail stored) is refused, never updated: support sorts it out by hand. Nothing of
 * the customer is returned or kept.
 */

export interface WooviPayer {
  /** The customer's key at Woovi: `polaris-payer-` and 32 hex digits of an HMAC of the document. */
  correlationId: string;
  email: string;
  name: string;
  /** CPF (11 digits) or CNPJ (14 digits), digits only. */
  taxId: string;
}

/**
 * The customer Woovi holds for this payer has another name or e-mail, or could
 * not be created. The caller answers it as one generic refusal, never saying
 * which or why.
 */
export class WooviCustomerMismatchError extends Error {
  readonly code = "payer_data_mismatch";

  constructor(options?: ErrorOptions) {
    super("payer_data_mismatch", options);
    this.name = "WooviCustomerMismatchError";
  }
}

const spaces = /\s+/g;

/** Same name up to case, composition (NFC) and extra spaces: it is the payer's own name, typed twice. */
function sameName(left: string, right: string): boolean {
  const normal = (value: string) =>
    value
      .normalize("NFC")
      .replace(spaces, " ")
      .trim()
      .toLocaleLowerCase("pt-BR");
  return normal(left) === normal(right);
}

function sameEmail(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

/** The fields compared; the rest of the customer is not read. */
function pickCustomer(raw: unknown): {
  correlationId: string;
  email: string;
  name: string;
  taxId: string;
} {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ProviderResponseMalformedError();
  }
  const { correlationID, email, name, taxID } = raw as Record<string, unknown>;
  const taxId =
    typeof taxID === "object" && taxID !== null
      ? (taxID as Record<string, unknown>).taxID
      : taxID;
  if (
    typeof name !== "string" ||
    !(email === undefined || email === null || typeof email === "string") ||
    typeof correlationID !== "string" ||
    typeof taxId !== "string"
  ) {
    throw new ProviderResponseMalformedError();
  }
  return { correlationId: correlationID, email: email ?? "", name, taxId };
}

/** Same key, same document, same name and e-mail. */
function matches(
  customer: ReturnType<typeof pickCustomer>,
  payer: WooviPayer
): boolean {
  return (
    customer.correlationId === payer.correlationId &&
    customer.taxId === payer.taxId &&
    sameName(customer.name, payer.name) &&
    sameEmail(customer.email, payer.email)
  );
}

/**
 * `matches`: Woovi has the customer under this key, with the payer's document,
 * name and e-mail (one read). `created`: it had none and now has one with the
 * payer's data (one read and one creation). Throws `WooviCustomerMismatchError`
 * when the customer differs in anything, or when Woovi refuses to create it
 * with a 400 (the document already has a customer under another key, or Woovi
 * does not take the data); the other errors as they come.
 */
export async function alignWooviCustomer(
  client: WooviClient,
  payer: WooviPayer
): Promise<"created" | "matches"> {
  if (
    !(
      isTaxIdDigits(payer.taxId) &&
      isWooviPayerCorrelationId(payer.correlationId)
    ) ||
    payer.name.trim().length === 0 ||
    payer.email.trim().length === 0
  ) {
    throw new TypeError("invalid_payer");
  }
  const found = await client.getCustomer(payer.correlationId);
  if (found !== null) {
    if (!matches(pickCustomer(found), payer)) {
      throw new WooviCustomerMismatchError();
    }
    return "matches";
  }
  let created: ReturnType<typeof pickCustomer>;
  try {
    created = pickCustomer(
      await client.createCustomer({
        correlationId: payer.correlationId,
        email: payer.email.trim(),
        name: payer.name.trim(),
        taxId: payer.taxId,
      })
    );
  } catch (error: unknown) {
    if (error instanceof ProviderRejectedError && error.status === 400) {
      // the 400 measured in the sandbox (the document already has a customer under another key,
      // or Woovi does not take the data); a 401, 403 or 404 is a fault of the setup, not of the payer
      // biome-ignore lint/style/useErrorCause: the cause is passed in the options object.
      throw new WooviCustomerMismatchError({ cause: error });
    }
    throw error;
  }
  if (!matches(created, payer)) {
    throw new WooviCustomerMismatchError();
  }
  return "created";
}
