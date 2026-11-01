/**
 * Local sweep: runs the node suites of apps/web, apps/admin, apps/catalog and packages/* (minus packages/db) with the
 * system clock frozen (POLARIS_TEST_NOW) at critical instants, under two time zones. Not part of `bun run check` or CI.
 *
 *   bun run test:datas                      every instant, both zones
 *   bun run test:datas --instante virada-do-ano --tz UTC apps/web
 *
 * The first argument that is not a flag, or everything after `--`, goes to Vitest as a file filter. (`bun run` drops a leading
 * `--`, so `bun run test:datas -- apps/web` reaches this script as `apps/web`.)
 */
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FUSOS, INSTANTES } from "./test-clock/instants.mjs";

export function parseArgs(argv) {
  const options = { filters: [], instante: null, tz: null };
  let i = 0;
  while (i < argv.length && argv[i] !== "--" && argv[i].startsWith("--")) {
    const flag = argv[i];
    if (flag !== "--instante" && flag !== "--tz") {
      throw new Error(`argumento desconhecido: ${flag}`);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${flag} pede um valor`);
    }
    options[flag === "--instante" ? "instante" : "tz"] = value;
    i += 2;
  }
  options.filters = argv.slice(argv[i] === "--" ? i + 1 : i);
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
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  main();
}
