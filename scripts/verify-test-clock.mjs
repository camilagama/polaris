import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { countLooseClock } from "../packages/db/scripts/gate-clock-scan.ts";
import { exactCountProblems, walkFiles } from "./exact-count-list.mjs";
import { TEST_CLOCK_LIST } from "./verify-test-clock.list.mjs";

/**
 * A test that reads the wall clock (`Date.now()`, `new Date()` with no argument) gets a different
 * day depending on when it runs: it passes in the afternoon and fails after midnight in São Paulo,
 * or on the last day of the month. The gates of `packages/db/scripts` already have their own rule
 * (`gate-loose-clock.test.ts`, which this one does not read); this check covers every other test and
 * e2e spec of the repository: a file named `*.test.*` or `*.e2e.*`.
 *
 * The scanner is the one of the gates (`gate-clock-scan.ts`): comments and the text of strings do not
 * count. The main branch already has such reads, so `verify-test-clock.list.mjs` keeps the exact count
 * per file and only a change that adds one fails.
 */
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

export const LIST_FILE = "scripts/verify-test-clock.list.mjs";
export const OWN_RULE_FOLDER = "packages/db/scripts/";

export const ADVICE =
  "Fixe o relógio do teste e derive as datas dele: `vi.useFakeTimers({ now: NOW, toFake: ['Date'] })` e " +
  "`new Date(NOW)` (Vitest) ou `page.clock.setFixedTime(NOW)` (Playwright), com um caso perto da meia-noite de São Paulo " +
  "(docs/testing/relogio-nos-testes.md; `bun run test:datas` varre instantes e fusos). Tempo decorrido: `performance.now()`. " +
  `Sufixo único: \`crypto.randomUUID()\`. Se o relógio real é o que está em teste, acrescente o arquivo a ${LIST_FILE} com o motivo.`;

const testFile = /\.(?:test|e2e)\.(?:ts|tsx|mjs|js)$/;

/** A test or e2e spec outside the gates, which `gate-loose-clock.test.ts` owns. */
export function isTestFile(relative) {
  return testFile.test(relative) && !relative.startsWith(OWN_RULE_FOLDER);
}

export function testClockProblems(sources, allowed = TEST_CLOCK_LIST) {
  const found = Object.fromEntries(
    Object.entries(sources).map(([file, source]) => [
      file,
      countLooseClock(source),
    ])
  );
  return exactCountProblems({
    advice: ADVICE,
    allowed,
    found,
    listFile: LIST_FILE,
    what: "leitura(s) do relógio real (Date.now() ou new Date() sem argumento)",
  });
}

export function checkRepository(base = root, allowed = TEST_CLOCK_LIST) {
  const sources = Object.fromEntries(
    walkFiles(base, isTestFile).map((file) => [
      file,
      readFileSync(path.join(base, file), "utf8"),
    ])
  );
  return testClockProblems(sources, allowed);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const problems = checkRepository(process.argv[2] ?? root);
  for (const problem of problems) {
    console.error(problem);
  }
  if (problems.length > 0) {
    console.error(
      `\n${problems.length} problema(s) de relógio solto em teste.`
    );
    process.exit(1);
  }
  console.log("Nenhuma leitura nova do relógio real nos testes.");
}
