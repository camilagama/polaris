import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { exactCountProblems, walkFiles } from "./exact-count-list.mjs";
import { BLIND_WAITS_LIST } from "./verify-no-blind-waits.list.mjs";
import { stripComments } from "./verify-no-history-comments.mjs";

/**
 * A Playwright test that sleeps for a fixed time before an assertion proves nothing when the
 * assertion is negative ("no new read", "the dialog did not reopen"): on a slow runner the thing
 * happens after the sleep and the test passes anyway, and on a fast one the sleep is only lost time.
 * The test has to wait for a signal it can see: a locator state, a request counter read with
 * `expect.poll`, a `page.waitForResponse`, a marker the app sets after it settled.
 *
 * Counted, after comments are dropped, in every file of a folder whose name starts with `e2e` and in
 * every `*.e2e.ts`: `.waitForTimeout(`, a `new Promise` resolved by `setTimeout`, and an import of
 * `node:timers/promises`. Not caught: a sleep inside a helper imported from outside those folders,
 * `setTimeout` reached through a variable, `page["waitForTimeout"]`, a busy loop on `Date.now()`.
 *
 * Waits that exist before the rule stay in `verify-no-blind-waits.list.mjs` with their exact count per
 * file, so only a change that adds one fails. Simulating a slow answer inside a
 * `page.route` handler is a legitimate use: it goes into the list with its reason.
 */
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const BLIND_WAITS = [
  /\.\s*waitForTimeout\s*\(/g,
  /\bnew\s+Promise\s*(?:<[^>]*>)?\s*\(\s*(?:\([^)]*\)|\w+)\s*=>\s*\{?\s*(?:(?:globalThis|window|self)\s*\.\s*)?setTimeout\s*\(/g,
  /\bnew\s+Promise\s*(?:<[^>]*>)?\s*\(\s*function\b[^{]*\{\s*(?:(?:globalThis|window|self)\s*\.\s*)?setTimeout\s*\(/g,
  /\bfrom\s*["']node:timers\/promises["']|\brequire\s*\(\s*["']node:timers\/promises["']\s*\)/g,
];

export const LIST_FILE = "scripts/verify-no-blind-waits.list.mjs";

export const ADVICE =
  "Espere um sinal em vez de um tempo: `await expect(locator).toBeVisible()`/`toHaveText()`, " +
  "`await expect.poll(() => leituras).toBe(n)`, `page.waitForResponse(...)` ou a marca que a tela põe ao assentar " +
  "(antes de uma asserção negativa, espere o sinal positivo de que a tela terminou). " +
  `Se é a latência de uma resposta simulada dentro de \`page.route\`, acrescente o arquivo a ${LIST_FILE} com o motivo.`;

const sourceFile = /\.(?:ts|tsx|mjs|js)$/;
const e2eFile = /\.e2e\.(?:ts|tsx|mjs|js)$/;

/** Playwright code: a file under a folder whose name starts with `e2e`, or a `*.e2e.ts`. */
export function isPlaywrightFile(relative) {
  if (!sourceFile.test(relative) || relative.endsWith(".d.ts")) {
    return false;
  }
  const parts = relative.split("/");
  return (
    e2eFile.test(relative) ||
    parts.slice(0, -1).some((part) => part.startsWith("e2e"))
  );
}

/** How many blind waits a source has, comments not counted. */
export function countBlindWaits(source) {
  const code = stripComments(source);
  return BLIND_WAITS.reduce(
    (total, pattern) => total + (code.match(pattern)?.length ?? 0),
    0
  );
}

export function blindWaitProblems(sources, allowed = BLIND_WAITS_LIST) {
  const found = Object.fromEntries(
    Object.entries(sources).map(([file, source]) => [
      file,
      countBlindWaits(source),
    ])
  );
  return exactCountProblems({
    advice: ADVICE,
    allowed,
    found,
    listFile: LIST_FILE,
    what: "espera(s) por tempo fixo",
  });
}

export function checkRepository(base = root, allowed = BLIND_WAITS_LIST) {
  const sources = Object.fromEntries(
    walkFiles(base, isPlaywrightFile).map((file) => [
      file,
      readFileSync(path.join(base, file), "utf8"),
    ])
  );
  return blindWaitProblems(sources, allowed);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const problems = checkRepository(process.argv[2] ?? root);
  for (const problem of problems) {
    console.error(problem);
  }
  if (problems.length > 0) {
    console.error(`\n${problems.length} problema(s) de espera por tempo fixo.`);
    process.exit(1);
  }
  console.log("Nenhuma espera por tempo fixo nova nos testes de navegador.");
}
