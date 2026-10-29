import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * The trigger of the browser error reports, with no LLM (docs/runbooks/erros-do-navegador.md). Written to run from a
 * cron every 30 minutes over a window of 35.
 *
 * The route that writes those lines is public, so whoever controls the body controls the signature: "a new signature
 * wakes" without a limit would be "an attacker wakes". The rules below are that limit, and what is left of it is
 * the cap of wakes per day (the served release is in the public bundle, so the release only drops old builds):
 * - only the served release and the previous one count;
 * - a signature never announced wakes when any `NEW_WINDOW_MINUTES` minutes hold `NEW_MIN_EVENTS` events (the
 *   cron is every 30 minutes, so a burst that ended 20 minutes ago must still wake);
 * - an announced one wakes when it passes `--spike-per-hour` events in the last hour, once per day;
 * - at most `MAX_WAKES_PER_DAY` wakes per day; the rest is held for the morning summary;
 * - fewer than `SILENCE_BELOW` events in 24 hours is silence, except that a full window (`truncated`) is never silence:
 *   it wakes once per day with `reason: "truncated"` and counts in the cap;
 * - more than `FLOOD_ABOVE` signatures never announced and at the threshold (the held ones of earlier runs count) wake
 *   once per day as `reason: "flood"` (one wake of the cap) and the signatures themselves are held.
 * The watermark assumes the log answers in the order of its timestamps: a line that is indexed after a later one was
 * already read is not counted.
 * The 10-minute, 1-hour and 24-hour counts come from per-minute buckets kept in the state file (`--seen`), because the
 * window of one run is shorter than the counts the rules need. The windows of two runs overlap, so each log line is
 * counted once: the state keeps, per event name, a watermark of the log timestamp (and the lines already read at that
 * exact instant), and the counts of the lines past it are added to the buckets. A `client_error_count` line is logged
 * by the next request of the isolate, so it can reach a later run than the minute it counts; adding by line keeps it.
 *
 * The token is read-only (Observability) and never printed or written. The output is one JSON line with fingerprints
 * and numbers only, nothing the client wrote. A failure of the API exits with `EXIT_API_FAILED` and `wake: false`: a
 * broken script is not an alert. An answer whose lines are all unreadable (`linesRead > 0` and every one invalid) is
 * a change of format and exits the same way.
 *
 * `--service` is required: staging and production can serve the same SHA, and each one must wake only for its own
 * Worker.
 *
 * Usage: node scripts/client-error-sentinel.mjs --release <sha> --prev-release <sha> --seen <csv> --service <worker>
 *   [--since 35m] [--spike-per-hour 20] [--now <iso>]
 */

export const EXIT_OK = 0;
export const EXIT_USAGE = 2;
export const EXIT_API_FAILED = 3;
export const EXIT_STATE_FAILED = 4;
export const EXIT_INTERNAL = 5;

export const NEW_MIN_EVENTS = 5;
export const NEW_WINDOW_MINUTES = 10;
export const MAX_WAKES_PER_DAY = 5;
export const SILENCE_BELOW = 3;
export const FLOOD_ABOVE = 3;
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
const RELEASE_SHA = /^[0-9a-f]{7,40}$/;
const TIE_ID = /^[0-9a-f]{16}\.\d{1,9}\.\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const MARK_EVENTS = ["client_error", "client_error_count"];
const SYSTEM_WAKES = ["truncated", "flood"];
const SINCE = /^(\d{1,4})([smh])$/;
const OPTION_PREFIX = /^--/;
const MINUTE_KEY = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
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

function parseBuckets(text) {
  const map = new Map();
  for (const pair of text.split("|").filter(Boolean)) {
    const [key, count] = pair.split("~");
    const valid =
      MINUTE_KEY.test(key) &&
      Number.isFinite(minuteStart(key)) &&
      Number.isSafeInteger(Number(count)) &&
      Number(count) >= 1;
    if (!valid) {
      throw new Error("state file with an invalid bucket");
    }
    map.set(key, Number(count));
  }
  return map;
}

function parseRow(line) {
  const [fingerprint, firstSeen, release, announced, lastWake, buckets] =
    line.split(",");
  if (!FINGERPRINT.test(fingerprint ?? "")) {
    throw new Error("state file with an invalid fingerprint");
  }
  if (!RELEASE_SHA.test(release ?? "")) {
    throw new Error("state file with an invalid release");
  }
  for (const date of [firstSeen, announced, lastWake]) {
    if (date && !Number.isFinite(Date.parse(date))) {
      throw new Error("state file with an invalid date");
    }
  }
  return [
    fingerprint,
    {
      announced: announced ?? "",
      buckets: parseBuckets(buckets ?? ""),
      firstSeen: firstSeen ?? "",
      lastWake: lastWake ?? "",
      release,
    },
  ];
}

function parseTies(text) {
  const ties = new Map();
  for (const pair of text.split("|").filter(Boolean)) {
    const [id, times] = pair.split("~");
    if (!(TIE_ID.test(id) && Number.isSafeInteger(Number(times)))) {
      throw new Error("state file with an invalid watermark");
    }
    ties.set(id, Number(times));
  }
  return ties;
}

function emptyState() {
  const marks = {};
  for (const event of MARK_EVENTS) {
    marks[event] = { at: null, ties: new Map() };
  }
  return {
    entries: new Map(),
    marks,
    wakes: { flood: "", truncated: "" },
  };
}

function parseMeta(line, state) {
  const [tag, name, value, ties] = line.split(",");
  if (tag === "@mark" && MARK_EVENTS.includes(name)) {
    const at = Number(value);
    if (!(Number.isSafeInteger(at) && at > 0)) {
      throw new Error("state file with an invalid watermark");
    }
    state.marks[name] = { at, ties: parseTies(ties ?? "") };
  } else if (
    tag === "@wake" &&
    SYSTEM_WAKES.includes(name) &&
    Number.isFinite(Date.parse(value ?? ""))
  ) {
    state.wakes[name] = value;
  } else {
    throw new Error("state file with an unknown line");
  }
}

export function parseState(text) {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  const state = emptyState();
  if (lines.length === 0) {
    return state;
  }
  if (lines[0] !== STATE_HEADER) {
    throw new Error("state file with an unknown header");
  }
  for (const line of lines.slice(1)) {
    if (line.startsWith("@")) {
      parseMeta(line, state);
    } else {
      const [fingerprint, entry] = parseRow(line);
      state.entries.set(fingerprint, entry);
    }
  }
  return state;
}

export function serializeState(state) {
  const meta = [
    ...MARK_EVENTS.filter((event) => state.marks[event].at !== null).map(
      (event) => {
        const { at, ties } = state.marks[event];
        const text = [...ties].map(([id, times]) => `${id}~${times}`).join("|");
        return `@mark,${event},${at},${text}`;
      }
    ),
    ...SYSTEM_WAKES.filter((name) => state.wakes[name] !== "").map(
      (name) => `@wake,${name},${state.wakes[name]}`
    ),
  ];
  const rows = [...state.entries]
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
  return `${[STATE_HEADER, ...meta, ...rows].join("\n")}\n`;
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
  return Number.isFinite(ms) ? Math.trunc(ms) : null;
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

function wokeOnIso(iso, day) {
  return iso !== "" && dayOfSaoPaulo(Date.parse(iso)) === day;
}

function wokeOn(entry, day) {
  return wokeOnIso(entry.lastWake, day);
}

function releaseFilter(release, prevRelease) {
  return (value) =>
    sameRelease(value, release) || sameRelease(value, prevRelease);
}

/** The line as the rules read it, or `null` when it lacks a signature, a time or (for a repeat) a count. */
function readLine(line) {
  const { event, fields, timestamp } = line;
  const ms = toMs(timestamp);
  if (ms === null || !FINGERPRINT.test(fields.fingerprint ?? "")) {
    return null;
  }
  const repeat = event === "client_error_count";
  const count = repeat ? fields.count : 1;
  if (!(Number.isSafeInteger(count) && count >= 1 && count <= 999_999_999)) {
    return null;
  }
  const at = (repeat ? toMs(fields.minute) : null) ?? ms;
  return {
    at,
    count,
    event,
    fingerprint: fields.fingerprint,
    id: `${fields.fingerprint}.${count}.${minuteKey(at)}`,
    ms,
    release: fields.release,
  };
}

/**
 * The lines of one event name past its watermark, and the watermark to keep. Lines at the exact instant of the mark
 * are skipped only as many times as the state saw them (two equal lines at the same millisecond are two lines).
 * `read` holds no line dated after `now`, so a future date cannot move the mark and mute the real lines that follow.
 */
function pastMark(read, mark) {
  const left = new Map(mark.ties);
  const unseen = [];
  for (const line of read) {
    const spent = left.get(line.id) ?? 0;
    if (mark.at !== null && line.ms === mark.at && spent > 0) {
      left.set(line.id, spent - 1);
    } else if (mark.at === null || line.ms >= mark.at) {
      unseen.push(line);
    }
  }
  const top = Math.max(mark.at ?? 0, ...read.map((line) => line.ms));
  if (top === 0) {
    return { next: mark, unseen };
  }
  const ties = top === mark.at ? new Map(mark.ties) : new Map();
  const here = new Map();
  for (const line of read.filter((l) => l.ms === top)) {
    here.set(line.id, (here.get(line.id) ?? 0) + 1);
  }
  for (const [id, times] of here) {
    ties.set(id, Math.max(ties.get(id) ?? 0, times));
  }
  return { next: { at: top, ties }, unseen };
}

function ingest({ allowed, canonical, lines, now, state }) {
  const inDay = (ms) => now >= ms && now - ms <= DAY_MS;
  const fresh = new Map();
  let otherRelease = 0;
  let unknownRelease = 0;
  const add = (fingerprint, ms, count) => {
    const key = minuteKey(ms);
    const buckets = fresh.get(fingerprint) ?? new Map();
    buckets.set(key, (buckets.get(key) ?? 0) + count);
    fresh.set(fingerprint, buckets);
  };
  const read = lines.map(readLine).filter(Boolean);
  const dated = read.filter((line) => line.ms <= now);
  const unseen = {};
  for (const event of MARK_EVENTS) {
    const past = pastMark(
      dated.filter((line) => line.event === event),
      state.marks[event]
    );
    state.marks[event] = past.next;
    unseen[event] = past.unseen;
  }

  for (const line of unseen.client_error) {
    if (!inDay(line.ms)) {
      continue;
    }
    if (!allowed(line.release)) {
      otherRelease += 1;
      continue;
    }
    const entry = state.entries.get(line.fingerprint) ?? emptyEntry(now);
    entry.release = canonical(line.release);
    state.entries.set(line.fingerprint, entry);
    add(line.fingerprint, line.ms, 1);
  }
  for (const line of unseen.client_error_count) {
    if (!inDay(line.at)) {
      continue;
    }
    if (allowed(state.entries.get(line.fingerprint)?.release)) {
      add(line.fingerprint, line.at, line.count);
    } else {
      unknownRelease += 1;
    }
  }
  return {
    fresh,
    linesIgnoredInvalid: lines.length - read.length,
    otherRelease,
    unknownRelease,
  };
}

function peakOf(buckets, spanMs) {
  const starts = [...buckets.keys()].map(minuteStart);
  let peak = 0;
  for (const from of starts) {
    let total = 0;
    for (const [key, count] of buckets) {
      const at = minuteStart(key);
      if (at >= from && at < from + spanMs) {
        total += count;
      }
    }
    peak = Math.max(peak, total);
  }
  return peak;
}

function windowsOf(entry, now) {
  return {
    day: sumAfter(entry.buckets, now - DAY_MS),
    hour: sumAfter(entry.buckets, now - HOUR_MS),
    peak: peakOf(entry.buckets, NEW_WINDOW_MINUTES * MINUTE_MS),
  };
}

function candidatesOf({ allowed, counts, entries, spikePerHour, today }) {
  const candidates = [];
  for (const [fingerprint, entry] of entries) {
    const window = counts.get(fingerprint);
    if (window.day < SILENCE_BELOW || !allowed(entry.release)) {
      continue;
    }
    if (entry.announced === "") {
      if (window.peak >= NEW_MIN_EVENTS) {
        candidates.push({ fingerprint, reason: "new", weight: window.peak });
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
 * What wakes, in order: the full window, the flood, then the signatures. A flood replaces the new signatures (they
 * are held); a full window or a flood that already woke today is not repeated.
 */
function queueOf({ candidates, today, truncated, wakes }) {
  const newOnes = candidates.filter((c) => c.reason === "new");
  const isFlood = newOnes.length > FLOOD_ABOVE;
  const system = [];
  if (truncated && !wokeOnIso(wakes.truncated, today)) {
    system.push({ reason: "truncated" });
  }
  if (isFlood && !wokeOnIso(wakes.flood, today)) {
    system.push({ count: newOnes.length, reason: "flood" });
  }
  return {
    held: isFlood ? newOnes : [],
    queue: [
      ...system,
      ...(isFlood ? candidates.filter((c) => c.reason !== "new") : candidates),
    ],
  };
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
  truncated = false,
}) {
  const nowIso = new Date(now).toISOString();
  const next = {
    entries: new Map(
      [...state.entries].map(([fingerprint, entry]) => [
        fingerprint,
        { ...entry, buckets: new Map(entry.buckets) },
      ])
    ),
    marks: { ...state.marks },
    wakes: { ...state.wakes },
  };
  const allowed = releaseFilter(release, prevRelease);
  const canonical = (value) =>
    sameRelease(value, release) ? release : prevRelease;
  const { fresh, linesIgnoredInvalid, otherRelease, unknownRelease } = ingest({
    allowed,
    canonical,
    lines,
    now,
    state: next,
  });
  for (const [fingerprint, buckets] of fresh) {
    const entry = next.entries.get(fingerprint);
    for (const [key, count] of buckets) {
      entry.buckets.set(key, (entry.buckets.get(key) ?? 0) + count);
    }
  }

  const today = dayOfSaoPaulo(now);
  const counts = new Map();
  let wokeToday = SYSTEM_WAKES.filter((name) =>
    wokeOnIso(next.wakes[name], today)
  ).length;
  for (const [fingerprint, entry] of next.entries) {
    for (const key of entry.buckets.keys()) {
      if (minuteStart(key) + MINUTE_MS <= now - DAY_MS) {
        entry.buckets.delete(key);
      }
    }
    if (entry.buckets.size === 0 && entry.announced === "") {
      next.entries.delete(fingerprint);
      continue;
    }
    wokeToday += wokeOn(entry, today) ? 1 : 0;
    counts.set(fingerprint, windowsOf(entry, now));
  }
  const newSignatures = [...fresh.keys()].filter(
    (fingerprint) => next.entries.get(fingerprint)?.announced === ""
  );

  const candidates = candidatesOf({
    allowed,
    counts,
    entries: next.entries,
    spikePerHour,
    today,
  });
  const { held: floodHeld, queue } = queueOf({
    candidates,
    today,
    truncated,
    wakes: next.wakes,
  });
  const room = Math.max(0, MAX_WAKES_PER_DAY - wokeToday);
  const woken = queue.slice(0, room);
  for (const { fingerprint, reason } of woken) {
    if (fingerprint === undefined) {
      next.wakes[reason] = nowIso;
      continue;
    }
    const entry = next.entries.get(fingerprint);
    entry.announced = entry.announced || nowIso;
    entry.lastWake = nowIso;
  }

  const describe = (candidate) => {
    const { fingerprint, reason } = candidate;
    if (fingerprint === undefined) {
      return candidate;
    }
    return {
      events1h: counts.get(fingerprint).hour,
      events24h: counts.get(fingerprint).day,
      fingerprint,
      peak10m: counts.get(fingerprint).peak,
      reason,
    };
  };
  return {
    result: {
      held: [...floodHeld, ...queue.slice(room)].map(describe),
      ignoredOtherRelease: otherRelease,
      ignoredUnknownRelease: unknownRelease,
      linesIgnoredInvalid,
      linesRead: lines.length,
      newAtThreshold: newSignatures.filter(
        (fingerprint) => counts.get(fingerprint).peak >= NEW_MIN_EVENTS
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
  for (const required of ["release", "prev-release", "seen", "service"]) {
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
      return emptyState();
    }
    throw error;
  }
}

function writeState(path, state) {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, serializeState(state));
  renameSync(temp, path);
}

const failure = (code, reason) => ({
  code,
  output: { reason, wake: false },
});

function readOptions(args, now) {
  const sinceMs = parseSince(args.since ?? DEFAULT_SINCE);
  const spikePerHour = Number(args["spike-per-hour"] ?? DEFAULT_SPIKE_PER_HOUR);
  if (!(Number.isInteger(spikePerHour) && spikePerHour > 0)) {
    throw new Error("--spike-per-hour invalid");
  }
  for (const name of ["release", "prev-release"]) {
    if (!RELEASE_SHA.test(args[name])) {
      throw new Error(`--${name} is not a commit hash (7 to 40 hex digits)`);
    }
  }
  const at = args.now === undefined ? now : Date.parse(args.now);
  if (!Number.isFinite(at)) {
    throw new Error("--now invalid");
  }
  return { at, sinceMs, spikePerHour };
}

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
  let options;
  try {
    options = readOptions(args, now);
  } catch (error) {
    return failure(EXIT_USAGE, error.message);
  }
  const { at, sinceMs, spikePerHour } = options;

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

  let verdict;
  try {
    verdict = evaluate({
      lines,
      now: at,
      prevRelease: args["prev-release"],
      release: args.release,
      spikePerHour,
      state,
      truncated,
    });
  } catch {
    return failure(EXIT_INTERNAL, "evaluation failed");
  }
  const { linesIgnoredInvalid, linesRead } = verdict.result;
  if (linesRead > 0 && linesIgnoredInvalid === linesRead) {
    return {
      code: EXIT_API_FAILED,
      output: {
        linesIgnoredInvalid,
        linesRead,
        reason: "source failed: no line in the expected format",
        wake: false,
      },
    };
  }
  try {
    writeState(args.seen, verdict.state);
  } catch {
    return failure(EXIT_STATE_FAILED, "state file not written");
  }
  return { code: EXIT_OK, output: { ...verdict.result, truncated } };
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
