import type { Locator, Page } from "@playwright/test";

/** The value cell of a row of the result chain ("Como chegamos a este resultado") on /dashboard. */
export function chainValue(page: Page, label: string): Locator {
  return page
    .getByRole("region", { name: "Como chegamos a este resultado" })
    .getByRole("row")
    .filter({ has: page.getByRole("rowheader", { exact: true, name: label }) })
    .getByRole("cell");
}
