import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync } from "oxc-parser";
import { describe, expect, it } from "vitest";
import {
  type AlertSignal,
  type AlertThreshold,
  alertSeverities,
  alertSignals,
  alertSourceEvents,
  criticalRoutes,
  errorEventsWithoutSignal,
  isCriticalRoute,
} from "./alerts";

/**
 * The registry of alert signals (ADR 0095) names events by string. A name
 * that nothing emits is an alert that never fires, so this reads the backend
 * sources (AST, like `call-sites.test.ts`) and collects the event names the
 * code emits; every event in the registry must be one of them. It also keeps
 * the runbook in step: each signal has its section and the section names
 * each event.
 */

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  ".."
);

const sourceRoots = [
  "apps/admin/src",
  "apps/catalog/src",
  "apps/web/src/server",
  "apps/web/worker",
  "packages/billing/src",
  "packages/db/src",
];
const skippedFolders = new Set([".wrangler", "dist", "node_modules"]);
const sourceFilePattern = /\.(?:ts|tsx)$/;
const testFilePattern = /\.test\./;

/** Calls whose first argument is the event name, by callee name. */
const eventFunctions = new Set([
  "logServerEvent",
  "startWideEvent",
  "withWideEvent",
]);
const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const eventPattern = /^[a-z][a-z0-9_]*$/;
const levelMethods = new Set(["debug", "error", "info", "warn"]);

interface Node {
  [key: string]: unknown;
  type: string;
}

function isNode(value: unknown): value is Node {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

function walk(node: unknown, visit: (found: Node) => void): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      walk(item, visit);
    }
    return;
  }
  if (!isNode(node)) {
    return;
  }
  visit(node);
  for (const [key, child] of Object.entries(node)) {
    if (key !== "start" && key !== "end") {
      walk(child, visit);
    }
  }
}

function identifier(node: unknown): string | undefined {
  return isNode(node) && node.type === "Identifier"
    ? (node.name as string)
    : undefined;
}

/**
 * The event names a source emits: the string literal first argument of
 * `logger.<level>(...)`, `logServerEvent`, `startWideEvent`, `withWideEvent`,
 * and of `report(...)`, the injected reporter of the catalog and the Admin
 * (which hand the name to `logger.error` / `logger.warn`).
 */
function emittedCalls(
  source: string,
  filename: string,
  reportLevel?: string
): { event: string; level: string | undefined }[] {
  const { errors, program } = parseSync(filename, source);
  expect(errors, `${filename} must parse`).toEqual([]);
  const events: { event: string; level: string | undefined }[] = [];
  walk(program, (node) => {
    if (node.type !== "CallExpression" || !isNode(node.callee)) {
      return;
    }
    const { callee } = node;
    let emits = false;
    let level: string | undefined;
    if (callee.type === "MemberExpression") {
      const method = identifier(callee.property);
      const isLogger =
        identifier(callee.object) === "logger" &&
        method !== undefined &&
        levelMethods.has(method);
      if (isLogger) {
        level = method;
      } else if (method === "report") {
        level = reportLevel;
      }
      emits = isLogger || method === "report";
    } else {
      const name = identifier(callee);
      emits =
        name !== undefined && (eventFunctions.has(name) || name === "report");
      level = name === "report" ? reportLevel : undefined;
    }
    const [first] = node.arguments as unknown[];
    if (
      emits &&
      isNode(first) &&
      first.type === "Literal" &&
      typeof first.value === "string"
    ) {
      events.push({ event: first.value, level });
    }
  });
  return events;
}

function emittedEvents(source: string, filename: string): string[] {
  return emittedCalls(source, filename).map(({ event }) => event);
}

/**
 * The level an app's injected `report` writes at, read from the place that
 * wires it to the logger (`report: (...) => logger.<level>(...)`), so a
 * `report("<name>")` call counts as the level the app really emits it at.
 */
const reportWiringPattern =
  /\breport:\s*\([^)]*\)\s*=>\s*logger\.(debug|error|info|warn)\(/g;

function reportLevelsWired(text: string): string[] {
  return [...text.matchAll(reportWiringPattern)].map((match) => match[1] ?? "");
}

/** The event names a source emits at the error level: `logger.error("<name>", ...)` and `report("<name>")` where the app wires `report` to `logger.error`. */
function errorLevelEvents(
  source: string,
  filename: string,
  reportLevel?: string
): string[] {
  return emittedCalls(source, filename, reportLevel)
    .filter(({ level }) => level === "error")
    .map(({ event }) => event);
}

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!skippedFolders.has(entry.name)) {
        files.push(...sourceFiles(full));
      }
    } else if (
      sourceFilePattern.test(entry.name) &&
      !testFilePattern.test(entry.name)
    ) {
      files.push(full);
    }
  }
  return files;
}

const sourceTexts = sourceRoots.flatMap((sourceRoot) =>
  sourceFiles(path.join(root, sourceRoot)).map(
    (file) => [file, readFileSync(file, "utf8")] as const
  )
);

const emitted = new Set(
  sourceTexts.flatMap(([file, text]) => emittedEvents(text, file))
);

function appOf(file: string): string {
  return path.relative(root, file).split(path.sep).slice(0, 2).join("/");
}

const reportLevelsByApp = new Map<string, Set<string>>();
const appsCallingReport = new Set<string>();
for (const [file, text] of sourceTexts) {
  const app = appOf(file);
  if (/\breport\(\s*"/.test(text)) {
    appsCallingReport.add(app);
  }
  const levels = reportLevelsByApp.get(app) ?? new Set<string>();
  for (const level of reportLevelsWired(text)) {
    levels.add(level);
  }
  reportLevelsByApp.set(app, levels);
}

const reportLevelByApp = new Map<string, string>();
for (const [app, levels] of reportLevelsByApp) {
  if (levels.size === 1) {
    reportLevelByApp.set(app, [...levels][0] ?? "");
  }
}

const eventsEmittedByApp = new Map<string, Map<string, Set<string>>>();
for (const [file, text] of sourceTexts) {
  const app = appOf(file);
  const events = eventsEmittedByApp.get(app) ?? new Map<string, Set<string>>();
  for (const { event, level } of emittedCalls(
    text,
    file,
    reportLevelByApp.get(app)
  )) {
    const levels = events.get(event) ?? new Set<string>();
    levels.add(level ?? "");
    events.set(event, levels);
  }
  eventsEmittedByApp.set(app, events);
}

const emittedAtErrorLevel = new Set(
  sourceTexts.flatMap(([file, text]) =>
    errorLevelEvents(text, file, reportLevelByApp.get(appOf(file)))
  )
);

/** The error events that have neither a signal nor an entry with a reason, sorted. */
function errorEventsWithoutDestination(
  errorEvents: ReadonlySet<string>,
  signals: readonly SignalLike[],
  exceptions: readonly { event: string; reason: string }[]
): string[] {
  const routed = new Set([
    ...signals.flatMap((signal) => signal.source.events),
    ...exceptions.map(({ event }) => event),
  ]);
  return [...errorEvents].filter((event) => !routed.has(event)).sort();
}

const runbook = readFileSync(
  path.join(root, "docs", "runbooks", "alertas.md"),
  "utf8"
);

/** The text of the runbook from the anchor of a signal to the next anchor. */
function runbookSection(id: string): string | undefined {
  const marker = `<a id="${id}"></a>`;
  const start = runbook.indexOf(marker);
  if (start === -1) {
    return undefined;
  }
  const next = runbook.indexOf('<a id="', start + marker.length);
  return runbook.slice(start, next === -1 ? undefined : next);
}

const monitorsHeading = "## Monitores no staging";
const monitorsEndPattern = /^#{1,2} |<a id="/m;
const monitorIdPattern = /^\[`([^`]+)`\]/;
const monitorWindowPattern = /^(\d+) (min|h)$/;
const dlqRowPattern = /(\| \[`dlq`\].*\n)/;
const monitorDate = String.raw`(?:0[1-9]|[12]\d|3[01])\/(?:0[1-9]|1[0-2])\/\d{4}`;
const signalStatePattern = /^(?:pendente|coberto pela política ([1-9]\d*))$/;
const policyStatePattern = new RegExp(
  `^(?:criada em ${monitorDate} por \\S.*|V14, provada em ${monitorDate} \\(anotação do \\S+\\))$`
);
const monitorLinkPattern = /\(#([^)]+)\)/;
const policyRowPattern = /^\| [1-9]\d* \|/;
const queryEventsPattern =
  /^event (?:= ("[^"]+")|in \(("[^"]+"(?:, "[^"]+")*)\))(?=`?(?:;|$))/;
const secondEventClausePattern = /\bevent (?:=|in) /;
const outsideBackticksPattern = /[,\s]/g;
const policyNumberLimit = 5;
const backtickedPattern = /`([^`]+)`/g;
const accountPolicyLimit = 5;
const leadingBacktickPattern = /^`/;
const http5xxStatePattern =
  /(\| \[`http-5xx`\].*\| )coberto pela política 3 \|/;

interface MonitorRow {
  readonly cells: readonly string[];
  readonly id: string;
}

type SignalLike = Pick<
  AlertSignal,
  "id" | "notify" | "source" | "threshold" | "windowMinutes"
>;

function monitorTableLines(markdown: string): string[] {
  const start = markdown.indexOf(monitorsHeading);
  if (start === -1) {
    return [];
  }
  const after = markdown.slice(start + monitorsHeading.length);
  const end = after.search(monitorsEndPattern);
  const body = end === -1 ? after : after.slice(0, end);
  return body.split("\n").filter((line) => line.startsWith("|"));
}

function isMonitorRowLine(line: string): boolean {
  return line.startsWith("| [`");
}

function isPolicyRowLine(line: string): boolean {
  return policyRowPattern.test(line);
}

function splitCells(line: string): string[] {
  return line
    .slice(1, line.lastIndexOf("|"))
    .split("|")
    .map((cell) => cell.trim());
}

function monitorRows(markdown: string): MonitorRow[] {
  const rows: MonitorRow[] = [];
  for (const line of monitorTableLines(markdown)) {
    if (!isMonitorRowLine(line)) {
      continue;
    }
    const cells = splitCells(line);
    const id = monitorIdPattern.exec(cells[0] ?? "")?.[1] ?? cells[0] ?? "";
    rows.push({ cells, id });
  }
  return rows;
}

function policyRows(markdown: string): MonitorRow[] {
  return monitorTableLines(markdown)
    .filter(isPolicyRowLine)
    .map((line) => {
      const cells = splitCells(line);
      return { cells, id: cells[0] ?? "" };
    });
}

function minutesOf(cell: string): number | undefined {
  const match = monitorWindowPattern.exec(cell);
  return match ? Number(match[1]) * (match[2] === "h" ? 60 : 1) : undefined;
}

function expectedLimit(threshold: AlertThreshold): string {
  switch (threshold.kind) {
    case "count":
      return String(threshold.atLeast);
    case "absence":
      return "ausência";
    case "p95Ms":
      return `p95 acima do limite da rota (${threshold.minSamples} requisições, no mínimo)`;
    default:
      return threshold satisfies never;
  }
}

/** The events a query cell names in its leading `event = ...` or `event in (...)` clause, and the text after that clause; undefined when the cell does not start with one. */
function queryClause(
  query: string
): { events: string[]; rest: string } | undefined {
  const text = query.replace(leadingBacktickPattern, "");
  const match = queryEventsPattern.exec(text);
  const quoted = match?.[1] ?? match?.[2];
  if (!match || quoted === undefined) {
    return undefined;
  }
  return {
    events: quoted.split(", ").map((name) => name.slice(1, -1)),
    rest: text.slice(match[0].length),
  };
}

function queryFilters(rest: string): string[] {
  return rest
    .split(";")
    .map((part) => part.replaceAll("`", "").trim())
    .filter((part) => part !== "");
}

function setDifference(
  left: readonly string[],
  right: readonly string[]
): string[] {
  return left.filter((name) => !right.includes(name));
}

function eventDrift(
  label: string,
  query: string,
  expected: readonly string[]
): string[] {
  const clause = queryClause(query);
  if (!clause) {
    return [`${label}: query does not start with an event clause`];
  }
  const named = clause.events;
  return [
    ...(secondEventClausePattern.test(clause.rest)
      ? [`${label}: query has an event clause after the first`]
      : []),
    ...setDifference(expected, named).map(
      (event) => `${label}: query lacks ${event}`
    ),
    ...setDifference(named, expected).map(
      (event) => `${label}: query names ${event}, which the registry does not`
    ),
  ];
}

function backticked(cell: string): string[] {
  return [...cell.matchAll(backtickedPattern)].map((match) => match[1] ?? "");
}

function signalDrift(
  markdown: string,
  signals: readonly SignalLike[]
): string[] {
  const rows = monitorRows(markdown);
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.id)) {
      problems.push(`${row.id}: line repeated`);
    }
    seen.add(row.id);
    const signal = signals.find((candidate) => candidate.id === row.id);
    if (!signal) {
      problems.push(`${row.id}: line without a signal in the registry`);
      continue;
    }
    const [, query = "", window = "", limit = "", wakes = "", state = ""] =
      row.cells;
    if (row.cells.length !== 6) {
      problems.push(`${row.id}: ${row.cells.length} columns instead of 6`);
    }
    problems.push(...eventDrift(row.id, query, signal.source.events));
    if (signal.source.where && !query.includes(`\`${signal.source.where}\``)) {
      problems.push(`${row.id}: query lacks the filter of the registry`);
    }
    if (minutesOf(window) !== signal.windowMinutes) {
      problems.push(
        `${row.id}: runbook says window "${window}", registry says ${signal.windowMinutes} min`
      );
    }
    if (limit !== expectedLimit(signal.threshold)) {
      problems.push(
        `${row.id}: runbook says threshold "${limit}", registry says "${expectedLimit(signal.threshold)}"`
      );
    }
    const expectedWakes = signal.notify === "wake" ? "sim" : "não";
    if (wakes !== expectedWakes) {
      problems.push(
        `${row.id}: runbook says wakes "${wakes}", registry says "${expectedWakes}"`
      );
    }
    if (!signalStatePattern.test(state)) {
      problems.push(`${row.id}: state "${state}" is not one of the two forms`);
    }
    if (monitorLinkPattern.exec(row.cells[0] ?? "")?.[1] !== row.id) {
      problems.push(`${row.id}: link does not point to its own id`);
    }
  }
  for (const signal of signals) {
    if (!seen.has(signal.id)) {
      problems.push(`${signal.id}: signal without a line`);
    }
  }
  const wakes = rows.map(
    (row) => signals.find((s) => s.id === row.id)?.notify === "wake"
  );
  const firstOther = wakes.indexOf(false);
  const lastWake = wakes.lastIndexOf(true);
  if (firstOther !== -1 && lastWake > firstOther) {
    problems.push(
      `${rows[lastWake]?.id}: a waking signal after one that does not`
    );
  }
  return problems;
}

function policyDrift(
  markdown: string,
  signals: readonly SignalLike[]
): string[] {
  const policies = policyRows(markdown);
  const problems: string[] = [];
  if (policies.length > accountPolicyLimit) {
    problems.push(
      `policies: ${policies.length} lines, the account accepts at most ${accountPolicyLimit}`
    );
  }
  const owner = new Map<string, string>();
  const numbers = new Set<string>();
  for (const policy of policies) {
    const label = `policy ${policy.id}`;
    if (numbers.has(policy.id)) {
      problems.push(`${label}: line repeated`);
    }
    numbers.add(policy.id);
    const [, query = "", , covered = "", state = ""] = policy.cells;
    if (policy.cells.length !== 5) {
      problems.push(`${label}: ${policy.cells.length} columns instead of 5`);
    }
    if (!policyStatePattern.test(state)) {
      problems.push(`${label}: state "${state}" is not one of the two forms`);
    }
    if (state.startsWith("V14,") && policy.id !== "1") {
      problems.push(`${label}: the V14 state belongs to policy 1`);
    }
    if (Number(policy.id) > policyNumberLimit) {
      problems.push(`${label}: number outside 1 to ${policyNumberLimit}`);
    }
    if (
      covered
        .replace(backtickedPattern, "")
        .replace(outsideBackticksPattern, "") !== ""
    ) {
      problems.push(`${label}: signals column has text outside backticks`);
    }
    const expectedEvents: string[] = [];
    const coveredFilters: string[] = [];
    for (const id of backticked(covered)) {
      const signal = signals.find((candidate) => candidate.id === id);
      if (!signal) {
        problems.push(`${label}: covers ${id}, which is not in the registry`);
        continue;
      }
      const earlier = owner.get(id);
      if (earlier !== undefined) {
        problems.push(
          `${id}: covered by policy ${earlier} and by policy ${policy.id}`
        );
      }
      owner.set(id, policy.id);
      if (signal.source.where) {
        coveredFilters.push(signal.source.where);
      }
      for (const event of signal.source.events) {
        if (!expectedEvents.includes(event)) {
          expectedEvents.push(event);
        }
      }
    }
    problems.push(...eventDrift(label, query, expectedEvents));
    for (const filter of queryFilters(queryClause(query)?.rest ?? "")) {
      if (!coveredFilters.includes(filter)) {
        problems.push(
          `${label}: filter "${filter}" is not the filter of a signal it covers`
        );
      }
    }
  }
  for (const row of monitorRows(markdown)) {
    const claimed = signalStatePattern.exec(row.cells[5] ?? "")?.[1];
    if (owner.get(row.id) !== claimed) {
      problems.push(
        `${row.id}: the signal line says ${claimed === undefined ? "no policy" : `policy ${claimed}`} and the policy table says ${owner.get(row.id) === undefined ? "none" : `policy ${owner.get(row.id)}`}`
      );
    }
  }
  return problems;
}

/** What differs between the monitors section of the runbook and the registry, one message per problem, each naming the signal or the policy. */
function monitorDrift(
  markdown: string,
  signals: readonly SignalLike[]
): string[] {
  const problems: string[] = [];
  for (const line of monitorTableLines(markdown)) {
    const isHeader =
      line.startsWith("| Sinal |") || line.startsWith("| Política |");
    const isSeparator = line.startsWith("| ---");
    if (
      !(
        isMonitorRowLine(line) ||
        isPolicyRowLine(line) ||
        isHeader ||
        isSeparator
      )
    ) {
      problems.push(`line outside the format: ${line.slice(0, 60)}`);
    }
  }
  return [
    ...problems,
    ...signalDrift(markdown, signals),
    ...policyDrift(markdown, signals),
  ];
}

describe("emittedEvents", () => {
  it("finds the event names of every kind of call (the scan is not vacuous)", () => {
    const snippet = [
      'logger.error("a_error", { requestId });',
      'logServerEvent("b_event", context);',
      'const wide = startWideEvent("c_wide", {});',
      'withWideEvent("d_with", {}, async () => 1);',
      'dependencies.report("e_report", error);',
      'report("f_report");',
      'notLogger.error("not_an_event");',
      "logger.info(name);",
      "logger.info(`template`);",
    ].join("\n");

    expect(emittedEvents(snippet, "snippet.ts").sort()).toEqual([
      "a_error",
      "b_event",
      "c_wide",
      "d_with",
      "e_report",
      "f_report",
    ]);
  });

  it("sees the events of the code base", () => {
    expect(emitted.has("server_error")).toBe(true);
    expect(emitted.has("scheduled_job_run")).toBe(true);
  });
});

describe("alert signals", () => {
  it("name every source event that the code emits", () => {
    const missing = alertSourceEvents().filter((event) => !emitted.has(event));

    expect(missing).toEqual([]);
  });

  it("have a unique lowercase id and a snake_case event list", () => {
    const ids = alertSignals.map((signal) => signal.id);

    expect(new Set(ids).size).toBe(ids.length);
    for (const signal of alertSignals) {
      expect(signal.id).toMatch(idPattern);
      expect(signal.source.events.length).toBeGreaterThan(0);
      for (const event of signal.source.events) {
        expect(event).toMatch(eventPattern);
      }
    }
  });

  it("wake someone only when critical, and report the rest", () => {
    for (const signal of alertSignals) {
      expect(alertSeverities).toContain(signal.severity);
      expect(signal.notify === "wake").toBe(signal.severity === "critical");
    }
  });

  it("fire on a single missed verification link in a day, like the signup acceptance", () => {
    for (const id of ["link-de-verificacao", "aceite-no-cadastro"]) {
      const signal = alertSignals.find((candidate) => candidate.id === id);
      expect(signal?.threshold).toEqual({ atLeast: 1, kind: "count" });
      expect(signal?.windowMinutes).toBe(1440);
      expect(signal?.notify).toBe("report");
      expect(signal?.severity).toBe("warning");
    }
  });

  it("wake someone at the first stop of the refund safety net and at the first incident not written", () => {
    for (const event of [
      "billing_refund_rearm_exhausted",
      "billing_refund_pending_incident_failed",
      "billing_amount_mismatch_incident_failed",
    ]) {
      const signals = alertSignals.filter((candidate) =>
        (candidate.source.events as readonly string[]).includes(event)
      );
      expect(signals, event).toHaveLength(1);
      expect(signals[0]?.threshold).toEqual({ atLeast: 1, kind: "count" });
      expect(signals[0]?.notify).toBe("wake");
    }
  });

  it("watch the three failures of the activation series in one signal that wakes, at the first one in an hour", () => {
    const signal = alertSignals.find(
      (candidate) => candidate.id === "serie-falhando"
    );

    expect(signal?.source.events).toEqual([
      "activation_notice_email_misconfigured",
      "activation_notice_failed",
      "activation_sweep_failed",
    ]);
    expect(signal?.threshold).toEqual({ atLeast: 1, kind: "count" });
    expect(signal?.windowMinutes).toBe(60);
    expect(signal?.notify).toBe("wake");
  });

  it("wake someone at the first refund incident, rejected provider key and abandoned billing event", () => {
    for (const event of [
      "billing_refund_pending_incident",
      "billing_provider_rejected",
      "billing_webhook_unresolved_given_up",
    ]) {
      const signals = alertSignals.filter((candidate) =>
        (candidate.source.events as readonly string[]).includes(event)
      );
      expect(signals, event).toHaveLength(1);
      expect(signals[0]?.source.events, event).toEqual([event]);
      expect(signals[0]?.threshold).toEqual({ atLeast: 1, kind: "count" });
      expect(signals[0]?.notify).toBe("wake");
    }
  });

  it("wake someone at the first failed access e-mail, with a window of one hour", () => {
    const signal = alertSignals.find(
      (candidate) => candidate.id === "email-de-acesso-falhando"
    );

    expect(signal?.source.events).toEqual(["auth_email_delivery_failed"]);
    expect(signal?.threshold).toEqual({ atLeast: 1, kind: "count" });
    expect(signal?.notify).toBe("wake");
    expect(signal?.severity).toBe("critical");
    expect(signal?.windowMinutes).toBe(60);
  });

  it("only report the eight error events the classification keeps out of the wake", () => {
    for (const event of [
      "activation_notice_delivery_window_passed",
      "billing_notice_delivery_window_passed",
      "billing_notice_failed",
      "billing_trial_fact_without_claim",
      "billing_webhook_state_not_shown",
      "billing_webhook_fact_event_malformed",
      "billing_provider_response_malformed",
      "rate_limit_unavailable",
    ]) {
      const signals = alertSignals.filter((candidate) =>
        (candidate.source.events as readonly string[]).includes(event)
      );
      expect(signals, event).toHaveLength(1);
      expect(signals[0]?.notify, event).toBe("report");
    }
  });

  it("give every event emitted with logger.error a signal or an exception with a reason", () => {
    expect(emittedAtErrorLevel.has("activation_notice_failed")).toBe(true);
    expect(emittedAtErrorLevel.has("server_error")).toBe(true);
    expect(
      errorEventsWithoutDestination(
        emittedAtErrorLevel,
        alertSignals,
        errorEventsWithoutSignal
      )
    ).toEqual([]);
  });

  it("name in the exceptions only error events that exist, have no signal and carry a reason", () => {
    const events = errorEventsWithoutSignal.map(({ event }) => event);

    expect(new Set(events).size).toBe(events.length);
    for (const { event, reason } of errorEventsWithoutSignal) {
      expect(emittedAtErrorLevel.has(event), `${event} is emitted`).toBe(true);
      expect(alertSourceEvents(), `${event} has a signal`).not.toContain(event);
      expect(reason.trim().length, `${event} has a reason`).toBeGreaterThan(20);
    }
  });

  describe("the error event guard (control cases)", () => {
    const withoutRegistered = (event: string) =>
      alertSignals.map((signal) => ({
        ...signal,
        source: {
          ...signal.source,
          events: signal.source.events.filter((name) => name !== event),
        },
      }));

    it("names a new error event of the series that has no signal", () => {
      const found = new Set([...emittedAtErrorLevel, "activation_novo_erro"]);

      expect(
        errorEventsWithoutDestination(
          found,
          alertSignals,
          errorEventsWithoutSignal
        )
      ).toEqual(["activation_novo_erro"]);
    });

    it("names a series event whose signal was dropped, and one whose exception was dropped", () => {
      expect(
        errorEventsWithoutDestination(
          emittedAtErrorLevel,
          withoutRegistered("activation_sweep_failed"),
          errorEventsWithoutSignal
        )
      ).toEqual(["activation_sweep_failed"]);
      expect(
        errorEventsWithoutDestination(
          emittedAtErrorLevel,
          alertSignals,
          errorEventsWithoutSignal.filter(
            ({ event }) => event !== "queue_ledger_not_recorded"
          )
        )
      ).toEqual(["queue_ledger_not_recorded"]);
    });

    it("reads the level: a warn event is not an error event", () => {
      const snippet = [
        'logger.error("a_error", {});',
        'logger.warn("b_warn", {});',
        'report("c_report");',
        'dependencies.report("d_report");',
      ].join("\n");

      expect(errorLevelEvents(snippet, "snippet.ts")).toEqual(["a_error"]);
      expect(errorLevelEvents(snippet, "snippet.ts", "warn")).toEqual([
        "a_error",
      ]);
      expect(errorLevelEvents(snippet, "snippet.ts", "error")).toEqual([
        "a_error",
        "c_report",
        "d_report",
      ]);
    });

    it("wires the injected report of each app that calls it to exactly one level", () => {
      expect([...appsCallingReport].sort()).toEqual([
        "apps/admin",
        "apps/catalog",
      ]);
      for (const app of appsCallingReport) {
        expect(
          [...(reportLevelsByApp.get(app) ?? [])],
          `${app} wires report to one logger level`
        ).toHaveLength(1);
      }
    });

    it("reads each way the report wiring can be written, and none that it cannot", () => {
      expect(reportLevelsWired("report: (a, b) => logger.warn(a, b)")).toEqual([
        "warn",
      ]);
      expect(
        reportLevelsWired("report: x,\n other: (y) => logger.error(y)")
      ).toEqual([]);
      expect(reportLevelsWired("report: logger.error.bind(logger)")).toEqual(
        []
      );
    });

    it("reads the injected report at the level its app wires it to", () => {
      expect(reportLevelByApp.get("apps/catalog")).toBe("error");
      expect(reportLevelByApp.get("apps/admin")).toBe("warn");
      expect(emittedAtErrorLevel.has("catalog_media_object_missing")).toBe(
        true
      );
      expect(
        [...(eventsEmittedByApp.get("apps/admin")?.get("admin_error") ?? [])],
        "apps/admin emits admin_error, and only at the level its report is wired to"
      ).toEqual(["warn"]);
      expect(emittedAtErrorLevel.has("admin_error")).toBe(false);
      expect(
        reportLevelsWired(
          "report: (message, error) =>\n  logger.error(message, error)"
        )
      ).toEqual(["error"]);
    });

    it("names a catalog media event that has no signal", () => {
      const withoutMedia = alertSignals.map((signal) => ({
        ...signal,
        source: {
          ...signal.source,
          events: signal.source.events.filter(
            (name) => name !== "catalog_media_authorization_failed"
          ),
        },
      }));

      expect(
        errorEventsWithoutDestination(
          emittedAtErrorLevel,
          withoutMedia,
          errorEventsWithoutSignal
        )
      ).toEqual(["catalog_media_authorization_failed"]);
    });
  });

  it("count the two billing 503s of an unconfirmed provider apart, with the threshold of the reconcile signal", () => {
    const reconcile = alertSignals.find(
      (candidate) => candidate.id === "cobranca-reconcile"
    );
    const signal = alertSignals.find(
      (candidate) => candidate.id === "cobranca-provedor-nao-confirmou"
    );

    expect(signal?.source.events).toEqual(["billing_unavailable_refused"]);
    expect(signal?.source.where).toContain("previous_checkout_unverified");
    expect(signal?.source.where).toContain(
      "previous_renewal_cancel_unverified"
    );
    expect(signal?.source.where).not.toContain("billing_provider_unavailable");
    expect(signal?.threshold).toEqual(reconcile?.threshold);
    expect(signal?.windowMinutes).toBe(reconcile?.windowMinutes);
    expect(signal?.notify).toBe("report");
  });

  it("leave the purges held on purpose and the step failure that stalled already counted once out of the purge signal", () => {
    const signal = alertSignals.find(
      (candidate) => candidate.id === "purge-parado"
    );

    expect(signal?.source).toEqual({
      events: [
        "organization_purge_stalled",
        "organization_purge_failure_not_recorded",
      ],
    });
  });

  it("have a positive window and a threshold that can fire", () => {
    for (const signal of alertSignals) {
      expect(signal.windowMinutes).toBeGreaterThan(0);
      const { threshold } = signal;
      if (threshold.kind === "count") {
        expect(Number.isInteger(threshold.atLeast)).toBe(true);
        expect(threshold.atLeast).toBeGreaterThan(0);
      } else if (threshold.kind === "p95Ms") {
        expect(threshold.minSamples).toBeGreaterThan(0);
      }
    }
  });

  it("cover the signals the plan asks for (PR119)", () => {
    const events = new Set(alertSourceEvents());

    for (const required of [
      "server_error",
      "http_request_timed",
      "queue_dead_letter_recorded",
      "scheduled_job_run",
      "billing_maintenance_incomplete",
      "media_transform_quota_exceeded",
      "sync_push_command_rejected",
      "auth_access_log_write_failed",
      "legal_acceptance_signup_record_failed",
    ]) {
      expect(events.has(required), required).toBe(true);
    }
  });

  it("have a section in the runbook that names each of their events", () => {
    for (const signal of alertSignals) {
      const section = runbookSection(signal.id);

      expect(section, `runbook section of ${signal.id}`).toBeDefined();
      for (const event of signal.source.events) {
        expect(section, `${signal.id} cites ${event}`).toContain(event);
      }
    }
  });

  it("leave no section in the runbook without a signal", () => {
    const anchors = [...runbook.matchAll(/<a id="([^"]+)"><\/a>/g)].map(
      (match) => match[1]
    );

    expect(anchors.sort()).toEqual(
      alertSignals.map((signal) => signal.id).sort()
    );
  });
});

describe("the monitors section of the runbook", () => {
  const section = monitorRows(runbook);

  it("has exactly the signals of the registry, none missing or left over", () => {
    expect(section.length).toBeGreaterThan(0);
    expect(section.map((row) => row.id).sort()).toEqual(
      alertSignals.map((signal) => signal.id).sort()
    );
  });

  it("matches the registry in query, window, threshold, wake and state, waking signals first", () => {
    expect(monitorDrift(runbook, alertSignals)).toEqual([]);
  });

  describe("control cases (the check fails for the right reason)", () => {
    const drift = (change: (signals: AlertSignal[]) => AlertSignal[]) =>
      monitorDrift(runbook, change([...alertSignals]));
    const inSection = (change: (text: string) => string) => {
      const start = runbook.indexOf(monitorsHeading);
      const end = runbook.indexOf('<a id="', start);
      return (
        runbook.slice(0, start) +
        change(runbook.slice(start, end)) +
        runbook.slice(end)
      );
    };
    const swap =
      (id: string, patch: Partial<AlertSignal>) => (signals: AlertSignal[]) =>
        signals.map((signal) =>
          signal.id === id ? { ...signal, ...patch } : signal
        );

    it("names the id when a threshold changes in the registry", () => {
      expect(
        drift(swap("http-5xx", { threshold: { atLeast: 6, kind: "count" } }))
      ).toEqual(['http-5xx: runbook says threshold "5", registry says "6"']);
    });

    it("names the id when a window changes in the registry", () => {
      expect(drift(swap("dlq", { windowMinutes: 90 }))).toEqual([
        'dlq: runbook says window "60 min", registry says 90 min',
      ]);
    });

    it("names the id when a signal starts or stops waking", () => {
      expect(drift(swap("dlq", { notify: "wake" }))).toEqual([
        'dlq: runbook says wakes "não", registry says "sim"',
        "dlq: a waking signal after one that does not",
      ]);
      expect(drift(swap("http-5xx", { notify: "report" }))).toEqual([
        'http-5xx: runbook says wakes "sim", registry says "não"',
        "email-de-acesso-falhando: a waking signal after one that does not",
      ]);
    });

    it("names the id when the threshold changes kind", () => {
      expect(
        drift(
          swap("outbox-parado", { threshold: { atLeast: 1, kind: "count" } })
        )
      ).toEqual([
        'outbox-parado: runbook says threshold "ausência", registry says "1"',
      ]);
    });

    it("names the signal that is new in the registry and the one removed from it", () => {
      const extra: AlertSignal = {
        id: "sinal-novo",
        notify: "report",
        severity: "warning",
        source: { events: ["evento_novo"] },
        threshold: { atLeast: 1, kind: "count" },
        title: "Novo",
        windowMinutes: 5,
      };

      expect(drift((signals) => [...signals, extra])).toEqual([
        "sinal-novo: signal without a line",
      ]);
      expect(drift((signals) => signals.filter((s) => s.id !== "dlq"))).toEqual(
        ["dlq: line without a signal in the registry"]
      );
    });

    it("names the id when an event is added to the registry, or removed from it, in either direction", () => {
      const sweep = alertSignals.find((s) => s.id === "cobranca-reconcile");
      const withoutSweep = sweep?.source.events.filter(
        (event) => event !== "billing_sweep_failed"
      );

      expect(
        drift(
          swap("outbox-falhando", {
            source: {
              events: [
                "outbox_send_failed",
                "outbox_event_unsendable",
                "outro_evento",
              ],
            },
          })
        )
      ).toEqual(["outbox-falhando: query lacks outro_evento"]);
      expect(
        drift(
          swap("cobranca-reconcile", {
            source: { events: withoutSweep ?? [] },
          })
        )
      ).toEqual([
        "cobranca-reconcile: query names billing_sweep_failed, which the registry does not",
        "policy 4: query names billing_sweep_failed, which the registry does not",
      ]);
    });

    it("names the id when the filter of the query changes", () => {
      expect(
        drift(
          swap("http-5xx", {
            source: {
              events: [
                ...(alertSignals.find((s) => s.id === "http-5xx")?.source
                  .events ?? []),
              ],
              where: "httpStatus >= 400",
            },
          })
        )
      ).toEqual(["http-5xx: query lacks the filter of the registry"]);
    });

    it("rejects a state of a signal that is not one of the two forms, and a repeated line", () => {
      const withState = inSection((text) =>
        text.replace("| coberto pela política 2 |", "| ligado |")
      );
      const repeated = inSection((text) => text.replace(dlqRowPattern, "$1$1"));

      expect(monitorDrift(withState, alertSignals)).toEqual([
        'apagamento-automatico: state "ligado" is not one of the two forms',
        "apagamento-automatico: the signal line says no policy and the policy table says policy 2",
      ]);
      expect(monitorDrift(repeated, alertSignals)).toEqual([
        "dlq: line repeated",
      ]);
    });

    it("rejects a policy state that is not one of the two forms, and an impossible date", () => {
      const badState = inSection((text) =>
        text.replace(
          "| V14, provada em 09/11/2026 (anotação do Arrascaeta) |",
          "| a confirmar (V14) |"
        )
      );
      const badDate = inSection((text) =>
        text.replace("17/11/2026 por Arrascaeta", "31/13/2026 por Arrascaeta")
      );

      expect(monitorDrift(badState, alertSignals)).toEqual([
        'policy 1: state "a confirmar (V14)" is not one of the two forms',
      ]);
      expect(monitorDrift(badDate, alertSignals)).toEqual([
        'policy 2: state "criada em 31/13/2026 por Arrascaeta" is not one of the two forms',
      ]);
    });

    it("rejects a policy query that lacks an event, adds a second event clause or starts with something else, and a filter the signals do not have", () => {
      const lacks = inSection((text) =>
        text.replace('"queue_ledger_unavailable", ', "")
      );
      const second = inSection((text) =>
        text.replace(
          '`event = "auth_access_log_write_failed"` | não',
          '`event = "auth_access_log_write_failed"`; `event in ("outro_evento")` | não'
        )
      );
      const orClause = inSection((text) =>
        text.replace(
          '`event = "auth_access_log_write_failed"` | não',
          '`event = "auth_access_log_write_failed" or event = "outro_evento"` | não'
        )
      );
      const noClause = inSection((text) =>
        text.replace(
          '`event = "auth_access_log_write_failed"` | não',
          "`httpStatus >= 500` | não"
        )
      );
      const otherJob = inSection((text) =>
        text.replace('job = "outbox.dispatch"', 'job = "outro.job"')
      );

      expect(monitorDrift(lacks, alertSignals)).toEqual([
        "policy 3: query lacks queue_ledger_unavailable",
      ]);
      expect(monitorDrift(second, alertSignals)).toEqual([
        "policy 1: query has an event clause after the first",
        'policy 1: filter "event in ("outro_evento")" is not the filter of a signal it covers',
      ]);
      expect(monitorDrift(orClause, alertSignals)).toEqual([
        "policy 1: query does not start with an event clause",
      ]);
      expect(monitorDrift(noClause, alertSignals)).toEqual([
        "policy 1: query does not start with an event clause",
      ]);
      expect(monitorDrift(otherJob, alertSignals)).toEqual([
        'policy 5: filter "job = "outro.job" and outcome = "success"" is not the filter of a signal it covers',
      ]);
    });

    it("rejects the V14 state outside policy 1, a policy number above 5 and a signal id outside backticks", () => {
      const v14Elsewhere = inSection((text) =>
        text.replace(
          "| criada em 17/11/2026 por Arrascaeta |\n| 3 |",
          "| V14, provada em 09/11/2026 (anotação do Arrascaeta) |\n| 3 |"
        )
      );
      const numberNine = inSection((text) =>
        text.replace(
          '| 5 | `event = "scheduled_job_run"`',
          '| 9 | `event = "scheduled_job_run"`'
        )
      );
      const bareId = inSection((text) =>
        text.replace(
          "`http-5xx`, `erros-de-banco`, `serie-falhando`, `email-de-acesso-falhando` |",
          "`http-5xx`, erros-de-banco, `serie-falhando`, `email-de-acesso-falhando` |"
        )
      );

      expect(monitorDrift(v14Elsewhere, alertSignals)).toEqual([
        "policy 2: the V14 state belongs to policy 1",
      ]);
      expect(monitorDrift(numberNine, alertSignals)).toEqual([
        "policy 9: number outside 1 to 5",
        "outbox-parado: the signal line says policy 5 and the policy table says policy 9",
      ]);
      expect(monitorDrift(bareId, alertSignals)).toEqual([
        "policy 3: signals column has text outside backticks",
        "policy 3: query names scheduler_state_unavailable, which the registry does not",
        "policy 3: query names queue_ledger_unavailable, which the registry does not",
        "policy 3: query names legal_acceptance_unavailable, which the registry does not",
        "erros-de-banco: the signal line says policy 3 and the policy table says none",
      ]);
    });

    it("keeps the policy table and the signal lines in step", () => {
      const sixth = inSection((text) =>
        text.replace(
          "\n| Sinal |",
          '| 6 | `event = "auth_access_log_write_failed"` | 1 ou mais em 1 min | `registro-de-acesso` | criada em 17/11/2026 por Arrascaeta |\n\n| Sinal |'
        )
      );
      const unknownSignal = inSection((text) =>
        text.replace("`outbox-parado` |", "`outbox-parado`, `sinal-solto` |")
      );
      const dropped = inSection((text) =>
        text.replace(
          "`http-5xx`, `erros-de-banco`, `serie-falhando`, `email-de-acesso-falhando` |",
          "`http-5xx`, `serie-falhando`, `email-de-acesso-falhando` |"
        )
      );
      const wrongPolicy = inSection((text) =>
        text.replace(http5xxStatePattern, "$1coberto pela política 2 |")
      );

      expect(monitorDrift(sixth, alertSignals)).toEqual([
        "policies: 6 lines, the account accepts at most 5",
        "policy 6: number outside 1 to 5",
        "registro-de-acesso: covered by policy 1 and by policy 6",
        "registro-de-acesso: the signal line says policy 1 and the policy table says policy 6",
      ]);
      expect(monitorDrift(unknownSignal, alertSignals)).toEqual([
        "policy 5: covers sinal-solto, which is not in the registry",
      ]);
      expect(monitorDrift(dropped, alertSignals)).toEqual([
        "policy 3: query names scheduler_state_unavailable, which the registry does not",
        "policy 3: query names queue_ledger_unavailable, which the registry does not",
        "policy 3: query names legal_acceptance_unavailable, which the registry does not",
        "erros-de-banco: the signal line says policy 3 and the policy table says none",
      ]);
      expect(monitorDrift(wrongPolicy, alertSignals)).toEqual([
        "http-5xx: the signal line says policy 2 and the policy table says policy 3",
      ]);
    });

    it("rejects a line outside the format, a wrong column count, a wrong link and a missing filter", () => {
      const stray = inSection((text) => `${text}| \`sinal-solto\` | x |\n`);
      const fiveColumns = inSection((text) =>
        text.replace(dlqRowPattern, (row) => row.replace(" | pendente |", " |"))
      );
      const wrongLink = inSection((text) => text.replace("(#dlq)", "(#outro)"));
      const noFilter = inSection((text) =>
        text.replace(
          "; `httpStatus >= 500, or the event is not server_error`",
          ""
        )
      );

      expect(monitorDrift(stray, alertSignals)).toEqual([
        "line outside the format: | `sinal-solto` | x |",
      ]);
      expect(monitorDrift(fiveColumns, alertSignals)).toEqual([
        "dlq: 5 columns instead of 6",
        expect.stringContaining("dlq: state"),
      ]);
      expect(monitorDrift(wrongLink, alertSignals)).toEqual([
        "dlq: link does not point to its own id",
      ]);
      expect(monitorDrift(noFilter, alertSignals)).toEqual([
        "http-5xx: query lacks the filter of the registry",
      ]);
    });

    it("rejects a waking signal listed after one that only reports", () => {
      const moved = inSection((text) => {
        const lines = text.split("\n");
        const first = lines.findIndex((line) =>
          line.startsWith("| [`http-5xx`]")
        );
        const [row] = lines.splice(first, 1);
        const last = lines.findIndex((line) =>
          line.startsWith("| [`serie-parada`]")
        );
        lines.splice(last + 1, 0, row ?? "");
        return lines.join("\n");
      });

      expect(monitorDrift(moved, alertSignals)).toEqual([
        "http-5xx: a waking signal after one that does not",
      ]);
    });

    it("finds no line in a runbook without the section", () => {
      expect(monitorRows("# Alertas\n")).toEqual([]);
      expect(monitorDrift("# Alertas\n", alertSignals)).toHaveLength(
        alertSignals.length
      );
    });
  });
});

describe("critical routes", () => {
  it("are unique, with a positive p95 limit", () => {
    const routes = criticalRoutes.map(({ route }) => route);

    expect(new Set(routes).size).toBe(routes.length);
    for (const { p95Ms } of criticalRoutes) {
      expect(p95Ms).toBeGreaterThan(0);
    }
  });

  it("are the only ones `isCriticalRoute` accepts", () => {
    expect(isCriticalRoute("/rpc/sale/confirm")).toBe(true);
    expect(isCriticalRoute("/rpc/category/create")).toBe(false);
    expect(isCriticalRoute("/health")).toBe(false);
  });
});
