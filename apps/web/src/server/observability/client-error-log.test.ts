import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLIENT_ERROR_LINES_PER_MINUTE,
  CLIENT_ERROR_SIGNATURE_IDLE_MINUTES,
  CLIENT_ERROR_SIGNATURES_KEPT,
  createClientErrorLog,
} from "./client-error-log";

const MINUTE_MS = 60_000;
const START = Date.UTC(2026, 9, 28, 12, 0, 10);
const FIELDS = { kind: "error", routeId: "home" } as const;

function spyLogs() {
  return {
    error: vi.spyOn(console, "error").mockImplementation(() => undefined),
    info: vi.spyOn(console, "info").mockImplementation(() => undefined),
    log: vi.spyOn(console, "log").mockImplementation(() => undefined),
    warn: vi.spyOn(console, "warn").mockImplementation(() => undefined),
  };
}

function lines(logs: ReturnType<typeof spyLogs>, event?: string) {
  return Object.values(logs)
    .flatMap((spy) =>
      spy.mock.calls.map(([entry]) => entry as Record<string, unknown>)
    )
    .filter((line) => event === undefined || line.event === event);
}

function setup() {
  const logs = spyLogs();
  const clock = { now: START };
  const log = createClientErrorLog(() => clock.now);
  const advance = (minutes = 1) => {
    clock.now += minutes * MINUTE_MS;
  };
  return { advance, log, logs };
}

describe("the log of the reports of errors of the browser", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes the first occurrence of a signature as one client_error line and only counts the repeats", () => {
    const { log, logs } = setup();

    log.accepted("sig-a", FIELDS);
    log.accepted("sig-a", FIELDS);
    log.accepted("sig-a", FIELDS);

    const found = lines(logs);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      event: "client_error",
      kind: "error",
      level: "warn",
      routeId: "home",
    });
  });

  it("emits one client_error_count line with the repeats on the first call after the minute ends", () => {
    const { advance, log, logs } = setup();
    const signature = "0123456789abcdef";
    log.accepted(signature, FIELDS);
    log.accepted(signature, FIELDS);
    log.accepted(signature, FIELDS);
    log.accepted("sig-b", FIELDS);
    expect(lines(logs, "client_error")[0]).toMatchObject({
      fingerprint: signature,
    });

    expect(lines(logs, "client_error_count")).toEqual([]);
    advance();
    log.refused("bad_request");

    const counts = lines(logs, "client_error_count");
    expect(counts).toHaveLength(1);
    expect(counts[0]).toMatchObject({
      count: 2,
      fingerprint: signature,
      level: "info",
      minute: "2026-10-28T12:00:00.000Z",
    });
  });

  it("does not repeat a client_error line for a signature already seen in an earlier minute", () => {
    const { advance, log, logs } = setup();
    log.accepted("sig-a", FIELDS);
    advance();
    log.accepted("sig-a", FIELDS);
    advance();
    log.accepted("sig-a", FIELDS);
    log.accepted("sig-a", FIELDS);

    expect(lines(logs, "client_error")).toHaveLength(1);
    advance();
    log.piiSuspected();
    expect(lines(logs, "client_error_count").map((line) => line.count)).toEqual(
      [1, 2]
    );
  });

  it("writes nothing when the minute ends with nothing to report", () => {
    const { advance, log, logs } = setup();
    log.accepted("sig-a", FIELDS);
    advance(5);
    log.accepted("sig-a", FIELDS);
    advance();
    log.refused("bad_request");

    expect(lines(logs, "client_error_count")).toHaveLength(1);
    expect(lines(logs, "client_error_dropped")).toEqual([]);
    expect(lines(logs, "client_error_pii_suspected")).toEqual([]);
  });

  it("keeps 20 lines a minute: the 21st distinct signature is counted in client_error_dropped the next minute", () => {
    const { advance, log, logs } = setup();

    for (let index = 0; index <= CLIENT_ERROR_LINES_PER_MINUTE; index += 1) {
      log.accepted(`sig-${index}`, FIELDS);
    }

    expect(lines(logs, "client_error")).toHaveLength(20);
    expect(lines(logs, "client_error_dropped")).toEqual([]);
    advance();
    log.refused("bad_request");
    const dropped = lines(logs, "client_error_dropped");
    expect(dropped).toHaveLength(1);
    expect(dropped[0]).toMatchObject({
      count: 1,
      level: "warn",
      minute: "2026-10-28T12:00:00.000Z",
    });
  });

  it("starts the next minute with a new budget of 20 lines", () => {
    const { advance, log, logs } = setup();
    for (let index = 0; index < 25; index += 1) {
      log.accepted(`sig-${index}`, FIELDS);
    }
    advance();
    for (let index = 25; index < 30; index += 1) {
      log.accepted(`sig-${index}`, FIELDS);
    }

    expect(lines(logs, "client_error")).toHaveLength(25);
  });

  it("keeps 200 signatures: the 201st distinct one is dropped even in a later minute", () => {
    const { advance, log, logs } = setup();
    const perMinute = CLIENT_ERROR_LINES_PER_MINUTE;
    const minutes = CLIENT_ERROR_SIGNATURES_KEPT / perMinute;

    for (let minute = 0; minute < minutes; minute += 1) {
      for (let index = 0; index < perMinute; index += 1) {
        log.accepted(`sig-${minute * perMinute + index}`, FIELDS);
      }
      advance();
    }
    expect(lines(logs, "client_error")).toHaveLength(
      CLIENT_ERROR_SIGNATURES_KEPT
    );

    log.accepted("sig-new", FIELDS);
    advance(3);
    log.accepted("sig-new", FIELDS);
    advance();
    log.refused("bad_request");

    expect(lines(logs, "client_error")).toHaveLength(
      CLIENT_ERROR_SIGNATURES_KEPT
    );
    const dropped = lines(logs, "client_error_dropped");
    expect(dropped).toHaveLength(2);
    expect(dropped.map((line) => line.count)).toEqual([1, 1]);
  });

  it("lets an idle signature leave the memory: a table full of false signatures does not hide a new failure for good", () => {
    const { advance, log, logs } = setup();
    const perMinute = CLIENT_ERROR_LINES_PER_MINUTE;
    for (
      let minute = 0;
      minute < CLIENT_ERROR_SIGNATURES_KEPT / perMinute;
      minute += 1
    ) {
      for (let index = 0; index < perMinute; index += 1) {
        log.accepted(`false-${minute * perMinute + index}`, FIELDS);
      }
      advance();
    }
    log.accepted("real", FIELDS);
    expect(lines(logs, "client_error")).toHaveLength(
      CLIENT_ERROR_SIGNATURES_KEPT
    );

    advance(CLIENT_ERROR_SIGNATURE_IDLE_MINUTES + 1);
    log.accepted("real", FIELDS);

    const found = lines(logs, "client_error");
    expect(found).toHaveLength(CLIENT_ERROR_SIGNATURES_KEPT + 1);
    expect(found.at(-1)).toMatchObject({ fingerprint: "real" });
  });

  it("keeps a signature that had a report within the idle window, and logs no first line for it again", () => {
    const { advance, log, logs } = setup();
    log.accepted("kept", FIELDS);
    for (let step = 0; step < 3; step += 1) {
      advance(CLIENT_ERROR_SIGNATURE_IDLE_MINUTES - 1);
      log.accepted("kept", FIELDS);
    }

    expect(lines(logs, "client_error")).toHaveLength(1);
  });

  it("leaves room for a new signature in a minute whose counts would take every line", () => {
    const { advance, log, logs } = setup();
    for (let index = 0; index < CLIENT_ERROR_LINES_PER_MINUTE; index += 1) {
      log.accepted(`sig-${index}`, FIELDS);
      log.accepted(`sig-${index}`, FIELDS);
    }
    advance();
    log.accepted("new", FIELDS);

    expect(lines(logs, "client_error_count").length).toBeLessThan(
      CLIENT_ERROR_LINES_PER_MINUTE
    );
    expect(lines(logs, "client_error").at(-1)).toMatchObject({
      fingerprint: "new",
    });
  });

  it("still counts the repeats of a signature that is kept when the table is full", () => {
    const { advance, log, logs } = setup();
    const perMinute = CLIENT_ERROR_LINES_PER_MINUTE;
    for (let minute = 0; minute < 10; minute += 1) {
      for (let index = 0; index < perMinute; index += 1) {
        log.accepted(`sig-${minute * perMinute + index}`, FIELDS);
      }
      advance();
    }

    log.accepted("sig-0", FIELDS);
    log.accepted("sig-0", FIELDS);
    advance();
    log.refused("bad_request");

    const counts = lines(logs, "client_error_count");
    expect(counts.map((line) => line.count)).toEqual([2]);
    expect(lines(logs, "client_error_dropped")).toEqual([]);
  });

  it("sums the refusals of a minute into one client_error_refused line, by reason", () => {
    const { advance, log, logs } = setup();

    for (let index = 0; index < 3; index += 1) {
      log.refused("rate_limited");
    }
    log.refused("too_large");
    log.refused("unsupported");
    log.refused("unsupported");
    log.refused("bad_request");
    log.refused("limiter_unavailable");

    expect(lines(logs)).toEqual([]);
    advance();
    log.refused("bad_request");

    const refused = lines(logs, "client_error_refused");
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({
      bad_request: 1,
      level: "info",
      limiter_unavailable: 1,
      minute: "2026-10-28T12:00:00.000Z",
      rate_limited: 3,
      too_large: 1,
      unsupported: 2,
    });
    expect(lines(logs)).toHaveLength(1);

    advance();
    log.piiSuspected();
    expect(lines(logs, "client_error_refused")).toHaveLength(2);
    expect(lines(logs, "client_error_refused")[1]).toMatchObject({
      bad_request: 1,
    });
    expect(lines(logs, "client_error_refused")[1]).not.toHaveProperty(
      "rate_limited"
    );
  });

  it("sums the events the redaction net discarded into one client_error_pii_suspected line", () => {
    const { advance, log, logs } = setup();

    log.piiSuspected();
    log.piiSuspected();
    log.piiSuspected();

    expect(lines(logs)).toEqual([]);
    advance();
    log.refused("bad_request");

    const found = lines(logs, "client_error_pii_suspected");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ count: 3, level: "warn" });
  });
});
