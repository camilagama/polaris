import { clientErrorEventSchema } from "../packages/contracts/src/client-error.ts";
import { describe, expect, it } from "vitest";
import {
  clientErrorSignature,
  createClientErrorRoutes,
} from "../apps/web/src/server/routes/client-errors";
import {
  CANARY_EVENT,
  CANARY_FINGERPRINT,
  canaryBody,
  EXIT_API_FAILED,
  EXIT_BLIND,
  EXIT_OK,
  EXIT_REFUSED,
  EXIT_USAGE,
  run,
} from "./client-error-canary.mjs";
import { parseMuteList } from "./client-error-sentinel.mjs";

const NOW = Date.parse("2026-11-04T12:00:00Z");
const MINUTE = 60_000;
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const TOKEN = "token-de-teste-que-nao-pode-aparecer";
const RELEASE = "a1b2c3d4e5f6";
const ORIGIN = "https://dash.araute.app";
const SERVICE = "polaris-web-staging";
const HEX16 = /^[0-9a-f]{16}$/;
const SOURCE_FAILED = /^source failed/;
const ENV = { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: TOKEN };
const SEND = ["--base-url", ORIGIN, "--release", RELEASE];
const CHECK = [
  "--check",
  "--service",
  SERVICE,
  "--now",
  "2026-11-04T12:00:00Z",
];

const fakeFetch = (respond) => {
  const calls = [];
  const fetchImpl = (url, init) => {
    calls.push({ init, url });
    return respond(url, init);
  };
  return { calls, fetchImpl };
};

const telemetry = (events) =>
  Promise.resolve({
    json: () => Promise.resolve({ result: { events: { events } } }),
    status: 200,
  });

const canaryLine = (minutesAgo, fingerprint = CANARY_FINGERPRINT) => ({
  source: { event: "client_error", fingerprint, release: RELEASE },
  timestamp: NOW - minutesAgo * MINUTE,
});

describe("the body and the fingerprint of the canary", () => {
  it("is an event the schema of the route accepts", () => {
    const body = JSON.parse(canaryBody(RELEASE));
    expect(clientErrorEventSchema.safeParse(body).success).toBe(true);
    expect(body.release).toBe(RELEASE);
  });

  it("has the fingerprint the route computes for it", async () => {
    const parsed = clientErrorEventSchema.parse(
      JSON.parse(canaryBody(RELEASE))
    );
    expect(await clientErrorSignature(parsed)).toBe(CANARY_FINGERPRINT);
  });

  it("keeps the fingerprint written in the runbook and in the mute list", () => {
    expect(CANARY_FINGERPRINT).toMatch(HEX16);
    expect(CANARY_FINGERPRINT).toBe("ef8188b5f342498f");
    expect(parseMuteList(`${CANARY_FINGERPRINT}  # canário`)).toEqual(
      new Set([CANARY_FINGERPRINT])
    );
  });

  it("does not change with the release", async () => {
    const other = clientErrorEventSchema.parse(
      JSON.parse(canaryBody("0f9e8d7c6b5a"))
    );
    expect(await clientErrorSignature(other)).toBe(CANARY_FINGERPRINT);
  });

  it("is accepted by the real route and logged as one line with the fingerprint", async () => {
    const accepted = [];
    const refused = [];
    const routes = createClientErrorRoutes({
      log: {
        accepted: (signature, fields) => accepted.push({ fields, signature }),
        piiSuspected: () => refused.push("pii"),
        refused: (reason) => refused.push(reason),
      },
    });
    const response = await routes.request(
      "/api/client-errors",
      {
        body: canaryBody(RELEASE),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
      {}
    );
    expect(response.status).toBe(204);
    expect(refused).toEqual([]);
    expect(accepted).toHaveLength(1);
    expect(accepted[0].signature).toBe(CANARY_FINGERPRINT);
    expect(accepted[0].fields).toMatchObject({
      errorClass: CANARY_EVENT.errorName,
      kind: CANARY_EVENT.kind,
      release: RELEASE,
    });
  });
});

describe("sending the canary", () => {
  it("posts the body to the route with the origin of the app and says it was sent", async () => {
    const { calls, fetchImpl } = fakeFetch(() =>
      Promise.resolve({ status: 204 })
    );
    const { code, output } = await run({ argv: SEND, env: {}, fetchImpl });
    expect(code).toBe(EXIT_OK);
    expect(output).toEqual({
      fingerprint: CANARY_FINGERPRINT,
      ok: true,
      sent: true,
      status: 204,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${ORIGIN}/api/client-errors`);
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers).toEqual({
      "content-type": "application/json",
      origin: ORIGIN,
    });
    expect(calls[0].init.body).toBe(canaryBody(RELEASE));
    expect(Buffer.byteLength(calls[0].init.body)).toBeLessThan(2048);
  });

  it.each([400, 403, 415, 429, 500])(
    "does not hide a %i of the route",
    async (status) => {
      const { fetchImpl } = fakeFetch(() => Promise.resolve({ status }));
      const { code, output } = await run({ argv: SEND, env: {}, fetchImpl });
      expect(code).toBe(EXIT_REFUSED);
      expect(output).toMatchObject({ ok: false, status });
    }
  );

  it("exits with the API code when the request fails", async () => {
    const { fetchImpl } = fakeFetch(() => Promise.reject(new Error("offline")));
    const { code, output } = await run({ argv: SEND, env: {}, fetchImpl });
    expect(code).toBe(EXIT_API_FAILED);
    expect(output.ok).toBe(false);
  });

  it.each([
    [["--release", RELEASE]],
    [["--base-url", ORIGIN]],
    [["--base-url", "http://dash.araute.app", "--release", RELEASE]],
    [["--base-url", "not a url", "--release", RELEASE]],
    [["--base-url", ORIGIN, "--release", "main"]],
    [[...SEND, "--unknown", "x"]],
    [[...SEND, "positional"]],
  ])("refuses a bad command line before any request (%j)", async (argv) => {
    const { calls, fetchImpl } = fakeFetch(() =>
      Promise.resolve({ status: 204 })
    );
    const { code } = await run({ argv, env: ENV, fetchImpl });
    expect(code).toBe(EXIT_USAGE);
    expect(calls).toHaveLength(0);
  });
});

describe("checking the telemetry", () => {
  it("asks for the fingerprint of the canary in the service and passes when the line is there", async () => {
    const { calls, fetchImpl } = fakeFetch(() => telemetry([canaryLine(10)]));
    const { code, output } = await run({
      argv: CHECK,
      env: ENV,
      fetchImpl,
      now: 0,
    });
    expect(code).toBe(EXIT_OK);
    expect(output).toMatchObject({ found: 1, ok: true, window: "24h" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/observability/telemetry/query`
    );
    expect(calls[0].init.headers.authorization).toBe(`Bearer ${TOKEN}`);
    const query = JSON.parse(calls[0].init.body);
    expect(query.timeframe).toEqual({ from: NOW - 24 * 60 * MINUTE, to: NOW });
    expect(query.view).toBe("events");
    expect(query.parameters.filters).toEqual([
      {
        key: "fingerprint",
        operation: "eq",
        type: "string",
        value: CANARY_FINGERPRINT,
      },
      {
        key: "$metadata.service",
        operation: "eq",
        type: "string",
        value: SERVICE,
      },
    ]);
  });

  it("exits blind when the query answers with no line", async () => {
    const { fetchImpl } = fakeFetch(() => telemetry([]));
    const { code, output } = await run({ argv: CHECK, env: ENV, fetchImpl });
    expect(code).toBe(EXIT_BLIND);
    expect(output).toMatchObject({ found: 0, ok: false });
    expect(output.reason).toContain("reader blind");
  });

  it("does not count a line of another fingerprint or outside the window", async () => {
    const { fetchImpl } = fakeFetch(() =>
      telemetry([
        canaryLine(5, "0123456789abcdef"),
        canaryLine(25 * 60),
        canaryLine(-5),
        {
          source: { fingerprint: CANARY_FINGERPRINT },
          timestamp: "not a date",
        },
      ])
    );
    const { code } = await run({ argv: CHECK, env: ENV, fetchImpl });
    expect(code).toBe(EXIT_BLIND);
  });

  it("uses the window of --since", async () => {
    const { calls, fetchImpl } = fakeFetch(() => telemetry([canaryLine(60)]));
    const { code } = await run({
      argv: [...CHECK, "--since", "30m"],
      env: ENV,
      fetchImpl,
    });
    expect(code).toBe(EXIT_BLIND);
    expect(JSON.parse(calls[0].init.body).timeframe.from).toBe(
      NOW - 30 * MINUTE
    );
  });

  it("reads the timestamp of a line that comes without `source`", async () => {
    const { fetchImpl } = fakeFetch(() =>
      telemetry([
        {
          fingerprint: CANARY_FINGERPRINT,
          timestamp: new Date(NOW - MINUTE).toISOString(),
        },
      ])
    );
    const { code } = await run({ argv: CHECK, env: ENV, fetchImpl });
    expect(code).toBe(EXIT_OK);
  });

  it.each([
    [{ status: 401 }],
    [{ status: 500 }],
    [{ body: { result: {} }, status: 200 }],
  ])(
    "is an API failure and not a blind reader (%j)",
    async ({ body, status }) => {
      const { fetchImpl } = fakeFetch(() =>
        Promise.resolve({ json: () => Promise.resolve(body ?? {}), status })
      );
      const { code, output } = await run({ argv: CHECK, env: ENV, fetchImpl });
      expect(code).toBe(EXIT_API_FAILED);
      expect(output.reason).toMatch(SOURCE_FAILED);
    }
  );

  it("is an API failure when the request throws", async () => {
    const { fetchImpl } = fakeFetch(() => Promise.reject(new Error("offline")));
    const { code } = await run({ argv: CHECK, env: ENV, fetchImpl });
    expect(code).toBe(EXIT_API_FAILED);
  });

  it.each([
    [{}, CHECK],
    [{ CLOUDFLARE_ACCOUNT_ID: "ABC", CLOUDFLARE_API_TOKEN: TOKEN }, CHECK],
    [ENV, ["--check"]],
    [ENV, [...CHECK, "--since", "1d"]],
    [ENV, ["--check", "--service", SERVICE, "--now", "ontem"]],
  ])("refuses a bad setup before any request (%j)", async (env, argv) => {
    const { calls, fetchImpl } = fakeFetch(() => telemetry([canaryLine(1)]));
    const { code } = await run({ argv, env, fetchImpl });
    expect(code).toBe(EXIT_USAGE);
    expect(calls).toHaveLength(0);
  });

  it("never prints the token or the account", async () => {
    const responders = [
      () => telemetry([]),
      () => Promise.resolve({ status: 401 }),
      () => Promise.reject(new Error(`boom ${TOKEN}`)),
    ];
    const results = await Promise.all(
      responders.map((respond) =>
        run({ argv: CHECK, env: ENV, fetchImpl: fakeFetch(respond).fetchImpl })
      )
    );
    for (const { output } of results) {
      const text = JSON.stringify(output);
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(ACCOUNT);
    }
  });
});
