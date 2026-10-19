const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const maxPostgresInteger = 2_147_483_647;

export const SALE_CUSTOMER_LINK_ACTIONS = [
  "assign",
  "reassign",
  "unassign",
] as const;

export type SaleCustomerLinkAction =
  (typeof SALE_CUSTOMER_LINK_ACTIONS)[number];

/**
 * The attribution of a confirmed sale is an append-only history of versions.
 * Version 0 means the sale never had an attribution; the current state is the
 * latest version, where a null customer means "unassigned".
 */
export interface SaleCustomerLinkState {
  customerId: string | null;
  version: number;
}

export interface SaleCustomerLinkCommandInput {
  action: SaleCustomerLinkAction;
  customerId?: string | null;
  expectedVersion: number;
  saleId: string;
}

export interface NormalizedSaleCustomerLinkCommand {
  action: SaleCustomerLinkAction;
  customerId: string | null;
  expectedVersion: number;
  saleId: string;
}

export type SaleCustomerLinkPlan =
  | { changed: false; state: SaleCustomerLinkState }
  | { changed: true; next: SaleCustomerLinkState };

export class InvalidSaleCustomerLinkError extends Error {
  readonly code = "invalid_sale_customer_link";

  constructor() {
    super("invalid_sale_customer_link");
    this.name = "InvalidSaleCustomerLinkError";
  }
}

export class SaleCustomerLinkVersionConflictError extends Error {
  readonly code = "sale_customer_link_version_conflict";

  constructor(options?: ErrorOptions) {
    super("sale_customer_link_version_conflict", options);
    this.name = "SaleCustomerLinkVersionConflictError";
  }
}

/** The requested action does not fit the current attribution of the sale. */
export class SaleCustomerLinkStateError extends Error {
  readonly code = "sale_customer_link_state_conflict";

  constructor() {
    super("sale_customer_link_state_conflict");
    this.name = "SaleCustomerLinkStateError";
  }
}

/** Archived customers leave the active choices, so they cannot be newly linked. */
export class SaleCustomerArchivedError extends Error {
  readonly code = "sale_customer_archived";

  constructor() {
    super("sale_customer_archived");
    this.name = "SaleCustomerArchivedError";
  }
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && uuidPattern.test(value);
}

/**
 * Validates the command shape. `assign` and `reassign` name the customer;
 * `unassign` names none. The expected version is the version the operator saw.
 */
export function normalizeSaleCustomerLinkCommand(
  input: SaleCustomerLinkCommandInput
): NormalizedSaleCustomerLinkCommand {
  if (
    !input ||
    typeof input !== "object" ||
    !SALE_CUSTOMER_LINK_ACTIONS.includes(input.action) ||
    !isUuid(input.saleId) ||
    !Number.isInteger(input.expectedVersion) ||
    input.expectedVersion < 0 ||
    input.expectedVersion > maxPostgresInteger
  ) {
    throw new InvalidSaleCustomerLinkError();
  }

  const customerId = input.customerId ?? null;
  if (input.action === "unassign") {
    if (customerId !== null) {
      throw new InvalidSaleCustomerLinkError();
    }
  } else if (!isUuid(customerId)) {
    throw new InvalidSaleCustomerLinkError();
  }

  return {
    action: input.action,
    customerId: customerId === null ? null : customerId.toLowerCase(),
    expectedVersion: input.expectedVersion,
    saleId: input.saleId.toLowerCase(),
  };
}

/**
 * Decides the next attribution state. The expected version is checked first, so
 * a stale view conflicts. Repeating an action that already holds is a no-op
 * (no new version, no audit). `assign` only starts an attribution and
 * `reassign` only changes an existing one.
 */
export function planSaleCustomerLinkTransition(
  current: SaleCustomerLinkState,
  command: NormalizedSaleCustomerLinkCommand
): SaleCustomerLinkPlan {
  if (current.version !== command.expectedVersion) {
    throw new SaleCustomerLinkVersionConflictError();
  }

  const unchanged = { changed: false, state: current } as const;
  const next = (customerId: string | null) => ({
    changed: true as const,
    next: { customerId, version: current.version + 1 },
  });

  switch (command.action) {
    case "assign":
      if (current.customerId === null) {
        return next(command.customerId);
      }
      if (current.customerId === command.customerId) {
        return unchanged;
      }
      throw new SaleCustomerLinkStateError();
    case "reassign":
      if (current.customerId === null) {
        throw new SaleCustomerLinkStateError();
      }
      if (current.customerId === command.customerId) {
        return unchanged;
      }
      return next(command.customerId);
    case "unassign":
      return current.customerId === null ? unchanged : next(null);
    default:
      throw new InvalidSaleCustomerLinkError();
  }
}

const SALE_CUSTOMER_LINK_AUDIT_EVENTS = {
  assign: "sale_customer_link.assigned",
  reassign: "sale_customer_link.reassigned",
  unassign: "sale_customer_link.unassigned",
} as const satisfies Record<SaleCustomerLinkAction, string>;

export function saleCustomerLinkAuditEvent(action: SaleCustomerLinkAction) {
  return SALE_CUSTOMER_LINK_AUDIT_EVENTS[action];
}
