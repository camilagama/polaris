import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * The trigger of the browser error reports, with no LLM (docs/runbooks/erros-do-navegador.md). Written to run from a
 * cron every 30 minutes over a window of 35.
 *
 * The route that writes those lines is public, so whoever controls the body controls the signature: "a new signature
 * wakes" without a limit would be "an attacker wakes". The rules below are that limit:
 * - only the served release and the previous one count (a release is whatever the client said);
 * - a signature never announced wakes with `NEW_MIN_EVENTS` events in `NEW_WINDOW_MINUTES` minutes;
 * - an announced one wakes when it passes `--spike-per-hour` events in the last hour, once per day;
 * - at most `MAX_WAKES_PER_DAY` wakes per day; the rest is held for the morning summary;
 * - fewer than `SILENCE_BELOW` events in 24 hours is silence.
 * The 10-minute, 1-hour and 24-hour counts come from per-minute buckets kept in the state file (`--seen`), because the
 * window of one run is shorter than the counts the rules need. A bucket read again by the next run (the windows
 * overlap) is replaced by the larger value, never added.
 *
 * The token is read-only (Observability) and never printed or written. The output is one JSON line with fingerprints
 * and numbers only, nothing the client wrote. A failure of the API exits with `EXIT_API_FAILED` and `wake: false`: a
 * broken script is not an alert.
 *
 * Usage: node scripts/client-error-sentinel.mjs --release <sha> --prev-release <sha> --seen <csv> [--since 35m]
 *   [--spike-per-hour 20] [--service <worker>] [--now <iso>]
 */

export const EXIT_OK = 0;
export const EXIT_USAGE = 2;
export const EXIT_API_FAILED = 3;
export const EXIT_STATE_FAILED = 4;

export const NEW_MIN_EVENTS = 5;
export const NEW_WINDOW_MINUTES = 10;
export const MAX_WAKES_PER_DAY = 5;
export const SILENCE_BELOW = 3;
export const DEFAULT_SPIKE_PER_HOUR = 20;
export const DEFAULT_SINCE = "35m";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const SAO_PAULO_OFFSET_MS = 3 * HOUR_MS;
const QUERY_LIMIT = 1000;
const REQUEST_TIMEOUT_MS = 20_000;
const MIN_RELEASE_PREFIX = 7;
const FINGERPRINT = /^[0-9a-f]{16}$/;
const SINCE = /^(\d{1,4})([smh])$/;
const OPTION_PREFIX = /^--/;
const STATE_HEADER =
  "fingerprint,first_seen_utc,release,announced_utc,last_wake_utc,buckets";

export class ApiFailure extends Error {}

/** `35m`, `2h` or `90s` in milliseconds; anything else is not a window. */
export function parseSince(text) {
  const match = SINCE.exec(text ?? "");
  if (!match) {
    throw new Error(`--since invalid: ${text}`);
  }
  const unit = { h: HOUR_MS, m: MINUTE_MS, s: 1000 }[match[2]];
  return Number(match[1]) * unit;
}

/** The day of São Paulo (UTC-3, no summer time) that an instant falls in, as `YYYY-MM-DD`. */
export function dayOfSaoPaulo(ms) {
  return new Date(ms - SAO_PAULO_OFFSET_MS).toISOString().slice(0, 10);
}

function minuteKey(ms) {
  return new Date(Math.floor(ms / MINUTE_MS) * MINUTE_MS)
    .toISOString()
    .slice(0, 16);
}

function minuteStart(key) {
  return Date.parse(`${key}:00Z`);
}

/** Two releases are the same build when equal, or when one is a prefix (at least 7 characters) of the other. */
export function sameRelease(a, b) {
  if (typeof a !== "string" || typeof b !== "string") {
    return false;
  }
  if (a === b) {
    return a.length > 0;
  }
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= MIN_RELEASE_PREFIX && long.startsWith(short);
}

export function parseState(text) {
  const state = new Map();
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  if (lines.length === 0) {
    return state;
  }
  if (lines[0] !== STATE_HEADER) {
    throw new Error("state file with an unknown header");
  }
  for (const line of lines.slice(1)) {
    const [fingerprint, firstSeen, release, announced, lastWake, buckets] =
      line.split(",");
    if (!FINGERPRINT.test(fingerprint ?? "")) {
      throw new Error("state file with an invalid fingerprint");
    }
    const map = new Map();
    for (const pair of (buckets ?? "").split("|").filter(Boolean)) {
      const [key, count] = pair.split("~");
      map.set(key, Number(count));
    }
    state.set(fingerprint, {
      announced: announced ?? "",
      buckets: map,
      firstSeen: firstSeen ?? "",
      lastWake: lastWake ?? "",
      release: release ?? "",
    });
  }
  return state;
}

export function serializeState(state) {
  const rows = [...state]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([fingerprint, entry]) => {
      const buckets = [...entry.buckets]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([key, count]) => `${key}~${count}`)
        .join("|");
      return [
        fingerprint,
        entry.firstSeen,
        entry.release,
        entry.announced,
        entry.lastWake,
        buckets,
      ].join(",");
    });
  return `${[STATE_HEADER, ...rows].join("\n")}\n`;
}

function emptyEntry(now) {
  return {
    announced: "",
    buckets: new Map(),
    firstSeen: new Date(now).toISOString(),
    lastWake: "",
    release: "",
  };
}

function toMs(raw) {
  const ms = typeof raw === "number" ? raw : Date.parse(raw ?? "");
  return Number.isFinite(ms) ? ms : null;
}

function sumAfter(buckets, fromMs) {
  let total = 0;
  for (const [key, count] of buckets) {
    if (minuteStart(key) + MINUTE_MS > fromMs) {
      total += count;
    }
  }
  return total;
}

function wokeOn(entry, day) {
  return (
    entry.lastWake !== "" && dayOfSaoPaulo(Date.parse(entry.lastWake)) === day
  );
}

function ingest({ lines, next, now, prevRelease, release }) {
  const allowed = (value) =>
    sameRelease(value, release) || sameRelease(value, prevRelease);
  const inDay = (ms) => ms !== null && ms <= now && now - ms <= DAY_MS;
  const fresh = new Map();
  let ignored = 0;
  const add = (fingerprint, ms, count) => {
    const key = minuteKey(ms);
    const buckets = fresh.get(fingerprint) ?? new Map();
    buckets.set(key, (buckets.get(key) ?? 0) + count);
    fresh.set(fingerprint, buckets);
  };
  const valid = (line, event) =>
    line.event === event && FINGERPRINT.test(line.fields.fingerprint ?? "");

  for (const line of lines.filter((l) => valid(l, "client_error"))) {
    const { fields, timestamp } = line;
    const ms = toMs(timestamp);
    if (!inDay(ms)) {
      continue;
    }
    if (!allowed(fields.release)) {
      ignored += 1;
      continue;
    }
    const entry = next.get(fields.fingerprint) ?? emptyEntry(now);
    entry.release = fields.release;
    next.set(fields.fingerprint, entry);
    add(fields.fingerprint, ms, 1);
  }
  for (const line of lines.filter((l) => valid(l, "client_error_count"))) {
    const { fields, timestamp } = line;
    const { count } = fields;
    const at = toMs(fields.minute) ?? toMs(timestamp);
    if (!(Number.isSafeInteger(count) && count >= 1 && inDay(at))) {
      continue;
    }
    if (allowed(next.get(fields.fingerprint)?.release)) {
      add(fields.fingerprint, at, count);
    } else {
      ignored += 1;
    }
  }
  return { fresh, ignored };
}

function windowsOf(entry, now) {
  return {
    day: sumAfter(entry.buckets, now - DAY_MS),
    hour: sumAfter(entry.buckets, now - HOUR_MS),
    recent: sumAfter(entry.buckets, now - NEW_WINDOW_MINUTES * MINUTE_MS),
  };
}

function candidatesOf({ counts, next, spikePerHour, today }) {
  const candidates = [];
  for (const [fingerprint, entry] of next) {
    const window = counts.get(fingerprint);
    if (window.day < SILENCE_BELOW) {
      continue;
    }
    if (entry.announced === "") {
      if (window.recent >= NEW_MIN_EVENTS) {
        candidates.push({ fingerprint, reason: "new", weight: window.recent });
      }
    } else if (window.hour > spikePerHour && !wokeOn(entry, today)) {
      candidates.push({ fingerprint, reason: "spike", weight: window.hour });
    }
  }
  return candidates.sort(
    (a, b) => b.weight - a.weight || (a.fingerprint < b.fingerprint ? -1 : 1)
  );
}

/**
 * One run of the rules over the lines of the window and the state of the previous runs: the verdict and the state
 * to write. Pure: the clock comes in `now`.
 *
 * `lines` are `{ event, timestamp, fields }`; only `client_error` (one event, carries `release`) and
 * `client_error_count` (repeats, no release: it takes the one its signature was seen with) are read.
 */
export function evaluate({
  lines,
  now,
  prevRelease,
  release,
  spikePerHour = DEFAULT_SPIKE_PER_HOUR,
  state,
}) {
  const nowIso = new Date(now).toISOString();
  const next = new Map(
    [...state].map(([fingerprint, entry]) => [
      fingerprint,
      { ...entry, buckets: new Map(entry.buckets) },
    ])
  );
  const { fresh, ignored } = ingest({ lines, next, now, prevRelease, release });
  for (const [fingerprint, buckets] of fresh) {
    const entry = next.get(fingerprint);
    for (const [key, count] of buckets) {
      entry.buckets.set(key, Math.max(entry.buckets.get(key) ?? 0, count));
    }
  }

  const today = dayOfSaoPaulo(now);
  const counts = new Map();
  let wokeToday = 0;
  for (const [fingerprint, entry] of next) {
    for (const key of entry.buckets.keys()) {
      if (minuteStart(key) + MINUTE_MS <= now - DAY_MS) {
        entry.buckets.delete(key);
      }
    }
    if (entry.buckets.size === 0 && entry.announced === "") {
      next.delete(fingerprint);
      continue;
    }
    wokeToday += wokeOn(entry, today) ? 1 : 0;
    counts.set(fingerprint, windowsOf(entry, now));
  }
  const newSignatures = [...fresh.keys()].filter(
    (fingerprint) => next.get(fingerprint)?.announced === ""
  );

  const candidates = candidatesOf({ counts, next, spikePerHour, today });
  const room = Math.max(0, MAX_WAKES_PER_DAY - wokeToday);
  const woken = candidates.slice(0, room);
  for (const { fingerprint } of woken) {
    const entry = next.get(fingerprint);
    entry.announced = entry.announced || nowIso;
    entry.lastWake = nowIso;
  }

  const describe = ({ fingerprint, reason }) => ({
    events1h: counts.get(fingerprint).hour,
    events10m: counts.get(fingerprint).recent,
    events24h: counts.get(fingerprint).day,
    fingerprint,
    reason,
  });
  return {
    result: {
      held: candidates.slice(room).map(describe),
      ignoredOtherRelease: ignored,
      newAtThreshold: newSignatures.filter(
        (fingerprint) => counts.get(fingerprint).recent >= NEW_MIN_EVENTS
      ).length,
      newSignatures: newSignatures.length,
      signatures: woken.map(describe),
      wake: woken.length > 0,
      wakesToday: wokeToday + woken.length,
    },
    state: next,
  };
}

/** The lines of one event name in the window, as the telemetry API answers them; throws `ApiFailure` otherwise. */
export async function fetchLines({
  accountId,
  eventName,
  fetchImpl = fetch,
  from,
  service,
  to,
  token,
}) {
  const filters = [
    { key: "event", operation: "eq", type: "string", value: eventName },
  ];
  if (service) {
    filters.push({
      key: "$metadata.service",
      operation: "eq",
      type: "string",
      value: service,
    });
  }
  let response;
  try {
    response = await fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/observability/telemetry/query`,
      {
        body: JSON.stringify({
          limit: QUERY_LIMIT,
          parameters: { filterCombination: "and", filters },
          queryId: `client-error-sentinel-${eventName}`,
          timeframe: { from, to },
          view: "events",
        }),
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        method: "POST",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }
    );
  } catch (error) {
    throw new ApiFailure("request failed", { cause: error });
  }
  if (response.status < 200 || response.status > 299) {
    throw new ApiFailure(`HTTP ${response.status}`);
  }
  let body;
  try {
    body = await response.json();
  } catch (error) {
    throw new ApiFailure("response is not JSON", { cause: error });
  }
  const events = body?.result?.events?.events;
  if (!Array.isArray(events)) {
    throw new ApiFailure("response without result.events.events");
  }
  return {
    lines: events.map((event) => {
      const fields =
        event?.source && typeof event.source === "object"
          ? event.source
          : (event ?? {});
      return {
        event: eventName,
        fields,
        timestamp: event?.timestamp ?? fields.timestamp,
      };
    }),
    truncated: events.length >= QUERY_LIMIT,
  };
}

export function parseArgs(argv) {
  const args = {};
  const names = new Set([
    "now",
    "prev-release",
    "release",
    "seen",
    "service",
    "since",
    "spike-per-hour",
  ]);
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i]?.replace(OPTION_PREFIX, "");
    if (
      !(argv[i]?.startsWith("--") && names.has(name)) ||
      argv[i + 1] === undefined
    ) {
      throw new Error(`argument invalid: ${argv[i]}`);
    }
    args[name] = argv[i + 1];
  }
  for (const required of ["release", "prev-release", "seen"]) {
    if (!args[required]) {
      throw new Error(`--${required} is required`);
    }
  }
  return args;
}

function readState(path) {
  try {
    return parseState(readFileSync(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return new Map();
    }
    throw error;
  }
}

function writeState(path, state) {
  const temp = `${path}.tmp`;
  writeFileSync(temp, serializeState(state));
  renameSync(temp, path);
}

const failure = (code, reason) => ({
  code,
  output: { reason, wake: false },
});

/** The whole run; returns the JSON to print and the exit code. Does not touch the state file when it fails. */
export async function run({ argv, env, fetchImpl = fetch, now = Date.now() }) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    return failure(EXIT_USAGE, error.message);
  }
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const token = env.CLOUDFLARE_API_TOKEN;
  if (!(accountId && token)) {
    return failure(
      EXIT_USAGE,
      "CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required"
    );
  }
  let sinceMs;
  let spikePerHour = DEFAULT_SPIKE_PER_HOUR;
  let at = now;
  try {
    sinceMs = parseSince(args.since ?? DEFAULT_SINCE);
    if (args["spike-per-hour"] !== undefined) {
      spikePerHour = Number(args["spike-per-hour"]);
      if (!(Number.isInteger(spikePerHour) && spikePerHour > 0)) {
        throw new Error("--spike-per-hour invalid");
      }
    }
    if (args.now !== undefined) {
      at = Date.parse(args.now);
      if (!Number.isFinite(at)) {
        throw new Error("--now invalid");
      }
    }
  } catch (error) {
    return failure(EXIT_USAGE, error.message);
  }

  let state;
  try {
    state = readState(args.seen);
  } catch {
    return failure(EXIT_STATE_FAILED, "state file unreadable");
  }

  const lines = [];
  let truncated = false;
  for (const eventName of ["client_error", "client_error_count"]) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: two queries, one after the other, to stay far from any rate limit
      const page = await fetchLines({
        accountId,
        eventName,
        fetchImpl,
        from: at - sinceMs,
        service: args.service,
        to: at,
        token,
      });
      lines.push(...page.lines);
      truncated ||= page.truncated;
    } catch (error) {
      const reason =
        error instanceof ApiFailure ? error.message : "request failed";
      return failure(EXIT_API_FAILED, `source failed: ${reason}`);
    }
  }

  const { result, state: next } = evaluate({
    lines,
    now: at,
    prevRelease: args["prev-release"],
    release: args.release,
    spikePerHour,
    state,
  });
  try {
    writeState(args.seen, next);
  } catch {
    return failure(EXIT_STATE_FAILED, "state file not written");
  }
  return { code: EXIT_OK, output: { ...result, truncated } };
}

async function main() {
  const { code, output } = await run({
    argv: process.argv.slice(2),
    env: process.env,
  });
  console.log(JSON.stringify(output));
  process.exitCode = code;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
