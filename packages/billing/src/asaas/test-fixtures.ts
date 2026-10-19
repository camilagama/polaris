/**
 * Asaas payloads for the tests, built from the SHAPE of what the sandbox
 * returned on 19/10/2026 (spike t092: key names and types, never the values).
 * Every value here is made up; the personal data and the card are fake on
 * purpose, so a test can prove none of it leaves the adapter (AC-3).
 */

export const FAKE_PAYER = {
  cpf: "529.982.247-25",
  email: "pagador.teste@example.com",
  name: "Pagadora de Teste",
} as const;
export const FAKE_CARD_TOKEN = "tok_FAKE_9f8e7d6c5b4a39281706";
export const FAKE_INVOICE_URL = "https://sandbox.asaas.com/i/fakeinvoice000";
export const POLARIS_REF = "pol_3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b";
export const SUBSCRIPTION_ID = "sub_fake0000000001";
export const PAYMENT_ID = "pay_fake0000000001";
export const EVENT_ID = "evt_0123456789abcdef0123456789abcdef&100000001";

/** `GET /v3/subscriptions/{id}`. */
export function subscriptionJson(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    billingType: "CREDIT_CARD",
    checkoutSession: "c6d42a6f-0000-4000-8000-000000000001",
    creditCard: {
      creditCardBrand: "MASTERCARD",
      creditCardNumber: "4444",
      creditCardToken: FAKE_CARD_TOKEN,
    },
    customer: "cus_fake0000000001",
    cycle: "MONTHLY",
    dateCreated: "2026-10-19",
    deleted: false,
    description: "Polaris Pro mensal",
    externalReference: POLARIS_REF,
    fine: { type: "PERCENTAGE", value: 0 },
    id: SUBSCRIPTION_ID,
    interest: { type: "PERCENTAGE", value: 0 },
    nextDueDate: "2026-11-26",
    object: "subscription",
    paymentLink: null,
    sendPaymentByPostalService: false,
    split: null,
    status: "ACTIVE",
    value: 24.9,
    ...overrides,
  };
}

/** `GET /v3/payments/{id}`. The amount is written as `valueText` to keep its exact JSON form. */
export function paymentJson(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    anticipable: false,
    anticipated: false,
    bankSlipUrl: null,
    billingType: "CREDIT_CARD",
    checkoutSession: "c6d42a6f-0000-4000-8000-000000000001",
    clientPaymentDate: "2026-10-26",
    confirmedDate: "2026-10-26",
    creditCard: {
      creditCardBrand: "MASTERCARD",
      creditCardNumber: "4444",
      creditCardToken: FAKE_CARD_TOKEN,
    },
    creditDate: null,
    customer: "cus_fake0000000001",
    dateCreated: "2026-10-19",
    deleted: false,
    description: "Polaris Pro mensal",
    discount: { dueDateLimitDays: 0, limitDate: null, type: "FIXED", value: 0 },
    dueDate: "2026-10-26",
    escrow: null,
    estimatedCreditDate: null,
    externalReference: POLARIS_REF,
    fine: { type: "FIXED", value: 0 },
    id: PAYMENT_ID,
    installmentNumber: null,
    interest: { type: "PERCENTAGE", value: 0 },
    interestValue: null,
    invoiceNumber: "000000001",
    invoiceUrl: FAKE_INVOICE_URL,
    lastBankSlipViewedDate: null,
    lastInvoiceViewedDate: null,
    netValue: 23.91,
    nossoNumero: null,
    object: "payment",
    originalDueDate: "2026-10-26",
    originalValue: null,
    paymentDate: null,
    paymentLink: null,
    pixTransaction: null,
    postalService: false,
    refunds: null,
    status: "CONFIRMED",
    subscription: SUBSCRIPTION_ID,
    transactionReceiptUrl: "https://sandbox.asaas.com/comprovantes/fake000",
    value: 24.9,
    ...overrides,
  };
}

/**
 * A webhook body. The payment inside it is the body's claim, with the payer's
 * data the documentation shows; the adapter must not use any of it.
 */
export function webhookBody(
  event: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    dateCreated: "2026-10-26 09:15:00",
    event,
    id: EVENT_ID,
    payment: {
      ...paymentJson(),
      customer: {
        cpfCnpj: FAKE_PAYER.cpf,
        email: FAKE_PAYER.email,
        name: FAKE_PAYER.name,
      },
    },
    ...overrides,
  };
}
