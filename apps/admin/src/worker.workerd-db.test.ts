import { env, exports } from "cloudflare:workers";
import { activationFunnelResponse } from "@polaris/contracts/admin-activation-funnel";
import { describe, expect, it } from "vitest";
import { signAccessToken, type TokenOptions } from "./workerd-access";

/**
 * The whole Admin Worker through its real `fetch`, inside workerd, against PostgreSQL (T-127a, plan PR127):
 * Access token, principal in the database, capability, route, database function, audit. Cloudflare Access is
 * simulated (see vitest.workers-db.config.ts); everything behind it is real. The `admin-worker` gate
 * (packages/db/scripts/verify-admin-worker-gate.ts) makes the database logins and the fixtures, runs this file
 * and then checks the database itself (what must not have been written, what must).
 *
 * There is no refund here on purpose: the Admin has no refund command until a payment provider exists
 * (ADR 0073). The billing flow is the entitlement grant, recorded before and after, and the test proves
 * that a refund has no route.
 */

interface Fixture {
  customers: {
    email: string;
    id: string;
    name: string;
    organization: "a" | "b";
    phone: string;
  }[];
  organizations: Record<"a" | "b" | "reactivate" | "suspend", string>;
  principals: { disabled: string; ownerId: string; ownerSubject: string };
  /** The stores of the operator's page (corte admin-tela-v1, AC-17). */
  screen: Record<"free" | "hostile" | "trial", { id: string; name: string }> & {
    prefix: string;
  };
  strangerSubject: string;
}

const fixture = JSON.parse(env.TEST_FIXTURE ?? "{}") as Fixture;
const [maria] = fixture.customers.filter(
  (customer) => customer.organization === "a"
);
const [carlos] = fixture.customers.filter(
  (customer) => customer.organization === "b"
);

interface Answer {
  body: Record<string, unknown>;
  status: number;
}

interface Call {
  body?: unknown;
  /** No token at all when null; the owner's by default. */
  token?: string | null;
}

async function call(
  method: string,
  path: string,
  { body, token }: Call = {}
): Promise<Answer> {
  const accessToken =
    token === undefined
      ? await signAccessToken({ subject: fixture.principals.ownerSubject })
      : token;
  const response = await exports.default.fetch(`https://admin.test${path}`, {
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: {
      ...(accessToken === null
        ? {}
        : { "cf-access-jwt-assertion": accessToken }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      // a write names the Admin's own origin, as the operator's browser does
      ...(method === "GET" ? {} : { origin: "https://admin.test" }),
    },
    method,
  });
  return {
    body: (await response.json()) as Record<string, unknown>,
    status: response.status,
  };
}

const ownerToken = (options: TokenOptions = {}) =>
  signAccessToken({ subject: fixture.principals.ownerSubject, ...options });

/** A key the team never published, with the team's key id: a token someone else signed. */
async function otherKey(): Promise<JsonWebKey> {
  const pair = await crypto.subtle.generateKey(
    {
      hash: "SHA-256",
      modulusLength: 2048,
      name: "RSASSA-PKCS1-v1_5",
      publicExponent: new Uint8Array([1, 0, 1]),
    },
    true,
    ["sign", "verify"]
  );
  return await crypto.subtle.exportKey("jwk", pair.privateKey);
}

const openCaseBody = (organizationId: string) => ({
  kind: "support",
  organizationId,
  reason: "Conta comprometida",
});

async function openCase(organizationId: string): Promise<string> {
  const opened = await call("POST", "/api/support-cases", {
    body: openCaseBody(organizationId),
  });
  expect(opened.status).toBe(201);
  return opened.body.id as string;
}

function auditTypes(detail: Answer): string[] {
  return (detail.body.audit as { eventType: string }[]).map(
    (entry) => entry.eventType
  );
}

const PAGE_SCRIPT =
  /<script type="module" src="(\/ui\/admin-[0-9a-f]{16}\.js)">/;
const PAGE_SHEET =
  /<link rel="stylesheet" href="(\/ui\/admin-[0-9a-f]{16}\.css)"/;

async function getPage(path: string, token: string | null) {
  return await exports.default.fetch(`https://admin.test${path}`, {
    headers: token === null ? {} : { "cf-access-jwt-assertion": token },
  });
}

interface Listed {
  billingState: string;
  id: string;
  name: string;
  planInForce: string;
}

describe("the operator's page and its reads (corte admin-tela-v1, AC-2, AC-4, AC-5, AC-17)", () => {
  const search = async (query: string): Promise<Listed[]> => {
    const answer = await call(
      "GET",
      `/api/organizations?${new URLSearchParams({ limit: "50", query })}`
    );
    expect(answer.status).toBe(200);
    return answer.body.organizations as Listed[];
  };

  it("serves the page, its script and its sheet to the owner, under the document policy", async () => {
    const response = await getPage("/", await ownerToken());
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(response.headers.get("content-security-policy")).toContain(
      "trusted-types 'none'"
    );
    const script = PAGE_SCRIPT.exec(html)?.[1] ?? "missing";
    const sheet = PAGE_SHEET.exec(html)?.[1] ?? "missing";
    const [js, css] = await Promise.all([
      getPage(script, await ownerToken()),
      getPage(sheet, await ownerToken()),
    ]);
    expect([js.status, css.status]).toEqual([200, 200]);
    expect(js.headers.get("content-type")).toContain("text/javascript");
    expect(css.headers.get("content-type")).toContain("text/css");
    expect(await js.text()).toContain("/api/whoami");
  });

  it.each([
    ["no token", async (): Promise<string | null> => null, 401],
    [
      "a disabled operator",
      () => signAccessToken({ subject: fixture.principals.disabled }),
      403,
    ],
    [
      "someone who is not an operator",
      () => signAccessToken({ subject: `${fixture.strangerSubject}-none` }),
      403,
    ],
  ] as const)("gives no page to %s", async (_name, makeToken, status) => {
    const response = await getPage("/", await makeToken());
    expect(response.status).toBe(status);
    expect(await response.text()).not.toContain("<html");
  });

  it("finds the three stores by the start of their name or by ID, and only by what the server matches", async () => {
    const found = await search(fixture.screen.prefix);
    expect(found.map((store) => store.id).sort()).toEqual(
      [fixture.screen.free.id, fixture.screen.trial.id].sort()
    );
    const hostile = await search(fixture.screen.hostile.id);
    expect(hostile).toEqual([
      expect.objectContaining({
        billingState: "active",
        id: fixture.screen.hostile.id,
        name: fixture.screen.hostile.name,
        planInForce: "pro",
      }),
    ]);
    // the name comes back exactly as typed, markup and right-to-left override included
    expect(
      (await search("<script>alert")).map((store) => store.name)
    ).toContain(fixture.screen.hostile.name);
    // no wildcard: a % or _ is a character to match, not a pattern
    expect(await search(`%${fixture.screen.prefix.slice(1)}`)).toEqual([]);
    expect(await search(`T_la ${fixture.screen.prefix.slice(5)}`)).toEqual([]);
  });

  it.each([
    ["free", "free", "free", "free"],
    ["trial", "trialing", "pro", "trialing"],
    ["hostile", "active", "pro", "active"],
  ] as const)(
    "shows the %s store's plan as its diagnostics say",
    async (store, listed, plan, state) => {
      const { id } = fixture.screen[store];
      const [row] = await search(id);
      expect(row?.billingState).toBe(listed);
      const report = await call("GET", `/api/organizations/${id}/diagnostics`);
      expect(report.status).toBe(200);
      const entitlements = report.body.entitlements as {
        plan: string;
        state: string;
      };
      expect(entitlements.plan).toBe(plan);
      expect(entitlements.plan).toBe(row?.planInForce);
      expect(entitlements.state).toBe(state);
      expect((report.body.organization as { name: string }).name).toBe(
        fixture.screen[store].name
      );
    }
  );

  it("refuses a write without this origin, or from another origin of the site (AC-18 amended)", async () => {
    const token = await ownerToken();
    const write = (headers: Record<string, string>) =>
      exports.default.fetch("https://admin.test/api/support-cases", {
        body: JSON.stringify(openCaseBody(fixture.organizations.b)),
        headers: {
          "cf-access-jwt-assertion": token,
          "content-type": "application/json",
          ...headers,
        },
        method: "POST",
      });
    const [noOrigin, sameSite] = await Promise.all([
      write({}),
      write({ origin: "https://admin.test", "sec-fetch-site": "same-site" }),
    ]);
    expect([noOrigin.status, sameSite.status]).toEqual([403, 403]);
  });
});

describe("admin worker, whole chain, PostgreSQL", () => {
  it("has the fixtures the gate made", () => {
    expect(maria?.id).toBeTruthy();
    expect(carlos?.id).toBeTruthy();
    expect(fixture.principals.ownerId).toBeTruthy();
    expect(env.ADMIN_BILLING_HYPERDRIVE).toBeDefined();
  });

  describe("no valid Access login", () => {
    const refusals: [string, () => Promise<string | null>, number, string][] = [
      ["no token", async () => null, 401, "unauthenticated"],
      [
        "a token that is not a JWT",
        async () => "not-a-jwt",
        401,
        "unauthenticated",
      ],
      [
        "an expired token",
        () => ownerToken({ expiresInSeconds: -3600 }),
        401,
        "unauthenticated",
      ],
      [
        "a token signed by a key the team did not publish",
        async () => ownerToken({ privateJwk: await otherKey() }),
        401,
        "unauthenticated",
      ],
      [
        "a token for another audience",
        () => ownerToken({ audience: "b".repeat(64) }),
        401,
        "unauthenticated",
      ],
      [
        "a token from another team",
        () => ownerToken({ issuer: "https://other.cloudflareaccess.com" }),
        401,
        "unauthenticated",
      ],
      [
        "a valid login of someone who is not an operator",
        () => signAccessToken({ subject: `${fixture.strangerSubject}-none` }),
        403,
        "forbidden",
      ],
      [
        "a valid login whose subject is an operator's under another issuer",
        () => signAccessToken({ subject: fixture.strangerSubject }),
        403,
        "forbidden",
      ],
      [
        "a valid login of an operator who was disabled",
        () => signAccessToken({ subject: fixture.principals.disabled }),
        403,
        "forbidden",
      ],
    ];

    it.each(refusals)(
      "refuses %s, reading and writing",
      async (_name, makeToken, status, error) => {
        const token = await makeToken();
        const read = await call("GET", "/api/organizations", { token });
        expect(read.status).toBe(status);
        expect(read.body).toEqual({ error });
        // the write would open a case on organization B: the gate checks afterwards that B has none
        const write = await call("POST", "/api/support-cases", {
          body: openCaseBody(fixture.organizations.b),
          token,
        });
        expect(write.status).toBe(status);
        expect(write.body).toEqual({ error });
      }
    );

    it("does not trust a header that only claims an identity", async () => {
      const response = await exports.default.fetch(
        "https://admin.test/api/whoami",
        {
          headers: {
            "cf-access-authenticated-user-email": "operator@example.com",
            "x-forwarded-user": fixture.principals.ownerSubject,
          },
        }
      );
      expect(response.status).toBe(401);
    });

    it("answers /health without a login and says nothing else", async () => {
      const response = await exports.default.fetch("https://admin.test/health");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "ok" });
    });
  });

  describe("platform owner", () => {
    it("is known by the principal row, with every named capability", async () => {
      const answer = await call("GET", "/api/whoami");
      expect(answer.status).toBe(200);
      expect(answer.body.principal).toMatchObject({
        id: fixture.principals.ownerId,
        role: "platform_owner",
      });
      expect(answer.body.capabilities).toEqual(
        expect.arrayContaining([
          "organization:diagnose",
          "support_case:manage",
          "tenant_access:grant",
          "pii:reveal",
          "billing:operate",
          "organization:suspend",
        ])
      );
    });

    it("finds an organization and reads its diagnostics", async () => {
      const found = await call(
        "GET",
        `/api/organizations?query=${fixture.organizations.a}`
      );
      expect(found.status).toBe(200);
      expect(JSON.stringify(found.body)).toContain(fixture.organizations.a);
      const diagnostics = await call(
        "GET",
        `/api/organizations/${fixture.organizations.a}/diagnostics`
      );
      expect(diagnostics.status).toBe(200);
      expect(diagnostics.body.organization).toMatchObject({
        id: fixture.organizations.a,
        status: "active",
      });
      const unknown = await call(
        "GET",
        "/api/organizations/org-that-does-not-exist/diagnostics"
      );
      expect(unknown.status).toBe(404);
    });
  });

  describe("just-in-time access to a tenant's data", () => {
    it("opens a case, reads nothing until a grant, then reads masked and reveals on request", async () => {
      const caseId = await openCase(fixture.organizations.a);

      const before = await call(
        "GET",
        `/api/support-cases/${caseId}/customers`
      );
      expect(before.status).toBe(403);
      expect(before.body).toEqual({ error: "tenant_access_denied" });

      const granted = await call(
        "POST",
        `/api/support-cases/${caseId}/access`,
        { body: { minutes: 15 } }
      );
      expect(granted.status).toBe(201);
      expect(granted.body).toMatchObject({
        caseId,
        organizationId: fixture.organizations.a,
      });

      const page = await call("GET", `/api/support-cases/${caseId}/customers`);
      expect(page.status).toBe(200);
      const text = JSON.stringify(page.body);
      expect(text).toContain(maria?.id);
      expect(text).not.toContain(maria?.email);
      expect(text).not.toContain(maria?.phone);
      expect(text).not.toContain(maria?.name);
      expect(text).toContain("***");
      // another organization's customer is never on the page
      expect(text).not.toContain(carlos?.id);
      expect(text).not.toContain(carlos?.email);

      const revealed = await call(
        "POST",
        `/api/support-cases/${caseId}/customers/${maria?.id}/reveal`,
        { body: { field: "email" } }
      );
      expect(revealed.status).toBe(200);
      expect(revealed.body).toEqual({
        customerId: maria?.id,
        field: "email",
        value: maria?.email,
      });
      const outsider = await call(
        "POST",
        `/api/support-cases/${caseId}/customers/${carlos?.id}/reveal`,
        { body: { field: "email" } }
      );
      expect(outsider.status).toBe(404);
      const badField = await call(
        "POST",
        `/api/support-cases/${caseId}/customers/${maria?.id}/reveal`,
        { body: { field: "password" } }
      );
      expect(badField.status).toBe(400);

      const revoked = await call(
        "DELETE",
        `/api/tenant-access/${granted.body.id}`
      );
      expect(revoked.status).toBe(200);
      expect(revoked.body).toEqual({ revoked: true });
      const after = await call("GET", `/api/support-cases/${caseId}/customers`);
      expect(after.status).toBe(403);

      const detail = await call("GET", `/api/support-cases/${caseId}`);
      expect(detail.status).toBe(200);
      const events = auditTypes(detail);
      for (const expected of [
        "support_case.opened",
        "tenant_access.granted",
        "tenant_data.customers_read",
        "pii.revealed",
        "tenant_access.revoked",
      ]) {
        expect(events).toContain(expected);
      }
      // the reveal of the outsider's customer left nothing behind
      expect(JSON.stringify(detail.body)).not.toContain(carlos?.id);
    });

    it("keeps a grant short: the length is bounded", async () => {
      const caseId = await openCase(fixture.organizations.a);
      const answer = await call("POST", `/api/support-cases/${caseId}/access`, {
        body: { minutes: 100_000 },
      });
      expect(answer.status).toBe(400);
    });
  });

  describe("billing command and refund", () => {
    it("records a grant before and after, once per command, and ends it", async () => {
      const caseId = await openCase(fixture.organizations.a);
      const commandId = crypto.randomUUID();
      const body = {
        commandId,
        hours: 48,
        key: "variants.active.max",
        reason: "Compensação",
        value: 300,
      };
      const path = `/api/support-cases/${caseId}/entitlement-grants`;

      const first = await call("POST", path, { body });
      expect(first.status).toBe(201);
      expect(first.body).toMatchObject({
        created: true,
        id: commandId,
        organizationId: fixture.organizations.a,
        outcomeRecorded: true,
      });
      const repeat = await call("POST", path, { body });
      expect(repeat.status).toBe(200);
      expect(repeat.body).toMatchObject({ created: false, id: commandId });

      const diagnostics = await call(
        "GET",
        `/api/organizations/${fixture.organizations.a}/diagnostics`
      );
      expect(diagnostics.body.grants).toEqual([
        expect.objectContaining({
          key: "variants.active.max",
          limitValue: 300,
          revokedAt: null,
        }),
      ]);

      const ended = await call("DELETE", `${path}/${commandId}`);
      expect(ended.status).toBe(200);
      expect(ended.body).toMatchObject({
        outcomeRecorded: true,
        revoked: true,
      });

      const events = auditTypes(
        await call("GET", `/api/support-cases/${caseId}`)
      );
      expect(events).toEqual(
        expect.arrayContaining([
          "billing.entitlement_grant_requested",
          "billing.entitlement_granted",
          "billing.entitlement_revoke_requested",
          "billing.entitlement_revoked",
        ])
      );
    });

    it("refuses a grant on a case that is closed, and writes nothing", async () => {
      const caseId = await openCase(fixture.organizations.a);
      const closed = await call("POST", `/api/support-cases/${caseId}/close`, {
        body: { resolution: "Resolvido" },
      });
      expect(closed.status).toBe(200);
      const answer = await call(
        "POST",
        `/api/support-cases/${caseId}/entitlement-grants`,
        {
          body: {
            hours: 1,
            key: "variants.active.max",
            reason: "Depois de fechado",
            value: 301,
          },
        }
      );
      // a case that is not open: refused by the database before anything is done
      expect(answer.status).toBe(400);
      expect(answer.body).toEqual({ error: "case_not_open" });
    });

    it("has no refund: no route for it (ADR 0073)", async () => {
      const caseId = await openCase(fixture.organizations.a);
      for (const path of [
        `/api/support-cases/${caseId}/refund`,
        `/api/support-cases/${caseId}/refunds`,
        `/api/organizations/${fixture.organizations.a}/refund`,
      ]) {
        // biome-ignore lint/performance/noAwaitInLoops: three probes, in order
        const answer = await call("POST", path, {
          body: { amountCents: 100, reason: "x" },
        });
        expect(answer.status).toBe(404);
      }
    });
  });

  describe("activation funnel", () => {
    // the gate counts the `activation_funnel.read` events of the owner afterwards: one per answered read, none for a
    // refused one (ACTIVATION_FUNNEL_ANSWERED_READS in verify-admin-worker-gate.ts)
    it("answers each read through the audited wrapper in the closed contract, and refuses what is not one", async () => {
      // three answered reads: ACTIVATION_FUNNEL_ANSWERED_READS of the gate counts them, change both
      for (const weeks of [1, 4, 26]) {
        // biome-ignore lint/performance/noAwaitInLoops: Three reads, three events, in order.
        const read = await call("GET", `/api/funnel?weeks=${weeks}`);
        expect(read.status).toBe(200);
        expect(activationFunnelResponse.parse(read.body)).toEqual(read.body);
        expect(read.body.weeks).toBe(weeks);
        expect(read.body.cohorts).toHaveLength(weeks);
      }
      expect((await call("GET", "/api/funnel?weeks=0")).status).toBe(400);
      expect((await call("GET", "/api/funnel?weeks=27")).status).toBe(400);
      const disabled = await call("GET", "/api/funnel?weeks=4", {
        token: await signAccessToken({ subject: fixture.principals.disabled }),
      });
      expect(disabled.status).toBe(403);
    });
  });

  describe("internal store marker", () => {
    it("marks and unmarks a store through the database, a repeat changes nothing, an unknown store is 404", async () => {
      const path = `/api/organizations/${fixture.organizations.reactivate}/classification`;
      const marked = await call("POST", path, { body: { internal: true } });
      expect(marked).toEqual({
        body: { changed: true, internal: true },
        status: 200,
      });
      const again = await call("POST", path, { body: { internal: true } });
      expect(again.body).toEqual({ changed: false, internal: true });
      const unmarked = await call("POST", path, { body: { internal: false } });
      expect(unmarked.body).toEqual({ changed: true, internal: false });
      const unknown = await call(
        "POST",
        "/api/organizations/no-such-store/classification",
        { body: { internal: true } }
      );
      expect(unknown.status).toBe(404);
    });
  });

  describe("suspension", () => {
    it("suspends once, shows it in the diagnostics, and does not touch another organization", async () => {
      const caseId = await openCase(fixture.organizations.suspend);
      const first = await call("POST", `/api/support-cases/${caseId}/suspend`);
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ changed: true, status: "suspended" });
      const again = await call("POST", `/api/support-cases/${caseId}/suspend`);
      expect(again.body).toMatchObject({ changed: false, status: "suspended" });

      const diagnostics = await call(
        "GET",
        `/api/organizations/${fixture.organizations.suspend}/diagnostics`
      );
      expect(diagnostics.body.organization).toMatchObject({
        status: "suspended",
      });
      const untouched = await call(
        "GET",
        `/api/organizations/${fixture.organizations.a}/diagnostics`
      );
      expect(untouched.body.organization).toMatchObject({ status: "active" });
    });

    it("reactivates, and the epoch does not go back", async () => {
      const caseId = await openCase(fixture.organizations.reactivate);
      const before = await call(
        "GET",
        `/api/organizations/${fixture.organizations.reactivate}/diagnostics`
      );
      const epoch = (before.body.organization as { authorizationEpoch: number })
        .authorizationEpoch;
      const suspended = await call(
        "POST",
        `/api/support-cases/${caseId}/suspend`
      );
      expect(suspended.body).toMatchObject({ changed: true });
      const reactivated = await call(
        "POST",
        `/api/support-cases/${caseId}/reactivate`
      );
      expect(reactivated.status).toBe(200);
      expect(reactivated.body).toMatchObject({
        changed: true,
        status: "active",
      });
      const after = await call(
        "GET",
        `/api/organizations/${fixture.organizations.reactivate}/diagnostics`
      );
      expect(after.body.organization).toMatchObject({
        authorizationEpoch: epoch + 1,
        status: "active",
      });
    });

    it("is refused for a disabled operator, with the organization untouched", async () => {
      const caseId = await openCase(fixture.organizations.a);
      const answer = await call(
        "POST",
        `/api/support-cases/${caseId}/suspend`,
        {
          token: await signAccessToken({
            subject: fixture.principals.disabled,
          }),
        }
      );
      expect(answer.status).toBe(403);
      const diagnostics = await call(
        "GET",
        `/api/organizations/${fixture.organizations.a}/diagnostics`
      );
      expect(diagnostics.body.organization).toMatchObject({ status: "active" });
    });
  });
});
