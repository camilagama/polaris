import type { ClosureNoticeDelivery } from "@polaris/db/privacy-maintenance";
import { outboxIdempotencyKey } from "@polaris/domain/events/outbox";
import type { QueueEnvelope } from "@polaris/domain/events/queue-envelope";
import { logger } from "@polaris/observability/logger";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PermanentHandlerError } from "../queue/consumer";
import { handleClosureNotice } from "./closure-notice";

const NOTICE = "0199f0aa-2b3c-7d4e-8f90-123456789abc";
const ORG = "org_closure_notice";

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
  milestone: "d7",
  noticeId: NOTICE,
  organizationId: ORG,
  organizationName: "Loja de Teste",
  purgeFrom: null,
  recoverUntil: new Date("2026-11-19T12:00:00.000Z"),
  requestedAt: new Date("2026-10-20T12:00:00.000Z"),
  timeZone: "America/Sao_Paulo",
  userId: "user_owner",
};

function client(found: ClosureNoticeDelivery | null) {
  return {
    claimClosureNoticeDelivery: vi.fn((_notice: string, _org: string) =>
      Promise.resolve(found)
    ),
    markClosureNoticeFailed: vi.fn(
      (_notice: string, _org: string, _code: string) => Promise.resolve(true)
    ),
  };
}

function quiet() {
  return {
    info: vi.spyOn(logger, "info").mockImplementation(() => undefined),
    warn: vi.spyOn(logger, "warn").mockImplementation(() => undefined),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the consumer of a closure notice, before the e-mail exists", () => {
  it("reads the notice by its ID and organization and fails it closed, once, as email_not_configured", async () => {
    const { warn } = quiet();
    const notices = client(delivery);

    await handleClosureNotice(notices, envelope());

    expect(notices.claimClosureNoticeDelivery).toHaveBeenCalledWith(
      NOTICE,
      ORG
    );
    expect(notices.markClosureNoticeFailed).toHaveBeenCalledTimes(1);
    expect(notices.markClosureNoticeFailed).toHaveBeenCalledWith(
      NOTICE,
      ORG,
      "email_not_configured"
    );
    expect(warn).toHaveBeenCalledWith(
      "closure_notice_not_sent",
      expect.objectContaining({
        milestone: "d7",
        outcome: "rejected",
        reason: "email_not_configured",
      })
    );
    // nothing of the owner or the store reaches the log
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain("Loja de Teste");
    expect(logged).not.toContain("user_owner");
  });

  it("does nothing when the notice is not to go out (settled, of an undone closure, or of a store no longer closed)", async () => {
    const { info } = quiet();
    const notices = client(null);

    await handleClosureNotice(notices, envelope());

    expect(notices.markClosureNoticeFailed).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(
      "closure_notice_not_due",
      expect.objectContaining({ outcome: "skipped" })
    );
  });

  it("refuses an event whose body and outbox key name different notices, for good", async () => {
    quiet();
    const notices = client(delivery);
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
      await expect(handleClosureNotice(notices, wrong)).rejects.toBeInstanceOf(
        PermanentHandlerError
      );
    }
    expect(notices.claimClosureNoticeDelivery).not.toHaveBeenCalled();
  });
});
