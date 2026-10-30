import { describe, expect, it, vi } from "vitest";
import { CHANGE_FAULT_UNKNOWN } from "../lib/rpc-error";
import {
  offersCheckAndClose,
  SAVE_NOT_CONFIRMED_TEXT,
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
