import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { codeOnly } from "../packages/db/scripts/gate-clock-scan.ts";
import { exactCountProblems, walkFiles } from "./exact-count-list.mjs";
import { E2E_FIXED_DATES_LIST } from "./verify-e2e-fixed-dates.list.mjs";
import { isPlaywrightFile } from "./verify-no-blind-waits.mjs";

/**
 * An ISO date written in the code of a Playwright test ("2026-11-11T03:00:00.000Z") is a time bomb
 * when the browser runs on the real clock: the fixture is in the future today and in the past on a
 * day nobody chose (a trial plan with a literal end date expired on that day and turned the offline gate
 * red on every pull request). `verify-test-clock.mjs` catches the test that reads the clock; this one catches
 * the opposite, a fixed date next to a clock nobody fixed.
 *
 * Counted, in every file `verify-no-blind-waits.mjs` treats as Playwright code: string and template
 * literals whose text starts with `AAAA-MM-DD`, unless the same file installs a fixed clock
 * (`clock.setFixedTime`, `clock.setSystemTime`, `clock.pauseAt`, `clock.install({ time })` or Vitest's
 * `vi.useFakeTimers({ now })`; an install with no start time keeps the real clock running). Comments and the text inside other strings or regular expressions do not count
 * (the scanner is the one of `gate-clock-scan.ts`).
 *
 * Not caught: a helper that carries dates and is imported by a spec that does not fix the clock (the
 * file is judged alone: it passes when it installs the clock itself, as `serveFoot` does), a clock
 * fixed by a call the pattern does not know, a date built from parts (`${year}-11-11`), and a date
 * that is no ISO text (`new Date(2026, 10, 11)`). Dates that exist before the rule stay in
 * `verify-e2e-fixed-dates.list.mjs` with their exact count per file, so only a change that adds one fails.
 */
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

export const LIST_FILE = "scripts/verify-e2e-fixed-dates.list.mjs";

export const ADVICE =
  "Fixe o relógio do navegador (`await page.clock.setFixedTime(NOW)` antes de abrir a tela) e derive as datas " +
  "da fixture desse `NOW` (`new Date(NOW.getTime() + n * DAY).toISOString()`), com um caso perto da meia-noite de São Paulo " +
  "(docs/testing/relogio-nos-testes.md). Sem isso a data fixa vence sozinha num dia qualquer e o gate de navegador " +
  `fica vermelho em todo PR. Só se a data é histórica e nenhuma tela a compara com o relógio, acrescente o arquivo (ou suba a entrada) em ${LIST_FILE} com o motivo.`;

const ISO_DATE_LITERAL = /["'`]\d{4}-\d{2}-\d{2}/g;
const FIXED_CLOCK = new RegExp(
  [
    String.raw`\bclock\s*\.\s*(?:setFixedTime|setSystemTime|pauseAt)\s*\(`,
    String.raw`\bclock\s*\.\s*install\s*\(\s*\{[^}]*\btime\b`,
    String.raw`\buseFakeTimers\s*\(\s*\{[^}]*\bnow\b`,
  ].join("|")
);

/** Whether the source installs a fixed clock in code (a comment or a string that says so does not count). */
export function installsFixedClock(source) {
  return FIXED_CLOCK.test(codeOnly(source));
}

/**
 * How many ISO date literals the code has. A quote that `codeOnly` blanked sits inside a comment,
 * another string or a regular expression, so it opens nothing.
 */
export function countFixedDates(source) {
  const code = codeOnly(source);
  return [...source.matchAll(ISO_DATE_LITERAL)].filter(
    (match) => code[match.index] === match[0][0]
  ).length;
}

export function e2eFixedDateProblems(sources, allowed = E2E_FIXED_DATES_LIST) {
  const found = Object.fromEntries(
    Object.entries(sources).map(([file, source]) => [
      file,
      installsFixedClock(source) ? 0 : countFixedDates(source),
    ])
  );
  return exactCountProblems({
    advice: ADVICE,
    allowed,
    found,
    listFile: LIST_FILE,
    what: "data(s) ISO fixa(s) em teste de navegador sem relógio fixo",
  });
}

export function checkRepository(base = root, allowed = E2E_FIXED_DATES_LIST) {
  const sources = Object.fromEntries(
    walkFiles(base, isPlaywrightFile).map((file) => [
      file,
      readFileSync(path.join(base, file), "utf8"),
    ])
  );
  return e2eFixedDateProblems(sources, allowed);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const problems = checkRepository(process.argv[2] ?? root);
  for (const problem of problems) {
    console.error(problem);
  }
  if (problems.length > 0) {
    console.error(
      `\n${problems.length} problema(s) de data fixa sem relógio fixo em teste de navegador.`
    );
    process.exit(1);
  }
  console.log("Nenhuma data fixa nova em teste de navegador sem relógio fixo.");
}
