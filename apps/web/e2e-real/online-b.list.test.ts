import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ONLINE_B_JOURNEYS } from "./online-b.list";

const here = dirname(fileURLToPath(import.meta.url));
const NEEDS_THE_RUNTIME_PREVIEW = [
  "jornadas/encerramento.e2e.ts",
  "jornadas/encerramento-aparelho.e2e.ts",
  "jornadas/resultado-historico-offline.e2e.ts",
  "jornadas/venda-saldo-curto-sem-conexao.e2e.ts",
  "jornadas/venda-dividida-sem-conexao.e2e.ts",
  "jornadas/sair-e-recarregar.e2e.ts",
  "jornadas/estoque-produto-sem-conexao.e2e.ts",
];

describe("the journeys of the second online part", () => {
  it("names each file once, in order, and every one exists in jornadas/", () => {
    expect(new Set(ONLINE_B_JOURNEYS).size).toBe(ONLINE_B_JOURNEYS.length);
    expect([...ONLINE_B_JOURNEYS]).toEqual([...ONLINE_B_JOURNEYS].sort());
    for (const file of ONLINE_B_JOURNEYS) {
      expect(existsSync(join(here, file)), file).toBe(true);
    }
  });

  it("holds no journey that needs the runtime preview", () => {
    for (const file of ONLINE_B_JOURNEYS) {
      expect(NEEDS_THE_RUNTIME_PREVIEW, file).not.toContain(file);
    }
  });

  it("leaves the other half to the online project", () => {
    const onlineJourneys = readdirSync(join(here, "jornadas")).filter(
      (name) =>
        name.endsWith(".e2e.ts") &&
        !NEEDS_THE_RUNTIME_PREVIEW.includes(`jornadas/${name}`)
    );
    expect(onlineJourneys.length).toBeGreaterThan(ONLINE_B_JOURNEYS.length + 5);
  });
});
