import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Expand/contract guard (ADR 0096). A migration runs before the new Worker
 * replaces the old one, and a Worker rollback does not roll the database back,
 * so every migration must work with the previous Worker still serving. This
 * script rejects the statements that break that rule unless the migration file
 * carries an explicit marker comment:
 *
 *   -- expand-contract: contract <what stopped using the object, and since which version>
 *   -- expand-contract: janela <why this needs a maintenance window>
 *
 * Migrations up to LAST_GRANDFATHERED were merged before go-live, when no
 * previous version was in production, and are not checked.
 *
 * It is a text scan, not a SQL parser: it reads the statements written in the
 * file (including the body of a `DO` block or a function) and cannot see dynamic
 * SQL built with `EXECUTE format(...)` or a function signature changed through
 * `CREATE OR REPLACE`. The checklist in the pull request covers those. A
 * `.sql` file whose name is not `NNNN_name.sql` fails, so a mistyped number
 * cannot dodge the check.
 *
 * It also reads `meta/_journal.json`. The drizzle migrator applies, on an
 * existing database, only the migrations whose `when` is greater than the
 * `created_at` of the last one applied, and skips the others without an error.
 * So `when` must grow strictly along the journal and must not be in the future
 * (a migration generated before that moment would be skipped in staging and
 * production). A database created from scratch, as in CI, does not show it.
 */

export const LAST_GRANDFATHERED = 77;
// clock skew allowed between the machine that generated a migration and the one that checks
export const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

const markerPattern =
  /^[ \t]*--[ \t]*expand-contract:[ \t]*(contract|janela)\b[ \t]*(?:[:\-–—][ \t]*)?(\w.*)$/im;
const fileNamePattern = /^(\d{4})_.+\.sql$/;
const statementBreakpoint = /-->\s*statement-breakpoint/g;
// the first token wins, so a `--` inside a string is part of the string
const noisePattern = /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'/g;
const whitespace = /\s+/g;
// anywhere in the statement, so the body of a `DO` block is read too
const alterStatement =
  /\bALTER\s+(?:TABLE|VIEW|MATERIALIZED\s+VIEW|SEQUENCE|INDEX|TYPE|FUNCTION|PROCEDURE|ROUTINE|SCHEMA|DOMAIN)\b/i;
const renameWord = /\bRENAME\b/i;
const notNull = /\bNOT\s+NULL\b/i;
const hasDefault = /\b(?:DEFAULT|GENERATED|SERIAL|BIGSERIAL|SMALLSERIAL)\b/i;
// "ADD COLUMN x ..." or "ADD x ..."; not ADD CONSTRAINT/PRIMARY/FOREIGN/UNIQUE/CHECK/EXCLUDE/VALUE
const addColumnClause =
  /\bADD\s+(?!(?:CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|CHECK|EXCLUDE|VALUE)\b)(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?\S[\s\S]*$/i;

const rules = [
  {
    id: "drop-column",
    // COLUMN is optional in `ALTER TABLE t DROP c`; the other DROP actions of ALTER TABLE are not columns
    pattern:
      /\bDROP\s+COLUMN\b|\bALTER\s+TABLE\b[^;]*?\bDROP\s+(?!CONSTRAINT\b|DEFAULT\b|NOT\b|IDENTITY\b|EXPRESSION\b)(?:IF\s+EXISTS\s+)?"?\w/i,
    what: "DROP COLUMN",
  },
  { id: "drop-table", pattern: /\bDROP\s+TABLE\b/i, what: "DROP TABLE" },
  {
    id: "drop-function",
    pattern: /\bDROP\s+(?:FUNCTION|PROCEDURE|ROUTINE)\b/i,
    what: "DROP FUNCTION",
  },
  {
    id: "set-not-null",
    pattern: /\bSET\s+NOT\s+NULL\b/i,
    what: "SET NOT NULL",
  },
  {
    id: "alter-column-type",
    pattern: /\bALTER\s+(?:COLUMN\s+)?"?[\w]+"?\s+(?:SET\s+DATA\s+)?TYPE\b/i,
    what: "ALTER COLUMN ... TYPE",
  },
];

/** Blanks out comments and string literals so their text never matches. */
export function stripNoise(sql) {
  return sql.replace(noisePattern, (match) =>
    match.startsWith("'") ? "''" : " "
  );
}

function splitTopLevel(text, separator) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const char of text) {
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
    }
    if (char === separator && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts;
}

function statementsOf(sql) {
  return stripNoise(sql.replace(statementBreakpoint, ";"))
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

/** The violations of one migration file, as `{ id, what, statement }`. */
export function findViolations(sql) {
  const violations = [];
  for (const statement of statementsOf(sql)) {
    const summary = statement.replace(whitespace, " ").slice(0, 120);
    for (const rule of rules) {
      if (rule.pattern.test(statement)) {
        violations.push({ id: rule.id, what: rule.what, statement: summary });
      }
    }
    if (alterStatement.test(statement)) {
      if (renameWord.test(statement)) {
        violations.push({ id: "rename", what: "RENAME", statement: summary });
      }
      for (const part of splitTopLevel(statement, ",")) {
        const clause = addColumnClause.exec(part)?.[0];
        if (clause && notNull.test(clause) && !hasDefault.test(clause)) {
          violations.push({
            id: "add-column-not-null",
            what: "ADD COLUMN ... NOT NULL without DEFAULT",
            statement: summary,
          });
        }
      }
    }
  }
  return violations;
}

/** The marker of a migration file, or null. A marker needs a reason. */
export function findMarker(sql) {
  const match = markerPattern.exec(sql);
  return match
    ? { kind: match[1].toLowerCase(), reason: match[2].trim() }
    : null;
}

/** Problems of a migration file; empty when it is compatible or marked. */
export function checkMigration(fileName, sql) {
  const match = fileNamePattern.exec(fileName);
  if (!match) {
    return [`${fileName}: a migration must be named NNNN_name.sql.`];
  }
  if (Number(match[1]) <= LAST_GRANDFATHERED) {
    return [];
  }
  const violations = findViolations(sql);
  if (violations.length === 0 || findMarker(sql)) {
    return [];
  }
  return violations.map(
    (violation) =>
      `${fileName}: ${violation.what} is not compatible with the previous Worker (${violation.statement}). ` +
      "Use expand/contract (docs/adr/0096-migrations-compativeis-com-a-versao-anterior-do-worker.md) or add " +
      "'-- expand-contract: contract <reason>' or '-- expand-contract: janela <reason>' to the file."
  );
}

/** Problems of the journal: `when` not strictly increasing, or in the future. */
export function checkJournal(journal, now = Date.now()) {
  const problems = [];
  let previous = null;
  for (const entry of journal.entries ?? []) {
    const { tag, when } = entry;
    if (!Number.isFinite(when)) {
      problems.push(`${tag}: the journal 'when' must be a number.`);
      continue;
    }
    if (previous && when <= previous.when) {
      problems.push(
        `${tag}: the journal 'when' (${when}) must be greater than the one of ${previous.tag} (${previous.when}); ` +
          "the migrator skips a migration whose 'when' is not greater than the last one applied."
      );
    }
    if (when > now + FUTURE_TOLERANCE_MS) {
      problems.push(
        `${tag}: the journal 'when' (${when}) is in the future (now is ${now}); ` +
          "a migration generated before that moment would be skipped on an existing database."
      );
    }
    previous = { tag, when };
  }
  return problems;
}

export function checkDirectory(directory, now = Date.now()) {
  const problems = [];
  const names = readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const name of names) {
    problems.push(
      ...checkMigration(name, readFileSync(path.join(directory, name), "utf8"))
    );
  }
  problems.push(
    ...checkJournal(
      JSON.parse(
        readFileSync(path.join(directory, "meta", "_journal.json"), "utf8")
      ),
      now
    )
  );
  return problems;
}

export const migrationsDirectory = path.resolve(
  fileURLToPath(new URL("..", import.meta.url)),
  "packages",
  "db",
  "drizzle"
);

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const problems = checkDirectory(migrationsDirectory);
  for (const problem of problems) {
    console.error(problem);
  }
  if (problems.length > 0) {
    process.exit(1);
  }
  console.log(
    `Migrations after ${String(LAST_GRANDFATHERED).padStart(4, "0")} are compatible with the previous Worker.`
  );
}
