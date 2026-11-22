// @vitest-environment happy-dom
import type {
  SaleCustomerLinkReadModel,
  SaleDetailReadModel,
} from "@polaris/contracts";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getSale = vi.fn();
const getCustomerLink = vi.fn();
const returnSale = vi.fn();

vi.mock("../lib/orpc", () => ({
  orpcClient: {
    customer: { get: vi.fn(), list: vi.fn() },
    sale: {
      get: (input: unknown) => getSale(input),
      getCustomerLink: (input: unknown) => getCustomerLink(input),
      return: (input: unknown) => returnSale(input),
    },
  },
}));

import { StaticOrganizationProvider } from "../lib/current-organization";
import { SaleDetailPage } from "./sale-detail-page";
import type { ReturnSaleResult } from "./sale-return-model";

const ORGANIZATION = {
  id: "0199c2d0-0000-7000-8000-00000000a001",
  name: "Loja do teste",
  role: "owner",
  timezone: "America/Sao_Paulo",
};
const SALE_ID = "00000000-0000-4000-8000-000000000070";
const ITEM_LABEL = "Camiseta — Azul / M";
const ACTIONS_MENU = { name: /^Ações/ };
const REGISTER_RETURN = { name: "Registrar devolução" };
const RETURN_HEADING = { name: "Registrar devolução" };
const RETURNED_FIELD = { name: `Devolvido: ${ITEM_LABEL} (até 2)` };
const REREAD_MARKER = "Conferida no balcão";
const REREAD_MARKER_LINE = `Observação: ${REREAD_MARKER}`;
const DRAFT_NOTE = "Zíper quebrado";
const REASON_FIELD = { name: /Motivo/ };
const NOTE_FIELD = { name: /Observação/ };
const RETURNED_FIELD_AFTER = { name: `Devolvido: ${ITEM_LABEL} (até 1)` };

const NO_CUSTOMER_LINK: SaleCustomerLinkReadModel = {
  current: { customerId: null, version: 0 },
  history: [],
  saleId: SALE_ID,
};

const RETURN_RESULT: ReturnSaleResult = {
  lines: [{ position: 0, restockedQuantity: 1, returnedQuantity: 1 }],
  replayed: false,
  saleReturn: {
    commandId: "00000000-0000-4000-8000-000000000110",
    id: "00000000-0000-4000-8000-000000000111",
    reasonCode: "defective",
    reasonNote: DRAFT_NOTE,
    returnedAt: "2026-06-11T12:00:00.000Z",
    returnedBy: "user_1",
    saleId: SALE_ID,
  },
};

/** `note` adds a return to the history without moving the available quantities, to tell when a new read is on screen. */
const detail = (returned: number, note?: string): SaleDetailReadModel => ({
  cancellation: null,
  customer: { customerId: null, version: 0 },
  returnSummary: [
    {
      availableToReturn: 2 - returned,
      position: 0,
      restockedQuantity: returned,
      returnedQuantity: returned,
      sold: 2,
    },
  ],
  returns:
    returned === 0 && note === undefined
      ? []
      : [
          {
            commandId: "00000000-0000-4000-8000-000000000110",
            id: "00000000-0000-4000-8000-000000000111",
            items: [
              {
                position: 0,
                restockedQuantity: returned || 1,
                returnedQuantity: returned || 1,
              },
            ],
            reasonCode: "defective",
            reasonNote: note ?? null,
            returnedAt: "2026-06-11T12:00:00.000Z",
            returnedBy: "user_1",
            saleId: SALE_ID,
          },
        ],
  sale: {
    adjustments: [],
    items: [
      {
        chargedUnitPrice: "49.90",
        listedUnitPrice: "55.00",
        position: 0,
        productId: "00000000-0000-4000-8000-000000000050",
        productLabel: ITEM_LABEL,
        quantity: 2,
        unitCost: null,
        variantId: "00000000-0000-4000-8000-000000000051",
      },
    ],
    payment: {
      amount: "99.80",
      anticipationFee: {
        amount: "0.00",
        fixedAmount: null,
        mode: "not_applicable",
        percentage: null,
      },
      anticipationRequested: false,
      expectedSettlementDays: null,
      installmentPlan: null,
      installments: null,
      method: "pix",
      paymentProfileId: null,
      paymentProfileName: null,
      paymentProfileRuleId: null,
      paymentProfileVersion: null,
      processingFee: {
        amount: null,
        fixedAmount: null,
        mode: "unknown",
        percentage: null,
      },
    },
    sale: {
      commandId: "00000000-0000-4000-8000-000000000060",
      confirmedAt: "2026-06-10T12:00:01.000Z",
      currency: "BRL",
      id: SALE_ID,
      occurredAt: "2026-06-10T12:00:00.000Z",
      occurredOn: "2026-06-10",
      recordedAt: null,
    },
    totals: {
      discountTotal: "0.00",
      freightTotal: "0.00",
      paymentSurchargeTotal: "0.00",
      subtotal: "99.80",
      surchargeTotal: "0.00",
      totalDue: "99.80",
    },
  },
});

/** The server refused the return because the sale changed: the page reads the detail again. */
const saleChanged = () =>
  Object.assign(new Error("conflito"), { code: "CONFLICT" });

function renderPage() {
  window.history.replaceState(null, "", `/sales/detail?saleId=${SALE_ID}`);
  return render(
    <StaticOrganizationProvider organization={ORGANIZATION}>
      <SaleDetailPage />
    </StaticOrganizationProvider>
  );
}

async function openReturnFromMenu() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", ACTIONS_MENU));
  await user.click(await screen.findByRole("menuitem", REGISTER_RETURN));
}

async function openAndConfirmReturn() {
  await openReturnFromMenu();
  fireEvent.change(await screen.findByRole("textbox", RETURNED_FIELD), {
    target: { value: "1" },
  });
  expect(screen.getByRole("heading", RETURN_HEADING)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Revisar devolução" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Confirmar devolução" })
  );
  await waitFor(() => expect(returnSale).toHaveBeenCalledTimes(1));
}

beforeEach(() => {
  getSale.mockReset();
  getCustomerLink.mockReset();
  returnSale.mockReset();
  getCustomerLink.mockResolvedValue(NO_CUSTOMER_LINK);
  returnSale.mockRejectedValue(saleChanged());
});

afterEach(cleanup);

describe("the dialogs of the sale detail after a change to the returnable quantities", () => {
  it("closes the return dialog, back to its start, when the available quantities change, and does not read the customer again", async () => {
    getSale.mockResolvedValueOnce(detail(0)).mockResolvedValueOnce(detail(1));
    renderPage();
    await openAndConfirmReturn();
    await waitFor(() =>
      expect(screen.queryByRole("dialog", RETURN_HEADING)).toBeNull()
    );
    expect(getCustomerLink).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", ACTIONS_MENU)).toBeTruthy();
    expect(getSale).toHaveBeenCalledTimes(2);
  });

  it("keeps the return dialog open, with its failure, when the detail is read again with the same available quantities", async () => {
    getSale
      .mockResolvedValueOnce(detail(0))
      .mockResolvedValueOnce(detail(0, REREAD_MARKER));
    renderPage();
    await openAndConfirmReturn();
    await screen.findByText(REREAD_MARKER_LINE);

    expect(getCustomerLink).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("dialog", RETURN_HEADING)).toBeTruthy();
  });

  it("closes the dialog after a return the server accepted, reads the customer again, and the reopened one keeps nothing of the old draft", async () => {
    getSale.mockResolvedValueOnce(detail(0)).mockResolvedValueOnce(detail(1));
    returnSale.mockResolvedValue(RETURN_RESULT);
    renderPage();
    await openReturnFromMenu();
    fireEvent.change(await screen.findByRole("textbox", RETURNED_FIELD), {
      target: { value: "1" },
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", REASON_FIELD));
    await user.click(
      await screen.findByRole("option", { name: "Item com defeito" })
    );
    fireEvent.change(await screen.findByRole("textbox", NOTE_FIELD), {
      target: { value: DRAFT_NOTE },
    });
    fireEvent.click(screen.getByRole("button", { name: "Revisar devolução" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Confirmar devolução" })
    );

    await waitFor(() =>
      expect(screen.queryByRole("dialog", RETURN_HEADING)).toBeNull()
    );
    expect(returnSale).toHaveBeenCalledTimes(1);
    expect(returnSale).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [expect.objectContaining({ position: 0, returnedQuantity: 1 })],
        reasonCode: "defective",
        reasonNote: DRAFT_NOTE,
      })
    );
    expect(getSale).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(getCustomerLink).toHaveBeenCalledTimes(2));

    await openReturnFromMenu();
    const returned = await screen.findByRole("textbox", RETURNED_FIELD_AFTER);
    expect((returned as HTMLInputElement).value).toBe("");
    expect(screen.queryByDisplayValue(DRAFT_NOTE)).toBeNull();
    expect(screen.getByRole("combobox", REASON_FIELD).textContent).toContain(
      "Sem motivo informado"
    );
  });
});
