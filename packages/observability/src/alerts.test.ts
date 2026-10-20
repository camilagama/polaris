import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync } from "oxc-parser";
import { describe, expect, it } from "vitest";
import {
  alertSeverities,
  alertSignals,
  alertSourceEvents,
  criticalRoutes,
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
function emittedEvents(source: string, filename: string): string[] {
  const { errors, program } = parseSync(filename, source);
  expect(errors, `${filename} must parse`).toEqual([]);
  const events: string[] = [];
  walk(program, (node) => {
    if (node.type !== "CallExpression" || !isNode(node.callee)) {
      return;
    }
    const { callee } = node;
    let emits = false;
    if (callee.type === "MemberExpression") {
      const method = identifier(callee.property);
      emits =
        (identifier(callee.object) === "logger" &&
          method !== undefined &&
          levelMethods.has(method)) ||
        method === "report";
    } else {
      const name = identifier(callee);
      emits =
        name !== undefined && (eventFunctions.has(name) || name === "report");
    }
    const [first] = node.arguments as unknown[];
    if (
      emits &&
      isNode(first) &&
      first.type === "Literal" &&
      typeof first.value === "string"
    ) {
      events.push(first.value);
    }
  });
  return events;
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

const emitted = new Set(
  sourceRoots.flatMap((sourceRoot) =>
    sourceFiles(path.join(root, sourceRoot)).flatMap((file) =>
      emittedEvents(readFileSync(file, "utf8"), file)
    )
  )
);

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
