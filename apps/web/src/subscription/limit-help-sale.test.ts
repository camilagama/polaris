import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * AC-8 of the corte 1.6: the sale never meets a limit of the plan. No notice, link or way to the Pro on the screens of
 * the sale (Vender, the detail, the history), and the server's sale commands never check a limit, so a store at every
 * limit (variants, images, goals) still confirms its sales. The Início has no warning of the limit either: the card of the
 * plan lives in the shell, so no file of the Início may name the help.
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

const HOME_FORBIDDEN =
  /Conhecer o Pro|entitlement_limit_reached|chegou ao limite|LimitHelp\b|useLimitHelp/;

describe("a venda não muda com os limites do plano (corte 1.6, AC-8)", () => {
  it("as telas da venda não têm aviso, link nem caminho até o Pro", () => {
    const files = sourcesIn(join(src, "sales"), isScreenSource);
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(LIMIT_ON_SCREEN);
    }
  });

  it("o Início não nomeia o aviso de limite, nem o texto da recusa, nem o link", () => {
    const files = sourcesIn(join(src, "home"), isScreenSource);
    expect(files.length).toBeGreaterThan(10);
    const naming = files
      .filter((file) => LIMIT_ON_SCREEN.test(readFileSync(file, "utf8")))
      .map((file) => file.slice(file.lastIndexOf("/") + 1))
      .sort();
    expect(naming).toEqual([]);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(HOME_FORBIDDEN);
    }
  });

  it("os controles plantados reprovam: a regra pega cada forma que a venda ou o Início não podem ter", () => {
    for (const planted of [
      'import { LimitHelp } from "../subscription/limit-help";',
      '<a href="/x">Conhecer o Pro</a>',
      'reason === "entitlement_limit_reached"',
      "Você chegou ao limite de 50 variantes",
    ]) {
      expect(planted).toMatch(LIMIT_ON_SCREEN);
    }
    expect("const limitHelpFor = 1;").not.toMatch(LIMIT_ON_SCREEN);
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
