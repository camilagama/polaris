// @vitest-environment happy-dom
import type { PaymentProfileReadModel } from "@polaris/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PaymentProfileList } from "./payment-profile-list";

const AT = "2026-10-30T12:00:00.000Z";
const NO_FEE = { fixedAmount: null, mode: "none", percentage: null } as const;

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
      method: "pix",
      processingFee: NO_FEE,
    },
  ],
  status: "active",
  updatedAt: AT,
  version: 1,
};

const noop = () => undefined;
const MORE_ACTIONS = /Mais ações/;

function setup(
  overrides: Partial<React.ComponentProps<typeof PaymentProfileList>> = {}
) {
  const onEdit = vi.fn();
  const onChangeLifecycle = vi.fn();
  render(
    <PaymentProfileList
      hasAnyProfile
      includeArchived={false}
      loadError={null}
      loading={false}
      notLoaded={false}
      onChangeLifecycle={onChangeLifecycle}
      onEdit={onEdit}
      onIncludeArchivedChange={noop}
      online
      onRetry={noop}
      pending={false}
      profiles={[PROFILE]}
      {...overrides}
    />
  );
  return { onChangeLifecycle, onEdit };
}

afterEach(cleanup);

describe("PaymentProfileList, the actions of a profile row", () => {
  it("shows one menu button for an active profile and no loose Editar or Arquivar button", () => {
    setup();
    expect(
      screen.getByRole("button", { name: "Mais ações para Maquininha" })
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Editar perfil Maquininha" })
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Arquivar perfil Maquininha" })
    ).toBeNull();
  });

  it("opens by keyboard, keeps the accessible names and calls Editar", async () => {
    const user = userEvent.setup();
    const { onEdit, onChangeLifecycle } = setup();
    screen.getByRole("button", { name: "Mais ações para Maquininha" }).focus();
    await user.keyboard("{Enter}");
    const edit = await screen.findByRole("menuitem", {
      name: "Editar perfil Maquininha",
    });
    await user.click(edit);
    expect(onEdit).toHaveBeenCalledWith(PROFILE);
    expect(onChangeLifecycle).not.toHaveBeenCalled();
  });

  it("puts Arquivar last, apart, as the destructive item, and calls it", async () => {
    const user = userEvent.setup();
    const { onChangeLifecycle } = setup();
    await user.click(
      screen.getByRole("button", { name: "Mais ações para Maquininha" })
    );
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "Editar",
      "Arquivar",
    ]);
    const [edit, archive] = items;
    expect(archive?.getAttribute("data-variant")).toBe("destructive");
    expect(edit?.getAttribute("data-variant")).toBe("default");
    expect(archive?.getAttribute("aria-label")).toBe(
      "Arquivar perfil Maquininha"
    );
    await user.click(archive as HTMLElement);
    expect(onChangeLifecycle).toHaveBeenCalledWith(PROFILE);
  });

  it("offline, Arquivar reads why instead of being removed", async () => {
    const user = userEvent.setup();
    setup({ online: false });
    await user.click(
      screen.getByRole("button", { name: "Mais ações para Maquininha" })
    );
    const archive = await screen.findByRole("menuitem", {
      name: "Arquivar perfil Maquininha",
    });
    expect(archive.getAttribute("aria-disabled")).toBe("true");
    expect(archive.getAttribute("aria-describedby")).toBeTruthy();
  });

  it("keeps a single Restaurar button, no menu, on an archived profile", () => {
    const { onChangeLifecycle } = setup({
      profiles: [{ ...PROFILE, status: "archived" }],
    });
    expect(screen.queryByRole("button", { name: MORE_ACTIONS })).toBeNull();
    const restore = screen.getByRole("button", {
      name: "Restaurar perfil Maquininha",
    });
    restore.click();
    expect(onChangeLifecycle).toHaveBeenCalledTimes(1);
  });

  it("marks the trigger as the place the focus returns to after the form", () => {
    setup();
    const trigger = screen.getByRole("button", {
      name: "Mais ações para Maquininha",
    });
    expect(trigger.hasAttribute("data-profile-edit")).toBe(true);
    expect(
      trigger.closest("[data-profile-id]")?.getAttribute("data-profile-id")
    ).toBe(PROFILE.id);
  });
});

describe("PaymentProfileList, the states of the list", () => {
  it("frames the profiles with the title and no count, the filter above the frame", () => {
    setup();
    const region = screen.getByRole("region", { name: "Perfis cadastrados" });
    expect(region.hasAttribute("data-list-block")).toBe(true);
    const filter = screen.getByRole("checkbox", { name: "Incluir arquivados" });
    expect(region.contains(filter)).toBe(false);
    expect(region.querySelector("[data-list-count]")?.textContent).toBe("");
  });

  it("draws only the EmptyState, with no frame, when nothing was ever registered", () => {
    setup({ hasAnyProfile: false, profiles: [] });
    expect(screen.getByText("Nenhum perfil cadastrado")).toBeTruthy();
    expect(document.querySelector("[data-list-block]")).toBeNull();
  });

  it("keeps the frame and says the archived ones are hidden when only the filter emptied it", () => {
    setup({ profiles: [] });
    expect(screen.getByText("Nenhum perfil ativo")).toBeTruthy();
    expect(document.querySelector("[data-list-block]")).not.toBeNull();
    expect(
      screen.getByText(
        "Os perfis arquivados aparecem com “Incluir arquivados”."
      )
    ).toBeTruthy();
  });

  it("keeps the frame and its title while loading, saying Carregando… only to a reader", () => {
    setup({ loading: true, profiles: [] });
    const region = screen.getByRole("region", { name: "Perfis cadastrados" });
    expect(region.querySelector('[role="status"]')?.textContent).toBe(
      "Carregando…"
    );
    expect(screen.queryByText("Carregando perfis…")).toBeNull();
  });

  it("draws no frame for a list that was not read or failed to load", () => {
    setup({ notLoaded: true, profiles: [] });
    expect(document.querySelector("[data-list-block]")).toBeNull();
    cleanup();
    setup({ loadError: "Não deu para carregar.", profiles: [] });
    expect(document.querySelector("[data-list-block]")).toBeNull();
    expect(screen.getByText("Tentar novamente")).toBeTruthy();
  });
});
