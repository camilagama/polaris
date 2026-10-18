import { InvalidIncidentRetryError } from "@polaris/domain/admin/operational-incident";
import { describe, expect, it, vi } from "vitest";
import {
  listOperationalIncidents,
  readOperationalIncident,
  retryDeadLetter,
} from "./admin-incident-repository";
import type { AdminQueryable } from "./platform-principal-repository";

const INCIDENT = "0199a0a0-0000-7000-8000-0000000000a1";
const EVENT = "0199a0a0-0000-7000-8000-0000000000b2";
const PRINCIPAL = "0199a0a0-0000-7000-8000-000000000001";

function clientReturning(rows: unknown[]) {
  const query = vi.fn(() => Promise.resolve({ rows }));
  return { client: { query } as unknown as AdminQueryable, query };
}

function clientFailing(error: unknown) {
  const query = vi.fn(() => Promise.reject(error));
  return { client: { query } as unknown as AdminQueryable, query };
}

describe("listOperationalIncidents", () => {
  it("calls the database function with the limit and the cursor, in that order, and returns its result", async () => {
    const page = { incidents: [{ id: INCIDENT }], next: EVENT };
    const { client, query } = clientReturning([{ result: page }]);
    await expect(
      listOperationalIncidents(client, { after: EVENT, limit: 10 })
    ).resolves.toEqual(page);
    expect(query).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("public.admin_list_operational_incidents"),
      [10, EVENT]
    );
  });

  it("passes a null cursor for the first page", async () => {
    const { client, query } = clientReturning([{ result: { incidents: [] } }]);
    await listOperationalIncidents(client, { after: null, limit: 25 });
    expect(query).toHaveBeenCalledWith(expect.any(String), [25, null]);
  });

  it("answers an empty page when the database returns nothing", async () => {
    for (const rows of [[], [{ result: null }]]) {
      const { client } = clientReturning(rows);
      // biome-ignore lint/performance/noAwaitInLoops: Cases, in order.
      await expect(
        listOperationalIncidents(client, { after: null, limit: 25 })
      ).resolves.toEqual({ incidents: [], next: null });
    }
  });
});

describe("readOperationalIncident", () => {
  it("calls the database function with the ID, the limit and the cursor, in that order", async () => {
    const detail = { events: [], incident: { id: INCIDENT }, next: null };
    const { client, query } = clientReturning([{ result: detail }]);
    await expect(
      readOperationalIncident(client, INCIDENT, { after: EVENT, limit: 5 })
    ).resolves.toEqual(detail);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("public.admin_read_operational_incident"),
      [INCIDENT, 5, EVENT]
    );
  });

  it("answers null when there is no such incident", async () => {
    for (const rows of [[], [{ result: null }]]) {
      const { client } = clientReturning(rows);
      // biome-ignore lint/performance/noAwaitInLoops: Cases, in order.
      await expect(
        readOperationalIncident(client, INCIDENT, { after: null, limit: 25 })
      ).resolves.toBeNull();
    }
  });
});

describe("retryDeadLetter", () => {
  const retry = (client: AdminQueryable) =>
    retryDeadLetter(client, PRINCIPAL, INCIDENT, EVENT, "motivo");

  it("calls the database function with the operator, the incident, the event and the reason, in that order", async () => {
    const { client, query } = clientReturning([
      { result: { result: "retried" } },
    ]);
    await expect(retry(client)).resolves.toBe("retried");
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("public.admin_retry_dead_letter"),
      [PRINCIPAL, INCIDENT, EVENT, "motivo"]
    );
  });

  it("returns each result it knows", async () => {
    for (const result of [
      "already_pending",
      "busy",
      "event_gone",
      "retried",
      "unknown_item",
    ]) {
      const { client } = clientReturning([{ result: { result } }]);
      // biome-ignore lint/performance/noAwaitInLoops: Cases, in order.
      await expect(retry(client)).resolves.toBe(result);
    }
  });

  it("raises the domain's refusal when the database says the reason is invalid", async () => {
    const { client } = clientFailing(
      Object.assign(new Error("invalid_incident_reason"), { code: "22023" })
    );
    await expect(retry(client)).rejects.toBeInstanceOf(
      InvalidIncidentRetryError
    );
  });

  it("raises other errors as they are", async () => {
    const cases = [
      Object.assign(new Error("invalid_incident_reason"), { code: "40001" }),
      Object.assign(new Error("something else"), { code: "22023" }),
      new Error("down"),
    ];
    for (const error of cases) {
      const { client } = clientFailing(error);
      // biome-ignore lint/performance/noAwaitInLoops: Cases, in order.
      await expect(retry(client)).rejects.toBe(error);
    }
  });

  it("raises incident_retry_unreadable for a result it does not know", async () => {
    for (const rows of [
      [],
      [{ result: null }],
      [{ result: {} }],
      [{ result: { result: "exploded" } }],
      [{ result: { result: 5 } }],
      [{ result: "retried" }],
    ]) {
      const { client } = clientReturning(rows);
      // biome-ignore lint/performance/noAwaitInLoops: Cases, in order.
      await expect(retry(client)).rejects.toThrow("incident_retry_unreadable");
    }
  });
});
