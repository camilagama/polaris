import { describe, expect, it } from "vitest";
import { publicCatalogErrorMessage } from "./public-catalog-errors";

const rpcError = (code: string, reason?: string) => ({
  code,
  ...(reason ? { data: { reason } } : {}),
});

describe("publicCatalogErrorMessage", () => {
  it("explains each refusal of the profile in Portuguese", () => {
    for (const reason of [
      "invalid_slug",
      "reserved_slug",
      "invalid_name",
      "invalid_description",
      "invalid_whatsapp",
      "invalid_instagram",
    ]) {
      const message = publicCatalogErrorMessage(
        rpcError("BAD_REQUEST", reason),
        "profile"
      );
      expect(message).not.toBe("Confira os dados informados.");
      expect(message).not.toContain(reason);
    }
    expect(publicCatalogErrorMessage(rpcError("BAD_REQUEST"), "profile")).toBe(
      "Confira os dados informados."
    );
  });

  it("tells the plan, the address, the version and the product conflicts apart", () => {
    const messages = [
      "entitlement_denied",
      "public_catalog_slug_taken",
      "public_catalog_version_conflict",
      "public_catalog_profile_missing",
      "public_catalog_product_unavailable",
    ].map((reason) =>
      publicCatalogErrorMessage(rpcError("CONFLICT", reason), "profile")
    );
    expect(new Set(messages).size).toBe(5);
    expect(messages[0]).toContain("plano");
    expect(messages[1]).toContain("endereço");
  });

  it("never shows a raw code and falls back by the action", () => {
    expect(publicCatalogErrorMessage(new Error("boom"), "load")).toBe(
      "Não foi possível carregar o catálogo público. Tente novamente."
    );
    expect(publicCatalogErrorMessage(new Error("boom"), "switch")).toBe(
      "Não foi possível concluir a operação. Tente novamente."
    );
    expect(publicCatalogErrorMessage(rpcError("FORBIDDEN"), "load")).toContain(
      "não pode gerir"
    );
    expect(publicCatalogErrorMessage(rpcError("UNAUTHORIZED"), "load")).toBe(
      "Não foi possível carregar o catálogo público."
    );
    expect(publicCatalogErrorMessage(rpcError("UNAUTHORIZED"), "profile")).toBe(
      "A alteração do catálogo público não foi salva."
    );
  });
});
