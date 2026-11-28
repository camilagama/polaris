// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  failSubmission,
  requestDiscard,
  type SaleEvaluation,
  type SubmissionState,
} from "./sale-form-model";
import { SummaryPanel } from "./sale-summary-panel";

vi.mock("../lib/orpc", () => ({ orpcClient: {} }));

const NOOP = () => undefined;

const evaluation = {
  dateText: "agora",
  errors: {},
  feePreview: null,
  methodText: "Pix",
  profileText: "Sem perfil",
  summary: null,
} as unknown as SaleEvaluation;

const lockedSubmission = (): SubmissionState =>
  failSubmission(new Error("sem resposta"), []);

const renderPanel = (submission: SubmissionState) => {
  const onDiscardCancel = vi.fn();
  const onDiscardConfirm = vi.fn();
  render(
    <SummaryPanel
      errors={{}}
      evaluation={evaluation}
      offline={false}
      onDiscardCancel={onDiscardCancel}
      onDiscardConfirm={onDiscardConfirm}
      onDiscardRequest={NOOP}
      onKeepOnDevice={undefined}
      onRefresh={NOOP}
      showRequired={false}
      submission={submission}
      summary={null}
    />
  );
  return { onDiscardCancel, onDiscardConfirm };
};

afterEach(cleanup);

describe("a pergunta de descartar uma venda de resultado incerto, no Resumo", () => {
  it("lê a escolha pelo nome: Descartar venda e Manter venda", () => {
    renderPanel(requestDiscard(lockedSubmission()));
    const alert = screen.getByRole("alert");
    expect(
      within(alert).getByRole("button", { name: "Descartar venda" })
    ).toBeTruthy();
    expect(
      within(alert).getByRole("button", { name: "Manter venda" })
    ).toBeTruthy();
  });

  it("Manter venda recusa o descarte e Descartar venda o confirma", async () => {
    const user = userEvent.setup();
    const { onDiscardCancel, onDiscardConfirm } = renderPanel(
      requestDiscard(lockedSubmission())
    );
    await user.click(screen.getByRole("button", { name: "Manter venda" }));
    expect(onDiscardCancel).toHaveBeenCalledTimes(1);
    expect(onDiscardConfirm).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Descartar venda" }));
    expect(onDiscardConfirm).toHaveBeenCalledTimes(1);
  });

  it("antes da pergunta, Manter venda não aparece", () => {
    renderPanel(lockedSubmission());
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Manter venda" })).toBeNull();
  });
});
