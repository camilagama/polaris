import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { StaticOrganizationProvider } from "../lib/current-organization";
import { CancelLink } from "./change-password-page";

// the client of the server reads `window` when it loads: nothing here talks to it
vi.mock("../lib/orpc", () => ({ orpcClient: {} }));

const ORGANIZATION = {
  id: "0199c2d0-0000-7000-8000-00000000a001",
  name: "Loja do teste",
  role: "owner",
  timezone: "America/Sao_Paulo",
};

/**
 * "Cancelar" of the Senha tab goes to the first tab of Configurações this person has. Here the offline runtime is
 * off (the build default), so Aparelhos is not in the menu: the way back is `/configuracoes` (Formas de receber, the
 * first tab, has no `aba`), never `?aba=aparelhos`.
 */
describe("Cancelar of the Senha tab with the offline runtime off", () => {
  it("goes back to Formas de receber, not to Aparelhos", () => {
    const html = renderToStaticMarkup(
      <StaticOrganizationProvider
        billingSelfService={true}
        organization={ORGANIZATION}
      >
        <CancelLink />
      </StaticOrganizationProvider>
    );
    expect(html).toContain('href="/configuracoes"');
    expect(html).toContain(
      'aria-label="Cancelar e voltar para Formas de receber"'
    );
    expect(html).not.toContain("aparelhos");
    expect(html).not.toContain("Aparelhos");
  });
});
