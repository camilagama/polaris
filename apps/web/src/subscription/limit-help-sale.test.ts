import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * AC-8 of the corte 1.6: the sale never meets a limit of the plan. No notice, link or way to the Pro on the screens of
 * the sale (Vender, the detail, the history) nor on the Início, and the server's sale commands never check a limit, so
 * a store at every limit (variants, images, goals) still confirms its sales.
 */
const src = fileURLToPath(new URL("..", import.meta.url));
const db = fileURLToPath(
  new URL("../../../../packages/db/src", import.meta.url)
);

function sourcesIn(dir: string, keep: (name: string) => boolean): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && keep(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
}

const LIMIT_ON_SCREEN =
  /limit-help|LimitHelp|Conhecer o Pro|entitlement_limit_reached|chegou ao limite/;
const LIMIT_CHECK =
  /assertRoomFor|EntitlementLimitReachedError|entitlement-enforcement/;

const isScreenSource = (name: string) =>
  (name.endsWith(".ts") || name.endsWith(".tsx")) && !name.includes(".test.");

describe("a venda não muda com os limites do plano (corte 1.6, AC-8)", () => {
  it("as telas da venda e o Início não têm aviso, link nem caminho até o Pro", () => {
    const files = [
      ...sourcesIn(join(src, "sales"), isScreenSource),
      ...sourcesIn(join(src, "home"), isScreenSource),
    ];
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(LIMIT_ON_SCREEN);
    }
  });

  it("os comandos de venda do servidor nunca conferem um limite do plano", () => {
    const files = sourcesIn(
      db,
      (name) =>
        name.startsWith("sale-") &&
        name.endsWith(".ts") &&
        !name.includes(".test.")
    );
    expect(files.length).toBeGreaterThan(3);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(LIMIT_CHECK);
    }
  });
});
