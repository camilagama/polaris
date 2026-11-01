import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../..", import.meta.url));

const INSTANTS = [
  { name: "inicio-do-mes", now: "2026-11-01T03:30:00Z" },
  { name: "fim-do-mes", now: "2026-12-01T02:50:00Z" },
  { name: "virada-do-ano", now: "2027-01-01T02:50:00Z" },
  { name: "bissexto", now: "2028-02-29T15:00:00Z" },
] as const;

const TIME_ZONES = ["America/Sao_Paulo", "UTC"] as const;

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

const onlyInstant = option("instante");
const onlyZone = option("tz");
const separator = process.argv.indexOf("--");
const vitestArguments =
  separator === -1 ? [] : process.argv.slice(separator + 1);

const instants = INSTANTS.filter(
  (instant) => !onlyInstant || instant.name === onlyInstant
);
const zones = TIME_ZONES.filter((zone) => !onlyZone || zone === onlyZone);
if (instants.length === 0 || zones.length === 0) {
  console.error(
    `Instante ou fuso desconhecido. Instantes: ${INSTANTS.map((instant) => instant.name).join(", ")}. Fusos: ${TIME_ZONES.join(", ")}.`
  );
  process.exit(2);
}

const results: { label: string; status: number | null }[] = [];
for (const instant of instants) {
  for (const zone of zones) {
    const label = `${instant.name} ${instant.now} TZ=${zone}`;
    console.log(`\n== ${label}`);
    const run = spawnSync(
      "bunx",
      [
        "vitest",
        "run",
        "--config",
        "apps/web/vitest.clock.config.ts",
        ...vitestArguments,
      ],
      {
        cwd: root,
        env: { ...process.env, POLARIS_TEST_NOW: instant.now, TZ: zone },
        stdio: "inherit",
      }
    );
    results.push({ label, status: run.status });
  }
}

console.log("\nResumo:");
for (const result of results) {
  console.log(`${result.status === 0 ? "ok    " : "FALHOU"} ${result.label}`);
}
process.exit(results.every((result) => result.status === 0) ? 0 : 1);
