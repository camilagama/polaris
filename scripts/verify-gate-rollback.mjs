import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { codeOnly } from "../packages/db/scripts/gate-clock-scan.ts";
import { exactCountProblems, walkFiles } from "./exact-count-list.mjs";
import { GATE_ROLLBACK_LIST } from "./verify-gate-rollback.list.mjs";

/**
 * A gate that sends a bare `ROLLBACK` to `query(` lets a failed ROLLBACK replace the error already on its way up,
 * and hands a connection that may still hold the open transaction back to the pool. `rollbackQuietly` and
 * `rollbackAndRelease` in `packages/db/scripts/gate-roles.ts` never throw and destroy such a connection; this check
 * keeps a new gate from going back to the bare call.
 *
 * Counted, in every `.ts` file under `packages/db/scripts/` (tests included) except `gate-roles.ts`, which is where
 * the helpers live: a string or template literal whose whole text is `ROLLBACK` (case and a trailing `;` aside) written
 * at the top level of the arguments of a `query(` call, so both `query("ROLLBACK")` and
 * `query(commit ? "COMMIT" : "ROLLBACK")` count. `ROLLBACK TO SAVEPOINT` is another statement and does not. Comments
 * and the text inside other strings are not counted (the scanner is the one of `gate-clock-scan.ts`).
 *
 * Not caught: a statement held in a variable first (`const sql = "ROLLBACK"; query(sql)`), one passed as
 * `query({ text: "ROLLBACK" })`, and one built from parts. Uses that exist before the rule stay in
 * `verify-gate-rollback.list.mjs` with their exact count per file, so only a change that adds one fails.
 */
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

export const LIST_FILE = "scripts/verify-gate-rollback.list.mjs";
export const HELPERS_FILE = "packages/db/scripts/gate-roles.ts";

export const ADVICE =
  "Use rollbackAndRelease (conexão do pool) ou rollbackQuietly (conexão que o gate segue usando) de packages/db/scripts/gate-roles.ts: " +
  "eles não lançam, e o erro que já vinha subindo não é trocado pelo de um ROLLBACK que falhou. " +
  `Só se o ROLLBACK precisa mesmo falhar o gate, acrescente o arquivo (ou suba a entrada) em ${LIST_FILE} com o motivo.`;

const ROLLBACK_LITERAL = /(["'`])[ \t\r\n]*ROLLBACK[ \t\r\n]*;?[ \t\r\n]*\1/gi;
const QUERY_CALL = /\bquery\s*\(/g;

export function isGateScript(relative) {
  return (
    relative.startsWith("packages/db/scripts/") &&
    relative.endsWith(".ts") &&
    !relative.endsWith(".d.ts") &&
    relative !== HELPERS_FILE
  );
}

/** The index of the `)` that closes the call whose `(` is at `open`, read on blanked code; -1 when it never closes. */
function closingParen(code, open) {
  let depth = 0;
  for (let index = open; index < code.length; index += 1) {
    if (code[index] === "(") {
      depth += 1;
    } else if (code[index] === ")") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

/** Whether the code between `from` and `to` is at the top level of the arguments at `at`: no inner call, array or object around it. */
function atTopLevel(code, from, at) {
  let depth = 0;
  for (let index = from; index < at; index += 1) {
    if ("([{".includes(code[index])) {
      depth += 1;
    } else if (")]}".includes(code[index])) {
      depth -= 1;
    }
  }
  return depth === 0;
}

/** The 1-based lines with a bare ROLLBACK sent to `query(`. */
export function bareRollbackLines(source) {
  const code = codeOnly(source);
  const lines = new Set();
  for (const call of code.matchAll(QUERY_CALL)) {
    const open = call.index + call[0].length - 1;
    const close = closingParen(code, open);
    if (close === -1) {
      continue;
    }
    for (const literal of source
      .slice(open + 1, close)
      .matchAll(ROLLBACK_LITERAL)) {
      const at = open + 1 + literal.index;
      if (code[at] === literal[1] && atTopLevel(code, open + 1, at)) {
        lines.add(source.slice(0, at).split("\n").length);
      }
    }
  }
  return [...lines].sort((a, b) => a - b);
}

export function gateRollbackProblems(sources, allowed = GATE_ROLLBACK_LIST) {
  const lines = Object.fromEntries(
    Object.entries(sources).map(([file, source]) => [
      file,
      bareRollbackLines(source),
    ])
  );
  const found = Object.fromEntries(
    Object.entries(lines).map(([file, where]) => [file, where.length])
  );
  return exactCountProblems({
    advice: ADVICE,
    allowed,
    found,
    listFile: LIST_FILE,
    what: "ROLLBACK solto em query(",
  }).map((problem) => {
    const file = problem.split(": ")[0] ?? "";
    const where = lines[file] ?? [];
    if (where.length === 0 || problem.includes("Baixe a entrada")) {
      return problem;
    }
    return problem.replace(
      `${file}: `,
      `${file} (linha${where.length > 1 ? "s" : ""} ${where.join(", ")}): `
    );
  });
}

export function checkRepository(base = root, allowed = GATE_ROLLBACK_LIST) {
  const sources = Object.fromEntries(
    walkFiles(base, isGateScript).map((file) => [
      file,
      readFileSync(path.join(base, file), "utf8"),
    ])
  );
  return gateRollbackProblems(sources, allowed);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const problems = checkRepository(process.argv[2] ?? root);
  for (const problem of problems) {
    console.error(problem);
  }
  if (problems.length > 0) {
    console.error(
      `\n${problems.length} problema(s) de ROLLBACK solto em gate de banco.`
    );
    process.exit(1);
  }
  console.log("Nenhum ROLLBACK solto novo em gate de banco.");
}
