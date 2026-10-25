import { RefundWindowReadRefusedError } from "@polaris/domain/admin/refund-window";
import { describe, expect, it, vi } from "vitest";
import { readRefundWindow } from "./admin-refund-window-repository";
import type { AdminQueryable } from "./platform-principal-repository";

const PRINCIPAL = "0199a0a0-0000-7000-8000-000000000001";
const CASE = "0199a0a0-0000-7000-8000-0000000000c1";

const CALL =
  /^SELECT public\.admin_read_refund_window\(\$1::uuid, \$2::uuid, \$3::text\) AS result, pg_catalog\.clock_timestamp\(\) AS at$/;

const answer = {
  firstChargeAmount: "24.90",
  firstChargeAt: "2026-10-10T18:30:00.123456+00:00",
  method: "pix_automatic",
  now: "2026-10-12T12:00:00.654321+00:00",
  refundRequestedAt: null,
  state: "active",
};

function clientReturning(result: unknown) {
  const query = vi.fn(() => Promise.resolve({ rows: [{ result }] }));
  return { client: { query } as unknown as AdminQueryable, query };
}

function clientFailing(error: unknown) {
  const query = vi.fn(() => Promise.reject(error));
  return { client: { query } as unknown as AdminQueryable, query };
}

describe("readRefundWindow", () => {
  it("makes one call, to the function and to nothing else, with the operator, the case and the store", async () => {
    const { client, query } = clientReturning(answer);

    await readRefundWindow(client, PRINCIPAL, CASE, "org-1");

    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(expect.stringMatching(CALL), [
      PRINCIPAL,
      CASE,
      "org-1",
    ]);
  });

  it("parses the instants (PostgreSQL's microseconds too) and keeps the amount as text", async () => {
    const { client } = clientReturning({
      ...answer,
      refundRequestedAt: "2026-10-11T10:00:00+00:00",
    });

    const raw = await readRefundWindow(client, PRINCIPAL, CASE, "org-1");

    expect(raw).toEqual({
      firstChargeAmount: "24.90",
      firstChargeAt: new Date("2026-10-10T18:30:00.123Z"),
      method: "pix_automatic",
      now: new Date("2026-10-12T12:00:00.654Z"),
      refundRequestedAt: new Date("2026-10-11T10:00:00.000Z"),
      state: "active",
    });
  });

  it("reads a store that never charged: no instants, no amount, no method", async () => {
    const { client } = clientReturning({
      firstChargeAmount: null,
      firstChargeAt: null,
      method: null,
      now: answer.now,
      refundRequestedAt: null,
      state: "free",
    });

    const raw = await readRefundWindow(client, PRINCIPAL, CASE, "org-1");

    expect(raw).toMatchObject({
      firstChargeAmount: null,
      firstChargeAt: null,
      method: null,
      refundRequestedAt: null,
      state: "free",
    });
  });

  it("turns the function's 42501 into one refusal, also when the driver wraps it", async () => {
    const direct = clientFailing(
      Object.assign(new Error("refund_window_read_refused"), { code: "42501" })
    );
    const wrapped = clientFailing(
      new Error("outer", {
        cause: Object.assign(new Error("refund_window_read_refused"), {
          code: "42501",
        }),
      })
    );

    await expect(
      readRefundWindow(direct.client, PRINCIPAL, CASE, "org-1")
    ).rejects.toBeInstanceOf(RefundWindowReadRefusedError);
    await expect(
      readRefundWindow(wrapped.client, PRINCIPAL, CASE, "org-1")
    ).rejects.toBeInstanceOf(RefundWindowReadRefusedError);
  });

  it.each([
    ["a timeout", "timeout", "57014"],
    [
      "a missing grant, which is a 42501 too",
      "permission denied for table organization_billing",
      "42501",
    ],
  ])("does not turn %s into a refusal", async (_name, message, code) => {
    const { client } = clientFailing(
      Object.assign(new Error(message), { code })
    );

    const failure = await readRefundWindow(
      client,
      PRINCIPAL,
      CASE,
      "org-1"
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(RefundWindowReadRefusedError);
  });

  it.each([
    ["no answer", null],
    ["an instant that is not a date", { ...answer, now: "yesterday" }],
    ["no clock", { ...answer, now: null }],
    ["an unknown state", { ...answer, state: "gone" }],
    ["an unknown method", { ...answer, method: "boleto" }],
    ["an amount that is not text", { ...answer, firstChargeAmount: 24.9 }],
  ])("fails closed on %s", async (_name, result) => {
    const { client } = clientReturning(result);

    await expect(
      readRefundWindow(client, PRINCIPAL, CASE, "org-1")
    ).rejects.toThrow("refund_window_unreadable");
  });
});
