import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { polarisContract } from "../packages/contracts/src/index.ts";
import {
  attempt,
  awaitRelease,
  BILLING_WEBHOOK_PROVIDERS,
  COMMIT_REFUSAL,
  CREATE_INITIAL_INPUT,
  environmentOf,
  PRODUCTION_USER_AGENT,
  PRODUCTION_VARIABLES,
  planOf,
  productionTarget,
  REFUSAL,
  RELEASE_WAIT_CEILING_MS,
  refusalOf,
  runSmoke,
  STAGING_ACCESS_TEAM,
  STAGING_FIXED_HOST,
  STAGING_TARGET,
  STRANGE_ORIGIN,
  send,
  smokeChecks,
  USER_AGENT,
} from "./smoke-staging.mjs";
import { STAGING_WORKERS, worstCaseMs } from "./verify-deployed-sha.mjs";

const origins = {
  admin: "https://admin.araute.app",
  catalog: "https://catalogo.araute.app",
  web: "https://dash.araute.app",
};

const COMMIT = "9b3d37ed5c223fba78109e32e9196bb294b35358";
const RELEASE = "9b3d37ed5c22";
const INDEX = "<!doctype html><title>Polaris</title>";
const SHELL_CSP_WITHOUT_SENTRY =
  "default-src 'self'; script-src 'self'; connect-src 'self' data:";
const SHELL_CSP_WITH_SENTRY = `${SHELL_CSP_WITHOUT_SENTRY} https://o4510000000000000.ingest.us.sentry.io`;
const SERVICE_WORKER = "self.addEventListener('install', () => {});";
const REQUEST_ID = "0199c2d0-0000-7000-8000-0000000000aa";
const AUTH_METHODS = {
  emailPassword: true,
  google: true,
  turnstileSiteKey: "0x4AAAAAAFhym3AGtjg2fgH0",
};

const noPause = () => Promise.resolve();

/** What Access answers to a request without its cookie: a redirect to the login of the team. */
const toAccessLogin = (path) =>
  answer(302, {
    location: `https://${STAGING_ACCESS_TEAM}/cdn-cgi/access/login/admin.araute.app?kid=x&redirect_url=${encodeURIComponent(path)}`,
  });

/** A clock that moves only when something sleeps, so no test waits for real. */
function fakeClock() {
  let elapsed = 0;
  const sleeps = [];
  return {
    advance: (ms) => {
      elapsed += ms;
    },
    now: () => elapsed,
    sleep: (ms) => {
      sleeps.push(ms);
      elapsed += ms;
      return Promise.resolve();
    },
    sleeps,
  };
}

let buildDir = "";
let options = { buildDir: "", clock: fakeClock(), commit: COMMIT };

beforeAll(async () => {
  buildDir = await mkdtemp(join(tmpdir(), "smoke-staging-"));
  await writeFile(join(buildDir, "index.html"), INDEX);
  await writeFile(join(buildDir, "sw.js"), SERVICE_WORKER);
  options = { buildDir, clock: fakeClock(), commit: COMMIT };
});

afterAll(async () => {
  await rm(buildDir, { force: true, recursive: true });
});

const answer = (status, headers = {}, body = null) =>
  new Response(body, { headers, status });

const fromWorker = (status, headers = {}, body = null) =>
  answer(status, { "x-request-id": REQUEST_ID, ...headers }, body);

const json = (value) => JSON.stringify(value);

/** What the origin check of the Worker answers (`middleware/origin-check.ts`). */
const forbidden = (code = "forbidden") =>
  fromWorker(
    403,
    { "content-type": "application/json" },
    json({ error: { code }, requestId: REQUEST_ID })
  );

/** The input schema of a procedure of the contract decides between 400 (invalid body) and 401 (no session). */
function anonymousCall(procedure, init) {
  const schema = procedure["~orpc"].inputSchema;
  const input = JSON.parse(init.body).json;
  if (schema && !schema.safeParse(input).success) {
    return fromWorker(400);
  }
  return fromWorker(
    401,
    { "content-type": "application/json" },
    json({ json: { code: "UNAUTHORIZED" } })
  );
}

/** What the billing webhook route answers (`routes/billing-webhooks.ts`) to a delivery without proof, or without the provider's secrets. */
const webhookRefusal = (status = 401, code = "unauthorized") =>
  fromWorker(
    status,
    { "content-type": "application/json" },
    json({ error: { code }, requestId: REQUEST_ID })
  );

/** A staging that answers every check as expected. */
function stagingAnswer(url, init = {}) {
  const origin = new Headers(init.headers).get("origin");
  switch (url) {
    case `${origins.web}/health`:
      return fromWorker(
        200,
        { "x-polaris-release": RELEASE },
        json({ status: "ok" })
      );
    case `${origins.web}/`:
      return answer(
        200,
        { "content-security-policy": SHELL_CSP_WITH_SENTRY },
        INDEX
      );
    case `${origins.web}/sw.js`:
      return answer(200, {}, SERVICE_WORKER);
    case `${origins.web}/entrar`:
      return answer(200, {}, INDEX);
    case `${origins.web}/api/auth-methods`:
      return fromWorker(200, {}, json(AUTH_METHODS));
    case `${origins.web}/api/auth/get-session`:
      return fromWorker(200, {}, "null");
    case `${origins.web}/rpc/system/ping`:
      return origin === origins.web
        ? fromWorker(200, {}, json({ json: { message: "pong" } }))
        : forbidden();
    case `${origins.web}/rpc/organization/listMine`:
      return anonymousCall(polarisContract.organization.listMine, init);
    case `${origins.web}/rpc/organization/createInitial`:
      return anonymousCall(polarisContract.organization.createInitial, init);
    case `${origins.web}/webhooks/billing/asaas`:
    case `${origins.web}/webhooks/billing/woovi`:
    case `${origins.web}/webhooks/email/resend`:
      return webhookRefusal();
    case `${origins.catalog}/`:
      return answer(200, {
        "content-security-policy": "script-src 'nonce-abc' 'strict-dynamic'",
      });
    case `${origins.catalog}/robots.txt`:
      return answer(200, { "x-polaris-release": RELEASE }, "User-agent: *\n");
    case `${origins.admin}/health`:
      return toAccessLogin("/health");
    case `${origins.admin}/api/whoami`:
      return toAccessLogin("/api/whoami");
    default:
      return answer(404);
  }
}

/** `override` replaces the answer of one URL; a function there gets the request too. */
const fakeStaging =
  (override = {}) =>
  (url, init) => {
    if (url in override) {
      const replaced = override[url];
      return Promise.resolve(
        typeof replaced === "function" ? replaced(init) : replaced
      );
    }
    return Promise.resolve(stagingAnswer(url, init));
  };

describe("the staging smoke", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes when every check answers as expected, with twenty checks", async () => {
    const fetchImpl = vi.fn(fakeStaging());
    expect(await runSmoke(origins, options, fetchImpl, noPause)).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(22);
  });

  it("runs the anonymous /rpc calls that build Better Auth last, after the get-session", () => {
    const names = smokeChecks(origins, {
      release: RELEASE,
      shell: { index: "", serviceWorker: "" },
    }).map((check) => check.url);
    expect(names).toHaveLength(20);
    expect(names.slice(-2)).toEqual([
      `${origins.web}/rpc/organization/listMine`,
      `${origins.web}/rpc/organization/createInitial`,
    ]);
    expect(names.indexOf(`${origins.web}/api/auth/get-session`)).toBeLessThan(
      13
    );
  });

  it("sends the same-origin Origin from the web origin, and its user agent on every request", async () => {
    const requests = [];
    const fetchImpl = (url, init) => {
      requests.push({
        headers: new Headers(init.headers),
        method: init.method,
        url,
      });
      return fakeStaging()(url, init);
    };
    expect(await runSmoke(origins, options, fetchImpl, noPause)).toEqual([]);
    expect(
      requests.every(({ headers }) => headers.get("user-agent") === USER_AGENT)
    ).toBe(true);
    const posts = requests.filter(({ method }) => method === "POST");
    expect(
      posts.map(({ headers, url }) => [
        new URL(url).pathname,
        headers.get("origin"),
      ])
    ).toEqual([
      ["/rpc/system/ping", origins.web],
      ["/rpc/system/ping", null],
      ["/rpc/system/ping", STRANGE_ORIGIN],
      ["/rpc/system/ping", "null"],
      ["/webhooks/billing/asaas", null],
      ["/webhooks/billing/woovi", null],
      ["/webhooks/email/resend", null],
      ["/rpc/organization/listMine", origins.web],
      ["/rpc/organization/createInitial", origins.web],
    ]);
    expect(posts.every(({ url }) => url.startsWith(`${origins.web}/`))).toBe(
      true
    );
  });

  it("fails on a release different from the deployed commit, and passes when a later attempt has it", async () => {
    let healthCalls = 0;
    const fetchImpl = fakeStaging({
      [`${origins.web}/health`]: () => {
        healthCalls += 1;
        return fromWorker(200, {
          "x-polaris-release": healthCalls === 1 ? "0123456789ab" : RELEASE,
        });
      },
    });
    expect(await runSmoke(origins, options, fetchImpl, noPause)).toEqual([]);
    expect(healthCalls).toBe(3);

    const stale = fakeStaging({
      [`${origins.web}/health`]: () =>
        fromWorker(200, { "x-polaris-release": "0123456789ab" }),
    });
    expect(await runSmoke(origins, options, stale, noPause)).toEqual([
      `release wait (web): the release ${RELEASE} did not reach the edge in 120 s; active: 0123456789ab`,
      "web /health (release of the Worker): 200 release different",
    ]);
  });

  it("fails when a Worker declares no release", async () => {
    expect(
      await runSmoke(
        origins,
        options,
        fakeStaging({ [`${origins.catalog}/robots.txt`]: () => answer(200) }),
        noPause
      )
    ).toEqual([
      "catalog /robots.txt (release of the Worker): 200 release absent",
    ]);
  });

  it("fails when the CSP of the shell does not open the ingest host of Sentry (a build without the DSN)", async () => {
    expect(
      await runSmoke(
        origins,
        options,
        fakeStaging({
          [`${origins.web}/`]: () =>
            answer(
              200,
              { "content-security-policy": SHELL_CSP_WITHOUT_SENTRY },
              INDEX
            ),
        }),
        noPause
      )
    ).toEqual([
      "web / (SPA shell with CSP, equal to the artifact): 200 sentry ingest host missing in CSP",
    ]);
  });

  it.each([
    `${SHELL_CSP_WITHOUT_SENTRY}; img-src https://o4510000000000000.ingest.us.sentry.io`,
    `${SHELL_CSP_WITHOUT_SENTRY} https://o1.ingest.sentry.io.exemplo.com`,
    `${SHELL_CSP_WITHOUT_SENTRY} https://sentry.io`,
  ])(
    "does not take the ingest host of Sentry from another directive or a foreign host: %s",
    async (policy) => {
      expect(
        await runSmoke(
          origins,
          options,
          fakeStaging({
            [`${origins.web}/`]: () =>
              answer(200, { "content-security-policy": policy }, INDEX),
          }),
          noPause
        )
      ).toEqual([
        "web / (SPA shell with CSP, equal to the artifact): 200 sentry ingest host missing in CSP",
      ]);
    }
  );

  it.each(["o4510000000000000.ingest.us.sentry.io", "o123.ingest.sentry.io"])(
    "accepts the ingest host of Sentry %s",
    async (host) => {
      expect(
        await runSmoke(
          origins,
          options,
          fakeStaging({
            [`${origins.web}/`]: () =>
              answer(
                200,
                {
                  "content-security-policy": `${SHELL_CSP_WITHOUT_SENTRY} https://${host}`,
                },
                INDEX
              ),
          }),
          noPause
        )
      ).toEqual([]);
    }
  );

  it("refuses a shell different from the artifact before judging the Sentry host", async () => {
    expect(
      await runSmoke(
        origins,
        options,
        fakeStaging({
          [`${origins.web}/`]: () =>
            answer(
              200,
              { "content-security-policy": SHELL_CSP_WITHOUT_SENTRY },
              `${INDEX}<!-- edge -->`
            ),
        }),
        noPause
      )
    ).toEqual([
      "web / (SPA shell with CSP, equal to the artifact): 200 shell different",
    ]);
  });

  it("fails as no CSP when the shell answers without a policy", async () => {
    expect(
      await runSmoke(
        origins,
        options,
        fakeStaging({ [`${origins.web}/`]: () => answer(200, {}, INDEX) }),
        noPause
      )
    ).toEqual([
      "web / (SPA shell with CSP, equal to the artifact): 200 no CSP",
    ]);
  });

  it("fails when the shell served differs from the published artifact", async () => {
    expect(
      await runSmoke(
        origins,
        options,
        fakeStaging({
          [`${origins.web}/`]: () =>
            answer(
              200,
              { "content-security-policy": "default-src 'self'" },
              `${INDEX}<!-- edge -->`
            ),
          [`${origins.web}/sw.js`]: () => answer(200, {}, "old worker"),
        }),
        noPause
      )
    ).toEqual([
      "web / (SPA shell with CSP, equal to the artifact): 200 shell different",
      "web /sw.js (equal to the artifact): 200 service worker different",
    ]);
  });

  it("refuses a HEAD_SHA that is not the 40 lowercase hex characters of a commit, before any request", async () => {
    const fetchImpl = vi.fn();
    for (const commit of [
      undefined,
      "",
      RELEASE,
      COMMIT.toUpperCase(),
      `${COMMIT}0`,
      `${COMMIT.slice(0, 39)}g`,
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: each case on its own, for a clear failure
      const failures = await runSmoke(
        origins,
        { buildDir, commit },
        fetchImpl,
        noPause
      );
      expect(failures, String(commit)).toEqual([COMMIT_REFUSAL]);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails before any request when the published build is not there", async () => {
    const fetchImpl = vi.fn();
    expect(
      await runSmoke(
        origins,
        { buildDir: join(buildDir, "missing"), commit: COMMIT },
        fetchImpl,
        noPause
      )
    ).toEqual([
      "web build: index.html and sw.js of the published build were not found",
    ]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails when the ping without Origin, from a strange origin or with Origin null is answered", async () => {
    const pong = () => fromWorker(200, {}, json({ json: { message: "pong" } }));
    expect(
      await runSmoke(
        origins,
        options,
        fakeStaging({ [`${origins.web}/rpc/system/ping`]: pong }),
        noPause
      )
    ).toEqual([
      "web POST /rpc/system/ping without Origin (refused): 200 not 403",
      "web POST /rpc/system/ping from a strange origin (refused): 200 not 403",
      "web POST /rpc/system/ping with Origin null (refused): 200 not 403",
    ]);
  });

  it.each([
    ["another code", () => forbidden("tenant_access_denied")],
    ["no body", () => fromWorker(403)],
    ["an html body", () => fromWorker(403, {}, "<html>forbidden</html>")],
  ])(
    "fails when the refusal is a 403 with %s, and never logs the body",
    async (_name, refusal) => {
      const lines = [];
      const log = vi.spyOn(console, "log").mockImplementation((line) => {
        lines.push(String(line));
      });
      try {
        const failures = await runSmoke(
          origins,
          options,
          fakeStaging({
            [`${origins.web}/rpc/system/ping`]: (init) =>
              new Headers(init.headers).get("origin") === origins.web
                ? fromWorker(200, {}, json({ json: { message: "pong" } }))
                : refusal(),
          }),
          noPause
        );
        expect(failures).toEqual([
          "web POST /rpc/system/ping without Origin (refused): 403 403 not forbidden",
          "web POST /rpc/system/ping from a strange origin (refused): 403 403 not forbidden",
          "web POST /rpc/system/ping with Origin null (refused): 403 403 not forbidden",
        ]);
        expect(lines.join("\n")).not.toContain("tenant_access_denied");
        expect(lines.join("\n")).not.toContain("<html>");
      } finally {
        log.mockRestore();
      }
    }
  );

  it("fails when a strange origin is answered 200 while the others are refused", async () => {
    const fetchImpl = fakeStaging({
      [`${origins.web}/rpc/system/ping`]: (init) => {
        const origin = new Headers(init.headers).get("origin");
        return origin === origins.web || origin === STRANGE_ORIGIN
          ? fromWorker(200, {}, json({ json: { message: "pong" } }))
          : forbidden();
      },
    });
    expect(await runSmoke(origins, options, fetchImpl, noPause)).toEqual([
      "web POST /rpc/system/ping from a strange origin (refused): 200 not 403",
    ]);
  });

  it("fails when the ping answers something else than pong", async () => {
    const fetchImpl = fakeStaging({
      [`${origins.web}/rpc/system/ping`]: (init) =>
        new Headers(init.headers).get("origin") === origins.web
          ? fromWorker(200, {}, "<html>portal</html>")
          : forbidden(),
    });
    expect(await runSmoke(origins, options, fetchImpl, noPause)).toEqual([
      "web POST /rpc/system/ping (the oRPC handler answers): 200 not pong",
    ]);
  });

  it("fails when an anonymous listMine is answered", async () => {
    expect(
      await runSmoke(
        origins,
        options,
        fakeStaging({
          [`${origins.web}/rpc/organization/listMine`]: () =>
            fromWorker(200, {}, json({ json: {} })),
        }),
        noPause
      )
    ).toEqual([
      "web POST /rpc/organization/listMine anonymous (401): 200 not 401",
    ]);
  });

  it("fails when the sign-in methods of staging are not all on", async () => {
    const cases = [
      [{ ...AUTH_METHODS, google: false }, "sign-in methods different"],
      [{ ...AUTH_METHODS, emailPassword: false }, "sign-in methods different"],
      [
        { ...AUTH_METHODS, turnstileSiteKey: null },
        "Turnstile site key missing with the password on",
      ],
      [
        { ...AUTH_METHODS, turnstileSiteKey: " " },
        "Turnstile site key missing with the password on",
      ],
    ];
    for (const [methods, reason] of cases) {
      // biome-ignore lint/performance/noAwaitInLoops: each case on its own, for a clear failure
      const failures = await runSmoke(
        origins,
        options,
        fakeStaging({
          [`${origins.web}/api/auth-methods`]: () =>
            fromWorker(200, {}, json(methods)),
        }),
        noPause
      );
      expect(failures).toEqual([
        `web /api/auth-methods (Google, password and Turnstile configured): 200 ${reason}`,
      ]);
    }
  });

  it("fails when the get-session is not an empty session, or the auth secrets are missing (503)", async () => {
    const fetchImpl = vi.fn(
      fakeStaging({
        [`${origins.web}/api/auth/get-session`]: () => fromWorker(503),
      })
    );
    expect(await runSmoke(origins, options, fetchImpl, noPause)).toEqual([
      "web /api/auth/get-session (auth configured, no session): 503 not 200",
    ]);
    // nineteen checks pass at once, the failing one is tried three times, and the release wait reads two Workers
    expect(fetchImpl).toHaveBeenCalledTimes(24);
    expect(
      await runSmoke(
        origins,
        options,
        fakeStaging({
          [`${origins.web}/api/auth/get-session`]: () =>
            fromWorker(200, {}, json({ user: {} })),
        }),
        noPause
      )
    ).toEqual([
      "web /api/auth/get-session (auth configured, no session): 200 not an empty session",
    ]);
  });

  it("fails an answer of the web Worker without X-Request-Id, the mark that tells it from a captive portal", async () => {
    expect(
      await runSmoke(
        origins,
        options,
        fakeStaging({
          [`${origins.web}/api/auth-methods`]: () =>
            answer(200, {}, json(AUTH_METHODS)),
        }),
        noPause
      )
    ).toEqual([
      "web /api/auth-methods (Google, password and Turnstile configured): 200 no X-Request-Id",
    ]);
  });

  it("does not repeat an anonymous /rpc call that failed on the platform (503 or no X-Request-Id), and says cpu/plataforma", async () => {
    let listMineCalls = 0;
    let createInitialCalls = 0;
    const pause = vi.fn(noPause);
    const fetchImpl = fakeStaging({
      [`${origins.web}/rpc/organization/createInitial`]: () => {
        createInitialCalls += 1;
        return answer(
          500,
          { "content-type": "text/html" },
          "<html>Error 1102</html>"
        );
      },
      [`${origins.web}/rpc/organization/listMine`]: () => {
        listMineCalls += 1;
        return fromWorker(503);
      },
    });
    expect(await runSmoke(origins, options, fetchImpl, pause)).toEqual([
      "web POST /rpc/organization/listMine anonymous (401): cpu/plataforma 503",
      "web POST /rpc/organization/createInitial anonymous (401): cpu/plataforma 500",
    ]);
    expect(listMineCalls).toBe(1);
    expect(createInitialCalls).toBe(1);
    expect(pause).not.toHaveBeenCalled();
  });

  it("sends a createInitial body that the contract accepts, so the refusal is the 401 of the session and not a 400", () => {
    const check = smokeChecks(origins, {
      release: RELEASE,
      shell: { index: "", serviceWorker: "" },
    }).find(({ url }) => url.endsWith("/createInitial"));
    const body = JSON.parse(check.body);
    expect(body).toEqual({ json: CREATE_INITIAL_INPUT });
    const schema =
      polarisContract.organization.createInitial["~orpc"].inputSchema;
    expect(schema.safeParse(body.json).success).toBe(true);
    expect(stagingAnswer(check.url, { body: check.body }).status).toBe(401);
    // control: the body the old smoke would have sent is refused by the contract
    expect(stagingAnswer(check.url, { body: json({}) }).status).toBe(400);
  });

  it("keeps the procedures it calls as the contract declares them: two reads and one write", () => {
    const kindOf = (procedure) => procedure["~orpc"].meta.kind;
    expect(kindOf(polarisContract.system.ping)).toBe("read");
    expect(kindOf(polarisContract.organization.listMine)).toBe("read");
    expect(kindOf(polarisContract.organization.createInitial)).toBe("write");
  });

  describe("the billing webhooks", () => {
    const webhook = (provider) => `${origins.web}/webhooks/billing/${provider}`;
    const nameOf = (provider) =>
      `web POST /webhooks/billing/${provider} without a signature (refused with 401)`;

    it("knocks on the webhook of each provider with a POST, without a token or a signature", async () => {
      const requests = [];
      const fetchImpl = (url, init) => {
        requests.push({ headers: new Headers(init.headers), init, url });
        return fakeStaging()(url, init);
      };
      expect(await runSmoke(origins, options, fetchImpl, noPause)).toEqual([]);
      expect(BILLING_WEBHOOK_PROVIDERS).toEqual(["asaas", "woovi"]);
      for (const provider of BILLING_WEBHOOK_PROVIDERS) {
        const sent = requests.filter(
          (request) => request.url === webhook(provider)
        );
        expect(sent).toHaveLength(1);
        expect(sent[0].init.method).toBe("POST");
        expect(sent[0].headers.has("asaas-access-token")).toBe(false);
        expect(sent[0].headers.has("x-webhook-signature")).toBe(false);
        expect(sent[0].headers.has("origin")).toBe(false);
      }
    });

    const resendWebhook = `${origins.web}/webhooks/email/resend`;
    const resendName =
      "web POST /webhooks/email/resend without a signature (refused with 401)";

    it("knocks on the Resend webhook with a POST, without any Svix header or Origin", async () => {
      const requests = [];
      const fetchImpl = (url, init) => {
        requests.push({ headers: new Headers(init.headers), init, url });
        return fakeStaging()(url, init);
      };
      expect(await runSmoke(origins, options, fetchImpl, noPause)).toEqual([]);
      const sent = requests.filter((request) => request.url === resendWebhook);
      expect(sent).toHaveLength(1);
      expect(sent[0].init.method).toBe("POST");
      expect(sent[0].headers.has("svix-id")).toBe(false);
      expect(sent[0].headers.has("svix-signature")).toBe(false);
      expect(sent[0].headers.has("origin")).toBe(false);
    });

    it("fails when the Resend webhook's secret is missing (503), accepts without a signature (200) or is not routed (404)", async () => {
      expect(
        await runSmoke(
          origins,
          options,
          fakeStaging({
            [resendWebhook]: () =>
              webhookRefusal(503, "resend_webhook_not_configured"),
          }),
          noPause
        )
      ).toEqual([
        `${resendName}: 503 provider not configured (a secret is missing)`,
      ]);
      expect(
        await runSmoke(
          origins,
          options,
          fakeStaging({
            [resendWebhook]: () => fromWorker(200, {}, json({ received: 1 })),
          }),
          noPause
        )
      ).toEqual([`${resendName}: 200 accepted without a signature`]);
      expect(
        await runSmoke(
          origins,
          options,
          fakeStaging({
            [resendWebhook]: () => webhookRefusal(404, "not_found"),
          }),
          noPause
        )
      ).toEqual([`${resendName}: 404 not 401`]);
    });

    it("fails when a provider's secret is missing (503), saying so", async () => {
      const fetchImpl = fakeStaging({
        [webhook("woovi")]: () =>
          webhookRefusal(503, "billing_provider_not_configured"),
      });
      expect(await runSmoke(origins, options, fetchImpl, noPause)).toEqual([
        `${nameOf("woovi")}: 503 provider not configured (a secret is missing)`,
      ]);
    });

    it("fails when a delivery without a signature is accepted, or refused by something else", async () => {
      const fetchImpl = fakeStaging({
        [webhook("asaas")]: () =>
          fromWorker(200, {}, json({ duplicates: 0, received: 0 })),
        [webhook("woovi")]: () => webhookRefusal(401, "other"),
      });
      expect(await runSmoke(origins, options, fetchImpl, noPause)).toEqual([
        `${nameOf("asaas")}: 200 accepted without a signature`,
        `${nameOf("woovi")}: 401 401 not unauthorized`,
      ]);
    });

    it("fails when the route does not reach the Worker (the shell answered, no X-Request-Id) or answers 404", async () => {
      const fetchImpl = fakeStaging({
        [webhook("asaas")]: () => answer(200, {}, INDEX),
        [webhook("woovi")]: () => webhookRefusal(404, "not_found"),
      });
      expect(await runSmoke(origins, options, fetchImpl, noPause)).toEqual([
        `${nameOf("asaas")}: 200 no X-Request-Id`,
        `${nameOf("woovi")}: 404 not 401`,
      ]);
    });
  });

  it("never logs a body or a header value: only the check, the status and a fixed reason", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchImpl = fakeStaging({
      [`${origins.web}/health`]: () =>
        fromWorker(
          200,
          { "x-polaris-release": "deadbeef-secret" },
          "secret-body"
        ),
      [`${origins.web}/api/auth-methods`]: () =>
        fromWorker(
          200,
          {},
          json({ ...AUTH_METHODS, google: false, secret: "secret-body" })
        ),
    });
    await runSmoke(origins, options, fetchImpl, noPause);
    const printed = log.mock.calls.flat().join("\n");
    for (const leaked of [
      "secret-body",
      "deadbeef-secret",
      RELEASE,
      COMMIT,
      REQUEST_ID,
      "nonce-abc",
      "0x4AAAA",
    ]) {
      expect(printed).not.toContain(leaked);
    }
    expect(printed).toContain(
      "FAIL web /health (release of the Worker): 200 release different"
    );
  });

  it("never sends a request, above all a POST, to a host outside the fixed staging hosts", async () => {
    const fetchImpl = vi.fn();
    for (const url of [
      "https://evil.example/rpc/system/ping",
      "https://dash.araute.app.evil.example/rpc",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: each case on its own, for a clear failure
      await expect(send({ method: "POST", url }, fetchImpl)).rejects.toThrow(
        "host_refused"
      );
      expect(
        await attempt(
          { expect: () => true, method: "POST", url },
          fetchImpl,
          noPause
        )
      ).toEqual({
        outcome: "Error",
        passed: false,
      });
    }
    await expect(
      send({ url: "https://evil.example/health" }, fetchImpl)
    ).rejects.toThrow("host_refused");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports a network failure by its name and code only", async () => {
    const fetchImpl = (url, init) =>
      url === `${origins.web}/health`
        ? Promise.reject(
            new TypeError("fetch failed: secret detail", {
              cause: { code: "ENOTFOUND" },
            })
          )
        : fakeStaging()(url, init);
    expect(await runSmoke(origins, options, fetchImpl, noPause)).toEqual([
      "web /health (release of the Worker): TypeError ENOTFOUND",
    ]);
  });

  it("passes a check that recovers on a later attempt, and gives each request a timeout", async () => {
    let healthCalls = 0;
    const signals = [];
    const pause = vi.fn(noPause);
    const fetchImpl = (url, init) => {
      signals.push(init.signal);
      if (url === `${origins.web}/health`) {
        healthCalls += 1;
        return Promise.resolve(
          healthCalls <= 2
            ? fromWorker(503)
            : fromWorker(200, { "x-polaris-release": RELEASE })
        );
      }
      return fakeStaging()(url, init);
    };
    expect(await runSmoke(origins, options, fetchImpl, pause)).toEqual([]);
    expect(healthCalls).toBe(3);
    expect(pause).toHaveBeenCalledOnce();
    expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
  });

  it("fails when the catalog cannot reach the database (500 instead of 404)", async () => {
    expect(
      await runSmoke(
        origins,
        options,
        fakeStaging({
          [`${origins.catalog}/smoke-staging-loja-inexistente`]: () =>
            answer(500),
        }),
        noPause
      )
    ).toEqual([
      "catalog store page through Hyperdrive (unknown store answers 404): 500 not 404",
    ]);
  });

  it("fails when the catalog page has no nonce in its CSP", async () => {
    expect(
      await runSmoke(
        origins,
        options,
        fakeStaging({
          [`${origins.catalog}/`]: () =>
            answer(200, { "content-security-policy": "script-src 'self'" }),
        }),
        noPause
      )
    ).toEqual(["catalog / (CSP with nonce): 200 no nonce"]);
  });

  it("refuses the workers.dev web, before any request, saying that only the fixed host is accepted", async () => {
    const refusing = vi.fn();
    expect(
      await runSmoke(
        { ...origins, web: "https://polaris-web-staging.example.workers.dev" },
        options,
        refusing,
        noPause
      )
    ).toEqual([
      "web: the staging web only accepts https://dash.araute.app, without a path",
    ]);
    expect(refusing).not.toHaveBeenCalled();
  });

  it("has a refusal message of its own for every key that accepts a host", () => {
    for (const [key, host] of Object.entries(STAGING_FIXED_HOST)) {
      expect(Object.hasOwn(REFUSAL, key)).toBe(true);
      expect(REFUSAL[key]).toContain(`https://${host}`);
    }
    expect(Object.keys(REFUSAL).sort()).toEqual(
      Object.keys(STAGING_FIXED_HOST).sort()
    );
  });

  it("fails loudly for a key with no fixed host or message, naming the key", async () => {
    expect(refusalOf("pdv")).toContain("pdv:");
    for (const key of ["constructor", "toString", "__proto__"]) {
      expect(refusalOf(key)).toContain("no staging host is accepted");
    }
    const fetchImpl = vi.fn();
    const failures = await runSmoke(
      { ...origins, pdv: "https://pdv.araute.app" },
      options,
      fetchImpl,
      noPause
    );
    expect(failures).toHaveLength(1);
    const inherited = await runSmoke(
      { ...origins, constructor: "https://dash.araute.app" },
      options,
      fetchImpl,
      noPause
    );
    expect(inherited[0]).toContain("constructor: no staging host");
    expect(failures[0].startsWith("pdv: no staging host is accepted")).toBe(
      true
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails when the Admin is reached without sign-in, or Access sends it elsewhere", async () => {
    const health = `${origins.admin}/health`;
    const whoami = `${origins.admin}/api/whoami`;
    const failing = (override) =>
      runSmoke(origins, options, fakeStaging(override), noPause);
    expect(
      await failing({
        [health]: () => fromWorker(200, { "x-polaris-release": RELEASE }),
        [whoami]: () => fromWorker(403),
      })
    ).toEqual([
      "admin /health without sign-in (redirected to Access): 200 not a redirect to Access",
      "admin /api/whoami without sign-in (redirected to Access): 403 not a redirect to Access",
    ]);
    // a redirect of the Worker itself (it carries its marks) is not Access in front of it
    expect(
      await failing({
        [health]: () =>
          fromWorker(302, {
            location: `https://${STAGING_ACCESS_TEAM}/cdn-cgi/access/login`,
          }),
        [whoami]: () =>
          answer(302, {
            location: `https://${STAGING_ACCESS_TEAM}/cdn-cgi/access/login`,
            "x-polaris-release": RELEASE,
          }),
      })
    ).toEqual([
      "admin /health without sign-in (redirected to Access): 302 answered by the Worker",
      "admin /api/whoami without sign-in (redirected to Access): 302 answered by the Worker",
    ]);
    for (const location of [
      "https://polaris.cloudflareaccess.com/cdn-cgi/access/login",
      `http://${STAGING_ACCESS_TEAM}/cdn-cgi/access/login`,
      `https://${STAGING_ACCESS_TEAM}.evil.example/`,
      "https://admin.araute.app/entrar",
      "/cdn-cgi/access/login",
      "",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: each case on its own, for a clear failure
      const failures = await failing({
        [health]: () => answer(302, location ? { location } : {}),
      });
      expect(failures).toEqual([
        "admin /health without sign-in (redirected to Access): 302 redirect outside the Access team",
      ]);
    }
    // the right team, but not the login of the application of this hostname
    for (const path of [
      "/cdn-cgi/access/login",
      "/cdn-cgi/access/login/other.araute.app",
      "/cdn-cgi/access/login/admin.araute.app/x",
      "/",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: each case on its own, for a clear failure
      const failures = await failing({
        [health]: () =>
          answer(302, {
            location: `https://${STAGING_ACCESS_TEAM}${path}?kid=x`,
          }),
      });
      expect(failures).toEqual([
        "admin /health without sign-in (redirected to Access): 302 redirect to another Access page",
      ]);
    }
  });

  it("never follows the redirect of Access", async () => {
    const redirects = [];
    const fetchImpl = (url, init) => {
      if (url.startsWith(origins.admin)) {
        redirects.push(init.redirect);
      }
      return fakeStaging()(url, init);
    };
    expect(await runSmoke(origins, options, fetchImpl, noPause)).toEqual([]);
    expect(redirects).toEqual(["manual", "manual"]);
  });

  it("refuses an Admin origin other than https://admin.araute.app, before any request", async () => {
    const fetchImpl = vi.fn();
    for (const admin of [
      undefined,
      "https://polaris-admin-staging.example.workers.dev",
      "http://admin.araute.app",
      "https://admin.araute.app/api",
      "https://dash.araute.app",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: each case on its own, for a clear failure
      expect(await runSmoke({ ...origins, admin }, options, fetchImpl)).toEqual(
        [
          "admin: the staging Admin only accepts https://admin.araute.app, without a path",
        ]
      );
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses the workers.dev catalog, before any request", async () => {
    const refusing = vi.fn();
    expect(
      await runSmoke(
        {
          ...origins,
          catalog: "https://polaris-catalog-staging.example.workers.dev",
        },
        options,
        refusing,
        noPause
      )
    ).toEqual([
      "catalog: the staging catalog only accepts https://catalogo.araute.app, without a path",
    ]);
    expect(refusing).not.toHaveBeenCalled();
  });

  it("refuses an origin that is not an https staging origin without a path, before any request", async () => {
    const fetchImpl = vi.fn();
    const refused = (key) => [
      key === "catalog"
        ? "catalog: the staging catalog only accepts https://catalogo.araute.app, without a path"
        : "web: the staging web only accepts https://dash.araute.app, without a path",
    ];
    for (const web of [
      "http://polaris-web-staging.example.workers.dev",
      "https://polaris-web-staging.example.workers.dev/path",
      "https://user:pw@polaris-web-staging.example.workers.dev",
      "https://app.example.com",
      "https://other.araute.app",
      "http://dash.araute.app",
      "https://dash.araute.app/path",
      "https://user:pw@dash.araute.app",
      "https://dash.araute.app.evil.example",
      "https://DASH.araute.app",
      "https://dash.araute.app:8443",
      "https://polaris-web-staging.example.workers.dev:8443",
      "https://dash.araute.app./",
      "https://polaris-web-staging.evil.example",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: each case on its own, for a clear failure
      expect(await runSmoke({ ...origins, web }, options, fetchImpl)).toEqual(
        refused("web")
      );
    }
    expect(
      await runSmoke({ ...origins, catalog: undefined }, options, fetchImpl)
    ).toEqual(refused("catalog"));
    // each fixed host belongs to its own Worker only
    expect(
      await runSmoke(
        { ...origins, catalog: "https://dash.araute.app" },
        options,
        fetchImpl
      )
    ).toEqual(refused("catalog"));
    expect(
      await runSmoke(
        { ...origins, web: "https://catalogo.araute.app" },
        options,
        fetchImpl
      )
    ).toEqual(refused("web"));
    for (const catalog of [
      "http://catalogo.araute.app",
      "https://catalogo.araute.app/path",
      "https://user:pw@catalogo.araute.app",
      "https://catalogo.araute.app.evil.example",
      "https://CATALOGO.araute.app",
      "https://catalogo.araute.app:8443",
      "https://other.araute.app",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: each case on its own, for a clear failure
      const failures = await runSmoke(
        { ...origins, catalog },
        options,
        fetchImpl
      );
      expect(failures).toEqual(refused("catalog"));
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

const OLD_RELEASE = "0123456789ab";
const OLD_INDEX = "<!doctype html><title>Old</title>";
const WAIT_CEILING_SECONDS = 120;

const waitFailure = (worker, active = OLD_RELEASE) =>
  `release wait (${worker}): the release ${RELEASE} did not reach the edge in ${WAIT_CEILING_SECONDS} s; active: ${active}`;

/** The edge shows the new release and the new shell once the fake clock reaches `arrivesAt`. */
function propagating(clock, arrivesAt, { shell = true } = {}) {
  const arrived = () => clock.now() >= arrivesAt;
  const release = () => (arrived() ? RELEASE : OLD_RELEASE);
  const page = () => (arrived() && shell ? INDEX : OLD_INDEX);
  const calls = { catalog: 0, health: 0 };
  const fetchImpl = fakeStaging({
    [`${origins.catalog}/robots.txt`]: () => {
      calls.catalog += 1;
      return answer(200, { "x-polaris-release": release() }, "User-agent: *\n");
    },
    [`${origins.web}/`]: () =>
      answer(200, { "content-security-policy": SHELL_CSP_WITH_SENTRY }, page()),
    [`${origins.web}/entrar`]: () => answer(200, {}, page()),
    [`${origins.web}/health`]: () => {
      calls.health += 1;
      return fromWorker(200, { "x-polaris-release": release() }, "{}");
    },
  });
  return { calls, fetchImpl };
}

const webReleaseCheck = () =>
  smokeChecks(origins, {
    release: RELEASE,
    shell: { index: "", serviceWorker: "" },
  }).find(({ awaitsRelease }) => awaitsRelease === "web");

describe("the wait for the release to reach the edge", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("(a) passes when the release arrives on the second read, waiting only what it took", async () => {
    const clock = fakeClock();
    const { calls, fetchImpl } = propagating(clock, 2000);
    const pause = vi.fn(noPause);
    expect(
      await runSmoke(origins, { ...options, clock }, fetchImpl, pause)
    ).toEqual([]);
    expect(calls.health).toBe(3);
    expect(calls.catalog).toBe(3);
    expect(clock.sleeps).toEqual([2000, 2000]);
    expect(pause).not.toHaveBeenCalled();
  });

  it("waits for the web and the catalog side by side: both are read before the first pause", async () => {
    const clock = fakeClock();
    const events = [];
    const { sleep } = clock;
    clock.sleep = (ms) => {
      events.push("sleep");
      return sleep(ms);
    };
    const { fetchImpl } = propagating(clock, 2000);
    const traced = (url, init) => {
      const target = String(url);
      if (target.endsWith("/health")) {
        events.push("web");
      } else if (target.endsWith("/robots.txt")) {
        events.push("catalog");
      }
      return fetchImpl(url, init);
    };
    await runSmoke(origins, { ...options, clock }, traced, noPause);
    expect(events.slice(0, 3)).toEqual(["web", "catalog", "sleep"]);
  });

  it("(a) control: the three tries of the check alone do not outlast a release that takes 30 s", async () => {
    const clock = fakeClock();
    const { fetchImpl } = propagating(clock, 30_000);
    const pause = () => {
      clock.advance(5000);
      return Promise.resolve();
    };
    expect(await attempt(webReleaseCheck(), fetchImpl, pause)).toEqual({
      outcome: "200 release different",
      passed: false,
    });
  });

  it("(b) fails with the release, the seconds waited and the active one when it never arrives", async () => {
    const clock = fakeClock();
    const stale = fakeStaging({
      [`${origins.catalog}/robots.txt`]: () =>
        answer(200, { "x-polaris-release": OLD_RELEASE }),
      [`${origins.web}/health`]: () =>
        fromWorker(200, { "x-polaris-release": OLD_RELEASE }),
    });
    const failures = await runSmoke(
      origins,
      { ...options, clock },
      stale,
      noPause
    );
    expect(failures).toEqual([
      waitFailure("web"),
      waitFailure("catalog"),
      "web /health (release of the Worker): 200 release different",
      "catalog /robots.txt (release of the Worker): 200 release different",
    ]);
  });

  it("(b) pauses grow, never pass 15 s, and the whole wait stops at the ceiling", async () => {
    const clock = fakeClock();
    const reason = await awaitRelease(
      webReleaseCheck(),
      RELEASE,
      fakeStaging({
        [`${origins.web}/health`]: () =>
          fromWorker(200, { "x-polaris-release": OLD_RELEASE }),
      }),
      clock
    );
    expect(reason).toBe(waitFailure("web"));
    expect(clock.sleeps).toEqual([
      2000, 4000, 8000, 15_000, 15_000, 15_000, 15_000, 15_000, 15_000, 15_000,
      1000,
    ]);
    expect(clock.sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(
      RELEASE_WAIT_CEILING_MS
    );
  });

  it("(c) keeps failing the shell checks when the release arrives but the shell differs", async () => {
    const clock = fakeClock();
    const { fetchImpl } = propagating(clock, 2000, { shell: false });
    expect(
      await runSmoke(origins, { ...options, clock }, fetchImpl, noPause)
    ).toEqual([
      "web / (SPA shell with CSP, equal to the artifact): 200 shell different",
      "web /entrar (the shell, equal to the artifact): 200 shell different",
    ]);
  });

  it("keeps the normal path as fast as before: the release is already there, so nothing sleeps", async () => {
    const clock = fakeClock();
    const fetchImpl = vi.fn(fakeStaging());
    const pause = vi.fn(noPause);
    expect(
      await runSmoke(origins, { ...options, clock }, fetchImpl, pause)
    ).toEqual([]);
    expect(clock.sleeps).toEqual([]);
    expect(clock.now()).toBe(0);
    expect(pause).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(22);
  });

  it("keeps waiting when a read fails after another release was seen, and stops at the new one", async () => {
    const clock = fakeClock();
    const replies = [
      () => fromWorker(200, { "x-polaris-release": OLD_RELEASE }),
      () => fromWorker(503),
      () => Promise.reject(new TypeError("fetch failed")),
      () => fromWorker(200, { "x-polaris-release": RELEASE }),
    ];
    let reads = 0;
    const reason = await awaitRelease(
      webReleaseCheck(),
      RELEASE,
      fakeStaging({
        [`${origins.web}/health`]: () => {
          const reply = replies[Math.min(reads, replies.length - 1)];
          reads += 1;
          return reply();
        },
      }),
      clock
    );
    expect(reason).toBeNull();
    expect(reads).toBe(4);
    expect(clock.sleeps).toEqual([2000, 4000, 8000]);
  });

  it("names the last release seen when the reads fail until the ceiling", async () => {
    const clock = fakeClock();
    let reads = 0;
    const reason = await awaitRelease(
      webReleaseCheck(),
      RELEASE,
      fakeStaging({
        [`${origins.web}/health`]: () => {
          reads += 1;
          return reads === 1
            ? fromWorker(200, { "x-polaris-release": OLD_RELEASE })
            : fromWorker(503);
        },
      }),
      clock
    );
    expect(reason).toBe(waitFailure("web"));
  });

  it("does not wait for what is not an older release: no header, an error or no answer go to the check", async () => {
    const answers = [
      () => answer(200),
      () => fromWorker(503),
      () => answer(200, { "x-polaris-release": "not-a-release" }),
      () => Promise.reject(new TypeError("fetch failed")),
    ];
    for (const reply of answers) {
      const clock = fakeClock();
      // biome-ignore lint/performance/noAwaitInLoops: each case on its own, for a clear failure
      await runSmoke(
        origins,
        { ...options, clock },
        fakeStaging({ [`${origins.web}/health`]: reply }),
        noPause
      );
      expect(clock.sleeps).toEqual([]);
    }
  });

  it("does not read the release before the checks while production declares none", async () => {
    const { target } = productionTarget({
      ...productionEnv,
      PRODUCTION_EXPECT_RELEASE_HEADER: "false",
    });
    const fetchImpl = vi.fn((url, init) => {
      const response = productionAnswer(url, init);
      response.headers.delete("x-polaris-release");
      return Promise.resolve(response);
    });
    expect(
      await runSmoke(
        productionOrigins,
        { ...options, target },
        fetchImpl,
        noPause
      )
    ).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(20);
  });
});

describe("the requests of the smoke over the real fetch of Node", () => {
  let server;
  let local = "";
  const received = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        received.push({
          body,
          headers: request.headers,
          method: request.method,
          url: request.url,
        });
        response.writeHead(204).end();
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    local = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("delivers the Origin, the user agent, the content type and the body to the server", async () => {
    const checks = smokeChecks(origins, {
      release: RELEASE,
      shell: { index: "", serviceWorker: "" },
    });
    const posts = checks.filter((check) => check.method === "POST");
    // the real fetch, only redirected to the local server: what it sends is what the smoke asked for
    const toLocal = (url, init) =>
      fetch(`${local}${new URL(url).pathname}`, init);
    await Promise.all(posts.map((check) => send(check, toLocal)));
    const byOrigin = (origin) =>
      received.filter(({ headers }) => headers.origin === origin);
    expect(
      byOrigin(origins.web)
        .map(({ url }) => url)
        .sort()
    ).toEqual([
      "/rpc/organization/createInitial",
      "/rpc/organization/listMine",
      "/rpc/system/ping",
    ]);
    expect(byOrigin(STRANGE_ORIGIN)).toHaveLength(1);
    expect(byOrigin("null")).toHaveLength(1);
    // the ping without Origin and the two webhooks, which a provider sends without one
    expect(
      byOrigin(undefined)
        .map(({ url }) => url)
        .sort()
    ).toEqual([
      "/rpc/system/ping",
      "/webhooks/billing/asaas",
      "/webhooks/billing/woovi",
      "/webhooks/email/resend",
    ]);
    for (const request of received) {
      expect(request.method).toBe("POST");
      expect(request.headers["user-agent"]).toBe(USER_AGENT);
      expect(request.headers["content-type"]).toBe("application/json");
    }
    const created = received.find(
      ({ url }) => url === "/rpc/organization/createInitial"
    );
    expect(JSON.parse(created.body)).toEqual({ json: CREATE_INITIAL_INPUT });
  });
});

const productionEnv = {
  PRODUCTION_ACCESS_TEAM: "polaris-prod.cloudflareaccess.com",
  PRODUCTION_ADMIN_URL: "https://admin.exemplo.com.br",
  PRODUCTION_CATALOG_URL: "https://catalogo.exemplo.com.br",
  PRODUCTION_EXPECT_PASSWORD_SIGN_IN: "false",
  PRODUCTION_EXPECT_RELEASE_HEADER: "true",
  PRODUCTION_WEB_URL: "https://app.exemplo.com.br",
};
const productionOrigins = {
  admin: productionEnv.PRODUCTION_ADMIN_URL,
  catalog: productionEnv.PRODUCTION_CATALOG_URL,
  web: productionEnv.PRODUCTION_WEB_URL,
};
const { PRODUCTION_ACCESS_TEAM } = productionEnv;

const toStagingUrl = (url) =>
  url
    .replace(productionOrigins.web, origins.web)
    .replace(productionOrigins.catalog, origins.catalog)
    .replace(productionOrigins.admin, origins.admin);

/** A production that answers like the staging fake, with its own hosts, its own Access team and no password sign-in. */
function productionAnswer(url, init = {}) {
  const headers = new Headers(init.headers);
  if (headers.get("origin") === productionOrigins.web) {
    headers.set("origin", origins.web);
  }
  const stagingUrl = toStagingUrl(url);
  if (stagingUrl === `${origins.web}/api/auth-methods`) {
    return fromWorker(
      200,
      {},
      json({ ...AUTH_METHODS, emailPassword: false, turnstileSiteKey: null })
    );
  }
  const response = stagingAnswer(stagingUrl, { ...init, headers });
  if (response.status === 302) {
    const path = new URL(url).pathname;
    return answer(302, {
      location: `https://${PRODUCTION_ACCESS_TEAM}/cdn-cgi/access/login/admin.exemplo.com.br?kid=x&redirect_url=${encodeURIComponent(path)}`,
    });
  }
  return response;
}

const production = () => {
  const { target } = productionTarget(productionEnv);
  return target;
};

const productionOptions = () => ({ ...options, target: production() });

describe("the production smoke", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses to run with no variable, naming each one, and asks for no host", () => {
    const { refusals, target } = productionTarget({});
    expect(target).toBeNull();
    expect(refusals).toHaveLength(6);
    for (const variable of Object.values(PRODUCTION_VARIABLES)) {
      expect(
        refusals.filter((line) => line.startsWith(`${variable}:`))
      ).toHaveLength(1);
    }
    expect(refusals.join("\n")).toContain(
      "production domain is not configured"
    );
    expect(planOf("production", {}).refusals).toEqual(refusals);
  });

  it("refuses when one variable is missing, empty or blank", () => {
    for (const variable of Object.values(PRODUCTION_VARIABLES)) {
      for (const value of [undefined, "", "   "]) {
        const { refusals, target } = productionTarget({
          ...productionEnv,
          [variable]: value,
        });
        expect(target, `${variable}=${String(value)}`).toBeNull();
        expect(refusals).toHaveLength(1);
        expect(refusals[0].startsWith(`${variable}:`)).toBe(true);
      }
    }
  });

  it("refuses an origin that is not a custom https host without path, port or credentials", () => {
    for (const web of [
      "http://app.exemplo.com.br",
      "https://app.exemplo.com.br/path",
      "https://app.exemplo.com.br/",
      "https://app.exemplo.com.br:8443",
      "https://user:pw@app.exemplo.com.br",
      "https://APP.exemplo.com.br",
      "https://app.exemplo.com.br?x=1",
      "app.exemplo.com.br",
      "https://localhost",
      "https://127.0.0.1",
      "https://[::1]",
      "https://app.invalid",
      "https://polaris-web.exemplo.workers.dev",
      "https://dash.araute.app",
      "https://admin.araute.app",
      "https://catalogo.araute.app",
    ]) {
      const { refusals, target } = productionTarget({
        ...productionEnv,
        PRODUCTION_WEB_URL: web,
      });
      expect(target, web).toBeNull();
      expect(refusals, web).toHaveLength(1);
      expect(refusals[0].startsWith("PRODUCTION_WEB_URL:")).toBe(true);
    }
  });

  it("says why an origin is refused, without echoing it", () => {
    const reasonOf = (value) =>
      productionTarget({ ...productionEnv, PRODUCTION_WEB_URL: value })
        .refusals[0];
    const cases = [
      ["https://app.exemplo.com.br:8443", "must not have a port"],
      ["http://app.exemplo.com.br", "must be https"],
      ["https://APP.exemplo.com.br", "must be the origin only"],
      ["https://app.exemplo.com.br/path", "must be the origin only"],
      ["https://u:p@app.exemplo.com.br", "must be the origin only"],
      ["https://app.exemplo.com.br\n", "has whitespace around the value"],
      [" https://app.exemplo.com.br", "has whitespace around the value"],
      ["https://dash.araute.app", "is a staging host"],
      ["https://app.exemplo.test", "not a custom domain host"],
      ["https://app.exemplo.example", "not a custom domain host"],
      ["https://app.local", "not a custom domain host"],
      ["https://app.casa.internal", "not a custom domain host"],
      ["https://app.home.arpa", "not a custom domain host"],
      ["https://polaris.cloudflareaccess.com", "not a custom domain host"],
      ["https://app.exemplo.com.br.", "not a custom domain host"],
      ["not a url", "not a URL"],
    ];
    for (const [value, why] of cases) {
      const refusal = reasonOf(value);
      expect(refusal, value).toContain(`PRODUCTION_WEB_URL: ${why}`);
      expect(refusal, value).not.toContain("exemplo.com.br");
    }
  });

  it("refuses two Workers at the same host", () => {
    const { refusals, target } = productionTarget({
      ...productionEnv,
      PRODUCTION_CATALOG_URL: productionEnv.PRODUCTION_WEB_URL,
    });
    expect(target).toBeNull();
    expect(refusals).toEqual([
      "production hosts: web, catalog and admin must be distinct",
    ]);
  });

  it("refuses the staging Access team, a malformed team and a password flag that is not true or false", () => {
    for (const team of [
      "polaris-staging.cloudflareaccess.com",
      "polaris-prod.cloudflareaccess.com.evil.example",
      "https://polaris-prod.cloudflareaccess.com",
      "POLARIS.cloudflareaccess.com",
      "polaris-prod",
    ]) {
      const { target } = productionTarget({
        ...productionEnv,
        PRODUCTION_ACCESS_TEAM: team,
      });
      expect(target, team).toBeNull();
    }
    for (const variable of [
      "PRODUCTION_EXPECT_PASSWORD_SIGN_IN",
      "PRODUCTION_EXPECT_RELEASE_HEADER",
    ]) {
      for (const value of ["1", "TRUE", "yes", "on"]) {
        const { refusals } = productionTarget({
          ...productionEnv,
          [variable]: value,
        });
        expect(refusals, `${variable}=${value}`).toHaveLength(1);
      }
    }
  });

  it("passes with twenty checks, only at the production hosts and with its own user agent", async () => {
    const fetchImpl = vi.fn((url, init) =>
      Promise.resolve(productionAnswer(url, init))
    );
    expect(
      await runSmoke(productionOrigins, productionOptions(), fetchImpl, noPause)
    ).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(22);
    const productionHosts = Object.values(productionOrigins).map(
      (origin) => new URL(origin).host
    );
    for (const [url, init] of fetchImpl.mock.calls) {
      expect(productionHosts).toContain(new URL(url).host);
      expect(init.headers["user-agent"]).toBe(PRODUCTION_USER_AGENT);
    }
  });

  it.each([
    ["without", SHELL_CSP_WITHOUT_SENTRY],
    ["with", SHELL_CSP_WITH_SENTRY],
  ])(
    "does not ask for the ingest host of Sentry in production, nor refuse it (shell %s the host)",
    async (_, policy) => {
      const fetchImpl = (url, init) =>
        Promise.resolve(
          toStagingUrl(url) === `${origins.web}/`
            ? answer(200, { "content-security-policy": policy }, INDEX)
            : productionAnswer(url, init)
        );
      expect(
        await runSmoke(
          productionOrigins,
          productionOptions(),
          fetchImpl,
          noPause
        )
      ).toEqual([]);
    }
  );

  it("runs the same twenty checks as staging, in the same order, with the host swapped", () => {
    const shell = { index: "", serviceWorker: "" };
    const stagingChecks = smokeChecks(origins, { release: RELEASE, shell });
    const productionChecks = smokeChecks(
      productionOrigins,
      { release: RELEASE, shell },
      production()
    );
    expect(productionChecks.map(({ name, method }) => [name, method])).toEqual(
      stagingChecks.map(({ name, method }) => [name, method])
    );
    expect(productionChecks.map(({ url }) => url)).toEqual(
      stagingChecks.map(({ url }) =>
        url
          .replace(origins.web, productionOrigins.web)
          .replace(origins.catalog, productionOrigins.catalog)
          .replace(origins.admin, productionOrigins.admin)
      )
    );
  });

  it("expects the password sign-in the variable declares", async () => {
    const withPassword = {
      ...productionEnv,
      PRODUCTION_EXPECT_PASSWORD_SIGN_IN: "true",
    };
    const fetchImpl = (url, init) =>
      Promise.resolve(productionAnswer(url, init));
    const failures = await runSmoke(
      productionOrigins,
      { ...options, target: productionTarget(withPassword).target },
      fetchImpl,
      noPause
    );
    expect(failures).toEqual([
      "web /api/auth-methods (Google, password and Turnstile configured): 200 sign-in methods different",
    ]);
  });

  describe("sign-in methods of production", () => {
    const sentWith = (methods, expectPassword) => {
      const declared = {
        ...productionEnv,
        PRODUCTION_EXPECT_PASSWORD_SIGN_IN: expectPassword,
      };
      return runSmoke(
        productionOrigins,
        { ...options, target: productionTarget(declared).target },
        (url, init) => {
          const stagingUrl = toStagingUrl(url);
          if (stagingUrl === `${origins.web}/api/auth-methods`) {
            return Promise.resolve(fromWorker(200, {}, json(methods)));
          }
          return Promise.resolve(productionAnswer(url, init));
        },
        noPause
      );
    };
    const check =
      "web /api/auth-methods (Google, password and Turnstile configured)";

    it("passes with the password off and a null Turnstile key, as production is born", async () => {
      expect(
        await sentWith(
          { emailPassword: false, google: true, turnstileSiteKey: null },
          "false"
        )
      ).toEqual([]);
    });

    it("passes with the password on and the Turnstile key", async () => {
      expect(await sentWith(AUTH_METHODS, "true")).toEqual([]);
    });

    it("fails with the password on and no Turnstile key", async () => {
      expect(
        await sentWith({ ...AUTH_METHODS, turnstileSiteKey: null }, "true")
      ).toEqual([
        `${check}: 200 Turnstile site key missing with the password on`,
      ]);
    });

    it("fails with the password off and a Turnstile key", async () => {
      expect(
        await sentWith({ ...AUTH_METHODS, emailPassword: false }, "false")
      ).toEqual([`${check}: 200 Turnstile site key set with the password off`]);
    });

    it("fails when Google differs from the expected", async () => {
      expect(
        await sentWith(
          { emailPassword: false, google: false, turnstileSiteKey: null },
          "false"
        )
      ).toEqual([`${check}: 200 sign-in methods different`]);
    });
  });

  it("expects no release header while the flag is off, and fails if one is sent", async () => {
    const flagOff = {
      ...productionEnv,
      PRODUCTION_EXPECT_RELEASE_HEADER: "false",
    };
    const { target } = productionTarget(flagOff);
    const silent = (url, init) => {
      const response = productionAnswer(url, init);
      response.headers.delete("x-polaris-release");
      return Promise.resolve(response);
    };
    expect(
      await runSmoke(productionOrigins, { ...options, target }, silent, noPause)
    ).toEqual([]);
    const failures = await runSmoke(
      productionOrigins,
      { ...options, target },
      (url, init) => Promise.resolve(productionAnswer(url, init)),
      noPause
    );
    expect(failures).toEqual([
      "web /health (release of the Worker): 200 release header present (flag is off)",
      "catalog /robots.txt (release of the Worker): 200 release header present (flag is off)",
    ]);
    const missing = await runSmoke(
      productionOrigins,
      productionOptions(),
      silent,
      noPause
    );
    expect(missing).toHaveLength(2);
    expect(missing[0]).toContain("release absent");
  });

  it("sends the Admin to the production Access team, not to the staging one", async () => {
    const stagingLogin = answer(302, {
      location: `https://${STAGING_ACCESS_TEAM}/cdn-cgi/access/login/admin.exemplo.com.br`,
    });
    const wrongPath = answer(302, {
      location: `https://${PRODUCTION_ACCESS_TEAM}/cdn-cgi/access/login/admin.araute.app`,
    });
    const replaced = {
      [`${productionOrigins.admin}/health`]: stagingLogin,
      [`${productionOrigins.admin}/api/whoami`]: wrongPath,
    };
    const fetchImpl = (url, init) =>
      Promise.resolve(replaced[url] ?? productionAnswer(url, init));
    expect(
      await runSmoke(productionOrigins, productionOptions(), fetchImpl, noPause)
    ).toEqual([
      "admin /health without sign-in (redirected to Access): 302 redirect outside the Access team",
      "admin /api/whoami without sign-in (redirected to Access): 302 redirect to another Access page",
    ]);
  });

  it("refuses an origin that is not the declared host, before any request", async () => {
    const fetchImpl = vi.fn();
    for (const web of [
      undefined,
      origins.web,
      "https://outro.exemplo.com.br",
      `${productionOrigins.web}/path`,
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: each case on its own, for a clear failure
      const failures = await runSmoke(
        { ...productionOrigins, web },
        productionOptions(),
        fetchImpl,
        noPause
      );
      expect(failures).toEqual([
        "web: the origin is not the one declared for the production web",
      ]);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never sends a request across environments", async () => {
    const [check] = smokeChecks(
      origins,
      { release: RELEASE, shell: { index: "", serviceWorker: "" } },
      STAGING_TARGET
    );
    const fetchImpl = vi.fn();
    await expect(send(check, fetchImpl, production())).rejects.toThrow(
      "host_refused"
    );
    const [productionCheck] = smokeChecks(
      productionOrigins,
      { release: RELEASE, shell: { index: "", serviceWorker: "" } },
      production()
    );
    await expect(send(productionCheck, fetchImpl)).rejects.toThrow(
      "host_refused"
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("the choice of the environment", () => {
  it("is staging without --env, and the two spellings of --env are read", () => {
    expect(environmentOf([])).toBe("staging");
    expect(environmentOf(["--env", "staging"])).toBe("staging");
    expect(environmentOf(["--env", "production"])).toBe("production");
    expect(environmentOf(["--env=production"])).toBe("production");
  });

  it("refuses an unknown or missing environment", () => {
    for (const argv of [
      ["--env"],
      ["--env", "prod"],
      ["--env="],
      ["--env=Production"],
      ["--env", "--other"],
      ["--environment", "production"],
      ["--env-production"],
      ["-env", "production"],
      ["production"],
      ["--env", "staging", "--env", "production"],
      ["--env", "production", "--env", "staging"],
      ["--env=production", "extra"],
      ["--env", "production", "extra"],
      ["extra", "--env", "production"],
    ]) {
      expect(environmentOf(argv), argv.join(" ")).toBeNull();
    }
  });

  it("keeps staging reading its own three variables, with its fixed hosts", () => {
    const plan = planOf("staging", {
      PRODUCTION_WEB_URL: "https://app.exemplo.com.br",
      STAGING_ADMIN_URL: "a",
      STAGING_CATALOG_URL: "c",
      STAGING_WEB_URL: "w",
    });
    expect(plan.refusals).toEqual([]);
    expect(plan.origins).toEqual({ admin: "a", catalog: "c", web: "w" });
    expect(plan.target).toBe(STAGING_TARGET);
    expect(STAGING_TARGET.hosts).toBe(STAGING_FIXED_HOST);
    expect(STAGING_TARGET.userAgent).toBe(USER_AGENT);
    expect(STAGING_TARGET.accessTeam).toBe(STAGING_ACCESS_TEAM);
    expect(STAGING_TARGET.accessLoginPath).toBe(
      "/cdn-cgi/access/login/admin.araute.app"
    );
  });

  it("plans production from its own variables only, never from the staging ones", () => {
    const plan = planOf("production", {
      ...productionEnv,
      STAGING_WEB_URL: origins.web,
    });
    expect(plan.refusals).toEqual([]);
    expect(plan.origins).toEqual(productionOrigins);
    expect(plan.target.name).toBe("production");
  });
});

describe("the command line of the smoke", () => {
  const run = (args, env) =>
    spawnSync(process.execPath, ["scripts/smoke-staging.mjs", ...args], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, ...env },
      timeout: 20_000,
    });

  it("refuses --env production with no variable: exit 1, a clear message, no request", () => {
    const result = run(["--env", "production"], {});
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("PRODUCTION_WEB_URL: missing");
    expect(result.stderr).toContain("production domain is not configured");
    expect(result.stderr).toContain(
      "Smoke refused (production): nothing was requested."
    );
  });

  it("refuses --env production even with the staging variables set", () => {
    const result = run(["--env=production"], {
      HEAD_SHA: COMMIT,
      STAGING_ADMIN_URL: origins.admin,
      STAGING_CATALOG_URL: origins.catalog,
      STAGING_WEB_URL: origins.web,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Smoke refused (production)");
  });

  it("refuses an unknown environment", () => {
    const result = run(["--env", "prod"], {});
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--env must be one of staging, production");
  });

  it("runs staging, with no option, as the deploy workflow does: it refuses a staging host that is not fixed", () => {
    const result = run([], {
      HEAD_SHA: COMMIT,
      STAGING_ADMIN_URL: origins.admin,
      STAGING_CATALOG_URL: origins.catalog,
      STAGING_WEB_URL: "https://outro.exemplo.com.br",
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(`${REFUSAL.web}\nStaging smoke failed (1).\n`);
  });

  it("prints the reason of a HEAD_SHA refusal, without the value of the variable", () => {
    const secret = "valor-que-nao-pode-aparecer";
    const result = run([], {
      HEAD_SHA: secret,
      STAGING_ADMIN_URL: origins.admin,
      STAGING_CATALOG_URL: origins.catalog,
      STAGING_WEB_URL: origins.web,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      `${COMMIT_REFUSAL}\nStaging smoke failed (1).\n`
    );
    expect(result.stderr).not.toContain(secret);
  });

  it("prints the reason of a HEAD_SHA refusal in production too, without any variable value", () => {
    const secret = "valor-que-nao-pode-aparecer";
    const result = run(["--env", "production"], {
      ...productionEnv,
      HEAD_SHA: secret,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      `${COMMIT_REFUSAL}\nProduction smoke failed (1).\n`
    );
    for (const value of [
      secret,
      productionEnv.PRODUCTION_ACCESS_TEAM,
      ...Object.values(productionOrigins),
    ]) {
      expect(result.stderr).not.toContain(value);
    }
  });
});

const SMOKE_SOURCE = readFileSync(
  new URL("./smoke-staging.mjs", import.meta.url),
  "utf8"
);
const DEPLOY_WORKFLOW = readFileSync(
  new URL("../.github/workflows/deploy-staging.yml", import.meta.url),
  "utf8"
);

const DSN_SOURCE = readFileSync(
  new URL("../apps/web/src/observability/sentry-dsn.ts", import.meta.url),
  "utf8"
);

const APP_INGEST_HOST = /^const INGEST_HOST = \/(.+)\/;$/m;
const SMOKE_INGEST_ORIGIN = /^const SENTRY_INGEST_ORIGIN =\s*\/(.+)\/;$/m;
const ORIGIN_PREFIX = "^https:\\/\\/";

function patternSource(source, pattern, what) {
  const found = pattern.exec(source);
  if (!found) {
    throw new Error(`${what} not found`);
  }
  return found[1];
}

function ingestPatternDrift(appSource, smokeSource) {
  const app = patternSource(appSource, APP_INGEST_HOST, "INGEST_HOST");
  const smoke = patternSource(
    smokeSource,
    SMOKE_INGEST_ORIGIN,
    "SENTRY_INGEST_ORIGIN"
  );
  const expected = `${ORIGIN_PREFIX}${app.slice(1)}`;
  return smoke === expected
    ? null
    : `the ingest pattern of the smoke (${smoke}) differs from the one of the app (${expected})`;
}

describe("the Sentry ingest pattern of the smoke", () => {
  it("is the host pattern of the app (apps/web/src/observability/sentry-dsn.ts) as an origin", () => {
    expect(ingestPatternDrift(DSN_SOURCE, SMOKE_SOURCE)).toBeNull();
  });

  it("fails when the app accepts a host format the smoke does not (planted control)", () => {
    const widened = DSN_SOURCE.replace(
      "ingest(?:\\.[a-z0-9-]+)?",
      "ingest(?:\\.[a-z0-9-]+)*"
    );
    expect(widened).not.toBe(DSN_SOURCE);
    expect(ingestPatternDrift(widened, SMOKE_SOURCE)).toContain("differs");
  });

  it("fails when the smoke narrows its pattern (planted control)", () => {
    const narrowed = SMOKE_SOURCE.replace("o\\d+\\.ingest", "o\\d{3}\\.ingest");
    expect(narrowed).not.toBe(SMOKE_SOURCE);
    expect(ingestPatternDrift(DSN_SOURCE, narrowed)).toContain("differs");
  });

  it("fails loudly when either pattern cannot be found", () => {
    expect(() => ingestPatternDrift("", SMOKE_SOURCE)).toThrow("INGEST_HOST");
    expect(() => ingestPatternDrift(DSN_SOURCE, "")).toThrow(
      "SENTRY_INGEST_ORIGIN"
    );
  });
});

const STARTUP_SLACK_SECONDS = 15;

const ATTEMPTS_PATTERN = /^const ATTEMPTS = ([\d_]+);/m;
const PAUSE_PATTERN = /^const wait = .*setTimeout\(resolve, ([\d_]+)\)/m;
const REQUEST_TIMEOUT_PATTERN = /^const TIMEOUT_MS = ([\d_]+);/m;
const RELEASE_WAIT_PATTERN =
  /^export const RELEASE_WAIT_CEILING_MS = ([\d_]+);/m;
const WORKFLOW_STEP_SPLIT = /\n {6}- /;
const SMOKE_STEP_NAME = /^(?:if: .*\n {8})?name: Smoke$/m;
const STEP_TIMEOUT_PATTERN = /^ {8}timeout-minutes: (\d+)$/m;

function numberAfter(source, pattern, what) {
  const found = pattern.exec(source);
  if (!found) {
    throw new Error(`${what} not found in the source of the smoke`);
  }
  return Number(found[1].replaceAll("_", ""));
}

function smokeTiming() {
  return {
    attempts: numberAfter(SMOKE_SOURCE, ATTEMPTS_PATTERN, "ATTEMPTS"),
    pauseSeconds:
      numberAfter(SMOKE_SOURCE, PAUSE_PATTERN, "the pause of wait") / 1000,
    requestSeconds:
      numberAfter(SMOKE_SOURCE, REQUEST_TIMEOUT_PATTERN, "TIMEOUT_MS") / 1000,
    waitSeconds:
      numberAfter(
        SMOKE_SOURCE,
        RELEASE_WAIT_PATTERN,
        "RELEASE_WAIT_CEILING_MS"
      ) / 1000,
  };
}

function smokeStepMinutes(workflow) {
  const step = workflow
    .split(WORKFLOW_STEP_SPLIT)
    .find((part) => SMOKE_STEP_NAME.test(part));
  if (!step) {
    throw new Error("the step Smoke was not found in deploy-staging.yml");
  }
  return numberAfter(step, STEP_TIMEOUT_PATTERN, "timeout-minutes");
}

/**
 * Worst case: the release wait runs to its ceiling and its last read times out, then every check times out on every
 * try (a `platform` check that times out is repeated like the others).
 */
function worstCaseSeconds(
  checkCount,
  { attempts, pauseSeconds, requestSeconds, waitSeconds }
) {
  return (
    waitSeconds +
    requestSeconds +
    checkCount * (attempts * requestSeconds + (attempts - 1) * pauseSeconds)
  );
}

function timeoutVerdict(checkCount, timeoutMinutes) {
  const worst = worstCaseSeconds(checkCount, smokeTiming());
  const limit = timeoutMinutes * 60;
  if (worst + STARTUP_SLACK_SECONDS <= limit) {
    return null;
  }
  return (
    `the smoke has ${checkCount} checks: worst case ${worst} s + ${STARTUP_SLACK_SECONDS} s of slack, ` +
    `but the step Smoke of deploy-staging.yml allows ${limit} s (timeout-minutes: ${timeoutMinutes}). ` +
    "Raise timeout-minutes of the step in deploy-staging.yml or cut a check."
  );
}

describe("the worst case of the smoke against the timeout of its step", () => {
  const checkCount = () =>
    smokeChecks(origins, {
      release: RELEASE,
      shell: { index: "", serviceWorker: "" },
    }).length;
  const needed = () =>
    worstCaseSeconds(checkCount(), smokeTiming()) + STARTUP_SLACK_SECONDS;

  it("reads the timing the script really uses", () => {
    expect(smokeTiming()).toEqual({
      attempts: 3,
      pauseSeconds: 5,
      requestSeconds: 10,
      waitSeconds: 120,
    });
  });

  it("fits in the timeout-minutes of the step Smoke of the deploy workflow", () => {
    expect(
      timeoutVerdict(checkCount(), smokeStepMinutes(DEPLOY_WORKFLOW))
    ).toBeNull();
  });

  it("control: one more check than the timeout allows fails, saying both numbers and what to do", () => {
    const minutes = Math.ceil(needed() / 60);
    expect(timeoutVerdict(checkCount(), minutes)).toBeNull();
    const verdict = timeoutVerdict(checkCount() + 1, minutes);
    expect(verdict).toContain(`${checkCount() + 1} checks`);
    expect(verdict).toContain(`allows ${minutes * 60} s`);
    expect(verdict).toContain("Raise timeout-minutes");
    expect(verdict).toContain("cut a check");
  });

  it("control: a timeout one minute shorter than the checks need fails", () => {
    const below = Math.ceil(needed() / 60) - 1;
    expect(timeoutVerdict(checkCount(), below)).toContain(`${below * 60} s`);
  });

  it("control: a workflow without the step Smoke is refused", () => {
    expect(() =>
      smokeStepMinutes("jobs:\n  x:\n    steps:\n      - name: Other\n")
    ).toThrow("the step Smoke");
  });
});

const JOB_NAME = /^ {4}name: Migrate, deploy and smoke$/m;
const JOB_SPLIT = /\n {2}(?=[\w-]+:\n)/;
const JOB_TIMEOUT_PATTERN = /^ {4}timeout-minutes: (\d+)$/m;
// checkout, runtime setup, bun install, artifact download, isolation check, staging:verify-database, db:migrate and
// the three `wrangler deploy` have no time proof of their own; this is what the job keeps for them beyond the two
// worst cases
const REST_OF_THE_JOB_SECONDS = 240;

function deployJobMinutes(workflow) {
  const job = workflow.split(JOB_SPLIT).find((part) => JOB_NAME.test(part));
  if (!job) {
    throw new Error(
      "the job Migrate, deploy and smoke was not found in deploy-staging.yml"
    );
  }
  return numberAfter(job, JOB_TIMEOUT_PATTERN, "timeout-minutes of the job");
}

function verifyWorstCaseSeconds(workerCount) {
  return worstCaseMs(workerCount) / 1000;
}

function jobBudgetVerdict({ smokeMinutes, workers, jobMinutes, restSeconds }) {
  const smoke = smokeMinutes * 60;
  const verify = verifyWorstCaseSeconds(workers);
  const limit = jobMinutes * 60;
  if (smoke + verify + restSeconds <= limit) {
    return null;
  }
  return (
    `the job Migrate, deploy and smoke needs ${smoke} s of smoke (timeout-minutes: ${smokeMinutes} of the step Smoke) + ` +
    `${verify} s of verify-deployed-sha (${workers} Workers) + ${restSeconds} s for the rest = ` +
    `${smoke + verify + restSeconds} s, but deploy-staging.yml allows ${limit} s (timeout-minutes: ${jobMinutes}). ` +
    "Raise timeout-minutes of the job in deploy-staging.yml, or cut a check or a Worker."
  );
}

describe("the worst cases of the smoke and of verify-deployed-sha against the timeout of the deploy job", () => {
  const smokeSeconds = () => smokeStepMinutes(DEPLOY_WORKFLOW) * 60;
  const budget = (overrides = {}) =>
    jobBudgetVerdict({
      jobMinutes: deployJobMinutes(DEPLOY_WORKFLOW),
      restSeconds: REST_OF_THE_JOB_SECONDS,
      smokeMinutes: smokeStepMinutes(DEPLOY_WORKFLOW),
      workers: STAGING_WORKERS.length,
      ...overrides,
    });

  it("reads the timeout of the job, not the one of the step Smoke", () => {
    const job = deployJobMinutes(DEPLOY_WORKFLOW);
    expect(job).toBeGreaterThan(smokeStepMinutes(DEPLOY_WORKFLOW));
    expect(job * 60).toBeGreaterThan(
      smokeSeconds() + verifyWorstCaseSeconds(STAGING_WORKERS.length)
    );
  });

  it("fits in the timeout-minutes of the job Migrate, deploy and smoke", () => {
    expect(budget()).toBeNull();
  });

  it("control: five Workers in the version check overflow the job, and the message says both sums and the limit", () => {
    const verdict = budget({ workers: 5 });
    expect(verdict).toContain(
      `${verifyWorstCaseSeconds(5)} s of verify-deployed-sha (5 Workers)`
    );
    expect(verdict).toContain(`${smokeSeconds()} s of smoke`);
    expect(verdict).toContain(
      `allows ${deployJobMinutes(DEPLOY_WORKFLOW) * 60} s`
    );
    expect(verdict).toContain("Raise timeout-minutes of the job");
    expect(verdict).toContain(
      `= ${smokeSeconds() + verifyWorstCaseSeconds(5) + REST_OF_THE_JOB_SECONDS} s`
    );
  });

  it("sums the step Smoke at its timeout-minutes (960 s), not at its worst case", () => {
    expect(smokeSeconds()).toBe(960);
    expect(
      smokeSeconds() +
        verifyWorstCaseSeconds(STAGING_WORKERS.length) +
        REST_OF_THE_JOB_SECONDS
    ).toBe(1560);
  });

  it("control: a step Smoke three minutes longer overflows the job", () => {
    const verdict = budget({
      smokeMinutes: smokeStepMinutes(DEPLOY_WORKFLOW) + 3,
    });
    expect(verdict).toContain("1140 s of smoke (timeout-minutes: 19");
  });

  it("control: a job of 18 minutes overflows", () => {
    const verdict = budget({ jobMinutes: 18 });
    expect(verdict).toContain("allows 1080 s (timeout-minutes: 18)");
    expect(verdict).toContain(
      `${verifyWorstCaseSeconds(STAGING_WORKERS.length)} s of verify-deployed-sha (${STAGING_WORKERS.length} Workers)`
    );
  });

  it("control: a rest of the job that no longer fits the margin overflows", () => {
    const margin =
      deployJobMinutes(DEPLOY_WORKFLOW) * 60 -
      smokeSeconds() -
      verifyWorstCaseSeconds(STAGING_WORKERS.length);
    expect(budget({ restSeconds: margin })).toBeNull();
    expect(budget({ restSeconds: margin + 1 })).toContain("for the rest");
  });

  it("control: a workflow without the job is refused", () => {
    expect(() =>
      deployJobMinutes(
        "jobs:\n  other:\n    name: Other\n    timeout-minutes: 5\n"
      )
    ).toThrow("the job Migrate, deploy and smoke");
  });
});
