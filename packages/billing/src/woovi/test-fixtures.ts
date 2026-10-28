/**
 * Woovi payloads for the tests, built from the SHAPE of what the sandbox
 * returned and of the documentation (key names and types, never
 * the values). Every value here is made up; the personal data and the Pix
 * payload are fake on purpose, so a test can prove none of it leaves the
 * adapter (AC-3). No key lives here: a test generates its own RSA pair.
 */

const FAKE_PAYER = {
  cpf: "52998224725",
  email: "pagador.teste@example.com",
  name: "Pagadora de Teste",
  phone: "+5511987654321",
  street: "Rua Ficticia 123",
} as const;
const FAKE_EMV =
  "00020126FAKE0000PIXAUTOMATICO5204000053039865802BR5909POLARISFK6009SAO PAULO62070503***6304ABCD";
const FAKE_PIX_KEY = "chave.pix.falsa@example.com";
const FAKE_PAYMENT_LINK = "https://woovi-sandbox.com/pay/fake-link-0001";

const SUBSCRIPTION_HEX = "6a1b2c3d4e5f60718293a4b5";
const OTHER_SUBSCRIPTION_HEX = "6a1b2c3d4e5f60718293a4b6";
const INSTALLMENT_HEX = "6b1b2c3d4e5f60718293a4c7";
const OTHER_INSTALLMENT_HEX = "6b1b2c3d4e5f60718293a4c8";

export const SUBSCRIPTION_ID = btoa(`PaymentSubscription:${SUBSCRIPTION_HEX}`);
export const OTHER_SUBSCRIPTION_ID = btoa(
  `PaymentSubscription:${OTHER_SUBSCRIPTION_HEX}`
);
export const INSTALLMENT_ID = btoa(
  `PaymentSubscriptionInstallment:${INSTALLMENT_HEX}`
);
export const OTHER_INSTALLMENT_ID = btoa(
  `PaymentSubscriptionInstallment:${OTHER_INSTALLMENT_HEX}`
);
/** The same IDs as logs show them: decoded. */
export const SUBSCRIPTION_LOG_ID = `PaymentSubscription:${SUBSCRIPTION_HEX}`;
export const INSTALLMENT_LOG_ID = `PaymentSubscriptionInstallment:${INSTALLMENT_HEX}`;
const CUSTOMER_CORRELATION_ID = "cust-fake-0001";
const SUBSCRIPTION_CORRELATION_ID = "sub-corr-fake-0001";

/** A `globalID` of any type and 24 hex digits, written as Woovi writes it. */
export function globalId(type: string, hex = "0123456789abcdef01234567") {
  return btoa(`${type}:${hex}`);
}

/** The customer inside a subscription. */
function customerJson(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    address: {
      city: "Sao Paulo",
      complement: "",
      neighborhood: "Centro",
      number: "123",
      state: "SP",
      street: FAKE_PAYER.street,
      zipcode: "01000000",
    },
    correlationID: CUSTOMER_CORRELATION_ID,
    email: FAKE_PAYER.email,
    name: FAKE_PAYER.name,
    phone: FAKE_PAYER.phone,
    taxID: { taxID: FAKE_PAYER.cpf, type: "BR:CPF" },
    ...overrides,
  };
}

/** `GET /api/v1/subscriptions/{id}` without the `{ subscription }` wrapper. */
export function subscriptionJson(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    correlationID: SUBSCRIPTION_CORRELATION_ID,
    customer: customerJson(),
    dayGenerateCharge: 27,
    frequency: "MONTHLY",
    globalID: SUBSCRIPTION_ID,
    name: "Polaris Pro mensal",
    paymentLink: FAKE_PAYMENT_LINK,
    pixRecurring: {
      emv: FAKE_EMV,
      journey: "ONLY_RECURRENCY",
      paymentLinkID: "fake-payment-link-id-0001",
      recurrencyId: "RN0000000020261020FAKE000001",
      status: "APPROVED",
    },
    status: "ACTIVE",
    type: "PIX_RECURRING",
    value: 2490,
    ...overrides,
  };
}

/** A subscription whose payer has not acted yet: `pixRecurring.status` is absent. */
export function subscriptionBeforeApprovalJson(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  const base = subscriptionJson();
  const { status: _status, ...pix } = base.pixRecurring as Record<
    string,
    unknown
  >;
  return { ...base, pixRecurring: pix, ...overrides };
}

/** `GET /api/v1/installments/{id}` (not wrapped). */
export function installmentJson(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    cobr: {
      createdAt: "2026-10-20T12:00:00.000Z",
      endToEndId: "E00000000202610271200FAKE0000001",
      identifierId: "fake-identifier-0001",
      installmentId: "fake-installment-0001",
      recurrencyId: "RN0000000020261020FAKE000001",
      status: "CONCLUDED",
      tries: [
        {
          createdAt: "2026-10-24T12:00:00.000Z",
          finalityPurpose: "RECURRENCE_PAYMENT",
          requestedExecutionDate: "2026-10-27",
          tryStatus: "PAID",
          updatedAt: "2026-10-27T12:00:00.000Z",
          value: 2490,
        },
      ],
      value: 2490,
    },
    createdAt: "2026-10-20T12:00:00.000Z",
    dateGenerateCharge: "2026-10-27T12:00:00.000Z",
    expiration: 86_400,
    globalID: INSTALLMENT_ID,
    installmentNumber: 1,
    paymentSubscriptionGlobalID: SUBSCRIPTION_ID,
    status: "COMPLETED",
    value: 2490,
    ...overrides,
  };
}

/** The body of `PIX_AUTOMATIC_APPROVED` and `PIX_AUTOMATIC_REJECTED`: the body's claim, with personal data. */
export function subscriptionWebhookBody(
  event: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  const {
    name: _name,
    paymentLink: _link,
    type: _type,
    ...claim
  } = subscriptionJson();
  return { ...claim, event, ...overrides };
}

/** The body of `PIX_AUTOMATIC_COBR_*`: the body's claim. */
export function installmentWebhookBody(
  event: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    ...installmentJson(),
    correlationID: "inst-corr-fake-0001",
    event,
    ...overrides,
  };
}

/** `PIX_TRANSACTION_REFUND_SENT_CONFIRMED`, with the holder's data of the documentation. */
export function refundWebhookBody(): Record<string, unknown> {
  const holder = {
    account: { accountNumber: "12345", agency: "0001" },
    holder: { name: FAKE_PAYER.name, taxID: { taxID: FAKE_PAYER.cpf } },
    pixKey: FAKE_PIX_KEY,
  };
  return {
    event: "PIX_TRANSACTION_REFUND_SENT_CONFIRMED",
    originalTransaction: { ...holder, value: 2490 },
    refundTransaction: { ...holder, value: 2490 },
  };
}

/** `OPENPIX:DISPUTE_CREATED`. */
export function disputeWebhookBody(): Record<string, unknown> {
  return {
    dispute: {
      disputeReason: "FRAUD",
      email: FAKE_PAYER.email,
      endToEndId: "E00000000202610271200FAKE0000001",
      name: FAKE_PAYER.name,
      phoneNumber: FAKE_PAYER.phone,
      status: "OPEN",
      value: 2490,
    },
    event: "OPENPIX:DISPUTE_CREATED",
  };
}

/** Values that must never appear in a fact, a log or an answer. */
export const PERSONAL_VALUES: readonly string[] = [
  FAKE_PAYER.cpf,
  FAKE_PAYER.email,
  FAKE_PAYER.name,
  FAKE_PAYER.phone,
  FAKE_PAYER.street,
  FAKE_EMV,
  FAKE_PIX_KEY,
  FAKE_PAYMENT_LINK,
];

/** An RSA pair made for a test: the public key as base64 of its SPKI DER, and a signer over text. */
export async function generateSigningKey(modulusLength: 1024 | 2048 = 2048) {
  const pair = await crypto.subtle.generateKey(
    {
      hash: "SHA-256",
      modulusLength,
      name: "RSASSA-PKCS1-v1_5",
      publicExponent: new Uint8Array([1, 0, 1]),
    },
    true,
    ["sign", "verify"]
  );
  const spki = new Uint8Array(
    await crypto.subtle.exportKey("spki", pair.publicKey)
  );
  const publicKey = btoa(String.fromCharCode(...spki));
  const sign = async (text: string): Promise<string> => {
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        pair.privateKey,
        new TextEncoder().encode(text)
      )
    );
    return btoa(String.fromCharCode(...signature));
  };
  return { publicKey, sign };
}
