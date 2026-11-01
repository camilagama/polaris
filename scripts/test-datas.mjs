import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Local sweep: runs the node suites of apps/admin, apps/catalog and packages/* (minus packages/db) with the system
 * clock pinned (POLARIS_TEST_NOW) at critical instants, under two time zones. Not part of `bun run check` or CI:
 * it is 8 full runs of the suites.
 *
 *   bun run test:datas                      every instant, both zones
 *   bun run test:datas --instante virada-do-ano --tz UTC -- packages/billing
 *
 * Everything after `--` goes to Vitest as a file filter.
 */
const INSTANTES = [
  { chave: "dia-1-0030", now: "2026-11-01T03:30:00Z" },
  { chave: "ultimo-dia-2350", now: "2026-11-01T02:50:00Z" },
  { chave: "virada-do-ano", now: "2027-01-01T02:50:00Z" },
  { chave: "bissexto-1200", now: "2028-02-29T15:00:00Z" },
];

const FUSOS = ["America/Sao_Paulo", "UTC"];

function parseArgs(argv) {
  const separator = argv.indexOf("--");
  const own = separator === -1 ? argv : argv.slice(0, separator);
  const filters = separator === -1 ? [] : argv.slice(separator + 1);
  const options = { filters, instante: null, tz: null };
  for (let i = 0; i < own.length; i += 2) {
    const flag = own[i];
    const value = own[i + 1];
    if (!["--instante", "--tz"].includes(flag)) {
      throw new Error(`argumento desconhecido: ${flag}`);
    }
    if (value === undefined) {
      throw new Error(`${flag} pede um valor`);
    }
    options[flag === "--instante" ? "instante" : "tz"] = value;
  }
  return options;
}

function selectRuns(options) {
  const instantes = INSTANTES.filter(
    (item) => options.instante === null || item.chave === options.instante
  );
  const fusos = FUSOS.filter((tz) => options.tz === null || tz === options.tz);
  if (instantes.length === 0 || fusos.length === 0) {
    throw new Error(
      `nenhuma rodada: instantes ${INSTANTES.map((item) => item.chave).join(", ")}; fusos ${FUSOS.join(", ")}`
    );
  }
  return instantes.flatMap((instante) => fusos.map((tz) => ({ instante, tz })));
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const vitest = fileURLToPath(
    new URL("../node_modules/vitest/vitest.mjs", import.meta.url)
  );
  const config = fileURLToPath(
    new URL("../vitest.datas.config.ts", import.meta.url)
  );
  const results = [];
  for (const { instante, tz } of selectRuns(options)) {
    console.log(`\n=== ${instante.chave} ${instante.now} TZ=${tz} ===`);
    const run = spawnSync(
      process.execPath,
      [vitest, "run", "--config", config, ...options.filters],
      {
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

main();
