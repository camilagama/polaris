import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MenuProgress } from "./menu-progress";

const STEPS_NAME = 'aria-label="Primeiros passos, 2 de 3 concluídos"';
const TRIAL_NAME =
  'aria-label="Teste grátis, primeira cobrança em 10/11, abrir Assinatura"';
const DAYS = /\d+ dias?\b/;

describe("the foot of the menu", () => {
  it("is nothing without steps and without a trial", () => {
    expect(
      renderToStaticMarkup(<MenuProgress chargeDay={null} firstSteps={null} />)
    ).toBe("");
  });

  it("shows the first steps alone, linked to the checklist of the Início", () => {
    const html = renderToStaticMarkup(
      <MenuProgress chargeDay={null} firstSteps={2} />
    );
    expect(html).toContain(STEPS_NAME);
    expect(html).toContain('href="/#home-checklist"');
    expect(html).toContain("Primeiros passos");
    expect(html).toContain("2 de 3");
    expect(html).toContain("w-2/3");
    expect(html).not.toContain("Teste grátis");
  });

  it("draws the ink of the bar by the steps done", () => {
    const html = renderToStaticMarkup(
      <MenuProgress chargeDay={null} firstSteps={1} />
    );
    expect(html).toContain('aria-label="Primeiros passos, 1 de 3 concluídos"');
    expect(html).toContain("w-1/3");
  });

  it("shows the trial alone, with the day of the first charge and the way to the Assinatura", () => {
    const html = renderToStaticMarkup(
      <MenuProgress chargeDay="10/11" firstSteps={null} />
    );
    expect(html).toContain(TRIAL_NAME);
    expect(html).toContain('href="/configuracoes?aba=assinatura"');
    expect(html).toContain("Teste grátis");
    expect(html).toContain("1ª cobrança em 10/11");
    expect(html).toContain("Assinatura");
    expect(html).not.toMatch(DAYS);
    expect(html).not.toContain("Primeiros passos");
  });

  it("shows both, the steps first", () => {
    const html = renderToStaticMarkup(
      <MenuProgress chargeDay="10/11" firstSteps={2} />
    );
    expect(html.indexOf(STEPS_NAME)).toBeGreaterThan(-1);
    expect(html.indexOf(TRIAL_NAME)).toBeGreaterThan(html.indexOf(STEPS_NAME));
  });
});
