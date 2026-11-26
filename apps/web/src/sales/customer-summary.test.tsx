// @vitest-environment happy-dom
import type { CustomerReadModel } from "@polaris/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ hidden: false }));

vi.mock("@/lib/hidden-values", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hidden-values")>()),
  useHiddenValues: () => [state.hidden, () => undefined],
}));

const { StaticOrganizationProvider } = await import(
  "../lib/current-organization"
);
const { CurrentCustomerSummary } = await import("./customer-summary");

const ORGANIZATION = {
  id: "0199c2d0-0000-7000-8000-00000000a001",
  name: "Loja do teste",
  role: "owner",
  timezone: "America/Sao_Paulo",
};
const ANA = "a0000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-11-21T15:00:00.000Z");

const customer = (
  overrides: Partial<CustomerReadModel> = {}
): CustomerReadModel => ({
  anonymizedAt: null,
  archivedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  email: null,
  id: ANA,
  name: "Ana",
  notes: null,
  organizationId: ORGANIZATION.id,
  phone: "+55 11 99999-0000",
  status: "active",
  summary: {
    lastPurchaseOn: "2026-11-18",
    purchaseCount: 12,
    totalSpent: "1234.5",
  },
  updatedAt: "2026-01-01T00:00:00.000Z",
  version: 1,
  ...overrides,
});

type Load = Parameters<typeof CurrentCustomerSummary>[0]["load"];
const ready = (value: CustomerReadModel): Load => ({
  customerId: value.id,
  status: "ready",
  value,
});

const render = (load: Load, customerId: string | null = ANA) =>
  renderToStaticMarkup(
    <StaticOrganizationProvider organization={ORGANIZATION}>
      <CurrentCustomerSummary customerId={customerId} load={load} />
    </StaticOrganizationProvider>
  );

beforeEach(() => {
  state.hidden = false;
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
});
afterEach(() => vi.useRealTimers());

describe("the summary of the customer of a sale", () => {
  it("is a list of three terms and three values, in the order of the screen", () => {
    const html = render(ready(customer()));
    expect(html).toContain("<dl");
    const terms = [...html.matchAll(/<dt[^>]*>([^<]*)<\/dt>/g)].map(
      (match) => match[1]
    );
    expect(terms).toEqual(["Compras", "Total gasto", "Última compra"]);
    expect((html.match(/<dd/g) ?? []).length).toBe(3);
    expect(html).toContain(">12</dd>");
    expect(html).toContain("R$ 1.234,50");
    expect(html).toContain("Há 3 dias");
  });

  it("stacks under 20 rem and puts the three side by side with dividers from there", () => {
    const html = render(ready(customer()));
    expect(html).toContain("@container");
    expect(html).toContain("@min-[20rem]:grid-cols-3");
    expect(html).toContain("@min-[20rem]:divide-x");
  });

  it("masks the total and keeps the count and the day when the values are hidden", () => {
    state.hidden = true;
    const html = render(ready(customer()));
    expect(html).not.toContain("1.234,50");
    expect(html).toContain("R$ ••••");
    expect(html).toContain(">12</dd>");
    expect(html).toContain("Há 3 dias");
  });

  it("says Ainda sem compras. alone, with none of the three", () => {
    const html = render(
      ready(
        customer({
          summary: { lastPurchaseOn: null, purchaseCount: 0, totalSpent: "0" },
        })
      )
    );
    expect(html).toContain("Ainda sem compras.");
    expect(html).not.toContain("<dl");
    expect(html).not.toContain("Total gasto");
  });

  it("tells the last purchase from the store's day: 23h30 of São Paulo is still the same day", () => {
    vi.setSystemTime(new Date("2026-11-22T02:30:00.000Z"));
    expect(
      render(
        ready(
          customer({
            summary: {
              lastPurchaseOn: "2026-11-21",
              purchaseCount: 1,
              totalSpent: "10",
            },
          })
        )
      )
    ).toContain(">Hoje</dd>");
    vi.setSystemTime(new Date("2026-11-22T03:00:00.000Z"));
    expect(
      render(
        ready(
          customer({
            summary: {
              lastPurchaseOn: "2026-11-21",
              purchaseCount: 1,
              totalSpent: "10",
            },
          })
        )
      )
    ).toContain(">Ontem</dd>");
  });

  it.each([
    [
      "an anonymized customer",
      ready(customer({ anonymizedAt: "2026-02-01T00:00:00.000Z" })),
    ],
    [
      "an answer without the summary (an older server)",
      ready(customer({ summary: undefined })),
    ],
    [
      "a customer still being read",
      { customerId: ANA, status: "loading" } as Load,
    ],
    [
      "a read that failed",
      { customerId: ANA, message: "falhou", status: "error" } as Load,
    ],
    ["no read yet", { status: "idle" } as Load],
    [
      "the read of another customer",
      ready(customer({ id: "b0000000-0000-4000-8000-000000000002" })),
    ],
  ])("shows nothing for %s", (_name, load) => {
    expect(render(load)).toBe("");
  });
});
