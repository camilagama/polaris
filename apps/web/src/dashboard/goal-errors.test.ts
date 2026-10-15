import { describe, expect, it } from "vitest";
import { goalErrorMessage } from "./goal-errors";

describe("goalErrorMessage", () => {
  it("explains the codes every goal request can fail with", () => {
    expect(goalErrorMessage({ code: "UNAUTHORIZED" }, "load")).toContain(
      "sessão"
    );
    expect(goalErrorMessage({ code: "FORBIDDEN" }, "create")).toContain(
      "não tem acesso"
    );
    expect(goalErrorMessage({ code: "NOT_FOUND" }, "cancel")).toContain(
      "não existe mais"
    );
    expect(goalErrorMessage({ code: "SERVICE_UNAVAILABLE" }, "load")).toContain(
      "temporariamente indisponíveis"
    );
  });

  it("says what is wrong with a refused goal, by action", () => {
    expect(goalErrorMessage({ code: "BAD_REQUEST" }, "create")).toContain(
      "366 dias"
    );
    expect(goalErrorMessage({ code: "BAD_REQUEST" }, "update")).toContain(
      "alvo"
    );
    expect(goalErrorMessage({ code: "BAD_REQUEST" }, "cancel")).toBe(
      "Não foi possível concluir a operação. Tente novamente."
    );
  });

  it("explains a stale version or a goal that is no longer active", () => {
    expect(goalErrorMessage({ code: "CONFLICT" }, "update")).toContain(
      "já não está em andamento"
    );
    expect(goalErrorMessage({ code: "CONFLICT" }, "cancel")).toContain(
      "A lista foi atualizada"
    );
  });

  it("falls back to a message for the action", () => {
    expect(goalErrorMessage(new Error("boom"), "load")).toBe(
      "Não foi possível carregar as metas. Tente novamente."
    );
    expect(goalErrorMessage({ code: "INTERNAL_SERVER_ERROR" }, "history")).toBe(
      "Não foi possível carregar o histórico do alvo. Tente novamente."
    );
    expect(goalErrorMessage({ code: "INTERNAL_SERVER_ERROR" }, "update")).toBe(
      "Não foi possível concluir a operação. Tente novamente."
    );
  });
});
