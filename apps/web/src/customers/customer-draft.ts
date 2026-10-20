import type { CustomerReadModel } from "@polaris/contracts";
import { isDraftChanged } from "../lib/unsent-work";

export interface CustomerDraft {
  email: string;
  name: string;
  notes: string;
  phone: string;
}

export const emptyCustomerDraft: CustomerDraft = {
  email: "",
  name: "",
  notes: "",
  phone: "",
};

export function draftOfCustomer(customer: CustomerReadModel): CustomerDraft {
  return {
    email: customer.email ?? "",
    name: customer.name,
    notes: customer.notes ?? "",
    phone: customer.phone ?? "",
  };
}

/**
 * Whether the form holds something the person typed: it differs from an empty form, or from the customer
 * being edited. Opening a customer to edit, without changing a field, is not work.
 */
export function isCustomerDraftChanged(
  draft: CustomerDraft,
  editing: CustomerReadModel | null
): boolean {
  return isDraftChanged(
    draft,
    editing ? draftOfCustomer(editing) : emptyCustomerDraft
  );
}
