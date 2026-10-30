import { describe, expect, it, vi } from "vitest";
import { priceErrorMessage } from "./product-variant-price-section";

vi.mock("../lib/orpc", () => ({ orpcClient: {} }));

describe("priceErrorMessage", () => {
  it("o 503 server_busy, ou sem motivo, diz que o preço pode ter sido salvo", () => {
    for (const error of [
      { code: "SERVICE_UNAVAILABLE", data: { reason: "server_busy" } },
      { code: "SERVICE_UNAVAILABLE" },
    ]) {
      const message = priceErrorMessage(error);
      expect(message).toBe(
        "A alteração não foi confirmada. Pode ter sido salva: confira antes de repetir."
      );
      expect(message).not.toContain("Tente novamente");
    }
  });

  it("outro 503 e os demais códigos mantêm o texto de antes", () => {
    expect(
      priceErrorMessage({
        code: "SERVICE_UNAVAILABLE",
        data: { reason: "other" },
      })
    ).toBe("Não foi possível salvar o preço. Tente novamente.");
    expect(priceErrorMessage({ code: "BAD_REQUEST" })).toBe(
      "Informe um valor em reais, como 59,90."
    );
  });
});
