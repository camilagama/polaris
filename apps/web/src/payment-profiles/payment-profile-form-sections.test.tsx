// @vitest-environment happy-dom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { blankRule, type RuleDraft } from "./payment-profile-draft";
import { PaymentProfileForm } from "./payment-profile-form";

const noop = () => undefined;
const keepFocus = () => true;
const REMOVE_RULE_NAME = /^Remover regra \d$/;

function drawForm(ruleCount: number, makeRule: () => RuleDraft = blankRule) {
  render(
    <PaymentProfileForm
      confirmDuplicate={false}
      draft={{
        name: "Maquininha",
        rules: Array.from({ length: ruleCount }, makeRule),
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
    const removeButtons = order.flatMap((entry, position) =>
      entry?.startsWith("Remover regra") ? [position] : []
    );
    expect(removeButtons).toHaveLength(2);
    expect(order.indexOf("payment-add-rule")).toBeGreaterThan(
      Math.max(...removeButtons)
    );
  });

  it("keeps the remove button of a rule light, never the filled destructive one", () => {
    const dialog = drawForm(2);
    const buttons = within(dialog).getAllByRole("button", {
      name: REMOVE_RULE_NAME,
    });
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      expect(button.className).not.toContain("bg-destructive");
    }
  });

  it("names what each empty selector of a rule chooses, never just 'Escolha'", () => {
    const dialog = drawForm(1, () => ({
      ...blankRule(),
      anticipationFee: { ...blankRule().anticipationFee, mode: "" as never },
      method: "" as never,
      processingFee: { ...blankRule().processingFee, mode: "" as never },
    }));
    expect(screen.getAllByText("Escolha o método")).toHaveLength(1);
    expect(screen.getAllByText("Escolha como informar")).toHaveLength(2);
    expect(within(dialog).queryByText("Escolha")).toBeNull();
  });
});
