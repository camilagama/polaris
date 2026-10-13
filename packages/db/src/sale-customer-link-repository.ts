import { CustomerNotFoundError } from "@polaris/domain/customers/customer";
import {
  type NormalizedSaleCustomerLinkCommand,
  normalizeSaleCustomerLinkCommand,
  planSaleCustomerLinkTransition,
  SaleCustomerArchivedError,
  type SaleCustomerLinkAction,
  type SaleCustomerLinkCommandInput,
  SaleCustomerLinkVersionConflictError,
  type SaleCustomerLinkState,
  saleCustomerLinkAuditEvent,
} from "@polaris/domain/sales/sale-customer-link";
import { SaleNotFoundError } from "@polaris/domain/sales/sale-errors";
import { and, asc, desc, eq } from "drizzle-orm";
import { customers } from "./schema/customer";
import { sales } from "./schema/sale";
import { saleCustomerLinks } from "./schema/sale-customer-link";
import { recordTenantAuditEvent } from "./tenant-audit";
import {
  TenantAuthorizationError,
  type TenantRequestIdentity,
  type TenantRequestTransaction,
} from "./tenant-transaction";

export const SALE_CUSTOMER_LINK_CAPABILITY = "sale:assign_customer";

export interface ChangeSaleCustomerLinkInput
  extends SaleCustomerLinkCommandInput {
  requestId?: string | null;
}

export interface SaleCustomerLinkReadModel {
  current: SaleCustomerLinkState;
  history: Array<{
    action: SaleCustomerLinkAction;
    createdAt: Date;
    customerId: string | null;
    version: number;
  }>;
  saleId: string;
}

const uniqueViolation = "23505";
const versionUniqueConstraint =
  "sale_customer_links_organization_sale_version_unique";
const versionSequenceConstraint = "sale_customer_links_version_sequence";

function requireCapability(identity: TenantRequestIdentity): void {
  if (identity.capability !== SALE_CUSTOMER_LINK_CAPABILITY) {
    throw new TenantAuthorizationError("capability_denied");
  }
}

function causeField(error: unknown, field: "code" | "constraint") {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === "object" && current; ) {
    const candidate = current as Record<string, unknown>;
    if (typeof candidate[field] === "string") {
      return candidate[field];
    }
    current = candidate.cause;
    depth += 1;
  }
}

async function requireSale(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  saleId: string
) {
  const [sale] = await transaction
    .select({ id: sales.id })
    .from(sales)
    .where(
      and(
        eq(sales.organizationId, identity.organizationId),
        eq(sales.id, saleId)
      )
    )
    .limit(1);
  if (!sale) {
    throw new SaleNotFoundError();
  }
}

async function readHistory(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  saleId: string
): Promise<SaleCustomerLinkReadModel> {
  const rows = await transaction
    .select({
      action: saleCustomerLinks.action,
      createdAt: saleCustomerLinks.createdAt,
      customerId: saleCustomerLinks.customerId,
      version: saleCustomerLinks.version,
    })
    .from(saleCustomerLinks)
    .where(
      and(
        eq(saleCustomerLinks.organizationId, identity.organizationId),
        eq(saleCustomerLinks.saleId, saleId)
      )
    )
    .orderBy(asc(saleCustomerLinks.version));

  const latest = rows.at(-1);
  return {
    current: {
      customerId: latest?.customerId ?? null,
      version: latest?.version ?? 0,
    },
    history: rows.map((row) => ({
      action: row.action as SaleCustomerLinkAction,
      createdAt: row.createdAt,
      customerId: row.customerId,
      version: row.version,
    })),
    saleId,
  };
}

async function requireLinkableCustomer(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  customerId: string
) {
  // FOR SHARE makes a concurrent archive of this customer wait for this
  // transaction, so an archived customer is never newly linked.
  const [customer] = await transaction
    .select({ archivedAt: customers.archivedAt })
    .from(customers)
    .where(
      and(
        eq(customers.organizationId, identity.organizationId),
        eq(customers.id, customerId)
      )
    )
    .limit(1)
    .for("share");
  if (!customer) {
    throw new CustomerNotFoundError();
  }
  if (customer.archivedAt !== null) {
    throw new SaleCustomerArchivedError();
  }
}

async function insertVersion(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  command: NormalizedSaleCustomerLinkCommand,
  next: SaleCustomerLinkState
) {
  try {
    const [row] = await transaction
      .insert(saleCustomerLinks)
      .values({
        action: command.action,
        customerId: next.customerId,
        organizationId: identity.organizationId,
        saleId: command.saleId,
        version: next.version,
      })
      .returning({ id: saleCustomerLinks.id });
    if (!row) {
      throw new Error("sale_customer_link_insert_failed");
    }
    return row;
  } catch (error) {
    // A concurrent change took the same version: the operator's view is stale.
    // It surfaces as the unique index when both inserts overlap, or as the
    // sequence guard when the other change committed just before this insert.
    const constraint = causeField(error, "constraint");
    if (
      (causeField(error, "code") === uniqueViolation &&
        constraint === versionUniqueConstraint) ||
      constraint === versionSequenceConstraint
    ) {
      // The domain error constructor forwards this value to ErrorOptions.cause.
      // biome-ignore lint/style/useErrorCause: Biome cannot follow the custom error constructor.
      throw new SaleCustomerLinkVersionConflictError({ cause: error });
    }
    throw error;
  }
}

/** Current attribution plus its append-only history, oldest version first. */
export async function getSaleCustomerLink(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  saleId: string
): Promise<SaleCustomerLinkReadModel> {
  requireCapability(identity);
  const normalized = normalizeSaleCustomerLinkCommand({
    action: "unassign",
    expectedVersion: 0,
    saleId,
  });
  await requireSale(transaction, identity, normalized.saleId);
  return await readHistory(transaction, identity, normalized.saleId);
}

/**
 * Assigns, reassigns or unassigns the customer of a confirmed sale in the
 * caller's tenant transaction, as one new version plus its audit event. The
 * sale's economic rows are never touched. The organization and actor come from
 * the authorized identity.
 */
export async function changeSaleCustomerLink(
  transaction: TenantRequestTransaction,
  identity: TenantRequestIdentity,
  rawInput: ChangeSaleCustomerLinkInput
) {
  requireCapability(identity);
  const command = normalizeSaleCustomerLinkCommand(rawInput);
  await requireSale(transaction, identity, command.saleId);

  const [latest] = await transaction
    .select({
      customerId: saleCustomerLinks.customerId,
      version: saleCustomerLinks.version,
    })
    .from(saleCustomerLinks)
    .where(
      and(
        eq(saleCustomerLinks.organizationId, identity.organizationId),
        eq(saleCustomerLinks.saleId, command.saleId)
      )
    )
    .orderBy(desc(saleCustomerLinks.version))
    .limit(1);
  const plan = planSaleCustomerLinkTransition(
    { customerId: latest?.customerId ?? null, version: latest?.version ?? 0 },
    command
  );

  if (!plan.changed) {
    return {
      changed: false as const,
      link: await readHistory(transaction, identity, command.saleId),
    };
  }

  if (plan.next.customerId !== null) {
    await requireLinkableCustomer(transaction, identity, plan.next.customerId);
  }
  const row = await insertVersion(transaction, identity, command, plan.next);
  await recordTenantAuditEvent(transaction, identity, {
    entityId: row.id,
    entityType: "sale_customer_link",
    eventType: saleCustomerLinkAuditEvent(command.action),
    requestId: rawInput.requestId ?? null,
  });

  return {
    changed: true as const,
    link: await readHistory(transaction, identity, command.saleId),
  };
}
