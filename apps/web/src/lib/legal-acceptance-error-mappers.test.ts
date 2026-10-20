import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { periodSummaryErrorMessage } from "../dashboard/dashboard-errors";
import { goalErrorMessage } from "../dashboard/goal-errors";
import { expenseErrorMessage } from "../expenses/expense-errors";
import { mapStockError } from "../inventory/stock-command-model";
import { revokeFailure } from "../offline/runtime/devices-model";
import { setupErrorMessage } from "../organization/organization-setup-model";
import { publicCatalogErrorMessage } from "../catalog/public-catalog-errors";
import { mapCancelError } from "../sales/sale-cancellation-model";
import { mapLinkError } from "../sales/sale-customer-link-model";
import { loadErrorMessage, mapSaleSubmitError } from "../sales/sale-form-model";
import { mapReturnError } from "../sales/sale-return-model";
import {
  legalAcceptanceMessage,
  legalAcceptanceWriteMessage,
  readErrorMessage,
} from "./rpc-error";

const refusal = Object.assign(new Error("Forbidden"), {
  code: "FORBIDDEN",
  data: {
    pending: [{ document: "terms", version: 1 }],
    reason: "legal_acceptance_required",
  },
  status: 403,
});
const plainForbidden = Object.assign(new Error("Forbidden"), {
  code: "FORBIDDEN",
});

const WRITE_TEXT =
  "Não foi feito: falta aceitar os Termos de Uso e a Política de Privacidade.";
const MISSING = "falta aceitar os Termos de Uso e a Política de Privacidade.";

describe("the shared text of the missing legal acceptance", () => {
  it("is a write refusal without a subject and a failed read with one", () => {
    expect(legalAcceptanceWriteMessage).toBe(WRITE_TEXT);
    expect(legalAcceptanceMessage(refusal)).toBe(WRITE_TEXT);
    expect(legalAcceptanceMessage(refusal, "as categorias")).toBe(
      `Não foi possível carregar as categorias: ${MISSING}`
    );
  });

  it("leaves every other error to the mapper of the screen", () => {
    expect(legalAcceptanceMessage(plainForbidden)).toBeUndefined();
    expect(legalAcceptanceMessage({ code: "UNAUTHORIZED" })).toBeUndefined();
    expect(legalAcceptanceMessage(new TypeError("Failed to fetch"))).toBe(
      undefined
    );
  });
});

describe("every screen error mapper treats the refusal for the missing acceptance", () => {
  const writeMappers: [string, (error: unknown) => string][] = [
    ["mapCancelError", (error) => mapCancelError(error).message],
    ["mapReturnError", (error) => mapReturnError(error).message],
    ["mapLinkError", (error) => mapLinkError(error).message],
    ["mapStockError", (error) => mapStockError("receive", error).message],
    ["setupErrorMessage", setupErrorMessage],
    [
      "revokeFailure",
      (error) => {
        const failure = revokeFailure(error);
        return failure.kind === "message" ? failure.text : "";
      },
    ],
    [
      "expenseErrorMessage(save)",
      (error) => expenseErrorMessage(error, "save"),
    ],
    ["goalErrorMessage(update)", (error) => goalErrorMessage(error, "update")],
    [
      "publicCatalogErrorMessage(switch)",
      (error) => publicCatalogErrorMessage(error, "switch"),
    ],
  ];
  const readMappers: [string, (error: unknown) => string, string][] = [
    ["readErrorMessage", (error) => readErrorMessage(error, "x"), "x"],
    ["loadErrorMessage", (error) => loadErrorMessage(error, "x"), "x"],
    ["periodSummaryErrorMessage", periodSummaryErrorMessage, "o resultado"],
    [
      "expenseErrorMessage(load)",
      (error) => expenseErrorMessage(error, "load"),
      "as despesas",
    ],
    [
      "goalErrorMessage(load)",
      (error) => goalErrorMessage(error, "load"),
      "as metas",
    ],
    [
      "publicCatalogErrorMessage(load)",
      (error) => publicCatalogErrorMessage(error, "load"),
      "o catálogo público",
    ],
  ];

  it.each(writeMappers)(
    "%s says what is missing, not a lack of access",
    (_name, map) => {
      expect(map(refusal)).toBe(WRITE_TEXT);
      expect(map(plainForbidden)).not.toContain("aceitar");
    }
  );

  it.each(readMappers)(
    "%s says it could not load, and why",
    (_name, map, subject) => {
      expect(map(refusal)).toBe(
        `Não foi possível carregar ${subject}: ${MISSING}`
      );
      expect(map(plainForbidden)).not.toContain("aceitar");
    }
  );

  it("mapSaleSubmitError keeps the items and names the acceptance", () => {
    expect(mapSaleSubmitError(refusal).message).toContain(
      "falta aceitar os Termos de Uso"
    );
  });

  it("keeps editing open: a refusal is definite, nothing is locked or discarded", () => {
    for (const failure of [
      mapCancelError(refusal),
      mapReturnError(refusal),
      mapStockError("count", refusal),
    ]) {
      expect(failure.unknownOutcome).toBe(false);
      expect(failure.discardAttempt).toBe(false);
    }
  });
});

const SOURCE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOURCE_FILE = /\.(ts|tsx)$/;
const MAPS_FORBIDDEN = /(===|case) "FORBIDDEN"/;
const TREATS_REFUSAL = /legalAcceptanceMessage\(|isLegalAcceptanceRefusal\(/;
const TEST_FILE = /\.test\.(ts|tsx)$/;
/** Files that name FORBIDDEN without mapping it to a text of a screen, and why. */
const NOT_SCREEN_MAPPERS = new Map([
  ["lib/rpc-error.ts", "defines the helper"],
  [
    "offline/runtime/offline-runtime.ts",
    "pauses the sync before the session refusal",
  ],
]);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "server" ? [] : sourceFiles(path);
    }
    return SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name)
      ? [path]
      : [];
  });
}

describe("the screens that map FORBIDDEN", () => {
  it("all call the shared helper first: none says 'sua conta não tem acesso' for a missing acceptance", () => {
    const missing = sourceFiles(SOURCE_ROOT)
      .map((path) => relative(SOURCE_ROOT, path))
      .filter((path) => !NOT_SCREEN_MAPPERS.has(path))
      .filter((path) => {
        const text = readFileSync(join(SOURCE_ROOT, path), "utf8");
        return MAPS_FORBIDDEN.test(text) && !TREATS_REFUSAL.test(text);
      });
    expect(missing).toEqual([]);
  });
});
