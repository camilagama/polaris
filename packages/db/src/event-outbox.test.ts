import { InvalidOutboxEventError } from "@polaris/domain/events/outbox";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { recordOutboxEvent } from "./event-outbox";
import type { TenantRequestTransaction } from "./tenant-transaction";

const EXPORT = "0199a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b";
const REQUEST = "0199a1b2-c3d4-7e5f-9a6b-7c8d9e0f1a2c";
const UUID_TEXT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const event = {
  correlationId: REQUEST,
  event: { exportId: EXPORT },
  idempotencyKey: `data_export.requested:${EXPORT}`,
  organizationId: "organization-1",
  type: "data_export.requested",
};

function fakeTransaction() {
  const execute = vi.fn().mockResolvedValue({ rows: [] });
  return {
    execute,
    transaction: { execute } as unknown as TenantRequestTransaction,
  };
}

describe("recordOutboxEvent", () => {
  it("inserts only the five columns the tenant role may write, and does nothing on a repeat", async () => {
    const { execute, transaction } = fakeTransaction();

    await recordOutboxEvent(transaction, event);

    expect(execute).toHaveBeenCalledTimes(1);
    const query = new PgDialect().sqlToQuery(execute.mock.calls[0]?.[0]);
    expect(query.sql.replace(/\s+/g, " ").trim()).toBe(
      "INSERT INTO public.event_outbox (organization_id, type, event, idempotency_key, correlation_id) VALUES ($1, $2, $3::jsonb, $4, $5) ON CONFLICT DO NOTHING"
    );
    expect(query.params).toEqual([
      "organization-1",
      "data_export.requested",
      JSON.stringify({ exportId: EXPORT }),
      `data_export.requested:${EXPORT}`,
      REQUEST,
    ]);
  });

  it("starts a trace of its own when the caller has none", async () => {
    const { execute, transaction } = fakeTransaction();

    await recordOutboxEvent(transaction, { ...event, correlationId: null });

    const { params } = new PgDialect().sqlToQuery(execute.mock.calls[0]?.[0]);
    expect(params[4]).toMatch(UUID_TEXT);
  });

  it.each([
    ["a type nobody declared", { ...event, type: "organization.purged" }],
    [
      "free text in the body",
      { ...event, event: { exportId: EXPORT, owner: "maria@example.com" } },
    ],
    ["a field beyond the contract", { ...event, status: "dispatched" }],
  ])("refuses %s before touching the database", async (_label, bad) => {
    const { execute, transaction } = fakeTransaction();

    await expect(
      recordOutboxEvent(transaction, bad as never)
    ).rejects.toBeInstanceOf(InvalidOutboxEventError);
    expect(execute).not.toHaveBeenCalled();
  });
});
