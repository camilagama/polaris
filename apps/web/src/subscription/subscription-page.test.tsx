import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { StaticOrganizationProvider } from "../lib/current-organization";
import { SubscriptionPage } from "./subscription-page";

// the client of the server reads `window` when it loads: nothing here talks to it
vi.mock("../lib/orpc", () => ({ orpcClient: {} }));

const ORGANIZATION = {
  id: "0199c2d0-0000-7000-8000-00000000a001",
  name: "Loja do teste",
  timezone: "America/Sao_Paulo",
};

const CONTROL = /<(button|a|form|input|select)[\s>]/;

function pageOf(role: string, billingSelfService: boolean) {
  return renderToStaticMarkup(
    <StaticOrganizationProvider
      billingSelfService={billingSelfService}
      organization={{ ...ORGANIZATION, role }}
    >
      <SubscriptionPage />
    </StaticOrganizationProvider>
  );
}

/**
 * `?aba=assinatura` without `billing:manage` is accepted (t423): the tab says why and offers nothing, so there is no
 * action to disable. Nothing of the billing is drawn or asked there (the screen that reads the plan is not mounted).
 */
describe("the Assinatura without billing:manage", () => {
  it("says only that the owner can see and change it, with no button, link or form", () => {
    const html = pageOf("staff", true);
    expect(html).toContain("Só o dono da loja pode ver e mudar a assinatura.");
    expect(html).not.toMatch(CONTROL);
    expect(html).not.toContain("aria-disabled");
    expect(html).not.toContain("Assinar");
  });

  it("says the self-service is off when it is, also with no action", () => {
    const html = pageOf("owner", false);
    expect(html).toContain("A assinatura não está disponível agora.");
    expect(html).not.toMatch(CONTROL);
  });
});
