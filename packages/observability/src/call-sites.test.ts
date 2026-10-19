import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync } from "oxc-parser";
import { describe, expect, it } from "vitest";
import { canonicalNameFor } from "./fields";

/**
 * Lint for the call sites (ADR 0091): the logger type refuses a forbidden alias
 * in an object literal, but a helper that takes `Record<string, string>` (the
 * Admin's `report`) slips past it. This parses the backend sources (AST, not
 * text) and fails when a call that writes log fields names one. It also fails
 * when a file logs from outside the scanned folders or a scanned file imports a
 * log function and the scan finds no call to it, so the scan cannot go quiet by
 * losing sight of the code (the earlier version relied on a call count).
 */

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  ".."
);

const sourceFilePattern = /\.(?:ts|tsx)$/;
const testFilePattern = /\.test\./;
const skippedFolders = new Set([
  ".wrangler",
  "dist",
  "e2e",
  "e2e-pwa",
  "node_modules",
]);

const sourceRoots = [
  "apps/admin/src",
  "apps/catalog/src",
  "apps/web/src/server",
  "apps/web/worker",
  "packages/billing/src",
  "packages/db/src",
];

/** Functions whose object argument becomes log fields, by the name they are imported under. */
const logFunctions = new Set([
  "logServerEvent",
  "logger",
  "startWideEvent",
  "withWideEvent",
]);
const levelMethods = new Set(["debug", "error", "info", "warn"]);
const observabilityImport = /^@polaris\/observability(?:\/|$)|\/server-log$/;

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

function nameOf(node: unknown): string | undefined {
  return isNode(node) && node.type === "Identifier"
    ? (node.name as string)
    : undefined;
}

/** The static name of a property key, or `undefined` for a computed one. */
function keyName(property: Node): string | undefined {
  const { key } = property;
  if (!isNode(key)) {
    return undefined;
  }
  if (key.type === "Identifier" && property.computed !== true) {
    return key.name as string;
  }
  return key.type === "Literal" && typeof key.value === "string"
    ? key.value
    : undefined;
}

/** Top-level keys of an object literal, following `...{ literal }` spreads; `...variable` is opaque. */
function objectKeys(object: Node): string[] {
  const keys: string[] = [];
  for (const entry of object.properties as unknown[]) {
    if (!isNode(entry)) {
      continue;
    }
    if (entry.type === "Property") {
      const name = keyName(entry);
      if (name !== undefined) {
        keys.push(name);
      }
    } else if (
      entry.type === "SpreadElement" &&
      isNode(entry.argument) &&
      entry.argument.type === "ObjectExpression"
    ) {
      keys.push(...objectKeys(entry.argument));
    }
  }
  return keys;
}

interface Scan {
  /** Calls to a log function the scan recognised. */
  calls: number;
  /** Log functions this file imports (`logger`, `startWideEvent`, ...). */
  imported: string[];
  violations: { alias: string; canonical: string; line: number }[];
}

function lineOf(source: string, offset: number): number {
  return source.slice(0, offset).split("\n").length;
}

function importedLogFunctions(program: unknown): string[] {
  const imported: string[] = [];
  walk(program, (node) => {
    if (
      node.type !== "ImportDeclaration" ||
      !isNode(node.source) ||
      typeof node.source.value !== "string" ||
      !observabilityImport.test(node.source.value)
    ) {
      return;
    }
    for (const specifier of node.specifiers as unknown[]) {
      if (isNode(specifier) && specifier.type === "ImportSpecifier") {
        const name = nameOf(specifier.imported);
        if (name !== undefined && logFunctions.has(name)) {
          imported.push(name);
        }
      }
    }
  });
  return imported;
}

function wideEventNames(program: unknown): Set<string> {
  const names = new Set(["wide"]);
  walk(program, (node) => {
    if (
      node.type === "VariableDeclarator" &&
      isNode(node.init) &&
      node.init.type === "CallExpression" &&
      nameOf(node.init.callee) === "startWideEvent"
    ) {
      const bound = nameOf(node.id);
      if (bound !== undefined) {
        names.add(bound);
      }
    }
    if (
      node.type === "CallExpression" &&
      nameOf(node.callee) === "withWideEvent"
    ) {
      const [, , work] = node.arguments as unknown[];
      if (isNode(work) && Array.isArray(work.params)) {
        const bound = nameOf(work.params[0]);
        if (bound !== undefined) {
          names.add(bound);
        }
      }
    }
  });
  return names;
}

/**
 * The object literals a call turns into log fields, or none when the call is
 * not a logging call. `report` is the Admin's helper only; elsewhere the name
 * is unrelated.
 */
function loggedObjects(
  call: Node,
  wide: ReadonlySet<string>,
  inAdmin: boolean
): Node[] {
  const { callee } = call;
  let isLogging = false;
  if (isNode(callee) && callee.type === "MemberExpression") {
    const object = nameOf(callee.object);
    const method = nameOf(callee.property);
    isLogging =
      (object === "logger" &&
        method !== undefined &&
        levelMethods.has(method)) ||
      (method === "set" && object !== undefined && wide.has(object));
  } else {
    const name = nameOf(callee);
    isLogging =
      name === "logServerEvent" ||
      name === "startWideEvent" ||
      name === "withWideEvent" ||
      (inAdmin && name === "report");
  }
  const objects: Node[] = [];
  if (isLogging) {
    for (const argument of call.arguments as unknown[]) {
      if (isNode(argument) && argument.type === "ObjectExpression") {
        objects.push(argument);
      }
    }
  } else if (nameOf(callee) === "logServerError") {
    // `logServerError({ ..., extra: { fields } })`
    for (const argument of call.arguments as unknown[]) {
      if (isNode(argument) && argument.type === "ObjectExpression") {
        for (const entry of argument.properties as unknown[]) {
          if (
            isNode(entry) &&
            entry.type === "Property" &&
            keyName(entry) === "extra" &&
            isNode(entry.value) &&
            entry.value.type === "ObjectExpression"
          ) {
            objects.push(entry.value);
          }
        }
      }
    }
  }
  return objects;
}

function scan(source: string, filename: string, inAdmin: boolean): Scan {
  const { errors, program } = parseSync(filename, source);
  expect(errors, `${filename} must parse`).toEqual([]);
  const wide = wideEventNames(program);
  const result: Scan = {
    calls: 0,
    imported: importedLogFunctions(program),
    violations: [],
  };
  walk(program, (node) => {
    if (node.type !== "CallExpression") {
      return;
    }
    const objects = loggedObjects(node, wide, inAdmin);
    const { callee } = node;
    const name = isNode(callee)
      ? (nameOf(callee) ??
        (callee.type === "MemberExpression"
          ? nameOf(callee.object)
          : undefined))
      : undefined;
    if (name !== undefined && (logFunctions.has(name) || name === "report")) {
      result.calls += 1;
    }
    for (const object of objects) {
      for (const key of objectKeys(object)) {
        const canonical = canonicalNameFor(key);
        if (canonical !== undefined) {
          result.violations.push({
            alias: key,
            canonical,
            line: lineOf(source, node.start as number),
          });
        }
      }
    }
  });
  return result;
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

const isAdminFile = (file: string) =>
  file.includes(`${path.sep}apps${path.sep}admin${path.sep}`);

describe("call sites", () => {
  it("find the forbidden aliases in a snippet (the scanner is not vacuous)", () => {
    const snippet = [
      'logger.info("a", { orgId: id, durationMs: 1 });',
      'logger.error("b", { ...x, errorName, "user_id": 1, "user-id": 2 });',
      'report("c", { name: error.name, request_id: "x" });',
      'logger.info("fine", { organizationId, requestId, outcome: "success" });',
      'logger.warn("spread", { ...{ tenantId: 1 }, ["status_code"]: 2, [dynamic]: 3 });',
      'const wide = startWideEvent("e", { jobId: 1 });',
      "wide.set({ userId: 1 });",
      'withWideEvent("w", {}, async (w) => { w.set({ elapsedMs: 1 }); });',
      'logServerEvent("s", context, { tenant: 1 });',
      "logServerError({ error, extra: { statusCode: 1 }, method, requestId, route });",
      'other.report("x", { orgId: 1 });',
      'notLogger.info("x", { orgId: 1 });',
    ].join("\n");

    const { violations } = scan(snippet, "snippet.ts", true);

    expect(violations.map((v) => v.alias)).toEqual([
      "orgId",
      "errorName",
      "user_id",
      "user-id",
      "request_id",
      "tenantId",
      "status_code",
      "jobId",
      "userId",
      "elapsedMs",
      "tenant",
      "statusCode",
    ]);
  });

  it("ignores `report` outside the Admin and nested record keys", () => {
    const snippet = [
      'report("x", { orgId: 1 });',
      'logger.info("n", { causes: [{ code: "23505", name: "E" }] });',
    ].join("\n");

    expect(scan(snippet, "snippet.ts", false).violations).toEqual([]);
  });

  it("counts the log functions a file imports and the calls the scan sees", () => {
    const snippet = [
      'import { logger, configureLogging } from "@polaris/observability/logger";',
      'import { logServerEvent } from "../observability/server-log";',
      'logger.info("a");',
      'logServerEvent("b", context);',
    ].join("\n");

    const found = scan(snippet, "snippet.ts", false);

    expect(found.imported).toEqual(["logger", "logServerEvent"]);
    expect(found.calls).toBe(2);
  });

  it("only scanned folders log, and no scanned file imports a logger it never calls", () => {
    const scanned = new Set(
      sourceRoots.flatMap((sourceRoot) =>
        sourceFiles(path.join(root, sourceRoot))
      )
    );

    // every file in the repository that imports the logger is inside a scanned folder
    const outside: string[] = [];
    for (const top of ["apps", "packages"]) {
      for (const file of sourceFiles(path.join(root, top))) {
        if (
          scanned.has(file) ||
          file.includes(
            `${path.sep}packages${path.sep}observability${path.sep}`
          )
        ) {
          continue;
        }
        const source = readFileSync(file, "utf8");
        if (
          source.includes("@polaris/observability") &&
          importedLogFunctions(parseSync(file, source).program).length > 0
        ) {
          outside.push(path.relative(root, file));
        }
      }
    }
    expect(outside).toEqual([]);

    const silent: string[] = [];
    let importers = 0;
    for (const file of scanned) {
      const source = readFileSync(file, "utf8");
      if (!source.includes("observability")) {
        continue;
      }
      const found = scan(source, file, isAdminFile(file));
      if (found.imported.length > 0) {
        importers += 1;
        if (found.calls === 0) {
          silent.push(path.relative(root, file));
        }
      }
    }
    expect(silent).toEqual([]);
    // the scan has something to read: the backend does log through the package
    expect(importers).toBeGreaterThan(0);
  });

  it("use no forbidden alias in the backend", () => {
    const violations: string[] = [];
    for (const sourceRoot of sourceRoots) {
      for (const file of sourceFiles(path.join(root, sourceRoot))) {
        const source = readFileSync(file, "utf8");
        for (const violation of scan(source, file, isAdminFile(file))
          .violations) {
          violations.push(
            `${path.relative(root, file)}:${violation.line} uses \`${violation.alias}\`, use \`${violation.canonical}\``
          );
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
