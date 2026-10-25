import {
  createExecutionContext,
  createMessageBatch,
  createScheduledController,
  getQueueResult,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { createDatabase } from "@polaris/db/client";
import { LEGAL_DOCUMENTS } from "@polaris/domain/legal/legal-documents";
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
  /**
   * What the sign-in flows use: the tag every e-mail of a journey carries (the gate reads the rows of those users as the
   * owner afterwards), and a user the gate made, verified and already linked to Google.
   */
  auth: {
    googleLinked: { accountId: string; email: string; userId: string };
    tag: string;
  };
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
  /** The login of each Hyperdrive and every role it is meant to belong to (its own group, and what that group itself includes). */
  logins: Record<Binding, { groups: string[]; login: string }>;
  organizations: { a: Organization; b: Organization };
}

const UUID = /^[0-9a-f-]{36}$/;

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

  it("the maintenance lane runs its five jobs, and the ones that cannot reach their database fail alone", async () => {
    const events = loggedEvents();
    // the authentication database is down: its two jobs (the sign-in lock and the unverified users) fail, the other three finish, and the cron shows the failure
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
    // the next tick finds only those two jobs owed (the others covered their window) and they finish
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
    expect(
      events().filter((entry) => entry.event === "auth_unverified_users_purged")
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

  // The gate counts the incidents of `invalid_envelope` and `wrong_queue` as `before + 1`. That holds because this is the only test
  // that delivers to the dead-letter queue with a database that is up (`refusals()` only records the notices in the other
  // tests, and the one below delivers them with the database down, where nothing is written). A second test that
  // delivers them to a live `polaris-dlq-local` adds an incident and the gate fails: change the gate's counts with it.
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

describe("the e-mail and password flows of the web worker", () => {
  const ORIGIN = "https://web.test";
  const PASSWORD = "Long passphrase for the web worker gate 2026!";
  const NEW_PASSWORD = "Another long passphrase for the web worker 2026!";
  const GOOGLE_CLIENT_ID = "harness-client.apps.googleusercontent.com";
  /** What the Worker needs to run the password flows and Google: every value is fake, none leaves the harness. */
  const AUTH_BINDINGS = {
    AUTH_ABUSE_PROTECTION_ENABLED: "true",
    AUTH_EMAIL_FROM: "Polaris <no-reply@web.test>",
    EMAIL_PASSWORD_AUTH_ENABLED: "true",
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: "harness-google-secret",
    RESEND_API_KEY: "re_harness_not_a_key",
    TURNSTILE_SECRET_KEY: "harness-turnstile-secret",
  };
  /** The action of Turnstile each protected route asks for: written here, not read from the Worker. */
  const TURNSTILE_ACTIONS: Record<string, string> = {
    "/api/auth/request-password-reset": "password_reset_request",
    "/api/auth/reset-password": "password_reset",
    "/api/auth/sign-in/email": "login",
    "/api/auth/sign-up/email": "signup",
  };

  interface SentEmail {
    subject: string;
    text: string;
    to: string[];
  }

  interface SessionAnswer {
    session: { userId: string };
    user: { email: string; emailVerified: boolean; id: string };
  }

  const email = (journey: string) =>
    `${fixture.auth.tag}-${journey}@example.invalid`;

  /**
   * A JWT with no signature: the Google provider of Better Auth (1.6) only decodes the identity token it gets from the
   * token endpoint in the callback. A version that verifies the signature there breaks these two tests, and then the
   * token needs a key the test serves as Google's JWKS.
   */
  function forgedIdToken(claims: Record<string, unknown>) {
    const part = (value: object) =>
      btoa(JSON.stringify(value))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replaceAll("=", "");
    return `${part({ alg: "none", typ: "JWT" })}.${part(claims)}.`;
  }

  async function bodyOf(input: Request | string | URL, init?: RequestInit) {
    if (init?.body !== undefined && init.body !== null) {
      return String(init.body);
    }
    return input instanceof Request ? await input.clone().text() : "";
  }

  /**
   * The network of the Worker, answered here: Resend (the e-mails are kept, the links are read from them), the Turnstile
   * check, the HIBP range of the password policy and the token endpoint of Google. Any other call is kept in `strangers`
   * and answered 502, and a test ends by asserting there is none.
   */
  function fakeNetwork(googleClaims?: Record<string, unknown>) {
    const emails: SentEmail[] = [];
    const strangers: string[] = [];
    const googleTokenRequests: URLSearchParams[] = [];
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input)
        );
        const body = await bodyOf(input, init);
        if (url.href.startsWith("https://api.pwnedpasswords.com/range/")) {
          return new Response(`${"0".repeat(35)}:0\r\n`);
        }
        if (url.href === "https://api.resend.com/emails") {
          emails.push(JSON.parse(body) as SentEmail);
          return Response.json({ id: crypto.randomUUID() });
        }
        if (
          url.href ===
          "https://challenges.cloudflare.com/turnstile/v0/siteverify"
        ) {
          // the token the test sends is the action it expects: the Worker must ask for the action of the route
          return Response.json({
            action: new URLSearchParams(body).get("response"),
            hostname: "web.test",
            success: true,
          });
        }
        if (
          url.href === "https://oauth2.googleapis.com/token" &&
          googleClaims
        ) {
          googleTokenRequests.push(new URLSearchParams(body));
          return Response.json({
            access_token: "harness-access-token",
            expires_in: 3600,
            id_token: forgedIdToken(googleClaims),
            scope: "openid email profile",
            token_type: "Bearer",
          });
        }
        strangers.push(`${init?.method ?? "GET"} ${url.origin}${url.pathname}`);
        return new Response("no network in the harness", { status: 502 });
      });
    return { emails, googleTokenRequests, spy, strangers };
  }

  /** The Worker's own `fetch`, with the bindings of the flows, and the background tasks (the e-mails) waited for. */
  async function call(
    path: string,
    options: { body?: unknown; cookie?: string; ip: string; method?: string }
  ) {
    const method =
      options.method ?? (options.body === undefined ? "GET" : "POST");
    const headers = new Headers({
      "cf-connecting-ip": options.ip,
      origin: ORIGIN,
    });
    if (options.body !== undefined) {
      headers.set("content-type", "application/json");
    }
    if (options.cookie) {
      headers.set("cookie", options.cookie);
    }
    const action = TURNSTILE_ACTIONS[path];
    if (action) {
      headers.set("x-turnstile-token", action);
    }
    const context = createExecutionContext();
    const response = await worker.fetch(
      new Request(`${ORIGIN}${path}`, {
        ...(options.body === undefined
          ? {}
          : { body: JSON.stringify(options.body) }),
        headers,
        method,
      }),
      bindingsWith(AUTH_BINDINGS),
      context
    );
    await waitOnExecutionContext(context);
    return response;
  }

  /** The cookies a response sets, as the browser sends them back (a cookie the response empties is dropped). */
  function cookiesOf(response: Response) {
    return response.headers
      .getSetCookie()
      .map((cookie) => cookie.split(";")[0] ?? "")
      .filter((cookie) => !cookie.endsWith("="))
      .join("; ");
  }

  /** The token of the link of an e-mail: the app puts it in the fragment, never in the query. */
  function linkTokenOf(message: SentEmail, page: string) {
    const link = message.text.match(
      new RegExp(`https://web\\.test${page}#token=[^\\s)>"\\]]+`)
    )?.[0];
    expect(link, `the e-mail has the link of ${page}`).toBeDefined();
    const token = new URLSearchParams(
      new URL(link as string).hash.slice(1)
    ).get("token");
    expect(token).toBeTruthy();
    return token as string;
  }

  async function sessionOf(cookie: string, ip: string) {
    const response = await call("/api/auth/get-session", { cookie, ip });
    expect(response.status).toBe(200);
    return (await response.json()) as SessionAnswer | null;
  }

  async function signUp(address: string, ip: string) {
    return await call("/api/auth/sign-up/email", {
      body: {
        email: address,
        legalAcceptance: {
          privacy: LEGAL_DOCUMENTS.privacy.version,
          terms: LEGAL_DOCUMENTS.terms.version,
        },
        name: "Web Worker Gate",
        password: PASSWORD,
      },
      ip,
    });
  }

  async function verifyByLink(token: string, ip: string) {
    return await call("/api/email-verification", { body: { token }, ip });
  }

  async function signIn(address: string, password: string, ip: string) {
    return await call("/api/auth/sign-in/email", {
      body: { email: address, password },
      ip,
    });
  }

  /** A verified user, made through the routes of the Worker as a person does. */
  async function verifiedUser(
    network: ReturnType<typeof fakeNetwork>,
    address: string,
    ip: string
  ) {
    expect((await signUp(address, ip)).status).toBe(200);
    const [message] = network.emails;
    expect(message).toBeDefined();
    const token = linkTokenOf(message as SentEmail, "/confirmar-email");
    expect((await verifyByLink(token, ip)).status).toBe(200);
    network.emails.length = 0;
  }

  async function signedInCookie(address: string, password: string, ip: string) {
    const response = await signIn(address, password, ip);
    expect(response.status).toBe(200);
    const cookie = cookiesOf(response);
    expect(cookie).toContain("session_token=");
    return cookie;
  }

  it("signs up, verifies the e-mail by the link, signs in with the password and signs out", async () => {
    const network = fakeNetwork();
    const address = email("signup");
    const ip = "198.51.100.11";

    const created = await signUp(address, ip);
    expect(created.status).toBe(200);
    // the verification e-mail went out through Resend, with the link of the app and the token in the fragment
    expect(network.emails).toHaveLength(1);
    const [message] = network.emails as [SentEmail];
    expect(message.to).toEqual([address]);
    expect(message.subject).toBe("Confirme seu e-mail do Polaris");
    const token = linkTokenOf(message, "/confirmar-email");

    // no session before the address is verified
    const early = await signIn(address, PASSWORD, ip);
    expect(early.status).toBe(403);
    expect(cookiesOf(early)).not.toContain("session_token=");

    // the token in a URL of the Worker is closed on purpose (it would reach the log); the page posts it in a body
    const closed = await call(
      `/api/auth/verify-email?token=${encodeURIComponent(token)}`,
      { ip }
    );
    expect(closed.status).toBe(404);
    const verified = await verifyByLink(token, ip);
    expect(verified.status).toBe(200);
    expect(await verified.json()).toEqual({ status: "verified" });
    // the same link again answers verified too (a reload of the page never says expired)
    expect((await verifyByLink(token, ip)).status).toBe(200);

    const wrong = await signIn(address, `${PASSWORD} wrong`, ip);
    expect(wrong.status).toBe(401);
    const cookie = await signedInCookie(address, PASSWORD, ip);
    const session = await sessionOf(cookie, ip);
    expect(session?.user).toMatchObject({
      email: address,
      emailVerified: true,
    });

    const out = await call("/api/auth/sign-out", {
      body: {},
      cookie,
      ip,
    });
    expect(out.status).toBe(200);
    expect(await sessionOf(cookie, ip)).toBeNull();
    expect(network.strangers).toEqual([]);
  });

  it("closes the connections of a signed-in get-session and sync/pull without a database_pool_error (CPU-1d)", async () => {
    const network = fakeNetwork();
    const address = email("pool-close");
    const ip = "198.51.100.17";
    await verifiedUser(network, address, ip);
    const cookie = await signedInCookie(address, PASSWORD, ip);
    const created = await call("/rpc/organization/createInitial", {
      body: {
        json: { name: "Loja do fechamento", timezone: "America/Sao_Paulo" },
      },
      cookie,
      ip,
    });
    expect(created.status).toBe(200);
    const organizationId = (
      (await created.json()) as { json: { organization: { id: string } } }
    ).json.organization.id;

    const events = loggedEvents();
    expect(await sessionOf(cookie, ip)).not.toBeNull();
    const pulled = await call("/rpc/sync/pull", {
      body: { json: { limit: 10, organizationId } },
      cookie,
      ip,
    });
    expect(pulled.status).toBe(200);
    // the pools end after the answer and the socket's read rejects a moment later: give it the time
    await new Promise((resolve) => setTimeout(resolve, 200));
    const logged = events();
    expect(
      logged.filter((entry) => entry.event === "database_pool_error")
    ).toEqual([]);
    // the request log says which isolate answered and the place of the request in it
    const timed = logged.filter(
      (entry) => entry.event === "http_request_timed"
    );
    expect(timed.length).toBeGreaterThanOrEqual(2);
    for (const entry of timed) {
      expect(entry.isolate).toEqual({
        closedByUs: expect.any(Number),
        id: expect.stringMatching(UUID),
        seq: expect.any(Number),
      });
    }
    expect(network.strangers).toEqual([]);
  });

  it("changes the password and ends every other session (the new one stays)", async () => {
    const network = fakeNetwork();
    const address = email("change");
    const ip = "198.51.100.12";
    await verifiedUser(network, address, ip);

    const phone = await signedInCookie(address, PASSWORD, ip);
    const laptop = await signedInCookie(address, PASSWORD, ip);
    expect((await sessionOf(phone, ip))?.user.email).toBe(address);
    expect((await sessionOf(laptop, ip))?.user.email).toBe(address);

    const changed = await call("/api/auth/change-password", {
      body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
      cookie: phone,
      ip,
    });
    expect(changed.status).toBe(200);
    // the session that changed it gets a new cookie, and the other devices lose theirs
    const renewed = cookiesOf(changed);
    expect(renewed).toContain("session_token=");
    expect((await sessionOf(renewed, ip))?.user.email).toBe(address);
    expect(await sessionOf(laptop, ip)).toBeNull();
    expect(await sessionOf(phone, ip)).toBeNull();

    expect((await signIn(address, PASSWORD, ip)).status).toBe(401);
    expect(await signedInCookie(address, NEW_PASSWORD, ip)).toContain(
      "session_token="
    );
    // the notice that the password changed went out, to the address of the account
    expect(network.emails.map((sent) => sent.subject)).toContain(
      "A senha da sua conta do Polaris foi trocada"
    );
    expect(network.emails.every((sent) => sent.to[0] === address)).toBe(true);
    expect(network.strangers).toEqual([]);
  });

  it("resets a forgotten password by the token the e-mail carries, once, and ends every session", async () => {
    const network = fakeNetwork();
    const address = email("reset");
    const ip = "198.51.100.13";
    await verifiedUser(network, address, ip);
    const device = await signedInCookie(address, PASSWORD, ip);

    const asked = await call("/api/auth/request-password-reset", {
      body: { email: address },
      ip,
    });
    expect(asked.status).toBe(200);
    expect(network.emails).toHaveLength(1);
    const [message] = network.emails as [SentEmail];
    expect(message.to).toEqual([address]);
    expect(message.subject).toBe("Redefina sua senha do Polaris");
    const token = linkTokenOf(message, "/redefinir-senha");

    // the token is the one Better Auth stored in `verification`, read here through the authentication role
    const { pool } = createDatabase(env.AUTH_HYPERDRIVE.connectionString, {
      maxConnections: 1,
    });
    const stored = async () =>
      (
        await pool.query<{ value: string }>(
          "SELECT value FROM public.verification WHERE identifier = $1",
          [`reset-password:${token}`]
        )
      ).rows;
    try {
      expect(await stored()).toHaveLength(1);
      // the link in a URL of the Worker is closed (the token would reach the log)
      expect(
        (await call(`/api/auth/reset-password/${token}`, { ip })).status
      ).toBe(404);

      const reset = await call("/api/auth/reset-password", {
        body: { newPassword: NEW_PASSWORD, token },
        ip,
      });
      expect(reset.status).toBe(200);
      expect(await stored()).toEqual([]);
    } finally {
      await pool.end();
    }

    // the token worked once, and the session that was open ended with the reset
    const again = await call("/api/auth/reset-password", {
      body: { newPassword: PASSWORD, token },
      ip,
    });
    expect(again.status).toBe(400);
    expect(await sessionOf(device, ip)).toBeNull();
    expect((await signIn(address, PASSWORD, ip)).status).toBe(401);
    const cookie = await signedInCookie(address, NEW_PASSWORD, ip);
    expect((await sessionOf(cookie, ip))?.user.email).toBe(address);
    expect(network.strangers).toEqual([]);
  });

  /** Google, from the start to the callback: the token endpoint is answered by `fakeNetwork`. */
  async function googleSignIn(ip: string, code: string) {
    const start = await call("/api/auth/sign-in/social", {
      body: { callbackURL: "/painel", provider: "google" },
      ip,
    });
    expect(start.status).toBe(200);
    const { url } = (await start.json()) as { url: string };
    const authorization = new URL(url);
    expect(`${authorization.origin}${authorization.pathname}`).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth"
    );
    expect(authorization.searchParams.get("client_id")).toBe(GOOGLE_CLIENT_ID);
    expect(authorization.searchParams.get("redirect_uri")).toBe(
      `${ORIGIN}/api/auth/callback/google`
    );
    const state = authorization.searchParams.get("state") ?? "";
    expect(state).not.toBe("");
    return await call(
      `/api/auth/callback/google?code=${code}&state=${encodeURIComponent(state)}`,
      { cookie: cookiesOf(start), ip }
    );
  }

  function claimsOf(subject: string, address: string) {
    return {
      aud: GOOGLE_CLIENT_ID,
      email: address,
      email_verified: true,
      exp: Math.floor(Date.now() / 1000) + 3600,
      iss: "https://accounts.google.com",
      name: "Google Person",
      sub: subject,
    };
  }

  it("signs a new person in with Google: the callback creates the user and the linked account, and opens a session", async () => {
    const address = email("google-new");
    const network = fakeNetwork(claimsOf(`${fixture.auth.tag}-new`, address));
    const callback = await googleSignIn("198.51.100.14", "harness-code-new");
    expect(callback.status).toBe(302);
    const location = new URL(callback.headers.get("location") ?? "", ORIGIN);
    expect(location.pathname).toBe("/painel");
    expect(location.searchParams.has("error")).toBe(false);
    // the code went to the token endpoint of Google with the client of the Worker, and nothing else left the harness
    expect(network.googleTokenRequests).toHaveLength(1);
    expect(network.googleTokenRequests[0]?.get("code")).toBe(
      "harness-code-new"
    );
    expect(network.googleTokenRequests[0]?.get("client_id")).toBe(
      GOOGLE_CLIENT_ID
    );
    const cookie = cookiesOf(callback);
    expect(cookie).toContain("session_token=");
    const session = await sessionOf(cookie, "198.51.100.14");
    expect(session?.user).toMatchObject({
      email: address,
      emailVerified: true,
    });
    expect(network.strangers).toEqual([]);
  });

  it("signs in with Google a person whose account is already linked: the same user, no second one", async () => {
    const { accountId, email: address, userId } = fixture.auth.googleLinked;
    const network = fakeNetwork(claimsOf(accountId, address));
    const callback = await googleSignIn("198.51.100.15", "harness-code-linked");
    expect(callback.status).toBe(302);
    const location = new URL(callback.headers.get("location") ?? "", ORIGIN);
    expect(location.pathname).toBe("/painel");
    expect(location.searchParams.has("error")).toBe(false);
    const session = await sessionOf(cookiesOf(callback), "198.51.100.15");
    expect(session?.user.id).toBe(userId);
    expect(network.strangers).toEqual([]);
  });
});
