import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FUSOS, INSTANTES } from "./test-clock/instants.mjs";

/**
 * Local sweep: runs the node suites of apps/web, apps/admin, apps/catalog and packages/* (minus packages/db) with the
 * system clock frozen (POLARIS_TEST_NOW) at critical instants, under two time zones. Not part of `bun run check` or CI.
 *
 *   bun run test:datas                      every instant, both zones
 *   bun run test:datas --instante virada-do-ano --tz UTC -- apps/web
 *
 * Everything after `--` goes to Vitest as a file filter.
 */
export function parseArgs(argv) {
  const separator = argv.indexOf("--");
  const own = separator === -1 ? argv : argv.slice(0, separator);
  const filters = separator === -1 ? [] : argv.slice(separator + 1);
  const options = { filters, instante: null, tz: null };
  for (let i = 0; i < own.length; i += 2) {
    const flag = own[i];
    if (flag !== "--instante" && flag !== "--tz") {
      throw new Error(`argumento desconhecido: ${flag}`);
    }
    const value = own[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${flag} pede um valor`);
    }
    options[flag === "--instante" ? "instante" : "tz"] = value;
  }
  return options;
}

export function selectRuns(options) {
  if (
    options.instante !== null &&
    !INSTANTES.some((item) => item.chave === options.instante)
  ) {
    throw new Error(
      `instante desconhecido: ${options.instante}. Instantes: ${INSTANTES.map((item) => item.chave).join(", ")}`
    );
  }
  if (options.tz !== null && !FUSOS.includes(options.tz)) {
    throw new Error(
      `fuso desconhecido: ${options.tz}. Fusos: ${FUSOS.join(", ")}`
    );
  }
  const instantes = INSTANTES.filter(
    (item) => options.instante === null || item.chave === options.instante
  );
  const fusos = FUSOS.filter((tz) => options.tz === null || tz === options.tz);
  return instantes.flatMap((instante) => fusos.map((tz) => ({ instante, tz })));
}

function main() {
  let plan;
  try {
    const options = parseArgs(process.argv.slice(2));
    plan = { filters: options.filters, runs: selectRuns(options) };
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  const { filters, runs } = plan;
  const vitest = fileURLToPath(
    new URL("../node_modules/vitest/vitest.mjs", import.meta.url)
  );
  const config = fileURLToPath(
    new URL("../vitest.datas.config.ts", import.meta.url)
  );
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  const results = [];
  for (const { instante, tz } of runs) {
    console.log(`\n=== ${instante.chave} ${instante.now} TZ=${tz} ===`);
    const run = spawnSync(
      process.execPath,
      [vitest, "run", "--config", config, ...filters],
      {
        cwd,
        env: { ...process.env, POLARIS_TEST_NOW: instante.now, TZ: tz },
        stdio: "inherit",
      }
    );
    if (run.error) {
      console.error(`vitest não iniciou: ${run.error.message}`);
    }
    results.push({ instante: instante.chave, status: run.status, tz });
  }
  console.log("\nResumo");
  for (const { instante, status, tz } of results) {
    console.log(`${status === 0 ? "ok    " : "FALHOU"} ${instante} ${tz}`);
  }
  process.exit(results.every((item) => item.status === 0) ? 0 : 1);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
