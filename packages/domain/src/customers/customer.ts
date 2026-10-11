export type CustomerLifecycle = "active" | "archived";
export type CustomerLifecycleAction = "archive" | "restore";

export interface CustomerProfileInput {
  email?: string | null;
  name: string;
  notes?: string | null;
  phone?: string | null;
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

  if (!(name && (phone || email))) {
    throw new InvalidCustomerProfileError();
  }

  return { email, name, notes, phone };
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
