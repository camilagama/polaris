// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RETURN_EXPLANATION, returnExplanation } from "./sale-return-model";

vi.mock("../lib/orpc", () => ({ orpcClient: {} }));

const { SaleReturnPanel } = await import("./sale-return-panel");

const NOOP = () => undefined;
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

const renderPanel = (paymentParts: number) =>
  render(
    <SaleReturnPanel
      finalFocus={undefined}
      onClose={NOOP}
      onSaleChanged={NOOP}
      open
      organizationId="loja-a"
      paymentParts={paymentParts}
      rows={ROWS}
      saleId={SALE_ID}
    />
  );

afterEach(cleanup);

describe("the explanation in the return dialog", () => {
  it("is the one for two parts, with the way each part goes back, when the sale was paid in two parts", async () => {
    renderPanel(2);
    const dialog = await screen.findByRole("dialog", {
      name: "Registrar devolução",
    });
    expect(dialog.textContent).toContain(returnExplanation(2));
    expect(dialog.textContent).toContain("pelo mesmo meio de cada parte");
  });

  it("is the one of today, with no sentence about parts, when the sale was paid in one", async () => {
    renderPanel(1);
    const dialog = await screen.findByRole("dialog", {
      name: "Registrar devolução",
    });
    expect(dialog.textContent).toContain(RETURN_EXPLANATION);
    expect(dialog.textContent).not.toContain("cada parte");
  });
});
