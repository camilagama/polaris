/**
 * A confirmed sale as `sale/get` answers it, with its customer link and the customers of the organization, for the
 * screen checks of the sale detail and of the customer page (synthetic data only). Two lines: the first has a
 * return made, the second a long name, so the return table shows a partial line and a name that wraps.
 */
const SALE_DETAIL_ORGANIZATION_ID = "0199c2d0-0000-7000-8000-00000000a001";

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
      returnedAt: "2026-10-15T12:00:00.000Z",
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
      confirmedAt: "2026-10-14T12:00:01.000Z",
      currency: "BRL",
      id: DETAIL_SALE_ID,
      occurredAt: "2026-10-14T12:00:00.000Z",
      occurredOn: "2026-10-14",
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
      createdAt: "2026-10-14T12:05:00.000Z",
      customerId: CUSTOMER_ANGELA,
      version: 1,
    },
  ],
  saleId: DETAIL_SALE_ID,
};

const customer = (customerId: string, name: string) => ({
  anonymizedAt: null,
  archivedAt: null,
  createdAt: "2026-10-01T12:00:00.000Z",
  email: null,
  id: customerId,
  name,
  notes: null,
  organizationId: SALE_DETAIL_ORGANIZATION_ID,
  phone: null,
  status: "active",
  updatedAt: "2026-10-01T12:00:00.000Z",
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

/** The answers of the detail and of the customer page, by procedure (`/rpc/<procedure>`). */
export const saleDetailAnswers = ({
  withReturn,
}: {
  withReturn: boolean;
}): Readonly<Record<string, unknown>> => ({
  "customer/list": SALE_CUSTOMERS,
  "sale/get": withReturn ? SALE_DETAIL : SALE_DETAIL_WITHOUT_RETURNS,
  "sale/getCustomerLink": SALE_CUSTOMER_LINK,
});
