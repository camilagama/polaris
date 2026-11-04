import { LEGAL_DOCUMENT_IDS } from "@polaris/domain/legal/legal-documents";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const MARKER_START = "[preencher";

async function pagesWith(day: string | undefined) {
  vi.resetModules();
  vi.stubEnv("VITE_LEGAL_VIGENCIA", day);
  const { LegalPage } = await import("../legal/legal-page");
  const { acceptanceVersionLine } = await import(
    "../legal/acceptance/acceptance-model"
  );
  return {
    acceptance: LEGAL_DOCUMENT_IDS.map((document) =>
      acceptanceVersionLine({
        changes: null,
        document,
        effectiveFrom: null,
        version: 1,
      })
    ),
    pages: LEGAL_DOCUMENT_IDS.map((document) =>
      renderToStaticMarkup(<LegalPage document={document} />)
    ),
  };
}

describe("the day the texts came into force, from the build", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("with the variable, no legal page and no acceptance line carries a pending marker", async () => {
    const { acceptance, pages } = await pagesWith("2026-11-04");
    expect(pages).toHaveLength(2);
    for (const html of pages) {
      expect(html).toContain("Em vigor desde: 04/11/2026.");
      expect(html.toLowerCase()).not.toContain(MARKER_START);
    }
    for (const line of acceptance) {
      expect(line).toBe("Versão 1. Em vigor desde: 04/11/2026.");
    }
  });

  it.each([undefined, "", "04/11/2026"])(
    "with the variable %j the pages keep the marker of the draft",
    async (day) => {
      const { acceptance, pages } = await pagesWith(day);
      for (const html of pages) {
        expect(html).toContain("[preencher na publicação]");
      }
      for (const line of acceptance) {
        expect(line).toContain("[preencher na publicação]");
      }
    }
  );
});
