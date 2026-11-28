// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/orpc", () => ({ orpcClient: {} }));

const { SaleCancelPanel } = await import("./sale-cancel-panel");
const { SaleReturnPanel } = await import("./sale-return-panel");

const NOOP = () => undefined;
const OPTIONAL = /opcional/i;
const SALE_ID = "00000000-0000-4000-8000-000000000070";
const ROWS = [
  {
    available: 2,
    label: "Camiseta — Azul / M",
    position: 0,
    restocked: 0,
    returned: 0,
    sold: 2,
  },
];

const renderCancel = () =>
  render(
    <SaleCancelPanel
      finalFocus={undefined}
      onClose={NOOP}
      onSaleChanged={NOOP}
      open
      organizationId="loja-a"
      saleId={SALE_ID}
      saleItemCount={2}
    />
  );

const renderReturn = () =>
  render(
    <SaleReturnPanel
      finalFocus={undefined}
      onClose={NOOP}
      onSaleChanged={NOOP}
      open
      organizationId="loja-a"
      paymentParts={1}
      rows={ROWS}
      saleId={SALE_ID}
    />
  );

afterEach(cleanup);

describe("a legenda do motivo nos painéis reais", () => {
  it("o cancelamento nomeia o grupo 'Motivo do cancelamento', sem '(opcional)', só para leitor de tela", async () => {
    renderCancel();
    const group = await screen.findByRole("group", {
      name: "Motivo do cancelamento",
    });
    const legend = group.querySelector("legend");
    expect(legend?.textContent).toBe("Motivo do cancelamento");
    expect(legend?.classList.contains("sr-only")).toBe(true);
    expect(screen.queryByRole("group", { name: OPTIONAL })).toBeNull();
  });

  it("a devolução nomeia o grupo 'Motivo da devolução', sem '(opcional)', só para leitor de tela", async () => {
    renderReturn();
    const group = await screen.findByRole("group", {
      name: "Motivo da devolução",
    });
    const legend = group.querySelector("legend");
    expect(legend?.textContent).toBe("Motivo da devolução");
    expect(legend?.classList.contains("sr-only")).toBe(true);
    expect(screen.queryByRole("group", { name: OPTIONAL })).toBeNull();
  });
});
