import type { CustomerReadModel } from "@polaris/contracts";
import { describe, expect, it } from "vitest";
import {
  draftOfCustomer,
  emptyCustomerDraft,
  isCustomerDraftChanged,
} from "./customer-draft";

const customer = {
  email: "ana@example.com",
  name: "Ana",
  notes: null,
  phone: null,
} as CustomerReadModel;

describe("isCustomerDraftChanged (the sign that the session notice warns about)", () => {
  it("does not count an empty form", () => {
    expect(isCustomerDraftChanged({ ...emptyCustomerDraft }, null)).toBe(false);
  });

  it("counts anything typed in a new customer", () => {
    expect(
      isCustomerDraftChanged({ ...emptyCustomerDraft, name: "Ana" }, null)
    ).toBe(true);
    expect(
      isCustomerDraftChanged({ ...emptyCustomerDraft, phone: "11" }, null)
    ).toBe(true);
  });

  it("does not count a customer opened to edit and left as it was", () => {
    expect(isCustomerDraftChanged(draftOfCustomer(customer), customer)).toBe(
      false
    );
  });

  it("counts an edit of the customer, and an emptied form that was filled", () => {
    expect(
      isCustomerDraftChanged(
        { ...draftOfCustomer(customer), name: "Ana Lima" },
        customer
      )
    ).toBe(true);
    expect(isCustomerDraftChanged({ ...emptyCustomerDraft }, customer)).toBe(
      true
    );
  });
});
