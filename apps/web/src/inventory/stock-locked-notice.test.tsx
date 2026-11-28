// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mapStockError } from "./stock-command-model";
import { LockedNotice } from "./stock-panel-fields";

const failure = mapStockError("write_off", new Error("sem resposta"));

const renderNotice = (confirmingDiscard: boolean) => {
  const onDiscardCancel = vi.fn();
  const onDiscardConfirm = vi.fn();
  render(
    <LockedNotice
      confirmingDiscard={confirmingDiscard}
      failure={failure}
      onDiscardCancel={onDiscardCancel}
      onDiscardConfirm={onDiscardConfirm}
    />
  );
  return { onDiscardCancel, onDiscardConfirm };
};

afterEach(cleanup);

describe("a pergunta de descartar um movimento de estoque de resultado incerto", () => {
  it("lê a escolha pelo nome: Descartar movimento e Manter movimento", () => {
    renderNotice(true);
    const alert = screen.getByRole("alert");
    expect(
      within(alert).getByRole("button", { name: "Descartar movimento" })
    ).toBeTruthy();
    expect(
      within(alert).getByRole("button", { name: "Manter movimento" })
    ).toBeTruthy();
  });

  it("Manter movimento recusa o descarte e Descartar movimento o confirma", async () => {
    const user = userEvent.setup();
    const { onDiscardCancel, onDiscardConfirm } = renderNotice(true);
    await user.click(screen.getByRole("button", { name: "Manter movimento" }));
    expect(onDiscardCancel).toHaveBeenCalledTimes(1);
    expect(onDiscardConfirm).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole("button", { name: "Descartar movimento" })
    );
    expect(onDiscardConfirm).toHaveBeenCalledTimes(1);
  });

  it("antes da pergunta, nenhum dos dois botões aparece", () => {
    renderNotice(false);
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Manter movimento" })
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Descartar movimento" })
    ).toBeNull();
  });
});
