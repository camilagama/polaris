import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  dayOfSaoPaulo,
  EXIT_API_FAILED,
  EXIT_OK,
  EXIT_STATE_FAILED,
  EXIT_USAGE,
  FLOOD_ABOVE,
  parseSince,
  run,
  sameRelease,
} from "./client-error-sentinel.mjs";

const NOW = Date.parse("2026-10-28T15:00:00Z");
const RELEASE = "a1b2c3d4e5f6";
const PREVIOUS = "0f9e8d7c6b5a";
const SERVICE = "polaris-web-staging";
const OLD = "deadbeef0000";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const TOKEN = "token-de-teste-que-nao-pode-aparecer";
const MINUTE = 60_000;

const fingerprint = (n) => n.toString(16).padStart(16, "0");

const errorLine = (n, minutesAgo, release = RELEASE, now = NOW) => ({
  event: "client_error",
  fingerprint: fingerprint(n),
  kind: "rpc",
  release,
  timestamp: now - minutesAgo * MINUTE,
});

const countLine = (n, minutesAgo, count, now = NOW) => {
  const at = now - minutesAgo * MINUTE;
  return {
    count,
    event: "client_error_count",
    fingerprint: fingerprint(n),
    minute: new Date(Math.floor(at / MINUTE) * MINUTE).toISOString(),
    timestamp: at,
  };
};

const fakeApi = (lines, { status = 200, body } = {}) => {
  const calls = [];
  const fetchImpl = (url, init) => {
    const query = JSON.parse(init.body);
    const name = query.parameters.filters.find(
      (filter) => filter.key === "event"
    ).value;
    calls.push({ headers: init.headers, name, query, url });
    if (status !== 200) {
      return Promise.resolve({ json: () => Promise.resolve({}), status });
    }
    const events = lines
      .filter((line) => line.event === name)
      .map(({ timestamp, ...source }) => ({ source, timestamp }));
    return Promise.resolve({
      json: () => Promise.resolve(body ?? { result: { events: { events } } }),
      status: 200,
    });
  };
  return { calls, fetchImpl };
};

let dir;
let seen;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sentinel-"));
  seen = join(dir, "vistos.csv");
});

afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

const execute = (lines, options = {}) => {
  const { api = fakeApi(lines), extra = [], now = NOW } = options;
  return run({
    argv: [
      "--release",
      RELEASE,
      "--prev-release",
      PREVIOUS,
      "--service",
      SERVICE,
      "--seen",
      seen,
      ...extra,
    ],
    env: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: TOKEN },
    fetchImpl: api.fetchImpl,
    now,
  });
};

const burst = (n, count, minutes = 5, release = RELEASE) =>
  Array.from({ length: count }, (_, i) =>
    errorLine(n, (i % minutes) + 1, release)
  );

describe("the query", () => {
  it("asks for client_error and client_error_count in the window, with the token in the header only", async () => {
    const api = fakeApi([]);
    const { output } = await execute([], { api });
    expect(api.calls.map((call) => call.name)).toEqual([
      "client_error",
      "client_error_count",
    ]);
    const [{ query, headers, url }] = api.calls;
    expect(url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/observability/telemetry/query`
    );
    expect(query.timeframe).toEqual({ from: NOW - 35 * MINUTE, to: NOW });
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.stringify(output)).not.toContain(TOKEN);
  });

  it("filters by the Worker of --service", async () => {
    const api = fakeApi([]);
    await execute([], { api });
    expect(api.calls[0].query.parameters.filters).toContainEqual({
      key: "$metadata.service",
      operation: "eq",
      type: "string",
      value: SERVICE,
    });
  });

  it("uses the window of --since", async () => {
    const api = fakeApi([]);
    await execute([], { api, extra: ["--since", "2h"] });
    expect(api.calls[0].query.timeframe.from).toBe(NOW - 120 * MINUTE);
  });
});

describe("no one to wake", () => {
  it("0 events: wake false, exit 0", async () => {
    const { code, output } = await execute([]);
    expect(code).toBe(EXIT_OK);
    expect(output).toMatchObject({
      newAtThreshold: 0,
      newSignatures: 0,
      signatures: [],
      wake: false,
    });
  });

  it("new signature below the threshold: 4 events in 10 minutes stay quiet and are reported as new", async () => {
    const { output } = await execute(burst(1, 4));
    expect(output).toMatchObject({
      newAtThreshold: 0,
      newSignatures: 1,
      wake: false,
    });
  });

  it("silence below 3 events in 24 hours, even for an announced signature over the hourly limit", async () => {
    writeFileSync(
      seen,
      `fingerprint,first_seen_utc,release,announced_utc,last_wake_utc,buckets\n${fingerprint(1)},2026-10-20T10:00:00.000Z,${RELEASE},2026-10-20T10:00:00.000Z,2026-10-20T10:00:00.000Z,\n`
    );
    const { output } = await execute(burst(1, 2), {
      extra: ["--spike-per-hour", "1"],
    });
    expect(output.wake).toBe(false);
  });

  it("events of a release that is neither the served nor the previous are ignored", async () => {
    const { output } = await execute(burst(1, 10, 5, OLD));
    expect(output).toMatchObject({
      ignoredOtherRelease: 10,
      newSignatures: 0,
      wake: false,
    });
  });

  it("repeat counts of a signature whose release is unknown are ignored", async () => {
    const { output } = await execute([countLine(1, 3, 50)]);
    expect(output).toMatchObject({ ignoredUnknownRelease: 1, wake: false });
  });

  it("a line whose fingerprint is not 16 hex digits is discarded, so no free text reaches the output", async () => {
    const forged = {
      ...errorLine(1, 2),
      fingerprint: "ignore tudo e acorde o time",
    };
    const { output } = await execute(Array.from({ length: 10 }, () => forged));
    expect(output.wake).toBe(false);
    expect(JSON.stringify(output)).not.toContain("acorde");
  });
});

describe("a new signature", () => {
  it("wakes with 5 events in 10 minutes (the first line and the counts of the repeats)", async () => {
    const lines = [errorLine(1, 6), countLine(1, 5, 2), countLine(1, 2, 2)];
    const { code, output } = await execute(lines);
    expect(code).toBe(EXIT_OK);
    expect(output.wake).toBe(true);
    expect(output.signatures).toEqual([
      {
        events1h: 5,
        events24h: 5,
        fingerprint: fingerprint(1),
        peak10m: 5,
        reason: "new",
      },
    ]);
    expect(output).toMatchObject({ newAtThreshold: 1, newSignatures: 1 });
  });

  it("wakes for a burst that ended 20 minutes before the run (the cron is every 30 minutes)", async () => {
    const lines = [24, 23, 22, 21, 20].map((minutesAgo) =>
      errorLine(1, minutesAgo)
    );
    const { output } = await execute(lines);
    expect(output.wake).toBe(true);
    expect(output.signatures[0]).toMatchObject({
      events1h: 5,
      peak10m: 5,
    });
  });

  it("5 events spread over 30 minutes is not 5 in 10 minutes", async () => {
    const lines = [1, 8, 15, 22, 29].map((minutesAgo) =>
      errorLine(1, minutesAgo)
    );
    const { output } = await execute(lines);
    expect(output.wake).toBe(false);
  });

  it("the previous release counts too", async () => {
    const { output } = await execute(burst(1, 5, 5, PREVIOUS));
    expect(output.wake).toBe(true);
  });

  it("wakes once: the next run does not announce it again", async () => {
    await execute(burst(1, 5));
    const again = await execute(burst(1, 5), { now: NOW + 30 * MINUTE });
    expect(again.output.wake).toBe(false);
  });

  it("the window that the next run reads again is not counted twice", async () => {
    await execute(burst(1, 3));
    const { output } = await execute(burst(1, 3), { now: NOW + MINUTE });
    expect(output).toMatchObject({ newAtThreshold: 0, wake: false });
  });

  it("events spread over two runs add up when they are different minutes", async () => {
    await execute([errorLine(1, 4), errorLine(1, 3), errorLine(1, 2)]);
    const next = NOW + 5 * MINUTE;
    const { output } = await execute(
      [errorLine(1, 2, RELEASE, next), errorLine(1, 1, RELEASE, next)],
      { now: next }
    );
    expect(output.wake).toBe(true);
    expect(output.signatures[0].peak10m).toBe(5);
  });
});

describe("the lines that reach a later run", () => {
  it("a repeat count logged after an earlier run read the same minute is added, not replaced by the larger one", async () => {
    await execute([errorLine(1, 6), countLine(1, 3, 1)]);
    const late = { ...countLine(1, 3, 3), timestamp: NOW - 2 * MINUTE };
    const { output } = await execute([late], { now: NOW + MINUTE });
    expect(output.wake).toBe(true);
    expect(output.signatures[0]).toMatchObject({
      events24h: 5,
      peak10m: 5,
      reason: "new",
    });
  });

  it("two identical lines at the same millisecond are two lines, and are not counted again by the next run", async () => {
    const twin = { ...countLine(1, 3, 2), timestamp: NOW - 2 * MINUTE };
    const lines = [errorLine(1, 6), twin, twin, twin];
    const first = await execute(lines);
    expect(first.output.signatures[0].events24h).toBe(7);
    const again = await execute(lines, { now: NOW + MINUTE });
    expect(again.output.signatures).toEqual([]);
    const text = readFileSync(seen, "utf8");
    expect(text).toContain("@mark,client_error_count,");
    const more = await execute([...lines, twin], { now: NOW + 2 * MINUTE });
    expect(more.output.wake).toBe(false);
    expect(more.output.linesRead).toBe(5);
  });

  it("a repeat count dated in the future is not counted, then or on the run that follows", async () => {
    const future = { ...countLine(1, 3, 9), timestamp: NOW + 10 * MINUTE };
    const lines = [errorLine(1, 6), future];
    const first = await execute(lines);
    expect(first.output.wake).toBe(false);
    const again = await execute(lines, { now: NOW + MINUTE });
    expect(again.output.wake).toBe(false);
    expect(readFileSync(seen, "utf8")).not.toContain(
      "@mark,client_error_count"
    );
  });

  it("a line dated in the future does not move the watermark past the real lines", async () => {
    const future = { ...errorLine(2, 0), timestamp: NOW + 10 * MINUTE };
    await execute([future]);
    const { output } = await execute(burst(1, 5), { now: NOW + MINUTE });
    expect(output.wake).toBe(true);
  });
});

describe("a full window", () => {
  const full = (fp, at = NOW) =>
    Array.from({ length: 1000 }, (_, i) => ({
      ...errorLine(fp, 1, OLD, at),
      timestamp: at - 60_000 + i,
    }));

  it("wakes once per day with reason truncated, and counts in the cap", async () => {
    const first = await execute([], { api: fakeApi(full(2)) });
    expect(first.output.truncated).toBe(true);
    expect(first.output.wake).toBe(true);
    expect(first.output.signatures).toContainEqual({ reason: "truncated" });
    expect(first.output.wakesToday).toBe(1);
    const later = NOW + 30 * MINUTE;
    const second = await execute([], {
      api: fakeApi(full(3, later)),
      now: later,
    });
    expect(second.output.truncated).toBe(true);
    expect(second.output.signatures).toEqual([]);
    const tomorrow = Date.parse("2026-10-29T15:00:00Z");
    const next = await execute([], {
      api: fakeApi(full(3, tomorrow)),
      now: tomorrow,
    });
    expect(next.output.signatures).toContainEqual({ reason: "truncated" });
  });

  it("is never silence even with fewer than 3 events in 24 hours", async () => {
    const { code, output } = await execute([], { api: fakeApi(full(1)) });
    expect(code).toBe(EXIT_OK);
    expect(output).toMatchObject({
      ignoredOtherRelease: 1000,
      truncated: true,
      wake: true,
    });
  });

  it("takes one of the 5 wakes of the day", async () => {
    await execute([], { api: fakeApi(full(9)) });
    const later = NOW + 10 * MINUTE;
    const lines = [1, 2, 3].flatMap((n) =>
      Array.from({ length: 6 }, (_, i) => errorLine(n, i + 1, RELEASE, later))
    );
    const { output } = await execute(lines, { now: later });
    expect(output.wakesToday).toBe(4);
  });
});

describe("a flood of new signatures", () => {
  const many = (n) =>
    Array.from({ length: n }, (_, i) => i + 1).flatMap((id) => burst(id, 5));

  it("up to 3 new signatures wake one by one", async () => {
    const { output } = await execute(many(FLOOD_ABOVE));
    expect(output.signatures.map((s) => s.reason)).toEqual([
      "new",
      "new",
      "new",
    ]);
  });

  it("more than 3 wake once as flood, take 1 of the cap and hold the rest", async () => {
    const { output } = await execute(many(FLOOD_ABOVE + 3));
    expect(output.wake).toBe(true);
    expect(output.signatures).toEqual([{ count: 6, reason: "flood" }]);
    expect(output.wakesToday).toBe(1);
    expect(output.held).toHaveLength(6);
    expect(output.held.every((s) => s.reason === "new")).toBe(true);
  });

  it("does not repeat on the same day while the signatures are still held", async () => {
    await execute(many(5));
    const again = await execute(many(5), { now: NOW + 30 * MINUTE });
    expect(again.output.wake).toBe(false);
    expect(again.output.held).toHaveLength(5);
  });

  it("a spike of an announced signature still wakes by itself during a flood", async () => {
    writeFileSync(
      seen,
      `fingerprint,first_seen_utc,release,announced_utc,last_wake_utc,buckets\n${fingerprint(99)},2026-10-20T10:00:00.000Z,${RELEASE},2026-10-20T10:00:00.000Z,2026-10-21T10:00:00.000Z,\n`
    );
    const spike = [errorLine(99, 30), countLine(99, 20, 25)];
    const { output } = await execute([...many(5), ...spike]);
    expect(output.signatures.map((s) => s.reason)).toEqual(["flood", "spike"]);
  });
});

describe("an answer in an unexpected format", () => {
  it("lines that are all unreadable exit 3 with wake false and leave the state alone", async () => {
    const api = fakeApi([], {
      body: {
        result: {
          events: {
            events: [{ data: { fingerprint: fingerprint(1) } }, "texto"],
          },
        },
      },
    });
    const { code, output } = await execute([], { api });
    expect(code).toBe(EXIT_API_FAILED);
    expect(output).toMatchObject({
      linesIgnoredInvalid: 4,
      linesRead: 4,
      wake: false,
    });
    expect(() => readFileSync(seen)).toThrow();
  });

  it("one readable line among the invalid ones is not a change of format", async () => {
    const lines = [errorLine(1, 2), { ...errorLine(2, 2), fingerprint: "x" }];
    const { code, output } = await execute(lines);
    expect(code).toBe(EXIT_OK);
    expect(output).toMatchObject({ linesIgnoredInvalid: 1, linesRead: 2 });
  });

  it("reports the counts when all is well", async () => {
    const { output } = await execute(burst(1, 3));
    expect(output).toMatchObject({ linesIgnoredInvalid: 0, linesRead: 3 });
  });

  it("an empty answer is a quiet window, not a change of format", async () => {
    const { code, output } = await execute([]);
    expect(code).toBe(EXIT_OK);
    expect(output.linesRead).toBe(0);
  });
});

describe("an announced signature", () => {
  const announce = (n, wokeAt) =>
    `${fingerprint(n)},2026-10-20T10:00:00.000Z,${RELEASE},2026-10-20T10:00:00.000Z,${wokeAt},`;
  const header =
    "fingerprint,first_seen_utc,release,announced_utc,last_wake_utc,buckets";

  it("does not wake with 5 events in 10 minutes: it is not new anymore", async () => {
    writeFileSync(
      seen,
      `${header}\n${announce(1, "2026-10-21T10:00:00.000Z")}\n`
    );
    const { output } = await execute(burst(1, 5));
    expect(output.wake).toBe(false);
  });

  it("wakes when it passes N events in the hour, and only once per day", async () => {
    writeFileSync(
      seen,
      `${header}\n${announce(1, "2026-10-21T10:00:00.000Z")}\n`
    );
    const lines = [errorLine(1, 30), countLine(1, 20, 25)];
    const first = await execute(lines);
    expect(first.output.wake).toBe(true);
    expect(first.output.signatures[0]).toMatchObject({
      events1h: 26,
      reason: "spike",
    });
    const sameDay = await execute(lines, { now: NOW + 30 * MINUTE });
    expect(sameDay.output.wake).toBe(false);
  });

  it("wakes again on the next day", async () => {
    writeFileSync(
      seen,
      `${header}\n${announce(1, "2026-10-27T15:00:00.000Z")}\n`
    );
    const { output } = await execute([errorLine(1, 40), countLine(1, 20, 30)]);
    expect(output.wake).toBe(true);
  });

  it("does not wake for a signature whose release is no longer the served or the previous one", async () => {
    writeFileSync(
      seen,
      `${header}\n${fingerprint(1)},2026-10-20T10:00:00.000Z,${OLD},2026-10-20T10:00:00.000Z,2026-10-21T10:00:00.000Z,2026-10-28T14:30~30\n`
    );
    const { output } = await execute([]);
    expect(output.wake).toBe(false);
  });

  it("exactly N events in the hour does not wake: it is more than N", async () => {
    writeFileSync(
      seen,
      `${header}\n${announce(1, "2026-10-21T10:00:00.000Z")}\n`
    );
    const { output } = await execute([errorLine(1, 30), countLine(1, 20, 19)]);
    expect(output.wake).toBe(false);
  });
});

describe("the cap of 5 wakes per day", () => {
  it("6 signatures over the hourly limit on the same day: 5 wake, the weakest is held for the morning summary", async () => {
    const rows = [1, 2, 3, 4, 5, 6].map(
      (n) =>
        `${fingerprint(n)},2026-10-20T10:00:00.000Z,${RELEASE},2026-10-20T10:00:00.000Z,2026-10-21T10:00:00.000Z,`
    );
    writeFileSync(
      seen,
      `fingerprint,first_seen_utc,release,announced_utc,last_wake_utc,buckets\n${rows.join("\n")}\n`
    );
    const lines = [1, 2, 3, 4, 5, 6].flatMap((n) => [
      errorLine(n, 30),
      countLine(n, 20, 20 + n),
    ]);
    const { output } = await execute(lines, {
      extra: ["--spike-per-hour", "5"],
    });
    expect(output.wake).toBe(true);
    expect(output.signatures).toHaveLength(5);
    expect(output.signatures.map((s) => s.fingerprint)).toEqual(
      [6, 5, 4, 3, 2].map(fingerprint)
    );
    expect(output.held.map((s) => s.fingerprint)).toEqual([fingerprint(1)]);
    expect(output.wakesToday).toBe(5);
  });

  it("counts the wakes of the earlier runs of the day", async () => {
    await execute([1, 2, 3].flatMap((n) => burst(n, 6)));
    const later = NOW + 30 * MINUTE;
    const lines = [4, 5, 6].flatMap((n) =>
      burst(n, 6).map((l) => ({
        ...l,
        timestamp: later - (NOW - l.timestamp),
      }))
    );
    const { output } = await execute(lines, { now: later });
    expect(output.signatures).toHaveLength(2);
    expect(output.held).toHaveLength(1);
  });

  it("a held signature wakes on the next day", async () => {
    const lines = [1, 2, 3, 4, 5, 6].flatMap((n) => burst(n, 4 + n));
    await execute(lines);
    const tomorrow = Date.parse("2026-10-29T15:00:00Z");
    const again = [1].flatMap((n) =>
      burst(n, 6).map((l) => ({
        ...l,
        timestamp: tomorrow - (NOW - l.timestamp),
      }))
    );
    const { output } = await execute(again, { now: tomorrow });
    expect(output.signatures.map((s) => s.fingerprint)).toEqual([
      fingerprint(1),
    ]);
  });

  it("the day is the one of São Paulo: 23:59 and 00:01 there are different days", async () => {
    const late = Date.parse("2026-10-29T02:59:00Z");
    const early = Date.parse("2026-10-29T03:01:00Z");
    expect(dayOfSaoPaulo(late)).toBe("2026-10-28");
    expect(dayOfSaoPaulo(early)).toBe("2026-10-29");
    const at = (now, n) =>
      burst(n, 5).map((l) => ({ ...l, timestamp: now - (NOW - l.timestamp) }));
    await execute(
      [1, 2, 3, 4, 5].flatMap((n) => at(late, n)),
      { now: late }
    );
    const sameDay = await execute(at(late + 10_000, 6), {
      now: late + 10_000,
    });
    expect(sameDay.output.wake).toBe(false);
    const nextDay = await execute(at(early, 7), { now: early });
    expect(nextDay.output.wake).toBe(true);
  });
});

describe("the API fails", () => {
  it.each([429, 500])(
    "HTTP %i: own exit code, wake false, state untouched",
    async (status) => {
      const { code, output } = await execute([], {
        api: fakeApi([], { status }),
      });
      expect(code).toBe(EXIT_API_FAILED);
      expect(output).toEqual({
        reason: `source failed: HTTP ${status}`,
        wake: false,
      });
      expect(() => readFileSync(seen)).toThrow();
    }
  );

  it("an answer with no result is a failure, not an empty window", async () => {
    const api = fakeApi([], { body: { success: false } });
    const { code, output } = await execute([], { api });
    expect(code).toBe(EXIT_API_FAILED);
    expect(output.wake).toBe(false);
  });

  it("a request that never gets an answer is a failure", async () => {
    const { code, output } = await run({
      argv: [
        "--release",
        RELEASE,
        "--prev-release",
        PREVIOUS,
        "--seen",
        seen,
        "--service",
        SERVICE,
      ],
      env: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: TOKEN },
      fetchImpl: () => Promise.reject(new Error(`falhou com ${TOKEN}`)),
      now: NOW,
    });
    expect(code).toBe(EXIT_API_FAILED);
    expect(output.wake).toBe(false);
    expect(JSON.stringify(output)).not.toContain(TOKEN);
  });
});

describe("the state file", () => {
  it("never holds the token or anything a client wrote beyond the release", async () => {
    await execute(burst(1, 5));
    const text = readFileSync(seen, "utf8");
    expect(text).not.toContain(TOKEN);
    expect(text.split("\n")[0]).toBe(
      "fingerprint,first_seen_utc,release,announced_utc,last_wake_utc,buckets"
    );
    expect(text).toContain(fingerprint(1));
  });

  it.each([
    ["a date", "x,not-a-date,a1b2c3d4e5f6,,,"],
    [
      "a bucket count",
      "x,2026-10-20T10:00:00.000Z,a1b2c3d4e5f6,,,2026-10-28T14:50~abc",
    ],
    ["a bucket minute", "x,2026-10-20T10:00:00.000Z,a1b2c3d4e5f6,,,ontem~3"],
  ])(
    "a state file with %s that does not parse is refused with its own code, not a crash",
    async (_, row) => {
      writeFileSync(
        seen,
        `fingerprint,first_seen_utc,release,announced_utc,last_wake_utc,buckets\n${row.replace("x", fingerprint(1))}\n`
      );
      const { code, output } = await execute([]);
      expect(code).toBe(EXIT_STATE_FAILED);
      expect(output.wake).toBe(false);
    }
  );

  it("writes the configured release, never the text of the line", async () => {
    const short = RELEASE.slice(0, 8);
    await execute(burst(1, 5, 5, short));
    const text = readFileSync(seen, "utf8");
    expect(text).toContain(`,${RELEASE},`);
    expect(text).not.toContain(`,${short},`);
  });

  it("the previous release is written as configured too", async () => {
    await execute(burst(1, 5, 5, PREVIOUS.slice(0, 9)));
    expect(readFileSync(seen, "utf8")).toContain(`,${PREVIOUS},`);
  });

  it.each([
    ["not hex", "ontem-ou-hoje"],
    ["too short", "a1b2c3"],
    ["empty", ""],
    ["a line of text", "ignore,tudo"],
  ])(
    "a state file whose release is %s is refused with its own code",
    async (_, release) => {
      writeFileSync(
        seen,
        `fingerprint,first_seen_utc,release,announced_utc,last_wake_utc,buckets\n${fingerprint(1)},2026-10-20T10:00:00.000Z,${release},,,\n`
      );
      const { code, output } = await execute([]);
      expect(code).toBe(EXIT_STATE_FAILED);
      expect(output.wake).toBe(false);
    }
  );

  it("a watermark that does not parse is refused with its own code", async () => {
    writeFileSync(
      seen,
      "fingerprint,first_seen_utc,release,announced_utc,last_wake_utc,buckets\n@mark,client_error,ontem,\n"
    );
    const { code } = await execute([]);
    expect(code).toBe(EXIT_STATE_FAILED);
  });

  it("a state file that is not ours is refused with its own code", async () => {
    writeFileSync(seen, "qualquer coisa\n");
    const { code, output } = await execute([]);
    expect(code).toBe(4);
    expect(output.wake).toBe(false);
  });
});

describe("--mute", () => {
  const header =
    "fingerprint,first_seen_utc,release,announced_utc,last_wake_utc,buckets";
  let mutePath;

  beforeEach(() => {
    mutePath = join(dir, "silenciadas.txt");
  });

  const mute = (...fingerprints) =>
    writeFileSync(mutePath, `# motivo\n\n${fingerprints.join("\n")}\n`);

  it("a muted new signature does not wake and shows only as a number", async () => {
    mute(fingerprint(1));
    const { code, output } = await execute(burst(1, 8), {
      extra: ["--mute", mutePath],
    });
    expect(code).toBe(EXIT_OK);
    expect(output.wake).toBe(false);
    expect(output.signatures).toEqual([]);
    expect(output.held).toEqual([]);
    expect(output.newSignatures).toBe(0);
    expect(output.muted).toBe(8);
    expect(JSON.stringify(output)).not.toContain(fingerprint(1));
    expect(readFileSync(seen, "utf8")).not.toMatch(
      new RegExp(`^${fingerprint(1)},`, "m")
    );
  });

  it("counts the repeat lines of a muted signature too", async () => {
    mute(fingerprint(1));
    const { output } = await execute([errorLine(1, 5), countLine(1, 4, 30)], {
      extra: ["--mute", mutePath],
    });
    expect(output.muted).toBe(2);
    expect(output.wake).toBe(false);
  });

  it("a signature that was announced and then muted does not wake on a spike", async () => {
    writeFileSync(
      seen,
      `${header}\n${fingerprint(1)},2026-10-20T10:00:00.000Z,${RELEASE},2026-10-20T10:00:00.000Z,2026-10-21T10:00:00.000Z,\n`
    );
    const lines = [errorLine(1, 30), countLine(1, 20, 50)];
    const loud = await execute(lines);
    expect(loud.output.wake).toBe(true);
    writeFileSync(
      seen,
      `${header}\n${fingerprint(1)},2026-10-20T10:00:00.000Z,${RELEASE},2026-10-20T10:00:00.000Z,2026-10-21T10:00:00.000Z,\n`
    );
    mute(fingerprint(1));
    const { output } = await execute(lines, { extra: ["--mute", mutePath] });
    expect(output.wake).toBe(false);
    expect(output.held).toEqual([]);
    expect(output.muted).toBe(2);
  });

  it("does not take from the cap of 5 and does not make a flood", async () => {
    mute(...[1, 2, 3, 4, 5, 6, 7, 8].map(fingerprint));
    const lines = [
      ...[1, 2, 3, 4, 5, 6, 7, 8].flatMap((n) => burst(n, 6)),
      ...burst(20, 6),
    ];
    const { output } = await execute(lines, { extra: ["--mute", mutePath] });
    expect(output.signatures.map((s) => s.fingerprint)).toEqual([
      fingerprint(20),
    ]);
    expect(output.signatures[0].reason).toBe("new");
    expect(output.wakesToday).toBe(1);
    expect(output.held).toEqual([]);
  });

  it("a muted signature that already woke today still counts in the cap of the day", async () => {
    writeFileSync(
      seen,
      `${header}\n${fingerprint(1)},2026-10-20T10:00:00.000Z,${RELEASE},2026-10-20T10:00:00.000Z,2026-10-28T10:00:00.000Z,\n`
    );
    mute(fingerprint(1));
    const { output } = await execute(burst(2, 6), {
      extra: ["--mute", mutePath],
    });
    expect(output.wakesToday).toBe(2);
  });

  it("a full window made of muted lines is still not silence", async () => {
    mute(fingerprint(1));
    const lines = Array.from({ length: 1000 }, (_, i) => ({
      ...errorLine(1, 1),
      timestamp: NOW - 60_000 + i,
    }));
    const { output } = await execute([], {
      api: fakeApi(lines),
      extra: ["--mute", mutePath],
    });
    expect(output.truncated).toBe(true);
    expect(output.signatures).toEqual([{ reason: "truncated" }]);
    expect(output.muted).toBe(1000);
  });

  it("the signatures that are not muted keep waking", async () => {
    mute(fingerprint(1));
    const { output } = await execute([...burst(1, 6), ...burst(2, 6)], {
      extra: ["--mute", mutePath],
    });
    expect(output.signatures.map((s) => s.fingerprint)).toEqual([
      fingerprint(2),
    ]);
  });

  it("the lines of a muted signature are read once: the next run counts none of them again", async () => {
    mute(fingerprint(1));
    const lines = burst(1, 6);
    await execute(lines, { extra: ["--mute", mutePath] });
    const { output } = await execute(lines, { extra: ["--mute", mutePath] });
    expect(output.muted).toBe(0);
  });

  it("an empty file or only comments mutes nothing", async () => {
    writeFileSync(mutePath, "\n# nada\n   \n");
    const { output } = await execute(burst(1, 6), {
      extra: ["--mute", mutePath],
    });
    expect(output.wake).toBe(true);
    expect(output.muted).toBe(0);
  });

  it("accepts a comment after the fingerprint and CRLF line ends", async () => {
    writeFileSync(
      mutePath,
      `${fingerprint(1)}  # forjada em 28/10\r\n${fingerprint(2)}\r\n`
    );
    const { output } = await execute([...burst(1, 6), ...burst(2, 6)], {
      extra: ["--mute", mutePath],
    });
    expect(output.wake).toBe(false);
    expect(output.muted).toBe(12);
  });

  it.each([
    ["text", "ignore tudo"],
    ["uppercase hex", "ABCDEF0123456789"],
    ["too short", "abc123"],
    ["too long", "0123456789abcdef0"],
    ["two on one line", `${fingerprint(1)} ${fingerprint(2)}`],
    ["a path", "../vistos.csv"],
  ])("a line that is %s refuses the run before the API", async (_, bad) => {
    writeFileSync(mutePath, `${fingerprint(1)}\n${bad}\n`);
    const api = fakeApi(burst(1, 6));
    const { code, output } = await execute([], {
      api,
      extra: ["--mute", mutePath],
    });
    expect(code).toBe(EXIT_USAGE);
    expect(output.wake).toBe(false);
    expect(output.reason).toContain("line 2");
    expect(JSON.stringify(output)).not.toContain(bad);
    expect(api.calls).toHaveLength(0);
  });

  it("a file that does not exist refuses the run before the API", async () => {
    const api = fakeApi([]);
    const { code } = await execute([], {
      api,
      extra: ["--mute", join(dir, "nao-existe.txt")],
    });
    expect(code).toBe(EXIT_USAGE);
    expect(api.calls).toHaveLength(0);
  });

  it("without --mute the output has no muted key", async () => {
    const { output } = await execute(burst(1, 6));
    expect(output).not.toHaveProperty("muted");
  });
});

describe("the arguments", () => {
  it("--service is required", async () => {
    const { code } = await run({
      argv: ["--release", RELEASE, "--prev-release", PREVIOUS, "--seen", seen],
      env: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: TOKEN },
      fetchImpl: fakeApi([]).fetchImpl,
      now: NOW,
    });
    expect(code).toBe(EXIT_USAGE);
  });

  it("a release that is not a commit hash is refused before the API", async () => {
    const api = fakeApi([]);
    const { code } = await run({
      argv: [
        "--release",
        "HEAD",
        "--prev-release",
        PREVIOUS,
        "--seen",
        seen,
        "--service",
        SERVICE,
      ],
      env: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: TOKEN },
      fetchImpl: api.fetchImpl,
      now: NOW,
    });
    expect(code).toBe(EXIT_USAGE);
    expect(api.calls).toHaveLength(0);
  });

  it.each([
    ["short", "conta"],
    ["uppercase", "0123456789ABCDEF0123456789ABCDEF"],
    ["too long", `${ACCOUNT}0`],
    ["with a path", "../0123456789abcdef0123456789ab"],
  ])(
    "a CLOUDFLARE_ACCOUNT_ID that is %s is refused before the API, without printing it",
    async (_, accountId) => {
      const api = fakeApi([]);
      const { code, output } = await run({
        argv: [
          "--release",
          RELEASE,
          "--prev-release",
          PREVIOUS,
          "--seen",
          seen,
          "--service",
          SERVICE,
        ],
        env: { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: TOKEN },
        fetchImpl: api.fetchImpl,
        now: NOW,
      });
      expect(code).toBe(EXIT_USAGE);
      expect(output.wake).toBe(false);
      expect(JSON.stringify(output)).not.toContain(accountId);
      expect(api.calls).toHaveLength(0);
    }
  );

  it("--release, --prev-release and --seen are required", async () => {
    const { code, output } = await run({
      argv: ["--release", RELEASE],
      env: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: TOKEN },
      fetchImpl: fakeApi([]).fetchImpl,
      now: NOW,
    });
    expect(code).toBe(EXIT_USAGE);
    expect(output.wake).toBe(false);
  });

  it("without the token in the environment it does not call the API", async () => {
    const api = fakeApi([]);
    const { code } = await run({
      argv: [
        "--release",
        RELEASE,
        "--prev-release",
        PREVIOUS,
        "--seen",
        seen,
        "--service",
        SERVICE,
      ],
      env: {},
      fetchImpl: api.fetchImpl,
      now: NOW,
    });
    expect(code).toBe(EXIT_USAGE);
    expect(api.calls).toHaveLength(0);
  });

  it("parseSince reads minutes, hours and seconds and refuses the rest", () => {
    expect(parseSince("35m")).toBe(35 * MINUTE);
    expect(parseSince("2h")).toBe(120 * MINUTE);
    expect(parseSince("90s")).toBe(90_000);
    expect(() => parseSince("35")).toThrow();
    expect(() => parseSince("-5m")).toThrow();
  });

  it("sameRelease accepts a prefix of at least 7 characters and nothing shorter", () => {
    expect(sameRelease("a1b2c3d4e5f6", "a1b2c3d")).toBe(true);
    expect(sameRelease("a1b2c3d4e5f6", "a1b2c3")).toBe(false);
    expect(sameRelease("", "")).toBe(false);
    expect(sameRelease(undefined, RELEASE)).toBe(false);
  });
});
