// @vitest-environment happy-dom
import type {
  CustomerReadModel,
  SaleCustomerLinkReadModel,
} from "@polaris/contracts";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getCustomerLink = vi.fn();
const getCustomer = vi.fn();
const listCustomers = vi.fn();

vi.mock("../lib/orpc", () => ({
  orpcClient: {
    customer: {
      get: (input: unknown) => getCustomer(input),
      list: (input: unknown) => listCustomers(input),
    },
    sale: { getCustomerLink: (input: unknown) => getCustomerLink(input) },
  },
}));

import { SaleCustomerPanel } from "./sale-customer-panel";

const organizationId = "org_1";
const saleId = "77777777-7777-4777-8777-777777777777";
const ana = "a0000000-0000-4000-8000-000000000001";
const bruno = "b0000000-0000-4000-8000-000000000002";

function customer(id: string, name: string): CustomerReadModel {
  return {
    anonymizedAt: null,
    archivedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    email: null,
    id,
    name,
    notes: null,
    organizationId,
    phone: "+55 11 99999-0000",
    status: "active",
    updatedAt: "2026-01-01T00:00:00.000Z",
    version: 1,
  };
}

function link(customerId: string | null): SaleCustomerLinkReadModel {
  return {
    current: { customerId, version: customerId === null ? 0 : 1 },
    history:
      customerId === null
        ? []
        : [
            {
              action: "assign",
              createdAt: "2026-05-01T12:00:00.000Z",
              customerId,
              version: 1,
            },
          ],
    saleId,
  };
}

function renderPanel() {
  return render(
    <SaleCustomerPanel
      headingLevel={2}
      organizationId={organizationId}
      saleId={saleId}
    />
  );
}

const refused = () =>
  Object.assign(new Error("recusado"), { code: "FORBIDDEN" });

beforeEach(() => {
  getCustomerLink.mockReset();
  getCustomer.mockReset();
  listCustomers.mockReset();
  listCustomers.mockResolvedValue({
    customers: [customer(ana, "Ana"), customer(bruno, "Bruno")],
  });
});

afterEach(cleanup);

describe("the customer panel of a sale", () => {
  it("reads no customer at all while the sale has none", async () => {
    getCustomerLink.mockResolvedValue(link(null));
    renderPanel();
    await screen.findByText("Sem cliente");
    await screen.findByRole("button", { name: "Associar cliente" });
    expect(getCustomer).not.toHaveBeenCalled();
    expect(listCustomers).not.toHaveBeenCalled();
  });

  it("reads only the customer of the sale, never the list, and names it", async () => {
    getCustomerLink.mockResolvedValue(link(ana));
    getCustomer.mockResolvedValue(customer(ana, "Ana Atual"));
    renderPanel();
    await screen.findByText("Carregando cliente…");
    await screen.findAllByText("Ana Atual");
    expect(getCustomer).toHaveBeenCalledTimes(1);
    expect(getCustomer).toHaveBeenCalledWith({ id: ana, organizationId });
    expect(listCustomers).not.toHaveBeenCalled();
  });

  it("reads the list only when the choice of customer opens", async () => {
    getCustomerLink.mockResolvedValue(link(null));
    renderPanel();
    const open = await screen.findByRole("button", {
      name: "Associar cliente",
    });
    expect(listCustomers).not.toHaveBeenCalled();
    await userEvent.click(open);
    await waitFor(() => expect(listCustomers).toHaveBeenCalledTimes(1));
    expect(listCustomers).toHaveBeenCalledWith({
      organizationId,
      status: "all",
    });
    expect(getCustomer).not.toHaveBeenCalled();
  });

  it("says the read of the name failed on the name's own line, with Tentar novamente that reads only that customer again", async () => {
    getCustomerLink.mockResolvedValue(link(ana));
    getCustomer.mockRejectedValueOnce(refused());
    renderPanel();
    const line = (await screen.findByText("Cliente atual")).parentElement;
    if (line === null) {
      throw new Error("the name line is missing");
    }
    await within(line).findByText(
      "Sua conta não tem acesso a esta loja ou a esta ação."
    );
    expect(screen.getByRole("button", { name: "Trocar cliente" })).toBeTruthy();
    expect(getCustomerLink).toHaveBeenCalledTimes(1);

    getCustomer.mockResolvedValueOnce(customer(ana, "Ana Atual"));
    await userEvent.click(
      within(line).getByRole("button", { name: "Tentar novamente" })
    );
    await within(line).findByText("Ana Atual");
    expect(getCustomer).toHaveBeenCalledTimes(2);
    expect(getCustomerLink).toHaveBeenCalledTimes(1);
    expect(listCustomers).not.toHaveBeenCalled();
  });
});
