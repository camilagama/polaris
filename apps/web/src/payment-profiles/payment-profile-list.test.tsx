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
      online
      onRetry={none}
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

const SINGLE_TILE = /data-row-tile=""[^>]*><svg[^>]*lucide-credit-card/;
const WALLET_TILE = /data-row-tile=""[^>]*><svg[^>]*lucide-wallet/;

describe("PaymentProfileList, the row of a profile", () => {
  const renderOf = (profile: PaymentProfileReadModel) =>
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
        online
        onRetry={none}
        pending={false}
        profiles={[profile]}
      />
    );

  it("reads name, count, state and then the buttons, with the state as a word in the badge", () => {
    for (const status of ["active", "archived"] as const) {
      const html = renderOf({ ...PROFILE, status });
      const word = status === "active" ? "Ativo" : "Arquivado";
      expect(html).toContain(`>${word}</span>`);
      const order = [
        html.indexOf(">Maquininha<"),
        html.indexOf(">1 regra<"),
        html.indexOf(`>${word}<`),
        html.indexOf(
          `${status === "active" ? "Arquivar" : "Restaurar"} perfil Maquininha`
        ),
      ];
      expect(order).not.toContain(-1);
      expect(order).toEqual([...order].sort((x, y) => x - y));
    }
  });

  it("draws the tile as decoration, with the icon of the only method or the wallet for several", () => {
    const single = renderOf(PROFILE);
    expect(single).toMatch(SINGLE_TILE);
    const [rule] = PROFILE.rules;
    if (!rule) {
      throw new Error("the fixture has a rule");
    }
    const several = renderOf({
      ...PROFILE,
      rules: [rule, { ...rule, id: "r2", method: "pix" }],
    });
    expect(several).toMatch(WALLET_TILE);
    expect(single).toContain('aria-hidden="true"');
  });
});
