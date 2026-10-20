import type { ClosureNoticeRecipient } from "@polaris/db/closure-notice-recipient";
import type { ClosureNoticeDelivery } from "@polaris/db/privacy-maintenance";
import { outboxIdempotencyKey } from "@polaris/domain/events/outbox";
import type { QueueEnvelope } from "@polaris/domain/events/queue-envelope";
import { logger } from "@polaris/observability/logger";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PermanentHandlerError } from "../queue/consumer";
import {
  type ClosureNoticeDependencies,
  ClosureNoticeRetryError,
  closureNoticeEmailConfig,
  handleClosureNotice,
  handOverOwedClosureNotices,
} from "./closure-notice";
import type {
  ClosureNoticeEmailConfig,
  ClosureNoticeSender,
  ClosureNoticeSendResult,
} from "./closure-notice-email";

const NOTICE = "0199f0aa-2b3c-7d4e-8f90-123456789abc";
const ORG = "org_closure_notice";
const ADDRESS = "dono@example.invalid";
const STORE = "Loja de Teste";
const USER = "user_owner";

function envelope(overrides: Partial<QueueEnvelope> = {}): QueueEnvelope {
  return {
    attempt: 1,
    correlationId: "corr_1",
    event: { noticeId: NOTICE },
    eventId: "0199f0aa-0000-7000-8000-000000000001",
    idempotencyKey: outboxIdempotencyKey("organization.closure_notice", NOTICE),
    organizationId: ORG,
    type: "organization.closure_notice",
    version: 1,
    ...overrides,
  };
}

const delivery: ClosureNoticeDelivery = {
  deletableFrom: new Date("2027-01-18T03:00:00.000Z"),
  deletionDate: "2027-01-18",
  dueAt: new Date("2027-01-11T03:00:00.000Z"),
  milestone: "d7",
  noticeId: NOTICE,
  organizationId: ORG,
  organizationName: STORE,
  purgeFrom: null,
  recoverUntil: new Date("2026-11-19T12:00:00.000Z"),
  reissue: 0,
  requestedAt: new Date("2026-10-20T12:00:00.000Z"),
  timeZone: "America/Sao_Paulo",
  userId: USER,
};

const emailConfig: ClosureNoticeEmailConfig = {
  apiKey: "re_test_key_not_real",
  appOrigin: "https://app.example.invalid",
  from: "Polaris <avisos@example.invalid>",
};

function setup(
  options: {
    found?: ClosureNoticeDelivery | null;
    recipient?: ClosureNoticeRecipient | null;
    result?: ClosureNoticeSendResult;
    emailOff?: boolean;
  } = {}
) {
  const found = options.found === undefined ? delivery : options.found;
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
  const notices = {
    claimClosureNoticeDelivery: vi.fn((_notice: string, _org: string) =>
      Promise.resolve(found)
    ),
    listOwedClosureNotices: vi.fn(
      (_limit: number) =>
        Promise.resolve([]) as Promise<
          { noticeId: string; organizationId: string }[]
        >
    ),
    markClosureNoticeFailed: vi.fn(
      (_notice: string, _org: string, _code: string) => Promise.resolve(true)
    ),
    markClosureNoticeSent: vi.fn((_notice: string, _org: string) =>
      Promise.resolve(true)
    ),
  };
  const dependencies: ClosureNoticeDependencies & { notices: typeof notices } =
    {
      email: options.emailOff
        ? null
        : { config: emailConfig, recipients, send },
      notices,
    };
  return { dependencies, notices, recipients, send };
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
  expect(text).not.toContain(STORE);
  expect(text).not.toContain(USER);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the consumer of a closure notice", () => {
  it("leaves the notice owed, neither sent nor failed, while no e-mail is configured", async () => {
    const spies = spyLogger();
    const { dependencies, notices } = setup({ emailOff: true });

    await handleClosureNotice(dependencies, envelope());

    expect(notices.claimClosureNoticeDelivery).toHaveBeenCalledWith(
      NOTICE,
      ORG
    );
    expect(notices.markClosureNoticeSent).not.toHaveBeenCalled();
    expect(notices.markClosureNoticeFailed).not.toHaveBeenCalled();
    expect(spies.warn).toHaveBeenCalledWith(
      "closure_notice_not_sent",
      expect.objectContaining({
        milestone: "d7",
        outcome: "skipped",
        reason: "email_not_configured",
      })
    );
    expectNoPersonalData(everythingLogged(spies));
  });

  it("does nothing, and never asks for the address, when the notice is not to go out", async () => {
    const spies = spyLogger();
    const { dependencies, notices, recipients, send } = setup({ found: null });

    await handleClosureNotice(dependencies, envelope());

    expect(spies.info).toHaveBeenCalledWith(
      "closure_notice_not_due",
      expect.objectContaining({ outcome: "skipped" })
    );
    expect(recipients.recipient).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(notices.markClosureNoticeSent).not.toHaveBeenCalled();
    expectNoPersonalData(everythingLogged(spies));
  });

  it("sends nothing when the notice was settled between the two reads (no recipient)", async () => {
    const spies = spyLogger();
    const { dependencies, notices, send } = setup({ recipient: null });

    await handleClosureNotice(dependencies, envelope());

    expect(spies.info).toHaveBeenCalledWith(
      "closure_notice_not_due",
      expect.objectContaining({ outcome: "skipped" })
    );
    expect(send).not.toHaveBeenCalled();
    expect(notices.markClosureNoticeSent).not.toHaveBeenCalled();
    expect(notices.markClosureNoticeFailed).not.toHaveBeenCalled();
    expectNoPersonalData(everythingLogged(spies));
  });

  it("leaves the notice owed, not failed, when the owner's e-mail is not verified", async () => {
    const spies = spyLogger();
    const { dependencies, notices, send } = setup({
      recipient: { verified: false },
    });

    await handleClosureNotice(dependencies, envelope());

    expect(send).not.toHaveBeenCalled();
    expect(notices.markClosureNoticeSent).not.toHaveBeenCalled();
    expect(notices.markClosureNoticeFailed).not.toHaveBeenCalled();
    expect(spies.warn).toHaveBeenCalledWith(
      "closure_notice_not_sent",
      expect.objectContaining({
        outcome: "skipped",
        reason: "email_not_verified",
      })
    );
    expectNoPersonalData(everythingLogged(spies));
  });

  it("sends once to the verified address under the notice's ID as the idempotency key, and marks it sent", async () => {
    const spies = spyLogger();
    const { dependencies, notices, send } = setup();

    await handleClosureNotice(dependencies, envelope());

    expect(send).toHaveBeenCalledTimes(1);
    const message = send.mock.calls[0]?.[0];
    expect(message?.idempotencyKey).toBe(NOTICE);
    expect(message?.to).toBe(ADDRESS);
    expect(notices.markClosureNoticeSent).toHaveBeenCalledWith(NOTICE, ORG);
    expect(notices.markClosureNoticeFailed).not.toHaveBeenCalled();
    expect(spies.info).toHaveBeenCalledWith(
      "closure_notice_email_sent",
      expect.objectContaining({ milestone: "d7", outcome: "success" })
    );
    expectNoPersonalData(everythingLogged(spies));
  });

  it("marks the notice failed, with no retry, when the provider refuses the message for good", async () => {
    const spies = spyLogger();
    const { dependencies, notices } = setup({
      result: { code: null, outcome: "rejected", status: 422 },
    });

    await handleClosureNotice(dependencies, envelope());

    expect(notices.markClosureNoticeFailed).toHaveBeenCalledWith(
      NOTICE,
      ORG,
      "email_rejected"
    );
    expect(notices.markClosureNoticeSent).not.toHaveBeenCalled();
    expect(spies.error).toHaveBeenCalledWith(
      "closure_notice_email_failed",
      expect.objectContaining({ httpStatus: 422, outcome: "rejected" })
    );
    expectNoPersonalData(everythingLogged(spies));
  });

  it("throws a retry error, marking nothing, when the provider or the network fails", async () => {
    const spies = spyLogger();
    const { dependencies, notices } = setup({
      result: { code: null, outcome: "retry", status: 503 },
    });

    const failure = await handleClosureNotice(dependencies, envelope()).then(
      () => null,
      (error: unknown) => error
    );

    expect(failure).toBeInstanceOf(ClosureNoticeRetryError);
    expect((failure as ClosureNoticeRetryError).status).toBe(503);
    expectNoPersonalData((failure as Error).message);
    expect(notices.markClosureNoticeSent).not.toHaveBeenCalled();
    expect(notices.markClosureNoticeFailed).not.toHaveBeenCalled();
    expect(spies.error).toHaveBeenCalledWith(
      "closure_notice_email_failed",
      expect.objectContaining({ outcome: "failure" })
    );
    expectNoPersonalData(everythingLogged(spies));
  });

  it("refuses an event whose body and outbox key name different notices, for good", async () => {
    spyLogger();
    const { dependencies, notices } = setup();
    for (const wrong of [
      envelope({ event: { noticeId: "0199f0aa-2b3c-7d4e-8f90-000000000000" } }),
      envelope({ event: { noticeId: 7 } }),
      envelope({
        event: { noticeId: "not-a-uuid" },
        idempotencyKey: "organization.closure_notice:not-a-uuid",
      }),
      envelope({ event: {} }),
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: one refusal at a time, for a clear failure
      await expect(
        handleClosureNotice(dependencies, wrong)
      ).rejects.toBeInstanceOf(PermanentHandlerError);
    }
    expect(notices.claimClosureNoticeDelivery).not.toHaveBeenCalled();
  });
});

describe("the handover of the owed closure notices", () => {
  it("does nothing, and does not even list, while the e-mail is off", async () => {
    spyLogger();
    const { dependencies, notices } = setup({ emailOff: true });

    const report = await handOverOwedClosureNotices(dependencies);

    expect(report).toEqual({
      failed: 0,
      handedOver: 0,
      notVerified: 0,
      retry: 0,
      sent: 0,
    });
    expect(notices.listOwedClosureNotices).not.toHaveBeenCalled();
  });

  it("sends each owed notice, counts a retry without stopping the others, and reports the totals", async () => {
    const spies = spyLogger();
    const { dependencies, notices, recipients, send } = setup();
    const owed = ["1", "2", "3", "4"].map((digit) => ({
      noticeId: `0199f0aa-2b3c-7d4e-8f90-12345678900${digit}`,
      organizationId: `org_${digit}`,
    }));
    notices.listOwedClosureNotices.mockResolvedValueOnce(owed);
    send
      .mockResolvedValueOnce({ outcome: "sent" })
      .mockResolvedValueOnce({ code: null, outcome: "retry", status: 500 })
      .mockResolvedValueOnce({ code: null, outcome: "rejected", status: 400 });
    recipients.recipient
      .mockResolvedValueOnce({ email: ADDRESS, verified: true })
      .mockResolvedValueOnce({ email: ADDRESS, verified: true })
      .mockResolvedValueOnce({ email: ADDRESS, verified: true })
      .mockResolvedValueOnce({ verified: false });

    const report = await handOverOwedClosureNotices(dependencies, 10);

    expect(notices.listOwedClosureNotices).toHaveBeenCalledWith(10);
    expect(report).toEqual({
      failed: 1,
      handedOver: 4,
      notVerified: 1,
      retry: 1,
      sent: 1,
    });
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls.map(([message]) => message.idempotencyKey)).toEqual(
      owed.slice(0, 3).map((notice) => notice.noticeId)
    );
    expectNoPersonalData(everythingLogged(spies));
  });
});

function configFor(
  bindings: Record<string, string | undefined>
): ReturnType<typeof closureNoticeEmailConfig> {
  // exactOptionalPropertyTypes: an absent binding is a missing key, not an undefined one
  return closureNoticeEmailConfig(
    Object.fromEntries(
      Object.entries(bindings).filter(([, value]) => value !== undefined)
    )
  );
}

describe("the configuration of the e-mail of the notices", () => {
  const on = {
    AUTH_EMAIL_FROM: "Polaris <avisos@example.invalid>",
    BETTER_AUTH_BASE_URL: "https://app.example.invalid/some/path",
    CLOSURE_NOTICE_EMAIL_ENABLED: "true",
    RESEND_API_KEY: "re_test_key_not_real",
  };

  it("is on only with the exact switch and every piece, with the origin of the app only", () => {
    expect(configFor(on)).toEqual({
      apiKey: "re_test_key_not_real",
      appOrigin: "https://app.example.invalid",
      from: "Polaris <avisos@example.invalid>",
    });
    expect(
      configFor({
        ...on,
        AUTH_EMAIL_REPLY_TO: " ajuda@example.invalid ",
      })?.replyTo
    ).toBe("ajuda@example.invalid");
  });

  it("stays off unless the switch is exactly true", () => {
    for (const value of [undefined, "", "TRUE", "True", "1", "yes", "false"]) {
      expect(
        configFor({
          ...on,
          CLOSURE_NOTICE_EMAIL_ENABLED: value,
        })
      ).toBeNull();
    }
  });

  it("stays off when the key, the sender or the app's URL is missing", () => {
    expect(configFor({ ...on, RESEND_API_KEY: undefined })).toBeNull();
    expect(configFor({ ...on, RESEND_API_KEY: "  " })).toBeNull();
    expect(configFor({ ...on, AUTH_EMAIL_FROM: undefined })).toBeNull();
    expect(configFor({ ...on, BETTER_AUTH_BASE_URL: undefined })).toBeNull();
    expect(configFor({ ...on, BETTER_AUTH_BASE_URL: "not a url" })).toBeNull();
  });

  it("accepts http only on localhost and refuses it anywhere else", () => {
    expect(
      configFor({
        ...on,
        BETTER_AUTH_BASE_URL: "http://localhost:3000/x",
      })?.appOrigin
    ).toBe("http://localhost:3000");
    expect(
      configFor({
        ...on,
        BETTER_AUTH_BASE_URL: "http://app.example.invalid",
      })
    ).toBeNull();
  });
});
