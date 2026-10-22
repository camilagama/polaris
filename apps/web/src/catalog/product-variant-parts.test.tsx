import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { VariantSaveNotice } from "./product-variant-parts";

/**
 * How a save of the SKU or of the list price is said (drawn without a browser): an error is an alert with text and
 * icon, a conflict is an alert with the way out, and success is a polite status.
 */
const noop = () => undefined;
const draw = (outcome: Parameters<typeof VariantSaveNotice>[0]["outcome"]) =>
  renderToStaticMarkup(<VariantSaveNotice onReload={noop} outcome={outcome} />);

describe("VariantSaveNotice", () => {
  it("draws nothing without an outcome", () => {
    expect(draw(null)).toBe("");
  });

  it("says a failed save as an alert with the text and an icon", () => {
    const markup = draw({
      kind: "error",
      text: "Não foi possível carregar ou salvar as variantes. Tente novamente.",
    });
    expect(markup).toContain('role="alert"');
    expect(markup).toContain(
      "Não foi possível carregar ou salvar as variantes. Tente novamente."
    );
    expect(markup).toContain("<svg");
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).not.toContain('role="status"');
    expect(markup).not.toContain("Atualizar variantes");
  });

  it("says a conflict as an alert with the button that reads the variants again", () => {
    const markup = draw({ kind: "conflict", text: "O produto mudou." });
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("O produto mudou.");
    expect(markup).toContain("Atualizar variantes");
  });

  it("says a saved value as a status, not an alert", () => {
    const markup = draw({ kind: "saved", text: "SKU salvo." });
    expect(markup).toContain('role="status"');
    expect(markup).toContain("SKU salvo.");
    expect(markup).not.toContain('role="alert"');
    expect(markup).not.toContain("Atualizar variantes");
  });
});
