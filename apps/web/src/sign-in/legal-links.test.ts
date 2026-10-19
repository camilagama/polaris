import { describe, expect, it } from "vitest";
import { LEGAL_LINKS, LEGAL_PAGES_PUBLISHED } from "./legal-links";

describe("the legal links", () => {
  it("point to the two pages the P6 pull request brings", () => {
    expect(LEGAL_LINKS).toEqual({ privacy: "/privacidade", terms: "/termos" });
  });

  it("stay off until those pages exist in the app (no link that leads to 'Página não encontrada')", async () => {
    const { resolveRoute } = await import("../app-shell/navigation-model");
    const pagesExist =
      resolveRoute(LEGAL_LINKS.privacy).kind === "page" &&
      resolveRoute(LEGAL_LINKS.terms).kind === "page";
    expect(LEGAL_PAGES_PUBLISHED).toBe(pagesExist);
  });
});
