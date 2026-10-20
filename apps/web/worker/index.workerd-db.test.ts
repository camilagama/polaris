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
  /** The login of each Hyperdrive and every role it is meant to belong to (its own group, and what that group itself includes). */
  logins: Record<Binding, { groups: string[]; login: string }>;
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

/** The events the Worker logged (`event` and its fields), read from the console: what a job or a consumer decided. */
function loggedEvents() {
  const spies = (["debug", "error", "info", "log", "warn"] as const).map(
    (level) => vi.spyOn(console, level).mockImplementation(() => undefined)
  );
  return () =>
    spies.flatMap((spy) =>
      spy.mock.calls.map(([entry]) => entry as Record<string, unknown>)
    );
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

  it("refuses a real procedure of the API without a session", async () => {
    const response = await exports.default.fetch(
      "https://web.test/rpc/category/create",
      {
        body: JSON.stringify({
          json: { name: "Camisas", organizationId: "org-1" },
        }),
        headers: {
          "content-type": "application/json",
          origin: "https://web.test",
        },
        method: "POST",
      }
    );
    expect(response.status).toBe(401);
  });

  it("refuses a state-changing request from another origin, before any procedure", async () => {
    const response = await exports.default.fetch(
      "https://web.test/rpc/category/create",
      {
        body: JSON.stringify({
          json: { name: "Camisas", organizationId: "org-1" },
        }),
        headers: {
          "content-type": "application/json",
          origin: "https://evil.example",
        },
        method: "POST",
      }
    );
    expect(response.status).toBe(403);
  });

  it("answers a visitor without a cookie that there is no session, through the authentication role", async () => {
    const response = await exports.default.fetch(
      "https://web.test/api/auth/get-session",
      { headers: { origin: "https://web.test" } }
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toBeNull();
  });

  it("does not run the sign-in without its secret (fails closed, never unconfigured)", async () => {
    const response = await worker.fetch(
      new Request("https://web.test/api/auth/get-session"),
      bindingsWith({ BETTER_AUTH_SECRET: undefined })
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
        const { rows } = await pool.query<{
          flags: boolean[];
          groups: string[];
          login: string;
        }>(
          `WITH RECURSIVE granted(role_id) AS (
             SELECT oid FROM pg_roles WHERE rolname = current_user
             UNION
             SELECT member.roleid FROM pg_auth_members AS member JOIN granted ON member.member = granted.role_id
           )
           SELECT current_user AS login,
                  ARRAY(SELECT rolname::text FROM pg_roles JOIN granted ON granted.role_id = pg_roles.oid
                         WHERE rolname <> current_user AND rolname NOT LIKE 'pg\\_%' ORDER BY rolname) AS groups,
                  (SELECT ARRAY[rolsuper, rolbypassrls, rolcreaterole, rolcreatedb] FROM pg_roles WHERE rolname = current_user) AS flags`
        );
        expect(rows[0]?.login).toBe(expected.login);
        // every role it belongs to, however far: exactly the roles of the binding (a binding wired to the wrong
        // login, or a login that gained another group or an owner role, would show)
        expect(rows[0]?.groups).toEqual(expected.groups);
        expect(rows[0]?.flags).toEqual([false, false, false, false]);
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
  it("the outbox lane sends the pending events to the queue of their type, once per window", async () => {
    const critical = recording();
    const standard = recording();
    const media = recording();
    const events = loggedEvents();
    const bindings = bindingsWith({
      QUEUE_CRITICAL: critical.producer,
      QUEUE_DEFAULT: standard.producer,
      QUEUE_MEDIA: media.producer,
    });
    await runScheduled("19 * * * *", bindings);
    const { dispatchExport, dispatchRenewal } = fixture.events;
    expect(standard.sent).toEqual([{ ...dispatchExport, attempt: 1 }]);
    expect(critical.sent).toEqual([{ ...dispatchRenewal, attempt: 1 }]);
    expect(media.sent).toEqual([]);
    expect(
      events().filter((entry) => entry.event === "outbox_dispatch_complete")
    ).toHaveLength(1);

    // the same window again: the lease is refused, so the dispatcher does not even run
    await runScheduled("19 * * * *", bindings);
    const skipped = events().filter(
      (entry) => entry.event === "scheduled_job_skipped"
    );
    expect(skipped.map((entry) => entry.job)).toEqual(["outbox.dispatch"]);
    expect(
      events().filter((entry) => entry.event === "outbox_dispatch_complete")
    ).toHaveLength(1);
    expect(standard.sent).toHaveLength(1);
    expect(critical.sent).toHaveLength(1);
  });

  it("the maintenance lane runs its four jobs, and one that cannot reach its database fails alone", async () => {
    const events = loggedEvents();
    // the sign-in lock's database is down: its job fails, the other three finish, and the cron shows the failure
    await expect(
      runScheduled("17 * * * *", bindingsWith({ AUTH_HYPERDRIVE: CLOSED }))
    ).rejects.toThrow();
    expect(
      events().filter((entry) => entry.event === "scheduled_job_skipped")
    ).toEqual([]);
    expect(
      events().map((entry) => entry.event),
      JSON.stringify(events().filter((entry) => entry.outcome === "failure"))
    ).toContain("billing_maintenance_complete");
    // the next tick finds only that job owed (the others covered their window) and it finishes
    await expect(
      runScheduled("17 * * * *", bindingsWith())
    ).resolves.toBeUndefined();
    const skipped = events()
      .filter((entry) => entry.event === "scheduled_job_skipped")
      .map((entry) => entry.job)
      .sort();
    expect(skipped).toEqual([
      "billing.maintenance",
      "media.maintenance",
      "privacy.maintenance",
    ]);
    expect(
      events().filter((entry) => entry.event === "auth_login_lock_expired")
    ).toHaveLength(1);
  });
});

describe("the queue handler of the web worker", () => {
  const {
    closureNoticeDone,
    closureNoticePermanent,
    closureNoticeRetry,
    closureNoticeWrongQueue,
  } = fixture.events;

  /** The notices the consumer sends to the dead-letter queue for a message it refuses for good, with what it answered. */
  async function refusals() {
    const deadLetters = recording();
    const bindings = bindingsWith({ QUEUE_DLQ: deadLetters.producer });
    const invalid = await deliver(
      "polaris-default-local",
      [{ body: { not: "an envelope" }, id: "msg-invalid" }],
      bindings
    );
    // a valid event on the queue of another weight
    const misrouted = await deliver(
      "polaris-critical-local",
      [{ body: closureNoticeWrongQueue, id: "msg-misrouted" }],
      bindings
    );
    return { deadLetters: deadLetters.sent, invalid, misrouted };
  }

  it("processes an event the outbox holds, and a second delivery of it is acknowledged without running the handler again", async () => {
    const events = loggedEvents();
    const first = await deliver(
      "polaris-default-local",
      [{ body: closureNoticeDone, id: "msg-done" }],
      bindingsWith()
    );
    expect(first.explicitAcks).toEqual(["msg-done"]);
    expect(first.retryMessages).toEqual([]);
    const handled = () =>
      events().filter((entry) => entry.event === "closure_notice_not_due");
    expect(handled()).toHaveLength(1);
    const second = await deliver(
      "polaris-default-local",
      [{ attempts: 2, body: closureNoticeDone, id: "msg-done-again" }],
      bindingsWith()
    );
    expect(second.explicitAcks).toEqual(["msg-done-again"]);
    expect(handled()).toHaveLength(1);
    expect(
      events().filter((entry) => entry.event === "queue_message_duplicate")
    ).toHaveLength(1);
  });

  it("acknowledges and drops an event the outbox does not hold (nothing runs on the envelope alone)", async () => {
    const deadLetters = recording();
    const events = loggedEvents();
    const result = await deliver(
      "polaris-default-local",
      [{ body: fixture.forged, id: "msg-forged" }],
      bindingsWith({ QUEUE_DLQ: deadLetters.producer })
    );
    expect(result.explicitAcks).toEqual(["msg-forged"]);
    expect(deadLetters.sent).toEqual([]);
    expect(
      events().filter((entry) => entry.event === "closure_notice_not_due")
    ).toEqual([]);
    expect(
      events().filter((entry) => entry.event === "queue_message_unknown_event")
    ).toHaveLength(1);
  });

  it("acknowledges a failure a retry cannot fix, and lets the key go", async () => {
    const result = await deliver(
      "polaris-default-local",
      [{ body: closureNoticePermanent, id: "msg-permanent" }],
      bindingsWith()
    );
    expect(result.explicitAcks).toEqual(["msg-permanent"]);
    expect(result.retryMessages).toEqual([]);
  });

  it("retries a failure that may pass, and finishes on the next delivery", async () => {
    const down = await deliver(
      "polaris-default-local",
      [{ body: closureNoticeRetry, id: "msg-retry" }],
      bindingsWith({ PRIVACY_HYPERDRIVE: CLOSED })
    );
    expect(down.explicitAcks).toEqual([]);
    // the delay is the consumer's own (consumer.test.ts); the harness reports which message was asked back
    expect(
      down.retryMessages.map((retried: { msgId: string }) => retried.msgId)
    ).toEqual(["msg-retry"]);
    const back = await deliver(
      "polaris-default-local",
      [{ attempts: 2, body: closureNoticeRetry, id: "msg-retry" }],
      bindingsWith()
    );
    expect(back.explicitAcks).toEqual(["msg-retry"]);
    expect(back.retryMessages).toEqual([]);
  });

  it("sends a notice to the dead-letter queue for a message it refuses for good, and acknowledges it", async () => {
    const { deadLetters, invalid, misrouted } = await refusals();
    expect(invalid.explicitAcks).toEqual(["msg-invalid"]);
    expect(invalid.retryMessages).toEqual([]);
    expect(misrouted.explicitAcks).toEqual(["msg-misrouted"]);
    expect(misrouted.retryMessages).toEqual([]);
    expect(deadLetters).toHaveLength(2);
    expect(deadLetters[0]).toMatchObject({
      cause: "invalid_envelope",
      kind: "polaris.dead_letter",
      messageId: "msg-invalid",
    });
    expect(deadLetters[1]).toMatchObject({
      cause: "wrong_queue",
      eventId: closureNoticeWrongQueue.eventId,
      type: "organization.closure_notice",
    });
  });

  it("turns each notice of the dead-letter queue into an incident, and acknowledges it only after", async () => {
    const { deadLetters } = await refusals();
    const result = await deliver(
      "polaris-dlq-local",
      deadLetters.map((body, index) => ({ body, id: `msg-dead-${index}` })),
      bindingsWith()
    );
    expect(result.explicitAcks).toEqual(["msg-dead-0", "msg-dead-1"]);
    expect(result.retryMessages).toEqual([]);
  });

  it("keeps a notice for retry when the database that records it is down", async () => {
    const { deadLetters } = await refusals();
    const result = await deliver(
      "polaris-dlq-local",
      [{ body: deadLetters[0], id: "msg-dead-down" }],
      bindingsWith({ OUTBOX_HYPERDRIVE: CLOSED })
    );
    expect(result.explicitAcks).toEqual([]);
    expect(result.retryMessages).toHaveLength(1);
  });
});
