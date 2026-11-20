import { describe, expect, it } from "vitest";
import {
  LIST_REFRESH_FAILED_TEXT,
  LIST_REFRESHING_TEXT,
} from "./list-refresh-text";

describe("list-refresh-text", () => {
  it("keeps the exact words shown on screen", () => {
    expect(LIST_REFRESHING_TEXT).toBe("Atualizando a lista…");
    expect(LIST_REFRESH_FAILED_TEXT).toBe(
      "Não foi possível atualizar a lista. O que está na tela pode estar desatualizado."
    );
  });
});
