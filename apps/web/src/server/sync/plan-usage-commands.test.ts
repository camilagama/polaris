import { describe, expect, it } from "vitest";
import { PLAN_USAGE_NEUTRAL_COMMAND_TYPES } from "../../lib/plan-usage-changes";
import { syncCommandHandlers } from "./registry";

describe("os comandos da fila e o uso do plano", () => {
  it("todo comando que o servidor aceita é neutro para o uso do plano ou apaga a leitura guardada, e só product.create apaga", () => {
    const erasing = syncCommandHandlers
      .map((handler) => handler.type)
      .filter((type) => !PLAN_USAGE_NEUTRAL_COMMAND_TYPES.includes(type));
    expect(erasing).toEqual(["product.create"]);
  });

  it("a lista de tipos neutros só tem tipos que o servidor aceita", () => {
    const accepted = syncCommandHandlers.map((handler) => handler.type);
    for (const type of PLAN_USAGE_NEUTRAL_COMMAND_TYPES) {
      expect(accepted).toContain(type);
    }
  });
});
