import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RefreshFailedNotice } from "./closed-refresh-notice";

const NATIVE_DISABLED = / disabled[ =>]/;
const noop = () => undefined;
const render = (reading: boolean, online = true) =>
  renderToStaticMarkup(
    <RefreshFailedNotice online={online} onRefresh={noop} reading={reading} />
  );

describe("the notice of a refresh that failed", () => {
  it("offers Tentar de novo, enabled, while no read is on its way", () => {
    const html = render(false);
    expect(html).toContain(
      "Não deu para atualizar. O que está na tela é da última leitura."
    );
    expect(html).toContain("Tentar de novo");
    expect(html).not.toContain('aria-disabled="');
    expect(html).not.toContain("Atualizando…");
  });

  it("keeps the notice and says Atualizando… on a locked button while the read is on its way", () => {
    const html = render(true);
    expect(html).toContain(
      "Não deu para atualizar. O que está na tela é da última leitura."
    );
    expect(html).toContain("Atualizando…");
    expect(html).not.toContain("Tentar de novo");
    expect(html).toContain('aria-disabled="true"');
    expect(html).not.toMatch(NATIVE_DISABLED);
  });

  it("locks the button with the reason when offline", () => {
    const html = render(false, false);
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain("closed-store-offline");
  });
});
