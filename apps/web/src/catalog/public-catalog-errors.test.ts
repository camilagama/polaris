import { describe, expect, it } from "vitest";
import {
  profileFieldError,
  publicCatalogErrorMessage,
} from "./public-catalog-errors";

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
      "não pode mexer"
    );
    expect(publicCatalogErrorMessage(rpcError("UNAUTHORIZED"), "load")).toBe(
      "Não foi possível carregar o catálogo público."
    );
    expect(publicCatalogErrorMessage(rpcError("UNAUTHORIZED"), "profile")).toBe(
      "A alteração do catálogo público não foi salva."
    );
  });
});

describe("profileFieldError (U-48)", () => {
  it("says which field a refused save is about", () => {
    expect(
      profileFieldError(rpcError("BAD_REQUEST", "invalid_slug"))
    ).toMatchObject({
      field: "slug",
    });
    expect(
      profileFieldError(rpcError("BAD_REQUEST", "reserved_slug"))
    ).toMatchObject({
      field: "slug",
    });
    expect(
      profileFieldError(rpcError("CONFLICT", "public_catalog_slug_taken"))
    ).toMatchObject({
      field: "slug",
      message: expect.stringContaining("em uso"),
    });
    expect(
      profileFieldError(rpcError("BAD_REQUEST", "invalid_name"))
    ).toMatchObject({
      field: "publicName",
    });
  });

  it("leaves what is not about one field to the message beside the button", () => {
    expect(profileFieldError(rpcError("BAD_REQUEST"))).toBeNull();
    expect(
      profileFieldError(rpcError("CONFLICT", "entitlement_denied"))
    ).toBeNull();
    expect(profileFieldError(rpcError("SERVICE_UNAVAILABLE"))).toBeNull();
    expect(profileFieldError(new Error("offline"))).toBeNull();
  });
});

describe("publicCatalogErrorMessage com o 503 de uma escrita", () => {
  const busy = rpcError("SERVICE_UNAVAILABLE", "server_busy");

  it("salvar o perfil, o interruptor e os produtos dizem que pode ter sido salvo", () => {
    for (const action of ["profile", "switch", "products"] as const) {
      const message = publicCatalogErrorMessage(busy, action);
      expect(message).toBe(
        "A alteração não foi confirmada. Pode ter sido salva: confira antes de repetir."
      );
      expect(
        publicCatalogErrorMessage(rpcError("SERVICE_UNAVAILABLE"), action)
      ).toBe(message);
    }
  });

  it("um 503 com outro motivo também é dúvida de escrita, e a leitura mantém o texto dela", () => {
    const other = rpcError("SERVICE_UNAVAILABLE", "other");
    for (const action of ["profile", "switch", "products"] as const) {
      expect(publicCatalogErrorMessage(other, action)).toBe(
        "A alteração não foi confirmada. Pode ter sido salva: confira antes de repetir."
      );
    }
    for (const error of [busy, other]) {
      expect(publicCatalogErrorMessage(error, "load")).toBe(
        "O catálogo público está temporariamente indisponível. Tente novamente."
      );
    }
  });
});
