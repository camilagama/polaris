import type { PaymentProfileReadModel } from "@polaris/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ hidden: false }));

vi.mock("@/lib/hidden-values", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hidden-values")>()),
  useHiddenValues: () => [state.hidden, () => undefined],
}));

const { PaymentProfileList } = await import("./payment-profile-list");

const AT = "2026-10-30T12:00:00.000Z";
const NO_FEE = { fixedAmount: null, mode: "none", percentage: null } as const;
const AMOUNT = /R\$\s?\d/;

const PROFILE: PaymentProfileReadModel = {
  archivedAt: null,
  createdAt: AT,
  id: "0199c2d0-0000-7000-8000-000000000001",
  name: "Maquininha",
  organizationId: "0199c2d0-0000-7000-8000-00000000a001",
  rules: [
    {
      anticipationFee: NO_FEE,
      expectedSettlementDays: 1,
      id: "0199c2d0-0000-7000-8000-000000000002",
      installmentPlan: null,
      installments: null,
      method: "debit_card",
      processingFee: {
        fixedAmount: "0.50",
        mode: "fixed_and_percentage",
        percentage: "0.99",
      },
    },
  ],
  status: "active",
  updatedAt: AT,
  version: 1,
};

const none = () => undefined;
const render = () =>
  renderToStaticMarkup(
    <PaymentProfileList
      hasAnyProfile
      includeArchived={false}
      loadError={null}
      loading={false}
      notLoaded={false}
      onChangeLifecycle={none}
      onEdit={none}
      onIncludeArchivedChange={none}
      onRetry={none}
      online
      pending={false}
      profiles={[PROFILE]}
    />
  );

describe("PaymentProfileList, the fixed fee of a rule", () => {
  beforeEach(() => {
    state.hidden = false;
  });

  it("writes the amount as it is while the values show", () => {
    expect(render()).toContain("R$ 0,50");
  });

  it("masks the amount and keeps the percent while the values are hidden", () => {
    state.hidden = true;
    const html = render();
    expect(html).not.toMatch(AMOUNT);
    expect(html).toContain("0,99%");
    expect(html).toContain("valor escondido");
  });
});
