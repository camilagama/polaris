import {
  ORGANIZATION_PURGE_CLOSURE_PERIOD_DAYS,
  ORGANIZATION_PURGE_REQUIRED_SCOPE,
} from "@polaris/domain/privacy/organization-purge";
import {
  PURGE_BILLING_FACT_KEYS,
  PURGE_DELETE_ORDER,
  PURGE_SURVIVING_TABLES,
} from "./purge-datasets";

/**
 * The purge functions as the database holds them against what the domain says (ADR 0081). A later migration
 * that recreates one of these functions replaces the whole body, and git does not see two migrations that
 * write the same function as a conflict: the gate `purge-functions` reads `pg_get_functiondef` of the live
 * functions and fails on any difference below. It is mandatory before a pull request that recreates
 * `admin_schedule_organization_purge`, `organization_purge_blocker` or `purge_organization_data`.
 */
export const PURGE_FUNCTIONS = Object.freeze([
  "admin_schedule_organization_purge",
  "organization_purge_blocker",
  "purge_organization_data",
] as const);

export type PurgeFunctionName = (typeof PURGE_FUNCTIONS)[number];

const INTERVAL_LITERAL = /\binterval\s+'([^']*)'/gi;
const DELAY_INTERVAL = /p_delay_seconds\s*\*\s*interval\s+'1 second'/gi;
const OTHER_INTERVAL_FORM = /::\s*interval\b|\bmake_interval\b/i;
const DELETE_STATEMENT = /\bDELETE\s+FROM\b[^;']*/gi;
const QUOTED = /'([^']*)'/g;
const TRUNCATE_STATEMENT = /\bTRUNCATE\b/i;
const WHITESPACE = /\s+/g;
const NOT_LIST_PUNCTUATION = /[\s,]/g;
const PERFORM_STATEMENT = /\bPERFORM\b/i;
const EXECUTE_STATEMENT = /\bEXECUTE\b/gi;

/** How many times each function counts the closure period: the schedule checks it and computes the due date. */
const CLOSURE_PERIOD_USES: Readonly<Record<PurgeFunctionName, number>> =
  Object.freeze({
    admin_schedule_organization_purge: 2,
    organization_purge_blocker: 1,
    purge_organization_data: 0,
  });

/**
 * The SQL without its comments (a comment may quote a number or a name that is not in the code), keeping the
 * string literals as they are: a `--` inside a string is not a comment.
 */
function withoutComments(definition: string): string {
  let result = "";
  let index = 0;
  while (index < definition.length) {
    const next = definition[index + 1];
    if (definition[index] === "'") {
      const end = endOfString(definition, index);
      result += definition.slice(index, end);
      index = end;
    } else if (definition[index] === "-" && next === "-") {
      const newline = definition.indexOf("\n", index);
      index = newline === -1 ? definition.length : newline;
    } else if (definition[index] === "/" && next === "*") {
      const close = definition.indexOf("*/", index + 2);
      index = close === -1 ? definition.length : close + 2;
    } else {
      result += definition[index];
      index += 1;
    }
  }
  return result;
}

/** The index right after the string literal that opens at `start` (`''` is a quote inside it). */
function endOfString(sql: string, start: number): number {
  let end = start + 1;
  while (end < sql.length) {
    if (sql[end] === "'" && sql[end + 1] === "'") {
      end += 2;
    } else if (sql[end] === "'") {
      return end + 1;
    } else {
      end += 1;
    }
  }
  return sql.length;
}

/** The quoted names of `<name> ... := ARRAY[ ... ]`, in order, or null when the declaration is not there or holds anything but literals. */
function arrayLiteral(sql: string, name: string): string[] | null {
  const declaration = new RegExp(
    `\\b${name}\\b[^;]*?:=\\s*ARRAY\\s*\\[`,
    "i"
  ).exec(sql);
  if (declaration === null) {
    return null;
  }
  const open = declaration.index + declaration[0].length - 1;
  const body = sql.slice(open + 1, sql.indexOf("]", open));
  // an element that is not a literal (a variable, a call) cannot be compared: it is as bad as a missing list
  if (body.replace(QUOTED, "").replace(NOT_LIST_PUNCTUATION, "") !== "") {
    return null;
  }
  return [...body.matchAll(QUOTED)].map((match) => match[1] ?? "");
}

function sameSet(left: readonly string[], right: readonly string[]) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

const show = (names: readonly string[]) => `[${names.join(", ")}]`;

function missingOrExtra(
  actual: readonly string[],
  expected: readonly string[]
) {
  const extra = actual.filter((name) => !expected.includes(name));
  const missing = expected.filter((name) => !actual.includes(name));
  return `extra ${show(extra)}, missing ${show(missing)}`;
}

/** The periods written as `interval '...'`, leaving out `p_delay_seconds * interval '1 second'`, which is a delay. */
function periodIntervals(sql: string): string[] {
  return [...sql.replace(DELAY_INTERVAL, "").matchAll(INTERVAL_LITERAL)].map(
    (match) => match[1] ?? ""
  );
}

const PERIOD_FUNCTIONS = [
  "admin_schedule_organization_purge",
  "organization_purge_blocker",
] as const;

/** The scope a privacy case must cover, `whole_organization`, is the domain's list. */
function scopeDifferences(sql: string): string[] {
  const scope = arrayLiteral(sql, "whole_organization");
  if (scope === null) {
    return [
      "admin_schedule_organization_purge: the whole_organization array is not declared with literals",
    ];
  }
  return sameSet(scope, ORGANIZATION_PURGE_REQUIRED_SCOPE)
    ? []
    : [
        `admin_schedule_organization_purge: whole_organization differs from ORGANIZATION_PURGE_REQUIRED_SCOPE (${missingOrExtra(scope, ORGANIZATION_PURGE_REQUIRED_SCOPE)})`,
      ];
}

/** The closure period is ORGANIZATION_PURGE_CLOSURE_PERIOD_DAYS, as many times as each function counts it. */
function periodDifferences(name: PurgeFunctionName, sql: string): string[] {
  const period = `${ORGANIZATION_PURGE_CLOSURE_PERIOD_DAYS} days`;
  const intervals = periodIntervals(sql);
  const problems = intervals
    .filter((interval) => interval !== period)
    .map(
      (interval) =>
        `${name}: interval '${interval}' is not the closure period of ${period}`
    );
  const expected = CLOSURE_PERIOD_USES[name];
  if (intervals.filter((interval) => interval === period).length !== expected) {
    problems.push(
      `${name}: it must count the closure period of ${period} ${expected} time(s)`
    );
  }
  if (OTHER_INTERVAL_FORM.test(sql)) {
    problems.push(
      `${name}: a period written as ::interval or make_interval is not compared, write interval '${period}'`
    );
  }
  return problems;
}

/** Each declaration is used where the purge depends on it: a correct list that nothing reads protects nothing. */
function usageDifferences(
  name: PurgeFunctionName,
  sql: string,
  required: readonly (readonly [string, RegExp])[],
  declared: readonly string[]
): string[] {
  const problems = required
    .filter(([, pattern]) => !pattern.test(sql))
    .map(([label]) => `${name}: ${label} is gone`);
  for (const variable of declared) {
    const assignments = sql.match(
      new RegExp(`\\b${variable}\\b(?:\\s+text\\[\\])?\\s*:=`, "gi")
    )?.length;
    if (assignments !== 1) {
      problems.push(
        `${name}: ${variable} must be assigned once, in its declaration (found ${assignments ?? 0})`
      );
    }
  }
  return problems;
}

const SCHEDULE_USAGE = [
  [
    "the check that the scope covers the whole organization",
    /privacy_scope\s*@>\s*whole_organization/i,
  ],
  [
    "the check that the scope holds nothing the purge keeps",
    /privacy_scope\s*<@\s*whole_organization/i,
  ],
] as const;

const PURGE_USAGE = [
  [
    "the loop over deleted_tables",
    /FOREACH\s+target\s+IN\s+ARRAY\s+deleted_tables\s+LOOP/i,
  ],
  [
    "the call to organization_purge_blocker",
    /blocker\s*:=\s*public\.organization_purge_blocker\s*\(\s*p_organization\s*\)/i,
  ],
  [
    "the refusal when the blocker is set",
    /IF\s+blocker\s+IS\s+NOT\s+NULL\s+THEN/i,
  ],
  [
    "the filter of the billing fact by kept_fact_keys",
    /[=]\s*ANY\s*\(\s*kept_fact_keys\s*\)/i,
  ],
] as const;

/** The tables the purge deletes are the domain's list, in the domain's order (the foreign keys decide it). */
function deletedTablesDifferences(sql: string): string[] {
  const deleted = arrayLiteral(sql, "deleted_tables");
  if (deleted === null) {
    return [
      "purge_organization_data: the deleted_tables array is not declared with literals",
    ];
  }
  const problems: string[] = [];
  if (JSON.stringify(deleted) !== JSON.stringify(PURGE_DELETE_ORDER)) {
    problems.push(
      `purge_organization_data: deleted_tables differs from PURGE_DELETE_ORDER, in names or in order (${missingOrExtra(deleted, PURGE_DELETE_ORDER)})`
    );
  }
  const kept = deleted.filter((name) =>
    Object.hasOwn(PURGE_SURVIVING_TABLES, name)
  );
  if (kept.length > 0) {
    problems.push(
      `purge_organization_data: deleted_tables holds tables that survive the purge ${show(kept)}`
    );
  }
  return problems;
}

/** No other statement deletes: the one DELETE is the loop over deleted_tables. */
function deleteStatementDifferences(sql: string): string[] {
  const problems: string[] = [];
  const deletes = [...sql.matchAll(DELETE_STATEMENT)].map((match) =>
    match[0].replace(WHITESPACE, " ").trim()
  );
  if (
    deletes.length !== 1 ||
    deletes[0] !== "DELETE FROM public.%I WHERE organization_id = $1"
  ) {
    problems.push(
      `purge_organization_data: the only DELETE must be the loop over deleted_tables, found ${show(deletes)}`
    );
  }
  if (TRUNCATE_STATEMENT.test(sql)) {
    problems.push("purge_organization_data: it truncates a table");
  }
  // the loop's EXECUTE is the only dynamic statement, and nothing is called for effect (PERFORM)
  if ((sql.match(EXECUTE_STATEMENT)?.length ?? 0) !== 1) {
    problems.push("purge_organization_data: it must have exactly one EXECUTE");
  }
  if (PERFORM_STATEMENT.test(sql)) {
    problems.push("purge_organization_data: it calls a function with PERFORM");
  }
  return problems;
}

/** What a billing fact keeps is the domain's list. */
function factKeysDifferences(sql: string): string[] {
  const keys = arrayLiteral(sql, "kept_fact_keys");
  if (keys === null) {
    return [
      "purge_organization_data: the kept_fact_keys array is not declared with literals",
    ];
  }
  return sameSet(keys, PURGE_BILLING_FACT_KEYS)
    ? []
    : [
        `purge_organization_data: kept_fact_keys differs from PURGE_BILLING_FACT_KEYS (${missingOrExtra(keys, PURGE_BILLING_FACT_KEYS)})`,
      ];
}

/**
 * The differences between the live definitions and the domain; empty when they agree. `definitions` maps each
 * function to its `pg_get_functiondef` text.
 */
export function purgeFunctionDifferences(
  definitions: Readonly<Record<PurgeFunctionName, string>>
): string[] {
  const sql = {
    admin_schedule_organization_purge: withoutComments(
      definitions.admin_schedule_organization_purge
    ),
    organization_purge_blocker: withoutComments(
      definitions.organization_purge_blocker
    ),
    purge_organization_data: withoutComments(
      definitions.purge_organization_data
    ),
  };
  return [
    ...scopeDifferences(sql.admin_schedule_organization_purge),
    ...usageDifferences(
      "admin_schedule_organization_purge",
      sql.admin_schedule_organization_purge,
      SCHEDULE_USAGE,
      ["whole_organization"]
    ),
    ...PERIOD_FUNCTIONS.flatMap((name) => periodDifferences(name, sql[name])),
    ...periodDifferences(
      "purge_organization_data",
      sql.purge_organization_data
    ),
    ...deletedTablesDifferences(sql.purge_organization_data),
    ...deleteStatementDifferences(sql.purge_organization_data),
    ...usageDifferences(
      "purge_organization_data",
      sql.purge_organization_data,
      PURGE_USAGE,
      ["deleted_tables", "kept_fact_keys"]
    ),
    ...factKeysDifferences(sql.purge_organization_data),
  ];
}
