import {
  CustomerNotFoundError,
  CustomerVersionConflictError,
  normalizeCustomerDuplicateSearch,
  normalizeCustomerProfile,
  transitionCustomerLifecycle,
  type CustomerDuplicateSearchInput,
  type CustomerLifecycleAction,
  type CustomerProfileInput,
} from "@polaris/domain/customers/customer";
import { and, asc, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { customers } from "./schema/customer";
import { recordTenantAuditEvent } from "./tenant-audit";
import type {
  TenantRequestIdentity,
  TenantRequestTransaction,
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
  requestId?: string | null;
}

export interface UpdateCustomerInput
  extends CustomerMutationInput,
    CustomerProfileInput {}

const customerColumns = {
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

  return await transaction
    .select(customerColumns)
    .from(customers)
    .where(and(...conditions))
    .orderBy(asc(customers.name), asc(customers.id));
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
  const [customer] = await transaction
    .insert(customers)
    .values({ ...profile, organizationId: identity.organizationId })
    .returning();

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
