import type { Locator } from "@playwright/test";
import { expect } from "@playwright/test";

const ANY_ID = /.+/;

/**
 * A closed Select popup stays in the page, transparent and with no size, and answers the same role and name as the
 * one that opens next. The option is looked up inside the list this trigger opened (its aria-controls), and the
 * choice ends when that list is gone.
 */
export async function chooseSelectOption(
  scope: Locator,
  label: string,
  option: RegExp | string
): Promise<void> {
  const trigger = scope.getByRole("combobox", { exact: true, name: label });
  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-controls", ANY_ID);
  const listId = await trigger.getAttribute("aria-controls");
  const list = scope.page().locator(`[id="${listId}"]`);
  await list
    .getByRole("option", { exact: typeof option === "string", name: option })
    .click();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(list).toBeHidden();
}
