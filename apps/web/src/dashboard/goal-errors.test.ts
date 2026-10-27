import { describe, expect, it } from "vitest";
import {
  GOAL_LIMIT_CANCEL_HINT,
  GOAL_LIMIT_REACHED,
  goalErrorMessage,
} from "./goal-errors";

/** Trying again never frees a place, and the text has no number. */
const NOT_IN_LIMIT_TEXT = /Tente novamente|\d/;

describe("goalErrorMessage", () => {
  it("explains the codes every goal request can fail with", () => {
    expect(goalErrorMessage({ code: "UNAUTHORIZED" }, "load")).toBe(
      "Não foi possível carregar as metas."
    );
    expect(goalErrorMessage({ code: "UNAUTHORIZED" }, "update")).toBe(
      "A meta não foi alterada."
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

  it("says a goal the plan pauses is paused, not that it changed elsewhere", () => {
    const message = goalErrorMessage(
      { code: "CONFLICT", data: { reason: "goal_paused_by_plan" } },
      "update"
    );
    expect(message).toContain("pausada");
    expect(message).not.toContain("mudou em outra solicitação");
  });

  it("says the plan's limit of goals on create, never 'try again' (L5 of the corte 1.6, AC-4)", () => {
    const limit = {
      code: "CONFLICT",
      data: { reason: "entitlement_limit_reached" },
    };
    expect(goalErrorMessage(limit, "create")).toBe(GOAL_LIMIT_REACHED);
    expect(GOAL_LIMIT_REACHED).toBe(
      "Seu plano chegou ao limite de metas em andamento. Nada foi criado."
    );
    expect(goalErrorMessage(limit, "create")).not.toMatch(NOT_IN_LIMIT_TEXT);
    // the paused goal keeps its text
    expect(
      goalErrorMessage(
        { code: "CONFLICT", data: { reason: "goal_paused_by_plan" } },
        "update"
      )
    ).toContain("está pausada");
    expect(GOAL_LIMIT_CANCEL_HINT).toBe("Cancele uma meta para abrir lugar.");
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
