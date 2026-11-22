import type { Page } from "@playwright/test";

/**
 * A confirmed sale as `sale/get` answers it, with its customer link and the customers of the organization, for the
 * screen checks of the sale detail and of the customer page (synthetic data only). Two lines: the first has a
 * return made, the second a long name, so the return table shows a partial line and a name that wraps.
 */
const SALE_DETAIL_ORGANIZATION_ID = "0199c2d0-0000-7000-8000-00000000a001";

const NOW = new Date("2026-10-14T12:00:00.000Z");
const MINUTE = 60_000;
const DAY = 86_400_000;
const at = (offsetMs: number) =>
  new Date(NOW.getTime() + offsetMs).toISOString();

/** Opens the "Ações" menu of the title of the sale detail and chooses one of its items. */
export async function openSaleAction(page: Page, action: string) {
  await page.getByRole("button", { exact: true, name: "Ações" }).click();
  await page.getByRole("menuitem", { exact: true, name: action }).click();
}

/** Fixes the page clock on the day of the sale: everything the screens read from the fixture is dated from `NOW`. */
export async function fixSaleDetailClock(page: Page) {
  await page.clock.setFixedTime(NOW);
}

const id = (n: number) =>
  `0199c2d0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

export const DETAIL_SALE_ID = id(0x7_00);
const CUSTOMER_ANGELA = id(0x7_10);
const CUSTOMER_BRUNO = id(0x7_11);

const zeroFee = (mode: string) => ({
  amount: mode === "unknown" ? null : "0.00",
  fixedAmount: null,
  mode,
  percentage: null,
});

const item = (
  position: number,
  productLabel: string,
  quantity: number,
  price: string
) => ({
  chargedUnitPrice: price,
  listedUnitPrice: price,
  position,
  productId: id(0x7_20 + position),
  productLabel,
  quantity,
  unitCost: null,
  variantId: id(0x7_30 + position),
});

const SALE_DETAIL = {
  cancellation: null,
  customer: { customerId: CUSTOMER_ANGELA, version: 1 },
  returnSummary: [
    {
      availableToReturn: 1,
      position: 0,
      restockedQuantity: 0,
      returnedQuantity: 1,
      sold: 2,
    },
    {
      availableToReturn: 3,
      position: 1,
      restockedQuantity: 0,
      returnedQuantity: 0,
      sold: 3,
    },
  ],
  returns: [
    {
      commandId: id(0x7_40),
      id: id(0x7_41),
      items: [{ position: 0, restockedQuantity: 0, returnedQuantity: 1 }],
      reasonCode: "defective",
      reasonNote: "Rasgada",
      returnedAt: at(DAY),
      returnedBy: "user_1",
      saleId: DETAIL_SALE_ID,
    },
  ],
  sale: {
    adjustments: [],
    items: [
      item(0, "Calça jeans — 42", 2, "114.95"),
      item(
        1,
        "Camiseta básica de algodão orgânico com estampa exclusiva — G",
        3,
        "59.90"
      ),
    ],
    payment: {
      amount: "409.60",
      anticipationFee: zeroFee("not_applicable"),
      anticipationRequested: false,
      expectedSettlementDays: null,
      installmentPlan: null,
      installments: null,
      method: "pix",
      paymentProfileId: null,
      paymentProfileName: null,
      paymentProfileRuleId: null,
      paymentProfileVersion: null,
      processingFee: zeroFee("unknown"),
    },
    sale: {
      commandId: id(0x7_42),
      confirmedAt: at(1000),
      currency: "BRL",
      id: DETAIL_SALE_ID,
      occurredAt: at(0),
      occurredOn: at(0).slice(0, 10),
      recordedAt: null,
    },
    totals: {
      discountTotal: "0.00",
      freightTotal: "0.00",
      paymentSurchargeTotal: "0.00",
      subtotal: "409.60",
      surchargeTotal: "0.00",
      totalDue: "409.60",
    },
  },
};

const SALE_CUSTOMER_LINK = {
  current: { customerId: CUSTOMER_ANGELA, version: 1 },
  history: [
    {
      action: "assign",
      createdAt: at(5 * MINUTE),
      customerId: CUSTOMER_ANGELA,
      version: 1,
    },
  ],
  saleId: DETAIL_SALE_ID,
};

const customer = (customerId: string, name: string) => ({
  anonymizedAt: null,
  archivedAt: null,
  createdAt: at(-13 * DAY),
  email: null,
  id: customerId,
  name,
  notes: null,
  organizationId: SALE_DETAIL_ORGANIZATION_ID,
  phone: null,
  status: "active",
  updatedAt: at(-13 * DAY),
  version: 1,
});

const SALE_CUSTOMERS = {
  customers: [
    customer(CUSTOMER_ANGELA, "Ângela Souza"),
    customer(CUSTOMER_BRUNO, "Bruno Lima"),
  ],
};

/** The same sale before any return: the only one where the cancellation is offered. */
const SALE_DETAIL_WITHOUT_RETURNS = {
  ...SALE_DETAIL,
  returnSummary: SALE_DETAIL.returnSummary.map((line) => ({
    ...line,
    availableToReturn: line.sold,
    returnedQuantity: 0,
  })),
  returns: [],
};

/** The same sale with a processing fee of R$ 12,75 recorded: the detail writes an amount in the payment block. */
const SALE_DETAIL_WITH_FEE = {
  ...SALE_DETAIL,
  sale: {
    ...SALE_DETAIL.sale,
    payment: {
      ...SALE_DETAIL.sale.payment,
      processingFee: {
        amount: "12.75",
        fixedAmount: "0.50",
        mode: "fixed_and_percentage",
        percentage: "2.99",
      },
    },
  },
};

/** The same sale cancelled: no return and no cancellation is offered, only the customer. */
const SALE_DETAIL_CANCELLED = {
  ...SALE_DETAIL_WITHOUT_RETURNS,
  cancellation: {
    cancelledAt: at(2 * DAY),
    cancelledBy: "user_1",
    commandId: id(0x7_50),
    id: id(0x7_51),
    reasonCode: null,
    reasonNote: null,
    saleId: DETAIL_SALE_ID,
  },
};

/** The same sale with every unit returned: nothing is left to return and it cannot be cancelled as a whole. */
const SALE_DETAIL_ALL_RETURNED = {
  ...SALE_DETAIL,
  returnSummary: SALE_DETAIL.returnSummary.map((line) => ({
    ...line,
    availableToReturn: 0,
    returnedQuantity: line.sold,
  })),
};

export type SaleDetailSituation = "allReturned" | "cancelled";

function saleDetailRead(
  withReturn: boolean,
  withFee: boolean,
  situation: SaleDetailSituation | undefined
) {
  if (situation === "cancelled") {
    return SALE_DETAIL_CANCELLED;
  }
  if (situation === "allReturned") {
    return SALE_DETAIL_ALL_RETURNED;
  }
  if (withFee) {
    return SALE_DETAIL_WITH_FEE;
  }
  return withReturn ? SALE_DETAIL : SALE_DETAIL_WITHOUT_RETURNS;
}

/** The answers of the detail and of the customer page, by procedure (`/rpc/<procedure>`). */
export const saleDetailAnswers = ({
  situation,
  withFee = false,
  withReturn,
}: {
  situation?: SaleDetailSituation | undefined;
  withFee?: boolean;
  withReturn: boolean;
}): Readonly<Record<string, unknown>> => ({
  "customer/get": customer(CUSTOMER_ANGELA, "Ângela Souza"),
  "customer/list": SALE_CUSTOMERS,
  "sale/get": saleDetailRead(withReturn, withFee, situation),
  "sale/getCustomerLink": SALE_CUSTOMER_LINK,
});
