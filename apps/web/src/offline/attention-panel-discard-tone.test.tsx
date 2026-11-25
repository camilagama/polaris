// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { AttentionItem } from "./attention";
import { AttentionPanel } from "./attention-panel";

const none = () => undefined;
const refused: AttentionItem = {
  actions: ["resubmit", "discard"],
  blocksQueue: true,
  cause: "insufficient_stock",
  code: "insufficient_stock",
  commandId: "0199c2d0-0000-7000-8000-000000000101",
  detail: "O estoque do servidor não cobre esta venda.",
  kind: "sale",
  redone: false,
  title: "Venda de 2 itens",
};

afterEach(cleanup);

describe("a confirmação de descartar uma operação recusada", () => {
  it("é o bloco rebaixado em tom destrutivo, com o anel de destructive", () => {
    render(
      <AttentionPanel
        onDiscard={none}
        onResubmit={none}
        onSignInAgain={none}
        summary={{ items: [refused], waitingBehind: 0 }}
      />
    );
    expect(document.querySelector('[data-slot="inset-block"]')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Descartar…" }));
    const block = screen.getByRole("alertdialog", {
      name: "Descartar Venda de 2 itens",
    });
    expect(block.getAttribute("data-slot")).toBe("inset-block");
    expect(block.classList.contains("ring-destructive/60")).toBe(true);
  });
});
