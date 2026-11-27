// @vitest-environment happy-dom
import type { GoalReadModel } from "@polaris/contracts";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GoalHistoryBody } from "./goal-history";

const targetChanges = vi.hoisted(() => vi.fn());

vi.mock("../lib/orpc", () => ({
  orpcClient: { goal: { targetChanges } },
}));

function renderHistory() {
  return render(
    <GoalHistoryBody
      goal={
        { id: "g1", kind: "net_sales", version: 1 } as unknown as GoalReadModel
      }
      open
      organizationId="o1"
      timezone="UTC"
    />
  );
}

afterEach(() => {
  cleanup();
  targetChanges.mockReset();
});

describe("o histórico do alvo", () => {
  it("espera com o esqueleto de uma linha escondido e a frase só para o leitor de tela, num status", () => {
    targetChanges.mockReturnValue(new Promise(() => undefined));
    const { container } = renderHistory();
    const status = screen.getByRole("status");
    expect(within(status).getByText("Carregando o histórico…").className).toBe(
      "sr-only"
    );
    expect(status.textContent).toBe("Carregando o histórico…");
    const shape = container.querySelector('[data-slot="skeleton"]');
    expect(shape?.parentElement?.getAttribute("aria-hidden")).toBe("true");
    expect(shape?.parentElement?.className).toContain("h-4.5");
  });

  it("sem alteração diz que o alvo nunca foi alterado, no lugar do esqueleto", async () => {
    targetChanges.mockResolvedValue({ changes: [] });
    const { container } = renderHistory();
    expect(await screen.findByText("O alvo nunca foi alterado.")).toBeTruthy();
    expect(container.querySelector('[data-slot="skeleton"]')).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });
});
