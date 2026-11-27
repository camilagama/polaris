// @vitest-environment happy-dom
import type {
  ExpenseCategoryReadModel,
  ExpenseReadModel,
} from "@polaris/contracts";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Dialog } from "@/ui/dialog";
import { ExpenseForm } from "./expense-form";
import {
  COMPETENCE_TOO_FAR_AHEAD_MESSAGE,
  type ExpenseDraft,
} from "./expense-model";

vi.mock("../lib/browser-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/browser-connection")>()),
  useConnectionOnline: () => true,
}));

const TODAY = "2026-11-27";
const CATEGORY_ID = "f0000000-0000-4000-8000-000000000001";
const category = {
  archivedAt: null,
  groupKey: "operational",
  id: CATEGORY_ID,
  name: "Frete",
  status: "active",
  systemKey: null,
} as ExpenseCategoryReadModel;

const saved = {
  amount: "10.00",
  categoryId: CATEGORY_ID,
  competenceOn: "2028-06-15",
  description: "Aluguel",
  id: "e0000001-0000-4000-8000-000000000000",
  payee: null,
} as ExpenseReadModel;

const farDraft: ExpenseDraft = {
  amount: "10,00",
  categoryId: CATEGORY_ID,
  competenceOn: "2028-06-15",
  description: "Aluguel",
  payee: "",
};

const noop = () => undefined;

function renderForm(
  props: { editing: ExpenseReadModel | null; keptDraft?: ExpenseDraft },
  onSave: (input: unknown) => Promise<boolean>
) {
  return render(
    <Dialog open>
      <ExpenseForm
        categories={[category]}
        disabled={false}
        editing={props.editing}
        feedback={null}
        keptDraft={props.keptDraft}
        onCancel={noop}
        onDraftChange={noop}
        onSave={onSave}
        saving={false}
        today={TODAY}
      />
    </Dialog>
  );
}

afterEach(cleanup);

describe("the competence limit on the expense form", () => {
  it("a new expense dated beyond a year ahead is refused at the field and not sent", async () => {
    const onSave = vi.fn(() => Promise.resolve(true));
    renderForm({ editing: null, keptDraft: farDraft }, onSave);
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Registrar despesa" }));
    expect(
      await screen.findByText(COMPETENCE_TOO_FAR_AHEAD_MESSAGE)
    ).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("editing without changing the date sends it, even if it is now beyond the window", async () => {
    const onSave = vi.fn(() => Promise.resolve(true));
    renderForm({ editing: saved }, onSave);
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Salvar alterações" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(COMPETENCE_TOO_FAR_AHEAD_MESSAGE)).toBeNull();
  });

  it("a new expense dated on the last day of the window (today plus 366 days) is sent", async () => {
    const onSave = vi.fn(() => Promise.resolve(true));
    renderForm(
      { editing: null, keptDraft: { ...farDraft, competenceOn: "2027-11-28" } },
      onSave
    );
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Registrar despesa" }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  });
});
