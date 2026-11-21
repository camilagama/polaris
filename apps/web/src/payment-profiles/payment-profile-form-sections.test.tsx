// @vitest-environment happy-dom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { blankRule } from "./payment-profile-draft";
import { PaymentProfileForm } from "./payment-profile-form";

const noop = () => undefined;
const keepFocus = () => true;

function drawForm(ruleCount: number) {
  render(
    <PaymentProfileForm
      confirmDuplicate={false}
      draft={{
        name: "Maquininha",
        rules: Array.from({ length: ruleCount }, blankRule),
      }}
      editingName={null}
      errors={{}}
      feedback={null}
      finalFocus={keepFocus}
      onAddRule={noop}
      onCancel={noop}
      onClosed={noop}
      onDismiss={noop}
      online
      onNameChange={noop}
      onRemoveRule={noop}
      onSubmit={noop}
      onUpdateRule={noop}
      open
      pending={false}
    />
  );
  return screen.getByRole("dialog");
}

afterEach(cleanup);

describe("sections of the payment profile form", () => {
  it("makes each rule a fieldset named by a visible legend, as before", () => {
    const dialog = drawForm(2);
    const legends = [...dialog.querySelectorAll(":scope fieldset > legend")]
      .map((legend) => legend.textContent)
      .filter((text) => text?.startsWith("Regra "));
    expect(legends).toEqual(["Regra 1", "Regra 2"]);
  });

  it("separates the name and the rules with the separator piece, not with a border by hand", () => {
    const dialog = drawForm(3);
    const separators = dialog.querySelectorAll("[data-slot=field-separator]");
    // one under the name, one between each pair of rules
    expect(separators).toHaveLength(3);
    for (const separator of separators) {
      expect(separator.getAttribute("aria-hidden")).toBe("true");
    }
    expect(dialog.querySelector("fieldset[class*='border-t']")).toBeNull();
  });

  it("keeps the name before the rules and the add row after them in the focus order", () => {
    const dialog = drawForm(2);
    const order = [
      ...dialog.querySelectorAll(
        "input:not([aria-hidden=true]), button, [role=combobox]"
      ),
    ].map((element) => element.id || element.textContent?.trim());
    expect(order.indexOf("payment-profile-name")).toBeLessThan(
      order.indexOf("payment-add-rule")
    );
    expect(order.indexOf("payment-add-rule")).toBeGreaterThan(
      order.findLastIndex((entry) => entry?.startsWith("Remover regra"))
    );
  });
});
