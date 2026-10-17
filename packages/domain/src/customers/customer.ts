/** Text limits shared by the contract, the domain and the database CHECKs. */
export const MAX_CUSTOMER_NAME_LENGTH = 200;
export const MAX_CUSTOMER_PHONE_LENGTH = 40;
export const MAX_CUSTOMER_EMAIL_LENGTH = 254;
export const MAX_CUSTOMER_NOTES_LENGTH = 2000;

export type CustomerLifecycle = "active" | "archived";
export type CustomerLifecycleAction = "archive" | "restore";

export interface CustomerProfileInput {
  email?: string | null;
  name: string;
  notes?: string | null;
  phone?: string | null;
}

export interface CustomerDuplicateSearchInput {
  email?: string | null | undefined;
  phone?: string | null | undefined;
}

export interface NormalizedCustomerDuplicateSearch {
  email: string | null;
  phone: string | null;
}

export interface NormalizedCustomerProfile {
  email: string | null;
  name: string;
  notes: string | null;
  phone: string | null;
}

export class InvalidCustomerProfileError extends Error {
  readonly code = "invalid_customer_profile";

  constructor() {
    super("invalid_customer_profile");
    this.name = "InvalidCustomerProfileError";
  }
}

export class InvalidCustomerDuplicateSearchError extends Error {
  readonly code = "invalid_customer_duplicate_search";

  constructor() {
    super("invalid_customer_duplicate_search");
    this.name = "InvalidCustomerDuplicateSearchError";
  }
}

export class CustomerNotFoundError extends Error {
  readonly code = "customer_not_found";

  constructor() {
    super("customer_not_found");
    this.name = "CustomerNotFoundError";
  }
}

export class CustomerVersionConflictError extends Error {
  readonly code = "customer_version_conflict";

  constructor() {
    super("customer_version_conflict");
    this.name = "CustomerVersionConflictError";
  }
}

function optionalText(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized || null;
}

export function normalizeCustomerProfile(
  input: CustomerProfileInput
): NormalizedCustomerProfile {
  const name = input.name.trim();
  const phone = optionalText(input.phone);
  const email = optionalText(input.email);
  const notes = optionalText(input.notes);

  if (
    !(name && (phone || email)) ||
    name.length > MAX_CUSTOMER_NAME_LENGTH ||
    (phone?.length ?? 0) > MAX_CUSTOMER_PHONE_LENGTH ||
    (email?.length ?? 0) > MAX_CUSTOMER_EMAIL_LENGTH ||
    (notes?.length ?? 0) > MAX_CUSTOMER_NOTES_LENGTH
  ) {
    throw new InvalidCustomerProfileError();
  }

  return { email, name, notes, phone };
}

export function normalizeCustomerDuplicateSearch(
  input: CustomerDuplicateSearchInput
): NormalizedCustomerDuplicateSearch {
  const email = optionalText(input.email);
  const phone = optionalText(input.phone);

  if (
    !(email || phone) ||
    (phone?.length ?? 0) > MAX_CUSTOMER_PHONE_LENGTH ||
    (email?.length ?? 0) > MAX_CUSTOMER_EMAIL_LENGTH
  ) {
    throw new InvalidCustomerDuplicateSearchError();
  }

  return { email, phone };
}

export function deriveCustomerLifecycle(
  archivedAt: Date | null
): CustomerLifecycle {
  return archivedAt === null ? "active" : "archived";
}

export interface CustomerLifecycleTransition {
  archivedAt: Date | null;
  changed: boolean;
  lifecycle: CustomerLifecycle;
}

export function transitionCustomerLifecycle(
  archivedAt: Date | null,
  action: CustomerLifecycleAction,
  at: Date = new Date()
): CustomerLifecycleTransition {
  const current = deriveCustomerLifecycle(archivedAt);
  const target = action === "archive" ? "archived" : "active";

  if (current === target) {
    return { archivedAt, changed: false, lifecycle: current };
  }

  return {
    archivedAt: target === "archived" ? at : null,
    changed: true,
    lifecycle: target,
  };
}

/**
 * What a customer becomes when it is anonymized for privacy (plan PR102, ADR 0075):
 * the same record, so every sale that points to it keeps its economic facts, with
 * no name, phone, e-mail or notes left. The text is fixed on purpose: it carries
 * nothing of the person, and the database requires exactly this.
 */
export const ANONYMIZED_CUSTOMER_NAME = "Cliente anonimizado";

/** The customer was anonymized: it can no longer be edited or restored (it cannot be undone). */
export class CustomerAnonymizedError extends Error {
  readonly code = "customer_anonymized";

  constructor() {
    super("customer_anonymized");
    this.name = "CustomerAnonymizedError";
  }
}

/** Whether a customer record has been anonymized. */
export function isCustomerAnonymized(anonymizedAt: Date | null): boolean {
  return anonymizedAt !== null;
}

/**
 * Whether a customer record is an anonymized one, from the record alone. The database
 * requires every customer that is NOT anonymized to have a phone or an e-mail
 * (`customers_contact_required`), so a record with neither can only be an anonymized
 * one. A device that keeps no `anonymized_at` uses this to show the state.
 */
export function hasAnonymizedShape(record: {
  email: string | null;
  phone: string | null;
}): boolean {
  return record.phone === null && record.email === null;
}

/** What replaces the person's data. Nothing from the previous values is read. */
export function anonymizedCustomerProfile(): {
  email: null;
  name: string;
  notes: null;
  phone: null;
} {
  return {
    email: null,
    name: ANONYMIZED_CUSTOMER_NAME,
    notes: null,
    phone: null,
  };
}
