import { describe, expect, it, vi } from "vitest";
import { CHANGE_FAULT_UNKNOWN } from "../lib/rpc-error";
import {
  errorText,
  lifecycleNotConfirmedText,
  offersCheckAndClose,
  SAVE_NOT_CONFIRMED_TEXT,
  saveNotConfirmedText,
} from "./payment-profiles-page";

vi.mock("../lib/orpc", () => ({ orpcClient: {} }));

describe("offersCheckAndClose", () => {
  it("todo aviso de dúvida que cita Fechar e conferir mostra o botão", () => {
    expect(offersCheckAndClose(SAVE_NOT_CONFIRMED_TEXT)).toBe(true);
    expect(
      offersCheckAndClose(`O servidor está ocupado. ${SAVE_NOT_CONFIRMED_TEXT}`)
    ).toBe(true);
    expect(offersCheckAndClose(CHANGE_FAULT_UNKNOWN)).toBe(true);
  });

  it("sem dúvida, ou com o texto de outra tela, não mostra o botão", () => {
    expect(offersCheckAndClose(null)).toBe(false);
    expect(offersCheckAndClose("Este perfil pode já ter sido salvo.")).toBe(
      false
    );
  });
});

describe("o 503 de Formas de receber", () => {
  const otherReason = {
    code: "SERVICE_UNAVAILABLE",
    data: { reason: "other" },
  };

  it("numa escrita, qualquer motivo dá o aviso de alteração não confirmada e pede conferir", () => {
    for (const error of [
      otherReason,
      { code: "SERVICE_UNAVAILABLE", data: { reason: "server_busy" } },
      { code: "SERVICE_UNAVAILABLE" },
    ]) {
      expect(saveNotConfirmedText(error)).toBe(CHANGE_FAULT_UNKNOWN);
    }
    expect(offersCheckAndClose(saveNotConfirmedText(otherReason))).toBe(true);
  });

  it("ao arquivar ou restaurar, qualquer motivo dá o aviso de alteração não confirmada", () => {
    for (const error of [
      otherReason,
      { code: "SERVICE_UNAVAILABLE", data: { reason: "server_busy" } },
      { code: "SERVICE_UNAVAILABLE" },
    ]) {
      expect(lifecycleNotConfirmedText(error)).toBe(CHANGE_FAULT_UNKNOWN);
    }
    expect(lifecycleNotConfirmedText({ code: "CONFLICT" })).toBeNull();
  });

  it("numa leitura, mantém o texto de antes", () => {
    expect(
      errorText(
        otherReason,
        "os perfis de pagamento",
        "Não foi possível carregar os perfis. Tente novamente."
      )
    ).toBe("Não foi possível carregar os perfis. Tente novamente.");
  });
});
