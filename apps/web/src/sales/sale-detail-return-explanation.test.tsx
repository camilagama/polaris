// @vitest-environment happy-dom
import type { SaleDetailReadModel } from "@polaris/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getSale = vi.fn();

vi.mock("../lib/orpc", () => ({
  orpcClient: {
    customer: { get: vi.fn(), list: vi.fn() },
    sale: {
      get: (input: unknown) => getSale(input),
      getCustomerLink: vi.fn().mockResolvedValue({
        current: { customerId: null, version: 0 },
        history: [],
        saleId: "00000000-0000-4000-8000-000000000070",
      }),
      return: vi.fn(),
    },
  },
}));

import { StaticOrganizationProvider } from "../lib/current-organization";
import { SaleDetailPage } from "./sale-detail-page";
import { RETURN_EXPLANATION, returnExplanation } from "./sale-return-model";

const ORGANIZATION = {
  id: "0199c2d0-0000-7000-8000-00000000a001",
  name: "Loja do teste",
  role: "owner",
  timezone: "America/Sao_Paulo",
};
const SALE_ID = "00000000-0000-4000-8000-000000000070";
const ACTIONS_MENU = { name: /^Ações/ };
const REGISTER_RETURN = { name: "Registrar devolução" };
const LONG_JOURNEY = 20_000;

const noFee = {
  amount: "0.00",
  fixedAmount: null,
  mode: "not_applicable",
  percentage: null,
} as const;

const part = (position: number, amount: string, method: "pix" | "cash") =>
  ({
    amount,
    anticipationFee: noFee,
    anticipationRequested: false,
    expectedSettlementDays: null,
    installmentPlan: null,
    installments: null,
    method,
    paymentProfileId: null,
    paymentProfileName: null,
    paymentProfileRuleId: null,
    paymentProfileVersion: null,
    position,
    processingFee: {
      amount: null,
      fixedAmount: null,
      mode: "unknown",
      percentage: null,
    },
  }) as const;

const detail = (
  payments: NonNullable<SaleDetailReadModel["sale"]["payments"]>
): SaleDetailReadModel => {
  const [first] = payments;
  if (!first) {
    throw new Error("a sale needs a part");
  }
  return {
    cancellation: null,
    customer: { customerId: null, version: 0 },
    returnSummary: [
      {
        availableToReturn: 2,
        position: 0,
        restockedQuantity: 0,
        returnedQuantity: 0,
        sold: 2,
      },
    ],
    returns: [],
    sale: {
      adjustments: [],
      items: [
        {
          chargedUnitPrice: "50.00",
          listedUnitPrice: "50.00",
          position: 0,
          productId: "00000000-0000-4000-8000-000000000050",
          productLabel: "Camiseta — Azul / M",
          quantity: 2,
          unitCost: null,
          variantId: "00000000-0000-4000-8000-000000000051",
        },
      ],
      payment: first,
      payments,
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
        subtotal: "100.00",
        surchargeTotal: "0.00",
        totalDue: "100.00",
      },
    },
  };
};

async function openReturnDialog() {
  window.history.replaceState(null, "", `/sales/detail?saleId=${SALE_ID}`);
  render(
    <StaticOrganizationProvider organization={ORGANIZATION}>
      <SaleDetailPage />
    </StaticOrganizationProvider>
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", ACTIONS_MENU));
  await user.click(await screen.findByRole("menuitem", REGISTER_RETURN));
  return screen.findByRole("dialog", REGISTER_RETURN);
}

beforeEach(() => {
  getSale.mockReset();
});

afterEach(cleanup);

describe("the explanation of the return on the sale detail", () => {
  it(
    "gives the return dialog of a sale paid in two parts the explanation for two parts",
    async () => {
      getSale.mockResolvedValue(
        detail([part(0, "40.00", "pix"), part(1, "60.00", "cash")])
      );
      const dialog = await openReturnDialog();
      expect(dialog.textContent).toContain(returnExplanation(2));
      expect(dialog.textContent).toContain("pelo mesmo meio de cada parte");
    },
    LONG_JOURNEY
  );

  it(
    "gives the return dialog of a sale paid in one part the explanation with no sentence about parts",
    async () => {
      getSale.mockResolvedValue(detail([part(0, "100.00", "pix")]));
      const dialog = await openReturnDialog();
      expect(dialog.textContent).toContain(RETURN_EXPLANATION);
      expect(dialog.textContent).not.toContain("cada parte");
    },
    LONG_JOURNEY
  );
});
