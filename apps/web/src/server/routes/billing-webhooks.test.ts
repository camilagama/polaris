import type { BillingStore } from "@polaris/db/billing-store";
import type { BillingFact } from "@polaris/domain/billing/facts";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type BillingProviderAdapter,
  type ParsedBillingEvent,
  type UnresolvedBillingEvent,
  WebhookMalformedError,
  WebhookRejectedError,
} from "../billing/provider-adapter";
import type { ServerEnv, WorkerBindings } from "../environment";
import { requestIdMiddleware } from "../middleware/request-id";
import { createServerApp } from "../app";
import { createBillingWebhookRoutes } from "./billing-webhooks";

const occurredAt = new Date("2026-10-14T12:00:00.000Z");
const charged: BillingFact = {
  cycleMonths: 1,
  occurredAt,
  periodEndsAt: new Date("2026-11-14T12:00:00.000Z"),
  type: "charge_succeeded",
};
const failed: BillingFact = { occurredAt, type: "charge_failed" };

/** A provider whose webhooks carry a shared token and a JSON list of events. */
function fakeAdapter(): BillingProviderAdapter {
  return {
    parse: ({ headers, rawBody }) => {
      if (headers.get("x-token") !== "good") {
        throw new WebhookRejectedError();
      }
      let payload: unknown;
      try {
        payload = JSON.parse(rawBody);
      } catch (cause: unknown) {
        // biome-ignore lint/style/useErrorCause: The adapter's own error type carries it.
        throw new WebhookMalformedError({ cause });
      }
      if ((payload as { crash?: boolean }).crash) {
        throw new Error("adapter bug");
      }
      const list = (payload as { events?: ParsedBillingEvent[] }).events;
      if (!Array.isArray(list)) {
        throw new WebhookMalformedError();
      }
      return list.map((entry) => ({
        ...entry,
        fact: entry.fact.type === "charge_failed" ? failed : charged,
      }));
    },
    provider: "fake",
  };
}

function fakeStore(
  options: {
    duplicates?: Set<string>;
    failRecord?: boolean;
    failRecordAfter?: number;
  } = {}
) {
  const recorded: string[] = [];
  const store = {
    attachProvider: vi.fn(),
    close: vi.fn(() => Promise.resolve()),
    processEvent: vi.fn((id: string) =>
      Promise.resolve({
        eventId: id,
        organizationId: "org",
        outcomeCode: null,
        status: "applied" as const,
      })
    ),
    readRecord: vi.fn(),
    recordEvent: vi.fn((input: { providerEventId: string }) => {
      if (
        options.failRecord ||
        (options.failRecordAfter !== undefined &&
          recorded.length >= options.failRecordAfter)
      ) {
        return Promise.reject(new Error("database down"));
      }
      recorded.push(input.providerEventId);
      return Promise.resolve({
        duplicate: options.duplicates?.has(input.providerEventId) ?? false,
        id: `id-${input.providerEventId}`,
      });
    }),
    retryPending: vi.fn(),
    startTrial: vi.fn(),
    sweepDue: vi.fn(),
  } as unknown as BillingStore;
  return { recorded, store };
}

function setup(
  options: {
    adapter?: BillingProviderAdapter;
    bindings?: Record<string, unknown>;
    store?: ReturnType<typeof fakeStore>;
  } = {}
) {
  const storeFixture = options.store ?? fakeStore();
  const background: Promise<unknown>[] = [];
  const createStore = vi.fn(() => storeFixture.store);
  const app = new Hono<ServerEnv>();
  app.use("*", requestIdMiddleware);
  app.route(
    "/",
    createBillingWebhookRoutes({
      adapters: { fake: options.adapter ?? fakeAdapter() },
      createStore,
      runInBackground: (promise) => {
        background.push(promise);
      },
    })
  );
  const bindings = {
    BILLING_HYPERDRIVE: { connectionString: "postgresql://billing.invalid/db" },
    ...options.bindings,
  } as unknown as WorkerBindings;
  const send = (
    path: string,
    init: {
      body?: BodyInit;
      duplex?: "half";
      headers?: Record<string, string>;
    } = {}
  ) =>
    app.fetch(
      new Request(`https://polaris.example.invalid${path}`, {
        body: init.body ?? "{}",
        duplex: init.duplex,
        headers: init.headers ?? {},
        method: "POST",
      } as RequestInit),
      bindings
    );
  return { background, createStore, send, ...storeFixture };
}

const WHY_WORDS = /token|signature/i;
const signed = { "x-token": "good" };
const delivery = (...facts: [string, BillingFact][]) =>
  JSON.stringify({
    events: facts.map(([providerEventId, fact]) => ({
      fact,
      providerEventId,
      providerRef: "sub_1",
    })),
  });

describe("the billing webhook route", () => {
  it("stores the provider's subscription ID with the event, and none when the adapter gives none", async () => {
    const t = setup();

    const response = await t.send("/webhooks/billing/fake", {
      body: JSON.stringify({
        events: [
          {
            fact: charged,
            providerEventId: "evt-sub",
            providerRef: "chk_1",
            providerSubscriptionId: "sub_000005135291",
          },
          { fact: failed, providerEventId: "evt-none", providerRef: "chk_1" },
        ],
      }),
      headers: signed,
    });

    expect(response.status).toBe(200);
    expect(t.store.recordEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        providerEventId: "evt-sub",
        providerSubscriptionId: "sub_000005135291",
      })
    );
    expect(t.store.recordEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        providerEventId: "evt-none",
        providerSubscriptionId: null,
      })
    );
    await Promise.all(t.background);
  });

  it("stores each event once and answers before processing them, then processes the new ones in order", async () => {
    const t = setup();

    const response = await t.send("/webhooks/billing/fake", {
      body: delivery(["evt-1", charged], ["evt-2", failed]),
      headers: signed,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      duplicates: 0,
      received: 2,
    });
    expect(t.recorded).toEqual(["evt-1", "evt-2"]);
    expect(t.store.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "fake",
        providerEventId: "evt-1",
        providerRef: "sub_1",
      })
    );
    await Promise.all(t.background);
    expect(
      (t.store.processEvent as ReturnType<typeof vi.fn>).mock.calls.map(
        ([id]) => id
      )
    ).toEqual(["id-evt-1", "id-evt-2"]);
    expect(t.store.close).toHaveBeenCalledTimes(1);
  });

  it("answers even while the processing is still running", async () => {
    const t = setup();
    let release: () => void = () => undefined;
    (t.store.processEvent as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise((resolve) => {
        release = () =>
          resolve({
            eventId: "x",
            organizationId: "org",
            outcomeCode: null,
            status: "applied",
          });
      })
    );

    const response = await t.send("/webhooks/billing/fake", {
      body: delivery(["evt-1", charged]),
      headers: signed,
    });

    // the provider already has its 200 and the store is still open for the work
    expect(response.status).toBe(200);
    expect(t.store.close).not.toHaveBeenCalled();
    release();
    await Promise.all(t.background);
    expect(t.store.close).toHaveBeenCalledTimes(1);
  });

  it("says an event is a redelivery and still hands it to processing, which is a no-op for one already applied", async () => {
    const t = setup({ store: fakeStore({ duplicates: new Set(["evt-1"]) }) });

    const response = await t.send("/webhooks/billing/fake", {
      body: delivery(["evt-1", charged], ["evt-2", failed]),
      headers: signed,
    });

    await expect(response.json()).resolves.toMatchObject({
      duplicates: 1,
      received: 2,
    });
    await Promise.all(t.background);
    // an event stored by an earlier delivery that never got applied is applied now, in order
    expect(
      (t.store.processEvent as ReturnType<typeof vi.fn>).mock.calls.map(
        ([id]) => id
      )
    ).toEqual(["id-evt-1", "id-evt-2"]);
    expect(t.store.close).toHaveBeenCalledTimes(1);
  });

  it("logs an event whose processing was deferred, with its outcome code and no message", async () => {
    const t = setup();
    (t.store.processEvent as ReturnType<typeof vi.fn>).mockResolvedValue({
      eventId: "x",
      organizationId: null,
      outcomeCode: "unknown_organization",
      status: "failed",
    });
    const warned = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);

    await t.send("/webhooks/billing/fake", {
      body: delivery(["evt-1", charged]),
      headers: signed,
    });
    await Promise.all(t.background);

    expect(warned).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "billing_webhook_processing_deferred",
        eventId: "id-evt-1",
        outcomeCode: "unknown_organization",
      })
    );
    warned.mockRestore();
  });

  it("refuses a request that is not proven to come from the provider, without saying why, and stores nothing", async () => {
    const t = setup();

    const response = await t.send("/webhooks/billing/fake", {
      body: delivery(["evt-1", charged]),
      headers: { "x-token": "forged" },
    });

    expect(response.status).toBe(401);
    expect(JSON.stringify(await response.json())).not.toMatch(WHY_WORDS);
    expect(t.createStore).not.toHaveBeenCalled();
  });

  it("acknowledges an authentic request it cannot read, one with too many events, and one with nothing the lifecycle needs", async () => {
    const t = setup();
    const logged = vi
      .spyOn(console, "info")
      .mockImplementation(() => undefined);

    // a retry would send the same bytes: refusing it only gets the provider's webhook paused
    const malformed = await t.send("/webhooks/billing/fake", {
      body: "not json",
      headers: signed,
    });
    expect(malformed.status).toBe(200);
    await expect(malformed.json()).resolves.toMatchObject({ received: 0 });
    const flood = await t.send("/webhooks/billing/fake", {
      body: delivery(
        ...Array.from({ length: 51 }, (_, index): [string, BillingFact] => [
          `evt-${index}`,
          charged,
        ])
      ),
      headers: signed,
    });
    expect(flood.status).toBe(200);
    await expect(flood.json()).resolves.toMatchObject({ received: 0 });
    logged.mockRestore();
    const empty = await t.send("/webhooks/billing/fake", {
      body: JSON.stringify({ events: [] }),
      headers: signed,
    });
    expect(empty.status).toBe(200);
    await expect(empty.json()).resolves.toMatchObject({ received: 0 });
    // nothing was stored for any of them
    expect(t.createStore).not.toHaveBeenCalled();
  });

  it("answers 503 for an adapter that fails in a way it did not expect, so the provider sends it again", async () => {
    const t = setup();
    const logged = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const response = await t.send("/webhooks/billing/fake", {
      body: JSON.stringify({ crash: true }),
      headers: signed,
    });

    expect(response.status).toBe(503);
    expect(t.createStore).not.toHaveBeenCalled();
    logged.mockRestore();
  });

  it("answers 404 for a provider that has no adapter, and for a name that cannot be one", async () => {
    const t = setup();

    for (const provider of [
      "unknown",
      "FAKE",
      "a",
      "x".repeat(40),
      "fake%2f",
      // names that exist on every object, not in the registry
      "constructor",
      "__proto__",
      "tostring",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: A handful of requests, in order.
      const response = await t.send(`/webhooks/billing/${provider}`, {
        headers: signed,
      });
      expect(response.status).toBe(404);
    }
    expect(t.createStore).not.toHaveBeenCalled();
  });

  it("answers 503 when billing is not provisioned or the event cannot be stored, so the provider sends it again", async () => {
    const unprovisioned = setup({
      bindings: { BILLING_HYPERDRIVE: undefined },
    });
    const notProvisioned = await unprovisioned.send("/webhooks/billing/fake", {
      body: delivery(["evt-1", charged]),
      headers: signed,
    });
    expect(notProvisioned.status).toBe(503);

    const broken = setup({ store: fakeStore({ failRecord: true }) });
    const notStored = await broken.send("/webhooks/billing/fake", {
      body: delivery(["evt-1", charged]),
      headers: signed,
    });
    expect(notStored.status).toBe(503);
    // nothing is processed for an event that was not stored, and the store is closed
    expect(broken.store.processEvent).not.toHaveBeenCalled();
    expect(broken.store.close).toHaveBeenCalledTimes(1);
  });

  it("answers 503 when only some of the events could be stored, and processes none of them", async () => {
    const t = setup({ store: fakeStore({ failRecordAfter: 1 }) });
    const logged = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const response = await t.send("/webhooks/billing/fake", {
      body: delivery(["evt-1", charged], ["evt-2", failed]),
      headers: signed,
    });

    // the provider resends both: the first comes back as a duplicate and both are applied in order
    expect(response.status).toBe(503);
    expect(t.recorded).toEqual(["evt-1"]);
    expect(t.store.processEvent).not.toHaveBeenCalled();
    expect(t.store.close).toHaveBeenCalledTimes(1);
    logged.mockRestore();
  });

  it("keeps going when processing one event fails: it is stored and the retry pass takes it", async () => {
    const t = setup();
    (t.store.processEvent as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("database down"))
      .mockResolvedValue({
        eventId: "x",
        organizationId: "org",
        outcomeCode: null,
        status: "applied",
      });
    const logged = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    const response = await t.send("/webhooks/billing/fake", {
      body: delivery(["evt-1", charged], ["evt-2", failed]),
      headers: signed,
    });
    expect(response.status).toBe(200);
    await Promise.all(t.background);

    expect(t.store.processEvent).toHaveBeenCalledTimes(2);
    expect(logged).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "billing_webhook_processing_failed",
        eventId: "id-evt-1",
        provider: "fake",
      })
    );
    expect(t.store.close).toHaveBeenCalledTimes(1);
    logged.mockRestore();
  });

  it("refuses a body that is too large by its declared size, by its real size, and when it declares none", async () => {
    const t = setup();

    const declared = await t.send("/webhooks/billing/fake", {
      body: "{}",
      headers: { ...signed, "content-length": String(10 * 64 * 1024) },
    });
    expect(declared.status).toBe(413);
    const real = await t.send("/webhooks/billing/fake", {
      body: JSON.stringify({ events: [], padding: "x".repeat(70 * 1024) }),
      headers: signed,
    });
    expect(real.status).toBe(413);
    // a chunked body declares no length: the stream is counted and abandoned at the limit
    let pulled = 0;
    const chunk = new TextEncoder().encode("x".repeat(16 * 1024));
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(chunk);
      },
    });
    const chunked = await t.send("/webhooks/billing/fake", {
      body: endless,
      duplex: "half",
      headers: signed,
    });
    expect(chunked.status).toBe(413);
    expect(pulled).toBeLessThan(10);
    expect(t.createStore).not.toHaveBeenCalled();
  });

  it("measures the limit in bytes, not characters, and hands the adapter the body unchanged", async () => {
    const seen: string[] = [];
    const t = setup();
    const padding = (count: number) =>
      JSON.stringify({ events: [], padding: "é".repeat(count) });
    // 40 K two-byte characters are 80 KiB: over the limit by bytes, under it by characters
    const over = await t.send("/webhooks/billing/fake", {
      body: padding(40 * 1024),
      headers: signed,
    });
    expect(over.status).toBe(413);

    const app = new Hono<ServerEnv>();
    app.use("*", requestIdMiddleware);
    app.route(
      "/",
      createBillingWebhookRoutes({
        adapters: {
          fake: {
            parse: ({ rawBody }) => {
              seen.push(rawBody);
              return [];
            },
            provider: "fake",
          },
        },
      })
    );
    const body = `\uFEFF${padding(10)}`;
    const kept = await app.fetch(
      new Request("https://polaris.example.invalid/webhooks/billing/fake", {
        body,
        method: "POST",
      }),
      {
        BILLING_HYPERDRIVE: { connectionString: "postgresql://x.invalid/db" },
      } as unknown as WorkerBindings
    );
    expect(kept.status).toBe(200);
    expect(seen).toEqual([body]);
  });
});

describe("the webhook path in the server app", () => {
  it("is not behind the browser origin check: a provider has no Origin, and an unknown provider is a 404, not a 403", async () => {
    const app = createServerApp();
    const response = await app.fetch(
      new Request("https://polaris.example.invalid/webhooks/billing/nobody", {
        body: "{}",
        method: "POST",
      }),
      { HYPERDRIVE: { connectionString: "x" } } as unknown as WorkerBindings
    );

    expect(response.status).toBe(404);
    // a 404 is also what an unmounted path answers, so the route itself is checked
    expect(
      app.routes.some(
        (route) =>
          route.method === "POST" &&
          route.path === "/webhooks/billing/:provider"
      )
    ).toBe(true);
  });
});

describe("an unresolved event is held for a retry only while its date is recent", () => {
  const minute = 60_000;
  const clock = new Date("2026-10-19T12:00:00.000Z");
  const unresolvedAdapter = (
    eventDate: Date,
    clamped = false
  ): BillingProviderAdapter => ({
    parse: () => [
      {
        eventType: "PAYMENT_CONFIRMED",
        kind: "unresolved",
        occurredAt: eventDate,
        ...(clamped ? { occurredAtClamped: true as const } : {}),
        providerEventId: "evt-unresolved",
        resourceId: "pay_1",
      } satisfies UnresolvedBillingEvent,
    ],
    provider: "fake",
  });
  const send = (offsetMs: number, clamped = false) => {
    const t = setup({
      adapter: unresolvedAdapter(new Date(clock.getTime() + offsetMs), clamped),
    });
    return t.send("/webhooks/billing/fake", { headers: signed });
  };

  beforeEach(() => {
    vi.useFakeTimers({ now: clock, toFake: ["Date"] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("refuses with a 503 for a date a little ahead or a little behind", async () => {
    expect((await send(5 * minute)).status).toBe(503);
    expect((await send(-30 * minute)).status).toBe(503);
  });

  it.each([
    ["more than 5 minutes ahead", 5 * minute + 1, "future"],
    ["more than 30 minutes behind", -30 * minute - 1, "stale"],
  ])(
    "acknowledges a date %s and logs the reason with IDs only",
    async (_name, offsetMs, reason) => {
      const errorLog = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      const response = await send(offsetMs);
      expect(response.status).toBe(200);
      expect(errorLog).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "billing_webhook_unresolved_given_up",
          providerEventId: "evt-unresolved",
          reason,
          resourceId: "pay_1",
        })
      );
    }
  );

  it("an event the adapter already cut down to now is acknowledged with no reason of its own", async () => {
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const response = await send(0, true);
    expect(response.status).toBe(200);
    const [entry] = errorLog.mock.calls[0] as [Record<string, unknown>];
    expect(entry.event).toBe("billing_webhook_unresolved_given_up");
    expect(entry).not.toHaveProperty("reason");
  });
});
