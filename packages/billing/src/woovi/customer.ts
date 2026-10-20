import { ProviderResponseMalformedError } from "../provider-port";
import type { WooviClient } from "./client";
import {
  isTaxIdDigits,
  isWooviCustomerCorrelationId,
  isWooviGlobalId,
} from "./ids";

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

  constructor(options?: ErrorOptions) {
    super("payer_data_mismatch", options);
    this.name = "WooviCustomerMismatchError";
  }
}

/**
 * The customer Woovi holds for this tax ID pays a live subscription of another
 * organization, and the payer's name or e-mail differ: they are not changed
 * under it (ADR 0101, emenda do PR 6). The caller answers it as the same
 * generic refusal as `WooviCustomerMismatchError`, never saying why.
 */
export class WooviCustomerHeldError extends Error {
  readonly code = "payer_data_mismatch";

  constructor() {
    super("payer_data_mismatch");
    this.name = "WooviCustomerHeldError";
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

export interface AlignWooviCustomerOptions {
  /**
   * Asked only when the name or the e-mail differ and the customer would be
   * updated: whether that may happen (no live subscription of another
   * organization pays through this customer). False refuses with
   * `WooviCustomerHeldError` and nothing is changed. Without it, nothing is
   * ever updated (fail closed).
   */
  mayUpdate?: () => Promise<boolean>;
}

/**
 * `absent`: Woovi has no customer with this tax ID (the subscription creates
 * it with the payer's data). `matches`: it has one with the same name and
 * e-mail. `updated`: it had other ones and now has the payer's. Throws
 * `WooviCustomerMismatchError` when the update fails or does not hold (a
 * refused or unanswered update included: only this path calls it), and the
 * lookup's errors as they come.
 */
export async function alignWooviCustomer(
  client: WooviClient,
  payer: WooviPayer,
  options: AlignWooviCustomerOptions = {}
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
  if (!(options.mayUpdate && (await options.mayUpdate()))) {
    throw new WooviCustomerHeldError();
  }
  if (isTaxIdDigits(customer.correlationId)) {
    // a key shaped like a CPF or CNPJ (another integration may have used the document as
    // the key) would put a document in the update's URL, which the platform's traces may keep
    throw new WooviCustomerMismatchError();
  }
  let updated: ReturnType<typeof pickCustomer>;
  try {
    updated = pickCustomer(
      await client.updateCustomer(customer.correlationId, {
        email: payer.email.trim(),
        name: payer.name.trim(),
      })
    );
  } catch (error: unknown) {
    // only this path calls the update: its failure is the same refusal as a
    // mismatch, never a code of its own that would tell the document is a customer
    // biome-ignore lint/style/useErrorCause: the cause is passed in the options object.
    throw new WooviCustomerMismatchError({ cause: error });
  }
  if (!matches(updated, payer)) {
    throw new WooviCustomerMismatchError();
  }
  return "updated";
}

/** The CPF or CNPJ of a subscription's customer (`customer.taxID.taxID`), or null when it cannot be read. */
function documentOf(customer: unknown): string | null {
  const document =
    typeof customer === "object" && customer !== null
      ? (customer as Record<string, unknown>).taxID
      : undefined;
  const holder =
    typeof document === "object" && document !== null
      ? (document as Record<string, unknown>).taxID
      : document;
  return typeof holder === "string" ? holder : null;
}

/**
 * The `globalID`s of the account's live subscriptions paid through the customer
 * with this tax ID: `ACTIVE` and approved by the payer (`pixRecurring.status =
 * APPROVED`). One still waiting for approval does not count: anyone can create
 * one with any document, and it would otherwise hold the customer's name
 * against its owner. Read from the whole list, because Woovi's takes no filter;
 * of each entry only the customer's tax ID, the states and the ID are looked
 * at, and nothing is kept. An `ACTIVE` entry whose customer's document cannot
 * be read fails closed (`ProviderResponseMalformedError`): a change of format
 * must never pass for "no live subscription".
 */
export async function liveSubscriptionsOfTaxId(
  client: WooviClient,
  taxId: string
): Promise<string[]> {
  if (!isTaxIdDigits(taxId)) {
    throw new TypeError("invalid_tax_id");
  }
  const ids: string[] = [];
  for (const entry of await client.listSubscriptions()) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new ProviderResponseMalformedError();
    }
    const { customer, globalID, pixRecurring, status } = entry as Record<
      string,
      unknown
    >;
    if (status !== "ACTIVE") {
      continue;
    }
    const holder = documentOf(customer);
    if (holder === null) {
      throw new ProviderResponseMalformedError();
    }
    const approved =
      typeof pixRecurring === "object" &&
      pixRecurring !== null &&
      (pixRecurring as Record<string, unknown>).status === "APPROVED";
    if (holder === taxId && approved) {
      if (!isWooviGlobalId("subscription", globalID)) {
        throw new ProviderResponseMalformedError();
      }
      ids.push(globalID);
    }
  }
  return ids;
}
