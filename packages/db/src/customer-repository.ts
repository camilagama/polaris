import {
  anonymizedCustomerProfile,
  CustomerAnonymizedError,
  type CustomerDuplicateSearchInput,
  type CustomerLifecycleAction,
  CustomerNotFoundError,
  type CustomerProfileInput,
  CustomerVersionConflictError,
  InvalidCustomerProfileError,
  normalizeCustomerDuplicateSearch,
  normalizeCustomerProfile,
  transitionCustomerLifecycle,
} from "@polaris/domain/customers/customer";
import { and, asc, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { recordDeletionLedgerEntry } from "./deletion-ledger";
import { customers } from "./schema/customer";
import { saleAdjustments, saleItems, sales } from "./schema/sale";
import { saleCancellations } from "./schema/sale-cancellation";
import { saleCustomerLinks } from "./schema/sale-customer-link";
import { recordTenantAuditEvent } from "./tenant-audit";
import {
  TenantAuthorizationError,
  type TenantRequestIdentity,
  type TenantRequestTransaction,
} from "./tenant-transaction";

export interface CustomerListOptions {
  status?: "active" | "archived" | "all";
}

export interface CustomerMutationInput {
  expectedVersion: number;
  id: string;
  requestId?: string | null;
}

export interface CreateCustomerInput extends CustomerProfileInput {
  /**
   * A UUID the caller generated (an offline device names the customer before the
   * server has seen it). Without one the database assigns a UUIDv7.
   */
  id?: string;
  requestId?: string | null;
}

export class CustomerIdConflictError extends Error {
  constructor(options?: ErrorOptions) {
    super("customer_id_conflict", options);
    this.name = "CustomerIdConflictError";
  }
}

const customerIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isCustomerIdConflict(error: unknown): boolean {
  const seen = new Set<object>();
  let current: unknown = error;
  while (
    typeof current === "object" &&
    current !== null &&
    !seen.has(current)
  ) {
    seen.add(current);
    const candidate = current as {
      cause?: unknown;
      code?: unknown;
      constraint?: unknown;
    };
    if (
      candidate.code === "23505" &&
      candidate.constraint === "customers_pkey"
    ) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

export interface UpdateCustomerInput
  extends CustomerMutationInput,
    CustomerProfileInput {}

const customerColumns = {
  anonymizedAt: customers.anonymizedAt,
  archivedAt: customers.archivedAt,
  createdAt: customers.createdAt,
  email: customers.email,
  id: customers.id,
  name: customers.name,
  notes: customers.notes,
  organizationId: customers.organizationId,
  phone: customers.phone,
  updatedAt: customers.updatedAt,
  version: customers.version,
};

/**
 * What a customer bought, in the same statement that reads the customer. A purchase is a confirmed sale that was not
 * cancelled and whose current attribution (the highest version of its links) is the customer; the total is what the
 * sale history shows for each one (items, plus surcharge, freight and payment surcharge, minus discount), with no
 * return taken out. The date is the commercial day of the sale in the store.
 */
function purchaseStats(
  transaction: TenantRequestTransaction,
  organizationId: string,
  customerId?: string
) {
  const itemsTotal = sql`(
    SELECT coalesce(sum(item.charged_unit_price * item.quantity), 0)
    FROM ${saleItems} AS item
    WHERE item.organization_id = ${sales.organizationId}
      AND item.sale_id = ${sales.id}
  )`;
  const adjustmentsTotal = sql`(
    SELECT coalesce(sum(CASE adjustment.kind WHEN 'discount' THEN -adjustment.amount ELSE adjustment.amount END), 0)
    FROM ${saleAdjustments} AS adjustment
    WHERE adjustment.organization_id = ${sales.organizationId}
      AND adjustment.sale_id = ${sales.id}
      AND adjustment.kind IN ('discount', 'freight', 'payment_surcharge', 'surcharge')
  )`;
  return transaction
    .select({
      customerId: saleCustomerLinks.customerId,
      lastPurchaseOn: sql<string | null>`max(${sales.occurredOn})::text`.as(
        "last_purchase_on"
      ),
      purchaseCount: sql<number>`count(*)::int`.as("purchase_count"),
      totalSpent:
        sql<string>`sum(${itemsTotal} + ${adjustmentsTotal})::text`.as(
          "total_spent"
        ),
    })
    .from(saleCustomerLinks)
    .innerJoin(
      sales,
      and(
        eq(sales.organizationId, saleCustomerLinks.organizationId),
        eq(sales.id, saleCustomerLinks.saleId)
      )
    )
    .where(
      and(
        eq(saleCustomerLinks.organizationId, organizationId),
        customerId === undefined
          ? isNotNull(saleCustomerLinks.customerId)
          : eq(saleCustomerLinks.customerId, customerId),
        sql`${saleCustomerLinks.version} = (
          SELECT max(latest.version) FROM ${saleCustomerLinks} AS latest
          WHERE latest.organization_id = ${saleCustomerLinks.organizationId}
            AND latest.sale_id = ${saleCustomerLinks.saleId}
        )`,
        sql`NOT EXISTS (
          SELECT 1 FROM ${saleCancellations}
          WHERE ${saleCancellations.organizationId} = ${sales.organizationId}
            AND ${saleCancellations.saleId} = ${sales.id}
        )`
      )
    )
    .groupBy(saleCustomerLinks.customerId)
    .as("purchase_stats");
}

export async function listCustomers(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  options: CustomerListOptions = {}
) {
  const conditions = [eq(customers.organizationId, identity.organizationId)];
  switch (options.status ?? "active") {
    case "active":
      conditions.push(isNull(customers.archivedAt));
      break;
    case "archived":
      conditions.push(isNotNull(customers.archivedAt));
      break;
    case "all":
      break;
    default:
      break;
  }

  const stats = purchaseStats(transaction, identity.organizationId);
  const rows = await transaction
    .select({ ...customerColumns, lastPurchaseOn: stats.lastPurchaseOn })
    .from(customers)
    .leftJoin(stats, eq(stats.customerId, customers.id))
    .where(and(...conditions))
    .orderBy(asc(customers.name), asc(customers.id));
  return rows.map((row) => ({
    ...row,
    lastPurchaseOn: row.lastPurchaseOn ?? null,
  }));
}

export async function getCustomer(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  customerId: string
) {
  const stats = purchaseStats(transaction, identity.organizationId, customerId);
  const [row] = await transaction
    .select({
      ...customerColumns,
      lastPurchaseOn: stats.lastPurchaseOn,
      purchaseCount: stats.purchaseCount,
      totalSpent: stats.totalSpent,
    })
    .from(customers)
    .leftJoin(stats, eq(stats.customerId, customers.id))
    .where(
      and(
        eq(customers.organizationId, identity.organizationId),
        eq(customers.id, customerId)
      )
    )
    .limit(1);
  if (!row) {
    throw new CustomerNotFoundError();
  }
  const { lastPurchaseOn, purchaseCount, totalSpent, ...customer } = row;
  return {
    ...customer,
    summary: {
      lastPurchaseOn: lastPurchaseOn ?? null,
      purchaseCount: purchaseCount ?? 0,
      totalSpent: totalSpent ?? "0",
    },
  };
}

export async function findPossibleCustomerDuplicates(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: CustomerDuplicateSearchInput
) {
  const normalized = normalizeCustomerDuplicateSearch(input);

  const emailCondition = normalized.email
    ? sql`lower(${customers.email}) = lower(${normalized.email})`
    : undefined;
  const phoneCondition = normalized.phone
    ? eq(customers.phone, normalized.phone)
    : undefined;

  const rows = await transaction
    .select({
      ...customerColumns,
      emailMatched: normalized.email
        ? sql<boolean>`
            ${customers.email} IS NOT NULL
            AND lower(${customers.email}) = lower(${normalized.email})
          `
        : sql<boolean>`false`,
      phoneMatched: normalized.phone
        ? sql<boolean>`${customers.phone} = ${normalized.phone}`
        : sql<boolean>`false`,
    })
    .from(customers)
    .where(
      and(
        eq(customers.organizationId, identity.organizationId),
        or(emailCondition, phoneCondition)
      )
    )
    .orderBy(asc(customers.name), asc(customers.id));

  return rows.map(({ emailMatched, phoneMatched, ...customer }) => ({
    customer,
    matchedBy: [
      ...(emailMatched ? (["email"] as const) : []),
      ...(phoneMatched ? (["phone"] as const) : []),
    ],
  }));
}

export async function createCustomer(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: CreateCustomerInput
) {
  const profile = normalizeCustomerProfile(input);
  if (input.id !== undefined && !customerIdPattern.test(input.id)) {
    throw new InvalidCustomerProfileError();
  }
  let customer: typeof customers.$inferSelect | undefined;
  try {
    // The savepoint keeps a duplicate ID from aborting the caller's transaction.
    [customer] = await transaction.transaction((savepoint) =>
      savepoint
        .insert(customers)
        .values({
          ...profile,
          ...(input.id === undefined ? {} : { id: input.id }),
          organizationId: identity.organizationId,
        })
        .returning()
    );
  } catch (error) {
    if (isCustomerIdConflict(error)) {
      // biome-ignore lint/style/useErrorCause: the cause is passed in the options object.
      throw new CustomerIdConflictError({ cause: error });
    }
    throw error;
  }

  if (!customer) {
    throw new Error("customer_insert_failed");
  }

  await recordTenantAuditEvent(transaction, identity, {
    entityId: customer.id,
    entityType: "customer",
    eventType: "customer.created",
    requestId: input.requestId ?? null,
  });

  return customer;
}

export async function updateCustomer(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: UpdateCustomerInput
) {
  const [existing] = await transaction
    .select(customerColumns)
    .from(customers)
    .where(
      and(
        eq(customers.id, input.id),
        eq(customers.organizationId, identity.organizationId)
      )
    )
    .limit(1)
    .for("update");

  if (!existing) {
    throw new CustomerNotFoundError();
  }
  if (existing.anonymizedAt !== null) {
    throw new CustomerAnonymizedError();
  }
  if (existing.version !== input.expectedVersion) {
    throw new CustomerVersionConflictError();
  }

  const profile = normalizeCustomerProfile(input);
  const changed =
    profile.name !== existing.name ||
    profile.phone !== existing.phone ||
    profile.email !== existing.email ||
    profile.notes !== existing.notes;

  if (!changed) {
    return { changed: false, customer: existing };
  }

  const [customer] = await transaction
    .update(customers)
    .set({ ...profile, updatedAt: new Date(), version: existing.version + 1 })
    .where(
      and(
        eq(customers.id, input.id),
        eq(customers.organizationId, identity.organizationId),
        eq(customers.version, input.expectedVersion)
      )
    )
    .returning();

  if (!customer) {
    throw new CustomerVersionConflictError();
  }

  await recordTenantAuditEvent(transaction, identity, {
    entityId: customer.id,
    entityType: "customer",
    eventType: "customer.updated",
    requestId: input.requestId ?? null,
  });

  return { changed: true, customer };
}

async function changeCustomerLifecycle(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: CustomerMutationInput,
  action: CustomerLifecycleAction
) {
  const [existing] = await transaction
    .select(customerColumns)
    .from(customers)
    .where(
      and(
        eq(customers.id, input.id),
        eq(customers.organizationId, identity.organizationId)
      )
    )
    .limit(1)
    .for("update");

  if (!existing) {
    throw new CustomerNotFoundError();
  }
  if (existing.anonymizedAt !== null) {
    if (action === "restore") {
      throw new CustomerAnonymizedError();
    }
    // archiving what is anonymized (and so archived) changes nothing, whatever version was named
    return { changed: false, customer: existing };
  }
  if (existing.version !== input.expectedVersion) {
    throw new CustomerVersionConflictError();
  }

  const transition = transitionCustomerLifecycle(existing.archivedAt, action);
  if (!transition.changed) {
    return { changed: false, customer: existing };
  }

  const [customer] = await transaction
    .update(customers)
    .set({
      archivedAt: transition.archivedAt,
      updatedAt: new Date(),
      version: existing.version + 1,
    })
    .where(
      and(
        eq(customers.id, input.id),
        eq(customers.organizationId, identity.organizationId),
        eq(customers.version, input.expectedVersion)
      )
    )
    .returning();

  if (!customer) {
    throw new CustomerVersionConflictError();
  }

  await recordTenantAuditEvent(transaction, identity, {
    entityId: customer.id,
    entityType: "customer",
    eventType: action === "archive" ? "customer.archived" : "customer.restored",
    requestId: input.requestId ?? null,
  });

  return { changed: true, customer };
}

export async function archiveCustomer(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: CustomerMutationInput
) {
  return await changeCustomerLifecycle(transaction, identity, input, "archive");
}

export async function restoreCustomer(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: CustomerMutationInput
) {
  return await changeCustomerLifecycle(transaction, identity, input, "restore");
}

/**
 * Anonymizes a customer for privacy (plan PR102, ADR 0075): the name, phone, e-mail
 * and notes are replaced and the record is archived, in one transaction with the
 * audit event. The record keeps its ID, so every sale that points to it keeps its
 * economic facts. It cannot be undone, which the database enforces. Doing it to an
 * already anonymized customer changes nothing.
 */
export async function anonymizeCustomerForPrivacy(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  input: CustomerMutationInput
) {
  if (identity.capability !== "customer:anonymize") {
    throw new TenantAuthorizationError("capability_denied");
  }
  const [existing] = await transaction
    .select(customerColumns)
    .from(customers)
    .where(
      and(
        eq(customers.id, input.id),
        eq(customers.organizationId, identity.organizationId)
      )
    )
    .limit(1)
    .for("update");

  if (!existing) {
    throw new CustomerNotFoundError();
  }
  if (existing.anonymizedAt !== null) {
    return { changed: false, customer: existing };
  }
  if (existing.version !== input.expectedVersion) {
    throw new CustomerVersionConflictError();
  }

  const now = new Date();
  const [customer] = await transaction
    .update(customers)
    .set({
      ...anonymizedCustomerProfile(),
      anonymizedAt: now,
      archivedAt: existing.archivedAt ?? now,
      updatedAt: now,
      version: existing.version + 1,
    })
    .where(
      and(
        eq(customers.id, input.id),
        eq(customers.organizationId, identity.organizationId),
        eq(customers.version, input.expectedVersion)
      )
    )
    .returning(customerColumns);

  if (!customer) {
    throw new CustomerVersionConflictError();
  }

  await recordTenantAuditEvent(transaction, identity, {
    entityId: customer.id,
    entityType: "customer",
    eventType: "customer.anonymized",
    requestId: input.requestId ?? null,
  });
  await recordDeletionLedgerEntry(transaction, {
    entityId: customer.id,
    entityType: "customer",
    operation: "anonymize",
    organizationId: identity.organizationId,
  });

  return { changed: true, customer };
}
