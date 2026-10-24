import type { BillingFact, BillingRecord } from "@polaris/domain/billing/facts";
import { outboxIdempotencyKey } from "@polaris/domain/events/outbox";
import type { QueueEnvelope } from "@polaris/domain/events/queue-envelope";
import { logger } from "@polaris/observability/logger";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ClosureNoticeSender,
  ClosureNoticeSendResult,
} from "../privacy/closure-notice-email";
import { PermanentHandlerError } from "../queue/consumer";
import {
  type BillingNoticeDelivery,
  type BillingNoticeDependencies,
  type BillingNoticeEmailConfig,
  type BillingNoticeReader,
  type BillingNoticeRecipient,
  BillingNoticeRetryError,
  type BillingNoticeStoreFacts,
  billingNoticeEmailConfig,
  billingNoticeEmailOf,
  handleBillingNotice,
  handOverOwedBillingNotices,
} from "./notice-consumer";

const NOTICE = "0199f0aa-2b3c-7d4e-8f90-123456789abc";
const ORG = "org_billing_notice";
const ADDRESS = "dono@example.invalid";
const PAYER_ADDRESS = "pagador@example.invalid";
const STORE_NAME = "Loja de Teste";
const AMOUNT = "29.90";
const EVENT_ID = "0199f0aa-1111-7000-8000-000000000002";
const PROVIDER_REF = "sub_test_1";
const NOW = new Date("2026-10-24T15:00:00.000Z");
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

function envelope(overrides: Partial<QueueEnvelope> = {}): QueueEnvelope {
  return {
    attempt: 1,
    correlationId: "corr_1",
    event: { noticeId: NOTICE },
    eventId: "0199f0aa-0000-7000-8000-000000000001",
    idempotencyKey: outboxIdempotencyKey("billing.notice", NOTICE),
    organizationId: ORG,
    type: "billing.notice",
    version: 1,
    ...overrides,
  };
}

function recordOf(overrides: Partial<BillingRecord> = {}): BillingRecord {
  return {
    accessEndsAt: new Date("2026-11-20T15:00:00.000Z"),
    cancelAtPeriodEnd: false,
    cycleMonths: 1,
    lastFactAt: null,
    pendingCycleMonths: null,
    revoked: null,
    state: "active",
    trialConsumed: true,
    ...overrides,
  };
}

function chargeSucceeded(amount?: string): BillingFact {
  return {
    ...(amount ? { amount: { currency: "BRL" as const, value: amount } } : {}),
    cycleMonths: 1,
    occurredAt: new Date("2026-10-24T14:00:00.000Z"),
    periodEndsAt: new Date("2026-11-24T14:00:00.000Z"),
    type: "charge_succeeded",
  };
}

/** A receipt (E4) of a renewal, due and still true, with the amount the provider reported. */
function deliveryOf(
  overrides: Partial<BillingNoticeDelivery> = {}
): BillingNoticeDelivery {
  return {
    cycleMonths: 1,
    dedupeKey: EVENT_ID,
    dueAt: new Date(NOW.getTime() - MINUTE_MS),
    event: {
      fact: chargeSucceeded(AMOUNT),
      id: EVENT_ID,
      providerRef: PROVIDER_REF,
    },
    firstChargeAmount: null,
    firstChargeAt: null,
    firstChargeEventId: null,
    firstChargeOn: null,
    kind: "charge_receipt",
    noticeId: NOTICE,
    organizationId: ORG,
    overLimitSince: null,
    paidSinceNotice: false,
    priceAmount: null,
    provider: "asaas",
    providerRef: PROVIDER_REF,
    record: recordOf(),
    recordedAt: new Date(NOW.getTime() - 11 * MINUTE_MS),
    refundRequestedAt: null,
    renewalFailedSentAt: [],
    trialStartedSentAt: null,
    ...overrides,
  };
}

function welcomeDelivery(): BillingNoticeDelivery {
  return deliveryOf({
    dedupeKey: "user_owner",
    event: null,
    kind: "welcome",
    provider: null,
    providerRef: null,
  });
}

const storeFacts: BillingNoticeStoreFacts = {
  closed: false,
  name: STORE_NAME,
  ownerActive: true,
  timeZone: "America/Sao_Paulo",
  variantLimit: 50,
  variants: 80,
};

const emailConfig: BillingNoticeEmailConfig = {
  apiKey: "re_test_key_not_real",
  appOrigin: "https://app.example.invalid",
  from: "Polaris <avisos@example.invalid>",
  supportEmail: "suporte@example.invalid",
};

function setup(
  options: {
    billingEmail?: BillingNoticeEmailConfig | null;
    delivery?: BillingNoticeDelivery | null;
    recipient?: BillingNoticeRecipient | null;
    result?: ClosureNoticeSendResult;
    store?: BillingNoticeStoreFacts | null;
    welcomeEmail?: BillingNoticeEmailConfig | null;
  } = {}
) {
  const found =
    options.delivery === undefined ? deliveryOf() : options.delivery;
  const store = options.store === undefined ? storeFacts : options.store;
  const recipient =
    options.recipient === undefined
      ? { email: ADDRESS, verified: true as const }
      : options.recipient;
  const send = vi.fn<ClosureNoticeSender>(() =>
    Promise.resolve(options.result ?? { outcome: "sent" })
  );
  const recipients = {
    recipient: vi.fn((_notice: string, _org: string) =>
      Promise.resolve(recipient)
    ),
  };
  const stores = {
    storeOf: vi.fn((_notice: string, _org: string) => Promise.resolve(store)),
  };
  const notices = {
    claim: vi.fn((_notice: string, _org: string) => Promise.resolve(found)),
    listOwed: vi.fn(
      (_now: Date, _limit: number) =>
        Promise.resolve([]) as Promise<
          { noticeId: string; organizationId: string }[]
        >
    ),
    markFailed: vi.fn((_notice: string, _org: string, _code: string) =>
      Promise.resolve(true)
    ),
    markSent: vi.fn((_notice: string, _org: string) => Promise.resolve(true)),
    markSkipped: vi.fn((_notice: string, _org: string, _reason: string) =>
      Promise.resolve(true)
    ),
  } satisfies BillingNoticeReader;
  const dependencies: BillingNoticeDependencies = {
    billingEmail:
      options.billingEmail === undefined ? emailConfig : options.billingEmail,
    notices,
    now: () => NOW,
    recipients,
    send,
    stores,
    welcomeEmail:
      options.welcomeEmail === undefined ? emailConfig : options.welcomeEmail,
  };
  return { dependencies, notices, recipients, send, stores };
}

function spyLogger() {
  return {
    error: vi.spyOn(logger, "error").mockImplementation(() => undefined),
    info: vi.spyOn(logger, "info").mockImplementation(() => undefined),
    warn: vi.spyOn(logger, "warn").mockImplementation(() => undefined),
  };
}

function everythingLogged(spies: ReturnType<typeof spyLogger>): string {
  return JSON.stringify([
    spies.info.mock.calls,
    spies.warn.mock.calls,
    spies.error.mock.calls,
  ]);
}

function expectNoPersonalData(text: string) {
  expect(text).not.toContain(ADDRESS);
  expect(text).not.toContain(PAYER_ADDRESS);
  expect(text).not.toContain(STORE_NAME);
  expect(text).not.toContain(AMOUNT);
  expect(text).not.toContain("29,90");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the consumer of a billing notice: the envelope and the claim", () => {
  it("refuses an event whose body and outbox key name different notices, for good", async () => {
    spyLogger();
    const { dependencies, notices } = setup();
    for (const wrong of [
      envelope({ event: { noticeId: "0199f0aa-2b3c-7d4e-8f90-000000000000" } }),
      envelope({ event: { noticeId: 7 } }),
      envelope({
        event: { noticeId: "not-a-uuid" },
        idempotencyKey: "billing.notice:not-a-uuid",
      }),
      envelope({ event: {} }),
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: one refusal at a time, for a clear failure
      await expect(
        handleBillingNotice(dependencies, wrong)
      ).rejects.toBeInstanceOf(PermanentHandlerError);
    }
    expect(notices.claim).not.toHaveBeenCalled();
  });

  it("does nothing when the claim finds the notice not owed (not_due)", async () => {
    const spies = spyLogger();
    const { dependencies, notices, recipients, send, stores } = setup({
      delivery: null,
    });

    const outcome = await handleBillingNotice(dependencies, envelope());

    expect(outcome).toBe("not_due");
    expect(notices.claim).toHaveBeenCalledWith(NOTICE, ORG);
    expect(stores.storeOf).not.toHaveBeenCalled();
    expect(recipients.recipient).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(notices.markSent).not.toHaveBeenCalled();
    expect(notices.markSkipped).not.toHaveBeenCalled();
    expect(notices.markFailed).not.toHaveBeenCalled();
    expectNoPersonalData(everythingLogged(spies));
  });
});

describe("the consumer of a billing notice: not yet due", () => {
  it("leaves a notice due in the future owed, marking and sending nothing", async () => {
    const spies = spyLogger();
    const { dependencies, notices, recipients, send, stores } = setup({
      delivery: deliveryOf({ dueAt: new Date(NOW.getTime() + MINUTE_MS) }),
    });

    const outcome = await handleBillingNotice(dependencies, envelope());

    expect(outcome).toBe("not_yet_due");
    expect(stores.storeOf).not.toHaveBeenCalled();
    expect(recipients.recipient).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(notices.markSent).not.toHaveBeenCalled();
    expect(notices.markSkipped).not.toHaveBeenCalled();
    expect(notices.markFailed).not.toHaveBeenCalled();
    expectNoPersonalData(everythingLogged(spies));
  });

  it("holds a receipt (E4) for 10 minutes and sends it at the 10th", async () => {
    spyLogger();
    const dueAt = new Date(NOW.getTime() + 10 * MINUTE_MS);
    const early = setup({ delivery: deliveryOf({ dueAt }) });
    early.dependencies.now = () => new Date(dueAt.getTime() - 1000);
    const onTime = setup({ delivery: deliveryOf({ dueAt }) });
    onTime.dependencies.now = () => dueAt;

    expect(await handleBillingNotice(early.dependencies, envelope())).toBe(
      "not_yet_due"
    );
    expect(await handleBillingNotice(onTime.dependencies, envelope())).toBe(
      "sent"
    );
    expect(early.send).not.toHaveBeenCalled();
    expect(onTime.send).toHaveBeenCalledTimes(1);
  });

  function cancellation(overrides: Partial<BillingNoticeDelivery> = {}) {
    return deliveryOf({
      dedupeKey: EVENT_ID,
      event: {
        fact: {
          occurredAt: new Date("2026-10-24T14:00:00.000Z"),
          type: "subscription_cancelled",
        },
        id: EVENT_ID,
        providerRef: PROVIDER_REF,
      },
      kind: "renewal_cancelled",
      record: recordOf({ cancelAtPeriodEnd: true }),
      ...overrides,
    });
  }

  it("holds a cancellation (E7) for 10 minutes", async () => {
    spyLogger();
    const dueAt = new Date(NOW.getTime() + 10 * MINUTE_MS);
    const early = setup({ delivery: cancellation({ dueAt }) });
    early.dependencies.now = () => new Date(dueAt.getTime() - 1000);
    const onTime = setup({ delivery: cancellation({ dueAt }) });
    onTime.dependencies.now = () => dueAt;

    expect(await handleBillingNotice(early.dependencies, envelope())).toBe(
      "not_yet_due"
    );
    expect(await handleBillingNotice(onTime.dependencies, envelope())).toBe(
      "sent"
    );
  });

  it("holds a cancellation that came with a refund request for 24 hours", async () => {
    spyLogger();
    const requestedAt = new Date(NOW.getTime());
    const dueAt = new Date(requestedAt.getTime() + 24 * HOUR_MS);
    const delivery = cancellation({ dueAt, refundRequestedAt: requestedAt });
    const early = setup({ delivery });
    early.dependencies.now = () => new Date(dueAt.getTime() - MINUTE_MS);
    const onTime = setup({ delivery });
    onTime.dependencies.now = () => dueAt;

    expect(await handleBillingNotice(early.dependencies, envelope())).toBe(
      "not_yet_due"
    );
    expect(early.notices.markSkipped).not.toHaveBeenCalled();
    expect(await handleBillingNotice(onTime.dependencies, envelope())).toBe(
      "sent"
    );
    expect(onTime.notices.markSent).toHaveBeenCalledWith(NOTICE, ORG);
  });
});

describe("the consumer of a billing notice: skipped before sending", () => {
  it("skips a billing notice as email_not_configured, reading no store and no recipient, while the billing e-mail is off", async () => {
    const spies = spyLogger();
    const { dependencies, notices, recipients, send, stores } = setup({
      billingEmail: null,
    });

    const outcome = await handleBillingNotice(dependencies, envelope());

    expect(outcome).toBe("skipped");
    expect(notices.markSkipped).toHaveBeenCalledWith(
      NOTICE,
      ORG,
      "email_not_configured"
    );
    expect(stores.storeOf).not.toHaveBeenCalled();
    expect(recipients.recipient).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(notices.markSent).not.toHaveBeenCalled();
    expect(spies.info).toHaveBeenCalledWith(
      "billing_notice_skipped",
      expect.objectContaining({
        kind: "charge_receipt",
        outcome: "skipped",
        reason: "email_not_configured",
      })
    );
    expectNoPersonalData(everythingLogged(spies));
  });

  it("skips a billing notice as email_not_configured when only the welcome e-mail is on", async () => {
    spyLogger();
    const { dependencies, notices, recipients, send, stores } = setup({
      billingEmail: null,
      welcomeEmail: emailConfig,
    });

    expect(await handleBillingNotice(dependencies, envelope())).toBe("skipped");

    expect(notices.markSkipped).toHaveBeenCalledWith(
      NOTICE,
      ORG,
      "email_not_configured"
    );
    expect(stores.storeOf).not.toHaveBeenCalled();
    expect(recipients.recipient).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("skips the welcome as email_not_configured while the welcome e-mail is off, even with the billing e-mail on", async () => {
    spyLogger();
    const { dependencies, notices, recipients, send, stores } = setup({
      billingEmail: emailConfig,
      delivery: welcomeDelivery(),
      welcomeEmail: null,
    });

    expect(await handleBillingNotice(dependencies, envelope())).toBe("skipped");

    expect(notices.markSkipped).toHaveBeenCalledWith(
      NOTICE,
      ORG,
      "email_not_configured"
    );
    expect(stores.storeOf).not.toHaveBeenCalled();
    expect(recipients.recipient).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("skips as no_recipient, without an error, when the store is gone (purged)", async () => {
    const spies = spyLogger();
    const { dependencies, notices, recipients, send } = setup({ store: null });

    const outcome = await handleBillingNotice(dependencies, envelope());

    expect(outcome).toBe("skipped");
    expect(notices.markSkipped).toHaveBeenCalledWith(
      NOTICE,
      ORG,
      "no_recipient"
    );
    expect(notices.markFailed).not.toHaveBeenCalled();
    expect(recipients.recipient).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(spies.error).not.toHaveBeenCalled();
  });

  it("skips a billing notice of a closed store as organization_closed (EM-7)", async () => {
    spyLogger();
    const { dependencies, notices, recipients, send } = setup({
      store: { ...storeFacts, closed: true },
    });

    expect(await handleBillingNotice(dependencies, envelope())).toBe("skipped");

    expect(notices.markSkipped).toHaveBeenCalledWith(
      NOTICE,
      ORG,
      "organization_closed"
    );
    expect(recipients.recipient).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("still sends the welcome of a closed store", async () => {
    spyLogger();
    const { dependencies, notices, send } = setup({
      delivery: welcomeDelivery(),
      store: { ...storeFacts, closed: true },
    });

    expect(await handleBillingNotice(dependencies, envelope())).toBe("sent");

    expect(send).toHaveBeenCalledTimes(1);
    expect(notices.markSent).toHaveBeenCalledWith(NOTICE, ORG);
    expect(notices.markSkipped).not.toHaveBeenCalled();
  });

  it("skips the eve of the first charge (E-B) as cancelled when the renewal was cancelled", async () => {
    spyLogger();
    const { dependencies, notices, send } = setup({
      delivery: deliveryOf({
        cycleMonths: 1,
        dedupeKey: PROVIDER_REF,
        event: null,
        firstChargeOn: "2026-10-25",
        kind: "trial_charge_eve",
        priceAmount: AMOUNT,
        record: recordOf({
          accessEndsAt: new Date("2026-10-25T15:00:00.000Z"),
          cancelAtPeriodEnd: true,
          state: "trialing",
        }),
      }),
    });

    expect(await handleBillingNotice(dependencies, envelope())).toBe("skipped");

    expect(notices.markSkipped).toHaveBeenCalledWith(NOTICE, ORG, "cancelled");
    expect(send).not.toHaveBeenCalled();
  });

  it("skips the failed first charge (E-C1) as recovered when a charge was applied after the notice", async () => {
    spyLogger();
    const { dependencies, notices, send } = setup({
      delivery: deliveryOf({
        dedupeKey: PROVIDER_REF,
        event: null,
        kind: "first_charge_failed",
        paidSinceNotice: true,
        priceAmount: AMOUNT,
        record: recordOf({ accessEndsAt: null, state: "free" }),
      }),
    });

    expect(await handleBillingNotice(dependencies, envelope())).toBe("skipped");

    expect(notices.markSkipped).toHaveBeenCalledWith(NOTICE, ORG, "recovered");
    expect(send).not.toHaveBeenCalled();
  });

  it("skips as price_unknown when the notice writes an amount nobody recorded", async () => {
    const spies = spyLogger();
    const { dependencies, notices, recipients, send } = setup({
      delivery: deliveryOf({
        event: {
          fact: chargeSucceeded(),
          id: EVENT_ID,
          providerRef: PROVIDER_REF,
        },
        priceAmount: null,
      }),
    });

    expect(await handleBillingNotice(dependencies, envelope())).toBe("skipped");

    expect(notices.markSkipped).toHaveBeenCalledWith(
      NOTICE,
      ORG,
      "price_unknown"
    );
    expect(recipients.recipient).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(spies.info).toHaveBeenCalledWith(
      "billing_notice_skipped",
      expect.objectContaining({ reason: "price_unknown" })
    );
  });
});

describe("the consumer of a billing notice: the recipient", () => {
  it("skips as no_recipient when the recipient is null", async () => {
    const spies = spyLogger();
    const { dependencies, notices, send } = setup({ recipient: null });

    expect(await handleBillingNotice(dependencies, envelope())).toBe("skipped");

    expect(notices.markSkipped).toHaveBeenCalledWith(
      NOTICE,
      ORG,
      "no_recipient"
    );
    expect(send).not.toHaveBeenCalled();
    expect(notices.markFailed).not.toHaveBeenCalled();
    expectNoPersonalData(everythingLogged(spies));
  });

  it("skips as email_not_verified, without sending, when the address is not verified", async () => {
    const spies = spyLogger();
    const { dependencies, notices, send } = setup({
      recipient: { verified: false },
    });

    expect(await handleBillingNotice(dependencies, envelope())).toBe("skipped");

    expect(notices.markSkipped).toHaveBeenCalledWith(
      NOTICE,
      ORG,
      "email_not_verified"
    );
    expect(send).not.toHaveBeenCalled();
    expect(notices.markSent).not.toHaveBeenCalled();
    expectNoPersonalData(everythingLogged(spies));
  });

  it("sends only to the address of the recipient (EM-6), never to the payer's", async () => {
    spyLogger();
    const { dependencies, recipients, send } = setup();

    await handleBillingNotice(dependencies, envelope());

    expect(recipients.recipient).toHaveBeenCalledWith(NOTICE, ORG);
    expect(send).toHaveBeenCalledTimes(1);
    const message = send.mock.calls[0]?.[0];
    expect(message?.to).toBe(ADDRESS);
    expect(JSON.stringify(message)).not.toContain(PAYER_ADDRESS);
  });
});

describe("the consumer of a billing notice: the provider's answer", () => {
  it("sends once under the notice's ID as the idempotency key, then marks it sent", async () => {
    const spies = spyLogger();
    const { dependencies, notices, send } = setup();

    const outcome = await handleBillingNotice(dependencies, envelope());

    expect(outcome).toBe("sent");
    expect(send).toHaveBeenCalledTimes(1);
    const message = send.mock.calls[0]?.[0];
    expect(message?.idempotencyKey).toBe(NOTICE);
    expect(message?.to).toBe(ADDRESS);
    expect(notices.markSent).toHaveBeenCalledWith(NOTICE, ORG);
    expect(notices.markFailed).not.toHaveBeenCalled();
    expect(notices.markSkipped).not.toHaveBeenCalled();
    expect(spies.info).toHaveBeenCalledWith(
      "billing_notice_sent",
      expect.objectContaining({ kind: "charge_receipt", outcome: "success" })
    );
    expectNoPersonalData(everythingLogged(spies));
  });

  it("marks the notice failed as email_rejected, with no retry, when the provider refuses the address", async () => {
    const spies = spyLogger();
    const { dependencies, notices, send } = setup({
      result: { code: null, outcome: "rejected", status: 422 },
    });

    const outcome = await handleBillingNotice(dependencies, envelope());

    expect(outcome).toBe("failed");
    expect(send).toHaveBeenCalledTimes(1);
    expect(notices.markFailed).toHaveBeenCalledWith(
      NOTICE,
      ORG,
      "email_rejected"
    );
    expect(notices.markSent).not.toHaveBeenCalled();
    expect(notices.markSkipped).not.toHaveBeenCalled();
    expect(spies.error).toHaveBeenCalledWith(
      "billing_notice_failed",
      expect.objectContaining({ httpStatus: 422, outcome: "rejected" })
    );
    expectNoPersonalData(everythingLogged(spies));
  });

  it.each([
    { label: "a 5xx", status: 503 },
    { label: "a 409", status: 409 },
    { label: "the network", status: null },
  ])("throws a retry error, marking nothing, on $label", async ({ status }) => {
    const spies = spyLogger();
    const { dependencies, notices } = setup({
      result: { code: null, outcome: "retry", status },
    });

    const failure = await handleBillingNotice(dependencies, envelope()).then(
      () => null,
      (error: unknown) => error
    );

    expect(failure).toBeInstanceOf(BillingNoticeRetryError);
    expect((failure as BillingNoticeRetryError).status).toBe(status);
    expectNoPersonalData((failure as Error).message);
    expect(notices.markSent).not.toHaveBeenCalled();
    expect(notices.markFailed).not.toHaveBeenCalled();
    expect(notices.markSkipped).not.toHaveBeenCalled();
    expect(spies.error).toHaveBeenCalledWith(
      "billing_notice_failed",
      expect.objectContaining({ outcome: "failure" })
    );
    expectNoPersonalData(everythingLogged(spies));
  });
});

describe("the handover of the owed billing notices", () => {
  it("asks for the owed notices with the clock, sends one at a time and counts each outcome without stopping at a retry", async () => {
    const spies = spyLogger();
    const { dependencies, notices, recipients, send } = setup();
    const owed = ["1", "2", "3", "4"].map((digit) => ({
      noticeId: `0199f0aa-2b3c-7d4e-8f90-12345678900${digit}`,
      organizationId: `org_${digit}`,
    }));
    notices.listOwed.mockResolvedValueOnce(owed);
    notices.claim.mockImplementation((noticeId, organizationId) =>
      Promise.resolve(deliveryOf({ noticeId, organizationId }))
    );
    send
      .mockResolvedValueOnce({ outcome: "sent" })
      .mockResolvedValueOnce({ code: null, outcome: "retry", status: 500 })
      .mockResolvedValueOnce({ code: null, outcome: "rejected", status: 400 });
    recipients.recipient
      .mockResolvedValueOnce({ email: ADDRESS, verified: true })
      .mockResolvedValueOnce({ email: ADDRESS, verified: true })
      .mockResolvedValueOnce({ email: ADDRESS, verified: true })
      .mockResolvedValueOnce({ verified: false });

    const report = await handOverOwedBillingNotices(dependencies, 10);

    expect(notices.listOwed).toHaveBeenCalledWith(NOW, 10);
    expect(report).toEqual({
      failed: 1,
      handedOver: 4,
      retry: 1,
      sent: 1,
      skipped: 1,
    });
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls.map(([message]) => message.idempotencyKey)).toEqual(
      owed.slice(0, 3).map((notice) => notice.noticeId)
    );
    expect(notices.markSent).toHaveBeenCalledTimes(1);
    expect(notices.markFailed).toHaveBeenCalledTimes(1);
    expect(notices.markSkipped).toHaveBeenCalledWith(
      owed[3]?.noticeId,
      "org_4",
      "email_not_verified"
    );
    expectNoPersonalData(everythingLogged(spies));
  });

  it("reports nothing when nothing is owed", async () => {
    spyLogger();
    const { dependencies, notices } = setup();

    const report = await handOverOwedBillingNotices(dependencies);

    expect(report).toEqual({
      failed: 0,
      handedOver: 0,
      retry: 0,
      sent: 0,
      skipped: 0,
    });
    expect(notices.listOwed).toHaveBeenCalledWith(NOW, 20);
  });
});

function configFor(
  bindings: Record<string, string | undefined>,
  switchValue: { value: string | undefined } = { value: "true" }
): ReturnType<typeof billingNoticeEmailConfig> {
  // exactOptionalPropertyTypes: an absent binding is a missing key, not an undefined one
  return billingNoticeEmailConfig(
    Object.fromEntries(
      Object.entries(bindings).filter(([, value]) => value !== undefined)
    ),
    switchValue.value
  );
}

describe("the configuration of the billing e-mails", () => {
  const on = {
    AUTH_EMAIL_FROM: " Polaris <avisos@example.invalid> ",
    BETTER_AUTH_BASE_URL: "https://app.example.invalid/some/path",
    BILLING_SUPPORT_EMAIL: " suporte@example.invalid ",
    RESEND_API_KEY: "re_test_key_not_real",
  };

  it("is on with the exact switch and every piece, with the origin of the app only", () => {
    expect(configFor(on)).toEqual({
      apiKey: "re_test_key_not_real",
      appOrigin: "https://app.example.invalid",
      from: "Polaris <avisos@example.invalid>",
      supportEmail: "suporte@example.invalid",
    });
  });

  it("stays off unless the switch is exactly true", () => {
    for (const value of [undefined, "", "TRUE", "True", "1", "yes", "false"]) {
      expect(configFor(on, { value })).toBeNull();
    }
  });

  it.each([
    "RESEND_API_KEY",
    "AUTH_EMAIL_FROM",
    "BILLING_SUPPORT_EMAIL",
    "BETTER_AUTH_BASE_URL",
  ])("stays off when %s is missing or blank", (name) => {
    expect(configFor({ ...on, [name]: undefined })).toBeNull();
    expect(configFor({ ...on, [name]: "  " })).toBeNull();
  });

  it("stays off when the app's URL is not a URL", () => {
    expect(configFor({ ...on, BETTER_AUTH_BASE_URL: "not a url" })).toBeNull();
  });

  it("accepts http only on localhost and refuses it anywhere else", () => {
    expect(
      configFor({ ...on, BETTER_AUTH_BASE_URL: "http://localhost:3000/x" })
        ?.appOrigin
    ).toBe("http://localhost:3000");
    expect(
      configFor({ ...on, BETTER_AUTH_BASE_URL: "http://app.example.invalid" })
    ).toBeNull();
  });
});

describe("the e-mail of a billing notice", () => {
  const origin = "https://app.example.invalid";
  const emailOf = (
    delivery: BillingNoticeDelivery,
    store: BillingNoticeStoreFacts = storeFacts
  ) => billingNoticeEmailOf(delivery, store, origin);

  function receipt(overrides: Partial<BillingNoticeDelivery> = {}) {
    return deliveryOf({
      firstChargeAmount: "19.90",
      firstChargeAt: new Date("2026-10-20T15:00:00.000Z"),
      firstChargeEventId: EVENT_ID,
      priceAmount: "39.90",
      ...overrides,
    });
  }

  it("writes the amount the provider reported for a receipt (E4) when there is one", () => {
    expect(emailOf(receipt())).toMatchObject({
      amount: AMOUNT,
      kind: "charge_receipt",
      method: "card",
    });
  });

  it("falls back to the recorded first charge for the first receipt, and to the price for a renewal", () => {
    const withoutAmount = {
      fact: chargeSucceeded(),
      providerRef: PROVIDER_REF,
    };
    expect(
      emailOf(receipt({ event: { ...withoutAmount, id: EVENT_ID } }))
    ).toMatchObject({ amount: "19.90" });
    expect(
      emailOf(receipt({ event: { ...withoutAmount, id: "another-event" } }))
    ).toMatchObject({ amount: "39.90" });
  });

  it("gives the right of withdrawal only to the first charge", () => {
    expect(emailOf(receipt())).toMatchObject({
      refundUntil: new Date("2026-10-28T02:59:59.000Z"),
    });
    const renewal = emailOf(
      receipt({
        event: {
          fact: chargeSucceeded(AMOUNT),
          id: "another-event",
          providerRef: PROVIDER_REF,
        },
      })
    );
    expect(renewal).toMatchObject({
      kind: "charge_receipt",
      refundUntil: null,
    });
  });

  it("is null when the method, the amount or the cycle is missing", () => {
    expect(emailOf(receipt({ provider: null }))).toBeNull();
    expect(
      emailOf(
        receipt({
          event: {
            fact: chargeSucceeded(),
            id: "another-event",
            providerRef: PROVIDER_REF,
          },
          priceAmount: null,
        })
      )
    ).toBeNull();
    const eve = deliveryOf({
      cycleMonths: 1,
      dedupeKey: PROVIDER_REF,
      event: null,
      firstChargeOn: "2026-10-25",
      kind: "trial_charge_eve",
      priceAmount: AMOUNT,
    });
    expect(emailOf(eve)).toMatchObject({ kind: "trial_charge_eve" });
    expect(emailOf({ ...eve, cycleMonths: null })).toBeNull();
    expect(emailOf({ ...eve, priceAmount: null })).toBeNull();
    expect(emailOf({ ...eve, provider: null })).toBeNull();
    expect(emailOf({ ...eve, firstChargeOn: null })).toBeNull();
    expect(
      emailOf({ ...eve, cycleMonths: null, kind: "first_charge_failed" })
    ).toBeNull();
  });

  describe("access ended (E-D)", () => {
    const ended = (overrides: Partial<BillingNoticeDelivery>) =>
      deliveryOf({
        dedupeKey: "2026-10-20T12:00:00.000Z",
        event: null,
        kind: "access_ended",
        ...overrides,
      });

    it("carries the over-limit data only in free_over_limit, with 7 days to choose", () => {
      const over = emailOf(
        ended({
          overLimitSince: new Date("2026-10-20T12:00:00.000Z"),
          record: recordOf({ accessEndsAt: null, state: "free_over_limit" }),
        })
      );
      expect(over).toMatchObject({
        kind: "access_ended",
        overLimit: {
          chooseUntil: new Date("2026-10-27T12:00:00.000Z"),
          limit: 50,
          variants: 80,
        },
      });
      const free = emailOf(
        ended({
          overLimitSince: new Date("2026-10-20T12:00:00.000Z"),
          record: recordOf({ accessEndsAt: null, state: "free" }),
        })
      );
      expect(free).toMatchObject({ kind: "access_ended", overLimit: null });
    });
  });

  describe("renewal cancelled (E7)", () => {
    const cancelled = (state: BillingRecord["state"]) =>
      deliveryOf({
        kind: "renewal_cancelled",
        record: recordOf({ cancelAtPeriodEnd: true, state }),
      });

    it("is of the trial phase while trialing, and of the pro phase otherwise", () => {
      expect(emailOf(cancelled("trialing"))).toMatchObject({ phase: "trial" });
      expect(emailOf(cancelled("active"))).toMatchObject({ phase: "pro" });
      expect(emailOf(cancelled("grace"))).toMatchObject({ phase: "pro" });
    });
  });
});

describe("the fixes of the review", () => {
  it("marks the notice sent when the provider already took a message under its key (409 invalid_idempotent_request)", async () => {
    const { dependencies, notices } = setup({
      result: {
        code: "invalid_idempotent_request",
        outcome: "retry",
        status: 409,
      },
    });
    expect(await handleBillingNotice(dependencies, envelope())).toBe("sent");
    expect(notices.markSent).toHaveBeenCalledTimes(1);
    expect(notices.markFailed).not.toHaveBeenCalled();
  });

  it("still tries again on the 409 of a request with the same key in flight", async () => {
    const { dependencies, notices } = setup({
      result: {
        code: "concurrent_idempotent_requests",
        outcome: "retry",
        status: 409,
      },
    });
    await expect(
      handleBillingNotice(dependencies, envelope())
    ).rejects.toBeInstanceOf(BillingNoticeRetryError);
    expect(notices.markSent).not.toHaveBeenCalled();
  });

  it("writes no E-A for a first charge already past (a method approved after it)", () => {
    const trial = deliveryOf({
      dedupeKey: PROVIDER_REF,
      event: null,
      firstChargeOn: "2026-10-23",
      kind: "trial_started",
      priceAmount: AMOUNT,
      record: recordOf({ state: "trialing" }),
    });
    expect(
      billingNoticeEmailOf(trial, storeFacts, emailConfig.appOrigin)
    ).toBeNull();
    const today = deliveryOf({ ...trial, firstChargeOn: "2026-10-24" });
    expect(
      billingNoticeEmailOf(today, storeFacts, emailConfig.appOrigin)
    ).not.toBeNull();
  });
});
