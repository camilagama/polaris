import type {
  CustomerDuplicateMatchReadModel,
  CustomerReadModel,
  LocalCustomerReadModel,
} from "@polaris/contracts";
import { normalizeCustomerDuplicateSearch } from "@polaris/domain/customers/customer";

/**
 * The customers screen reading this device's collection (plan PR64). The local
 * row is the server's read model without what the screen does not need offline;
 * these functions rebuild the screen's shape from it and mirror the server's
 * rules for listing and for possible duplicates, so the same customers show up
 * whether the list came from the network or from the disk.
 */
export function toCustomerReadModel(
  row: LocalCustomerReadModel,
  organizationId: string
): CustomerReadModel {
  return {
    archivedAt: row.archivedAt,
    // The device does not keep the creation date; the last change stands in for it.
    createdAt: row.updatedAt,
    email: row.email,
    id: row.id,
    name: row.name,
    notes: row.notes,
    organizationId,
    phone: row.phone,
    status: row.archivedAt === null ? "active" : "archived",
    updatedAt: row.updatedAt,
    version: row.version,
  };
}

/** The local row of a customer the server just answered with. */
export function toLocalCustomerRow(
  customer: CustomerReadModel
): LocalCustomerReadModel {
  return {
    archivedAt: customer.archivedAt,
    email: customer.email,
    id: customer.id,
    name: customer.name,
    notes: customer.notes,
    phone: customer.phone,
    updatedAt: customer.updatedAt,
    version: customer.version,
  };
}

function byNameThenId(a: CustomerReadModel, b: CustomerReadModel): number {
  return a.name.localeCompare(b.name, "pt-BR") || a.id.localeCompare(b.id);
}

/** The customers of one state, by name (then ID), like the server lists them. */
export function listLocalCustomers(
  rows: LocalCustomerReadModel[],
  organizationId: string,
  status: "active" | "archived"
): CustomerReadModel[] {
  return rows
    .map((row) => toCustomerReadModel(row, organizationId))
    .filter((customer) => customer.status === status)
    .sort(byNameThenId);
}

/**
 * Customers (active or archived) that share the e-mail (ignoring case) or the
 * phone (exactly) with the one being typed, like the server's check.
 */
export function findLocalDuplicates(
  rows: LocalCustomerReadModel[],
  organizationId: string,
  input: { email?: string | null; phone?: string | null }
): CustomerDuplicateMatchReadModel[] {
  const search = normalizeCustomerDuplicateSearch(input);
  const email = search.email?.toLowerCase() ?? null;
  return rows
    .map((row) => toCustomerReadModel(row, organizationId))
    .flatMap((customer) => {
      const matchedBy: ("email" | "phone")[] = [];
      if (email && customer.email?.toLowerCase() === email) {
        matchedBy.push("email");
      }
      if (search.phone && customer.phone === search.phone) {
        matchedBy.push("phone");
      }
      return matchedBy.length > 0 ? [{ customer, matchedBy }] : [];
    })
    .sort((a, b) => byNameThenId(a.customer, b.customer));
}
