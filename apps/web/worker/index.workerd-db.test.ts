import { env, exports } from "cloudflare:workers";
import {
  createExecutionContext,
  createMessageBatch,
  createScheduledController,
  getQueueResult,
} from "cloudflare:test";
import { createDatabase } from "@polaris/db/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkerBindings } from "../src/server/environment";
import worker from "./index";

/**
 * The Web Worker, real, inside workerd, against PostgreSQL (T-121b). Its own `fetch`, its own `scheduled` and its own
 * `queue` handlers run with the bindings of the app's wrangler file: the seven Hyperdrive (one login each, made by the
 * `web-worker` gate), the four queue producers and the bucket. The test hands the Worker its events itself (the queue
 * consumers are not simulated), and the gate reads the database as the owner afterwards: what the Worker wrote is
 * checked there, not here (packages/db/scripts/verify-web-worker-gate.ts).
 *
 * What it does not prove: the pooler and the real Hyperdrive (the binding is a direct local connection), the real
 * queue (no delivery, no retry by the platform, no dead-letter move), the cron of the platform (the event is made
 * here) and Images.
 */

type Binding =
  | "AUTH_HYPERDRIVE"
  | "BILLING_HYPERDRIVE"
  | "HYPERDRIVE"
  | "MEDIA_CLEANUP_HYPERDRIVE"
  | "ONBOARDING_HYPERDRIVE"
  | "OUTBOX_HYPERDRIVE"
  | "PRIVACY_HYPERDRIVE";

interface Envelope {
  attempt: number;
  correlationId: string;
  event: Record<string, string | number | boolean>;
  eventId: string;
  idempotencyKey: string;
  organizationId: string;
  type: string;
  version: number;
}

interface Organization {
  organizationId: string;
  userId: string;
}

interface Fixture {
  /** The login of each Hyperdrive and the group role it belongs to. */
  logins: Record<Binding, { group: string; login: string }>;
  organizations: { a: Organization; b: Organization };
  /** Events the outbox holds, made by the gate. */
  events: Record<
    | "closureNoticeDone"
    | "closureNoticePermanent"
    | "closureNoticeRetry"
    | "closureNoticeWrongQueue"
    | "dispatchExport"
    | "dispatchRenewal",
    Envelope
  >;
  /** An envelope the outbox does not hold. */
  forged: Envelope;
}

const fixture = JSON.parse(env.TEST_WEB_FIXTURE ?? "{}") as Fixture;
const GROUPS = [
  "polaris_admin_runtime",
  "polaris_auth_runtime",
  "polaris_billing_runtime",
  "polaris_catalog_runtime",
  "polaris_media_cleanup_runtime",
  "polaris_onboarding_runtime",
  "polaris_outbox_runtime",
  "polaris_pr11_runtime",
  "polaris_privacy_runtime",
] as const;
const HYPERDRIVES: Binding[] = [
  "AUTH_HYPERDRIVE",
  "BILLING_HYPERDRIVE",
  "HYPERDRIVE",
  "MEDIA_CLEANUP_HYPERDRIVE",
  "ONBOARDING_HYPERDRIVE",
  "OUTBOX_HYPERDRIVE",
  "PRIVACY_HYPERDRIVE",
];
/** A Hyperdrive that fails closed: a loopback port nobody listens on. */
const CLOSED = {
  connectionString: "postgresql://harness:harness@127.0.0.1:1/harness",
};

type Bindings = Record<string, unknown>;

/** The Worker's bindings, with some replaced (a producer that records, a database that is down). */
function bindingsWith(overrides: Bindings = {}): WorkerBindings {
  return { ...env, ...overrides } as unknown as WorkerBindings;
}

/**
 * A queue producer that only remembers what was sent: nothing reaches the simulated queue, whose consumer
 * (the Worker's own `queue`) would process it later and on its own.
 */
function recording() {
  const sent: unknown[] = [];
  return {
    producer: {
      send: (body: unknown) => {
        sent.push(body);
        return Promise.resolve();
      },
      sendBatch: (messages: Iterable<MessageSendRequest>) => {
        sent.push(...[...messages].map((message) => message.body));
        return Promise.resolve();
      },
    },
    sent,
  };
}

async function runScheduled(cron: string, bindings: WorkerBindings) {
  await worker.scheduled?.(createScheduledController({ cron }), bindings);
}

/** Delivers one batch to the Worker's own `queue` handler and returns what it acknowledged and retried. */
async function deliver(
  queue: string,
  messages: { attempts?: number; body: unknown; id: string }[],
  bindings: WorkerBindings
) {
  const batch = createMessageBatch(
    queue,
    messages.map((message) => ({
      attempts: message.attempts ?? 1,
      body: message.body,
      id: message.id,
      timestamp: new Date(),
    }))
  );
  const context = createExecutionContext();
  await worker.queue?.(batch, bindings);
  return getQueueResult(batch, context);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the fetch of the web worker", () => {
  it("answers /health and /ready with the security headers", async () => {
    for (const path of ["/health", "/ready"]) {
      // biome-ignore lint/performance/noAwaitInLoops: two paths, one request at a time, for a clear failure
      const response = await exports.default.fetch(`https://web.test${path}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });

  it("refuses a call to the API without a session before it reaches the database", async () => {
    const response = await exports.default.fetch(
      "https://web.test/rpc/anything",
      {
        body: "{}",
        headers: {
          "content-type": "application/json",
          origin: "https://web.test",
        },
        method: "POST",
      }
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });

  it("does not run the sign-in without its secret (fails closed, never unconfigured)", async () => {
    const response = await exports.default.fetch(
      "https://web.test/api/auth/get-session",
      {
        headers: { origin: "https://web.test" },
      }
    );
    expect(response.status).toBe(503);
  });
});

describe("the Hyperdrive bindings of the web worker", () => {
  it.each(HYPERDRIVES)(
    "%s reaches PostgreSQL as its own login, and as no other role",
    async (binding) => {
      const expected = fixture.logins[binding];
      const { pool } = createDatabase(env[binding].connectionString, {
        maxConnections: 1,
      });
      try {
        const { rows } = await pool.query<{ login: string; groups: string[] }>(
          `SELECT current_user AS login,
                ARRAY(SELECT g FROM unnest($1::text[]) AS g WHERE pg_has_role(current_user, g, 'member') ORDER BY g) AS groups`,
          [GROUPS]
        );
        expect(rows[0]?.login).toBe(expected.login);
        // exactly the group of the binding: a binding wired to the wrong login would show another one, or two
        expect(rows[0]?.groups).toEqual([expected.group]);
      } finally {
        await pool.end();
      }
    }
  );

  it("the tenant binding opens one organization at a time (RLS through the binding)", async () => {
    const { a, b } = fixture.organizations;
    const { pool } = createDatabase(env.HYPERDRIVE.connectionString, {
      maxConnections: 1,
    });
    const visibleTo = async (organization: Organization) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "SELECT set_config('app.organization_id', $1, true), set_config('app.user_id', $2, true)",
          [organization.organizationId, organization.userId]
        );
        const { rows } = await client.query<{ id: string }>(
          "SELECT id FROM public.organizations"
        );
        await client.query("COMMIT");
        return rows.map((row) => row.id);
      } finally {
        client.release();
      }
    };
    try {
      expect(await visibleTo(a)).toEqual([a.organizationId]);
      expect(await visibleTo(b)).toEqual([b.organizationId]);
    } finally {
      await pool.end();
    }
  });

  it("no binding reaches a table it has no business with (the outbox login reads no organization)", async () => {
    const { pool } = createDatabase(env.OUTBOX_HYPERDRIVE.connectionString, {
      maxConnections: 1,
    });
    try {
      await expect(
        pool.query("SELECT id FROM public.organizations")
      ).rejects.toMatchObject({
        code: "42501",
      });
    } finally {
      await pool.end();
    }
  });
});

describe("the other bindings of the web worker", () => {
  it("has the four queue producers, and each accepts a message", async () => {
    for (const queue of [
      env.QUEUE_CRITICAL,
      env.QUEUE_DEFAULT,
      env.QUEUE_MEDIA,
      env.QUEUE_DLQ,
    ]) {
      // delayed an hour: accepted by the real producer, and nothing is delivered while the test runs
      // biome-ignore lint/performance/noAwaitInLoops: four producers, one at a time, for a clear failure
      await queue.send({ harness: "probe" }, { delaySeconds: 3600 });
    }
  });

  it("has a bucket that keeps and returns an object, and forgets it", async () => {
    const key = `harness/${crypto.randomUUID()}`;
    await env.MEDIA_BUCKET.put(key, new Uint8Array([1, 2, 3]));
    const found = await env.MEDIA_BUCKET.get(key);
    expect(found?.size).toBe(3);
    await env.MEDIA_BUCKET.delete(key);
    expect(await env.MEDIA_BUCKET.get(key)).toBeNull();
  });
});

describe("the scheduled handler of the web worker", () => {
  it("the outbox lane sends the pending events to the queue of their type, and the gate finds them dispatched", async () => {
    const critical = recording();
    const standard = recording();
    const media = recording();
    await runScheduled(
      "19 * * * *",
      bindingsWith({
        QUEUE_CRITICAL: critical.producer,
        QUEUE_DEFAULT: standard.producer,
        QUEUE_MEDIA: media.producer,
      })
    );
    const { dispatchExport, dispatchRenewal } = fixture.events;
    expect(standard.sent).toEqual([{ ...dispatchExport, attempt: 1 }]);
    expect(critical.sent).toEqual([{ ...dispatchRenewal, attempt: 1 }]);
    expect(media.sent).toEqual([]);
  });

  it("the maintenance lane runs its four jobs, and one that cannot reach its database fails alone", async () => {
    // the sign-in lock's database is down: its job fails, the other three finish, and the cron shows the failure
    await expect(
      runScheduled("17 * * * *", bindingsWith({ AUTH_HYPERDRIVE: CLOSED }))
    ).rejects.toThrow();
    // the next tick finds only that job owed (the others covered their window) and it finishes
    await expect(
      runScheduled("17 * * * *", bindingsWith())
    ).resolves.toBeUndefined();
  });

  it("a tick of the lane does nothing twice in the same window", async () => {
    const standard = recording();
    await runScheduled(
      "19 * * * *",
      bindingsWith({ QUEUE_DEFAULT: standard.producer })
    );
    expect(standard.sent).toEqual([]);
  });
});

describe("the queue handler of the web worker", () => {
  const {
    closureNoticeDone,
    closureNoticePermanent,
    closureNoticeRetry,
    closureNoticeWrongQueue,
  } = fixture.events;
  const deadLetters = recording();
  const bindings = () => bindingsWith({ QUEUE_DLQ: deadLetters.producer });

  it("processes an event the outbox holds, and acknowledges a second delivery without processing it again", async () => {
    const first = await deliver(
      "polaris-default-local",
      [{ body: closureNoticeDone, id: "msg-done" }],
      bindings()
    );
    expect(first.explicitAcks).toEqual(["msg-done"]);
    expect(first.retryMessages).toEqual([]);
    const second = await deliver(
      "polaris-default-local",
      [{ attempts: 2, body: closureNoticeDone, id: "msg-done-again" }],
      bindings()
    );
    expect(second.explicitAcks).toEqual(["msg-done-again"]);
  });

  it("acknowledges and drops an event the outbox does not hold (nothing runs on the envelope alone)", async () => {
    const result = await deliver(
      "polaris-default-local",
      [{ body: fixture.forged, id: "msg-forged" }],
      bindings()
    );
    expect(result.explicitAcks).toEqual(["msg-forged"]);
    expect(deadLetters.sent).toEqual([]);
  });

  it("acknowledges a failure a retry cannot fix, and lets the key go", async () => {
    const result = await deliver(
      "polaris-default-local",
      [{ body: closureNoticePermanent, id: "msg-permanent" }],
      bindings()
    );
    expect(result.explicitAcks).toEqual(["msg-permanent"]);
    expect(result.retryMessages).toEqual([]);
  });

  it("retries a failure that may pass, and finishes on the next delivery", async () => {
    const down = await deliver(
      "polaris-default-local",
      [{ body: closureNoticeRetry, id: "msg-retry" }],
      bindingsWith({
        PRIVACY_HYPERDRIVE: CLOSED,
        QUEUE_DLQ: deadLetters.producer,
      })
    );
    expect(down.explicitAcks).toEqual([]);
    // the delay is the consumer's own (consumer.test.ts); the harness reports which message was asked back
    expect(
      down.retryMessages.map((retried: { msgId: string }) => retried.msgId)
    ).toEqual(["msg-retry"]);
    const back = await deliver(
      "polaris-default-local",
      [{ attempts: 2, body: closureNoticeRetry, id: "msg-retry" }],
      bindings()
    );
    expect(back.explicitAcks).toEqual(["msg-retry"]);
    expect(back.retryMessages).toEqual([]);
  });

  it("sends a notice to the dead-letter queue for a message it refuses for good, and acknowledges it", async () => {
    const result = await deliver(
      "polaris-default-local",
      [{ body: { not: "an envelope" }, id: "msg-invalid" }],
      bindings()
    );
    expect(result.explicitAcks).toEqual(["msg-invalid"]);
    expect(result.retryMessages).toEqual([]);
    expect(deadLetters.sent).toHaveLength(1);
    expect(deadLetters.sent[0]).toMatchObject({
      cause: "invalid_envelope",
      kind: "polaris.dead_letter",
      messageId: "msg-invalid",
    });
  });

  it("refuses a valid event that arrives on the queue of another weight", async () => {
    const result = await deliver(
      "polaris-critical-local",
      [{ body: closureNoticeWrongQueue, id: "msg-misrouted" }],
      bindings()
    );
    expect(result.explicitAcks).toEqual(["msg-misrouted"]);
    expect(deadLetters.sent).toHaveLength(2);
    expect(deadLetters.sent[1]).toMatchObject({
      cause: "wrong_queue",
      eventId: closureNoticeWrongQueue.eventId,
      type: "organization.closure_notice",
    });
  });

  it("turns each notice of the dead-letter queue into an incident, and acknowledges it only after", async () => {
    const result = await deliver(
      "polaris-dlq-local",
      deadLetters.sent.map((body, index) => ({
        body,
        id: `msg-dead-${index}`,
      })),
      bindings()
    );
    expect(result.explicitAcks).toEqual(["msg-dead-0", "msg-dead-1"]);
    expect(result.retryMessages).toEqual([]);
  });

  it("keeps a notice for retry when the database that records it is down", async () => {
    const result = await deliver(
      "polaris-dlq-local",
      [{ body: deadLetters.sent[0], id: "msg-dead-down" }],
      bindingsWith({ OUTBOX_HYPERDRIVE: CLOSED })
    );
    expect(result.explicitAcks).toEqual([]);
    expect(result.retryMessages).toHaveLength(1);
  });
});
