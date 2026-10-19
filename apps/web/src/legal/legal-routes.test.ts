import { describe, expect, it } from "vitest";
import { resolveRoute } from "../app-shell/navigation-model";
import { resolveLegalRoute } from "./legal-routes";

describe("the legal routes", () => {
  it("open the two public documents, with or without a trailing slash", () => {
    expect(resolveLegalRoute("/privacidade")).toBe("privacy");
    expect(resolveLegalRoute("/privacidade/")).toBe("privacy");
    expect(resolveLegalRoute("/termos")).toBe("terms");
  });

  it("leave every other address to the store", () => {
    for (const path of [
      "/",
      "/sales",
      "/termos/versoes/1",
      "/Termos",
      "/privacidade.html",
      "/terms",
    ]) {
      expect(resolveLegalRoute(path)).toBeNull();
    }
  });

  it("are not routes of the store, which would put the menu and the organization around them", () => {
    expect(resolveRoute("/termos").kind).toBe("not-found");
    expect(resolveRoute("/privacidade").kind).toBe("not-found");
  });
});
