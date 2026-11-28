// @vitest-environment happy-dom
import type { ExpenseCategoryReadModel } from "@polaris/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dialog } from "@/ui/dialog";
import { ExpenseForm } from "./expense-form";
import { ExpenseRuleForm } from "./expense-rule-form";

vi.mock("../lib/browser-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/browser-connection")>()),
  useConnectionOnline: () => true,
}));

const category = {
  archivedAt: null,
  groupKey: "operational",
  id: "f0000000-0000-4000-8000-000000000001",
  name: "Frete",
  status: "active",
  systemKey: null,
} as ExpenseCategoryReadModel;

const noop = () => undefined;
const resolveTrue = () => Promise.resolve(true);

afterEach(cleanup);

function addonOf(field: HTMLElement): string | undefined {
  return field
    .closest("[data-slot=input-group]")
    ?.querySelector("[data-slot=input-group-addon]")?.textContent;
}

describe("o R$ do valor da despesa fica dentro do campo", () => {
  it("a despesa avulsa chama o campo só de Valor e põe o R$ no addon", () => {
    render(
      <Dialog open>
        <ExpenseForm
          categories={[category]}
          disabled={false}
          editing={null}
          feedback={null}
          onCancel={noop}
          onDraftChange={noop}
          onSave={resolveTrue}
          saving={false}
          today="2026-11-27"
        />
      </Dialog>
    );
    const field = screen.getByLabelText("Valor", { exact: true });
    expect(addonOf(field)).toBe("R$");
  });

  it("a recorrente chama o campo de Valor de cada ocorrência e põe o R$ no addon", () => {
    render(
      <Dialog open>
        <ExpenseRuleForm
          categories={[category]}
          disabled={false}
          editing={null}
          feedback={null}
          onCancel={noop}
          onDraftChange={noop}
          onSave={resolveTrue}
          saving={false}
          today="2026-11-27"
        />
      </Dialog>
    );
    const field = screen.getByLabelText("Valor de cada ocorrência", {
      exact: true,
    });
    expect(addonOf(field)).toBe("R$");
  });
});
