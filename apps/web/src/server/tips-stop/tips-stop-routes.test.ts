import type { ActivationOptOutWriter } from "@polaris/db/activation-opt-out";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServerApp } from "../app";
import type { WorkerBindings } from "../environment";
import { TIPS_STOP_TEXTS, tipsStopStyleHash } from "./tips-stop-page";
import {
  createUnsubscribeToken,
  TIPS_STOP_PATH,
  type UnsubscribeSecrets,
} from "./unsubscribe-token";

const baseURL = "https://polaris.example.invalid";
const SECRET = "u".repeat(40);
const SESSION_SECRET = "a".repeat(40);
const USER = "Kq3vXbX0f1Lr9sTzUa2W";
const MISSING_USER = "ZZ7dPq0wNm4Lk2Jh1GfD";
const CLIENT_ADDRESS = "203.0.113.7";
const secrets: UnsubscribeSecrets = { current: SECRET };
const SCRIPT = /<script/i;
/** What the logger puts on every line by itself. */
const SERVICE_FIELDS = [
  "commitHash",
  "environment",
  "event",
  "level",
  "region",
  "service",
  "timestamp",
  "version",
];
const HREF = /href="([^"]*)"/g;
const BUTTONS = /<button\b|<a class="action\b/g;
const JARGON =
  /descadastr|cancelar inscri|opt-out|opt out|série|serie\b|ativação|ativacao|trial/i;

function spyLogs() {
  return {
    error: vi.spyOn(console, "error").mockImplementation(() => undefined),
    info: vi.spyOn(console, "info").mockImplementation(() => undefined),
    log: vi.spyOn(console, "log").mockImplementation(() => undefined),
    warn: vi.spyOn(console, "warn").mockImplementation(() => undefined),
  };
}

type Logs = ReturnType<typeof spyLogs>;

function logText(spies: Logs): string {
  return Object.values(spies)
    .flatMap((spy) => spy.mock.calls.map((call) => JSON.stringify(call)))
    .join("\n");
}

function answers(spies: Logs): Record<string, unknown>[] {
  return Object.values(spies)
    .flatMap((spy) => spy.mock.calls.map(([entry]) => entry))
    .filter(
      (entry): entry is Record<string, unknown> =>
        typeof entry === "object" &&
        entry !== null &&
        (entry as { event?: unknown }).event === "tips_stop_answered"
    );
}

interface Writers {
  closed: number;
  created: string[];
  recorded: string[];
}

function setup(
  overrides: {
    [K in keyof WorkerBindings]?: WorkerBindings[K] | undefined;
  } = {},
  {
    limiterSuccess = true,
    record,
  }: {
    limiterSuccess?: boolean;
    record?: (userId: string) => Promise<void>;
  } = {}
) {
  const writers: Writers = { closed: 0, created: [], recorded: [] };
  const limiter = {
    limit: vi.fn((_options: { key: string }) =>
      Promise.resolve({ success: limiterSuccess })
    ),
  };
  const env = {
    BETTER_AUTH_BASE_URL: baseURL,
    BETTER_AUTH_SECRET: SESSION_SECRET,
    BILLING_HYPERDRIVE: {
      connectionString: "postgresql://billing.test.invalid/neondb",
    },
    TIPS_STOP_RATE_LIMIT: limiter,
    UNSUBSCRIBE_TOKEN_SECRET: SECRET,
    ...overrides,
  } as WorkerBindings;
  const app = createServerApp({
    tipsStopRoutes: {
      createWriter: (connectionString): ActivationOptOutWriter => {
        writers.created.push(connectionString);
        return {
          close: () => {
            writers.closed += 1;
            return Promise.resolve();
          },
          record: async (userId) => {
            writers.recorded.push(userId);
            await record?.(userId);
          },
        };
      },
    },
  });
  const call = (
    method: string,
    token: string | undefined,
    {
      body,
      headers = {},
    }: { body?: string; headers?: Record<string, string> } = {}
  ) =>
    app.request(
      token === undefined
        ? TIPS_STOP_PATH
        : `${TIPS_STOP_PATH}?t=${encodeURIComponent(token)}`,
      {
        body: method === "GET" || method === "HEAD" ? null : (body ?? null),
        headers: { "cf-connecting-ip": CLIENT_ADDRESS, ...headers },
        method,
      },
      env
    );
  return { call, limiter, writers };
}

const formPost = {
  body: "List-Unsubscribe=One-Click",
  headers: {
    "content-type": "application/x-www-form-urlencoded",
    origin: baseURL,
    "sec-fetch-site": "same-origin",
  },
};
/** The POST of a mail reader (RFC 8058): from its own servers, no `Origin` and no Fetch Metadata. */
const oneClickPost = {
  body: "List-Unsubscribe=One-Click",
  headers: { "content-type": "application/x-www-form-urlencoded" },
};

let logs: Logs;

beforeEach(() => {
  logs = spyLogs();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function validToken(userId = USER) {
  return await createUnsubscribeToken(secrets, userId);
}

describe("GET and HEAD of the page (AC-8a.1)", () => {
  it("GET shows the question with one button and a native form, and writes nothing", async () => {
    const { call, writers } = setup();
    const response = await call("GET", await validToken());
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(html).toContain(TIPS_STOP_TEXTS.confirmTitle);
    expect(html).toContain(TIPS_STOP_TEXTS.confirmSupport);
    expect(html).toContain('<form method="post">');
    expect(html.match(BUTTONS)).toHaveLength(1);
    expect(html).toContain(TIPS_STOP_TEXTS.confirmButton);
    expect(writers.created).toEqual([]);
  });

  it("HEAD answers the same headers, no body, and writes nothing", async () => {
    const { call, writers } = setup();
    const response = await call("HEAD", await validToken());

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(writers.created).toEqual([]);
  });
});

describe("POST of the page and of the mail reader (AC-8a.3, AC-8a.10 iv)", () => {
  it("the form records the stop for the person of the token and says it is done", async () => {
    const { call, writers } = setup();
    const response = await call("POST", await validToken(), formPost);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain(TIPS_STOP_TEXTS.doneTitle);
    expect(html).toContain(TIPS_STOP_TEXTS.doneSupport);
    expect(html).toContain(TIPS_STOP_TEXTS.doneLink);
    expect(writers.recorded).toEqual([USER]);
    expect(writers.created).toEqual([
      "postgresql://billing.test.invalid/neondb",
    ]);
    expect(writers.closed).toBe(1);
  });

  it("the one-click POST with no Origin, and a POST with no body at all, record the same and answer the same", async () => {
    const token = await validToken();
    const form = setup();
    const formAnswer = await form.call("POST", token, formPost);
    const oneClick = setup();
    const oneClickAnswer = await oneClick.call("POST", token, oneClickPost);
    const bare = setup();
    const bareAnswer = await bare.call("POST", token);

    expect(oneClickAnswer.status).toBe(formAnswer.status);
    expect(bareAnswer.status).toBe(formAnswer.status);
    const formHtml = await formAnswer.text();
    expect(await oneClickAnswer.text()).toBe(formHtml);
    expect(await bareAnswer.text()).toBe(formHtml);
    expect(oneClick.writers.recorded).toEqual(form.writers.recorded);
    expect(bare.writers.recorded).toEqual(form.writers.recorded);
  });

  it("answers the same, status and body, whether the person exists or not, and again on a repeat", async () => {
    // the writer of a person that does not exist ends the same way (the function swallows the foreign key)
    const { call, writers } = setup();
    const existing = await call("POST", await validToken(), oneClickPost);
    const missing = await call(
      "POST",
      await validToken(MISSING_USER),
      oneClickPost
    );
    const repeated = await call("POST", await validToken(), oneClickPost);

    const body = await existing.text();
    expect(missing.status).toBe(existing.status);
    expect(await missing.text()).toBe(body);
    expect(repeated.status).toBe(existing.status);
    expect(await repeated.text()).toBe(body);
    expect(writers.recorded).toEqual([USER, MISSING_USER, USER]);
  });
});

describe("a token that does not verify (AC-8a.2, AC-8a.3)", () => {
  async function invalidTokens(): Promise<(string | undefined)[]> {
    const own = await validToken();
    const [userPart = "", mac = ""] = own.split(".");
    const flipped = `${mac.slice(0, 3)}${mac[3] === "A" ? "B" : "A"}${mac.slice(4)}`;
    return [
      undefined,
      "",
      "nada",
      `${userPart}.${flipped}`,
      await createUnsubscribeToken({ current: SESSION_SECRET }, USER),
      await createUnsubscribeToken({ current: "x".repeat(40) }, USER),
      `${own}.extra`,
    ];
  }

  it.each(["GET", "POST"])(
    "%s gets the same generic refusal for every one of them, and never opens the database",
    async (method) => {
      const { call, writers } = setup();
      const tokens = await invalidTokens();
      const responses = await Promise.all(
        tokens.map((token) => call(method, token, oneClickPost))
      );
      const bodies = await Promise.all(
        responses.map((response) => response.text())
      );

      expect(responses.map((response) => response.status)).toEqual(
        tokens.map(() => 400)
      );
      expect(new Set(bodies).size).toBe(1);
      expect(bodies[0]).toContain(TIPS_STOP_TEXTS.invalidTitle);
      expect(bodies[0]).not.toContain("<form");
      expect(writers.created).toEqual([]);
    }
  );

  it("a token of another purpose signed with the very same secret is refused before the database", async () => {
    const { call, writers } = setup();
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(SECRET),
      { hash: "SHA-256", name: "HMAC" },
      false,
      ["sign"]
    );
    const mac = new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(`polaris/email-suppression/v1\u0000${USER}`)
      )
    );
    const [userPart = ""] = (await validToken()).split(".");
    const macPart = btoa(String.fromCharCode(...mac))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
    const response = await call("POST", `${userPart}.${macPart}`, oneClickPost);

    expect(response.status).toBe(400);
    expect(await response.text()).toContain(TIPS_STOP_TEXTS.invalidTitle);
    expect(writers.created).toEqual([]);
  });
});

describe("the limit per address (before anything)", () => {
  it("counts by an HMAC of the address, never the address itself", async () => {
    const { call, limiter } = setup();
    await call("GET", await validToken());

    const [[{ key }]] = limiter.limit.mock.calls as [[{ key: string }]];
    expect(key.startsWith("tips-stop-ip:")).toBe(true);
    expect(key).not.toContain(CLIENT_ADDRESS);
  });

  it.each([
    ["GET", "valid"],
    ["POST", "valid"],
    ["POST", "invalid"],
  ])(
    "over the limit, a %s with a %s token gets the neutral wait in a status region and reaches nothing",
    async (method, kind) => {
      const { call, writers } = setup({}, { limiterSuccess: false });
      const token = kind === "valid" ? await validToken() : "nada";
      const response = await call(method, token, oneClickPost);
      const html = await response.text();

      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe("60");
      expect(html).toContain(
        `<div role="status"><div class="heading"><h1>${TIPS_STOP_TEXTS.rateLimitedTitle}</h1>`
      );
      expect(html).not.toContain("<form");
      expect(writers.created).toEqual([]);
    }
  );
});

describe("without what the page needs", () => {
  it.each([
    ["no secret", { UNSUBSCRIBE_TOKEN_SECRET: undefined }],
    ["a short secret", { UNSUBSCRIBE_TOKEN_SECRET: "u".repeat(31) }],
    [
      "the session's secret as its own",
      { UNSUBSCRIBE_TOKEN_SECRET: SESSION_SECRET },
    ],
  ])(
    "with %s it fails closed, 503, and reaches nothing",
    async (_name, env) => {
      const { call, writers } = setup(env);
      const response = await call("POST", await validToken(), oneClickPost);

      expect(response.status).toBe(503);
      expect(await response.text()).toContain(TIPS_STOP_TEXTS.unavailableTitle);
      expect(writers.created).toEqual([]);
    }
  );

  it("without the billing connection a valid POST answers 503 and a GET still asks", async () => {
    const { call, writers } = setup({ BILLING_HYPERDRIVE: undefined });
    const token = await validToken();

    expect((await call("GET", token)).status).toBe(200);
    expect((await call("POST", token, oneClickPost)).status).toBe(503);
    expect(writers.created).toEqual([]);
  });

  it("a failed write answers 503 and closes the connection", async () => {
    const failure = Object.assign(new Error("connection refused"), {
      code: "08006",
    });
    const { call, writers } = setup(
      {},
      { record: () => Promise.reject(failure) }
    );
    const response = await call("POST", await validToken(), oneClickPost);

    expect(response.status).toBe(503);
    expect(await response.text()).toContain(TIPS_STOP_TEXTS.unavailableTitle);
    expect(writers.closed).toBe(1);
  });
});

describe("the headers of every answer (AC-8a.10 ii, iii)", () => {
  it("is a page with no referrer, never cached, its style by hash, no script and its form back to the app", async () => {
    const token = await validToken();
    const cases = [
      setup().call("GET", token),
      setup().call("POST", token, oneClickPost),
      setup().call("GET", "nada"),
      setup({}, { limiterSuccess: false }).call("GET", token),
      setup({ UNSUBSCRIBE_TOKEN_SECRET: undefined }).call("GET", token),
    ];
    const hash = await tipsStopStyleHash();
    for (const response of await Promise.all(cases)) {
      const policy = response.headers.get("content-security-policy") ?? "";
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(policy).toBe(
        `default-src 'none'; style-src '${hash}'; img-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`
      );
    }
  });

  it("no answer has a script or a link out of the app, nor a word of the jargon (AC-8a.6)", async () => {
    const token = await validToken();
    const pages = await Promise.all([
      setup().call("GET", token),
      setup().call("POST", token, oneClickPost),
      setup().call("GET", "nada"),
      setup({}, { limiterSuccess: false }).call("GET", token),
      setup({ UNSUBSCRIBE_TOKEN_SECRET: undefined }).call("GET", token),
    ]);
    for (const html of await Promise.all(pages.map((page) => page.text()))) {
      expect(html).not.toMatch(SCRIPT);
      expect([...html.matchAll(HREF)].map((match) => match[1])).toEqual(
        html.includes(TIPS_STOP_TEXTS.doneLink) ? ["/"] : []
      );
      expect(html.match(BUTTONS)?.length ?? 0).toBeLessThanOrEqual(1);
      expect(html).not.toMatch(JARGON);
      expect(html).not.toContain(token);
      expect(html).not.toContain(USER);
    }
  });
});

describe("the log (AC-8a.8, AC-8a.10 ii)", () => {
  it("has the outcome of each answer and never the token, the query, the person nor the address", async () => {
    const token = await validToken();
    await setup().call("GET", token);
    await setup().call("POST", token, oneClickPost);
    await setup().call("POST", "nada", oneClickPost);
    await setup({}, { limiterSuccess: false }).call("GET", token);
    await setup(
      {},
      {
        record: () =>
          Promise.reject(
            Object.assign(new Error(`failed for ${USER}`), { code: "08006" })
          ),
      }
    ).call("POST", token, oneClickPost);

    expect(answers(logs).map((line) => line.reason)).toEqual([
      "asked",
      "recorded",
      "invalid_token",
      "rate_limited",
      "unavailable",
    ]);
    const text = logText(logs);
    expect(text).not.toContain(token);
    expect(text).not.toContain(token.split(".")[1]);
    expect(text).not.toContain("?t=");
    expect(text).not.toContain(USER);
    expect(text).not.toContain(CLIENT_ADDRESS);
    expect(text).not.toContain("failed for");
    for (const line of answers(logs)) {
      expect(line.route).toBeUndefined();
      const own = Object.keys(line).filter(
        (key) => !SERVICE_FIELDS.includes(key)
      );
      expect(own.sort()).toEqual(["method", "outcome", "reason", "requestId"]);
    }
  });
});
