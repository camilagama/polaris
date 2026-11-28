import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OfflineNotice } from "./offline-notice";

const TITLE = /data-slot="alert-title"[^>]*>Sem conexão\.</;
const WARNING_TONE =
  /class="[^"]*border-warning\/30 bg-warning\/10[^"]*" data-slot="alert" role="status"/;

describe("OfflineNotice", () => {
  it("abre sempre com o título Sem conexão., com o ícone de nuvem cortada escondido do leitor de tela", () => {
    const markup = renderToStaticMarkup(
      <OfflineNotice>Cadastrar funciona.</OfflineNotice>
    );
    expect(markup).toMatch(TITLE);
    expect(markup).toContain("lucide-cloud-off");
    expect(markup).toContain('aria-hidden="true"');
  });

  it("é um aviso de tom warning e leva o corpo da tela como descrição", () => {
    const markup = renderToStaticMarkup(
      <OfflineNotice>
        Veja <a href="/attention">Pendências</a>.
      </OfflineNotice>
    );
    expect(markup).toMatch(WARNING_TONE);
    expect(markup).toContain('data-slot="alert-description"');
    expect(markup).toContain('<a href="/attention">Pendências</a>');
  });

  it("só leva id quando a tela passa um", () => {
    expect(
      renderToStaticMarkup(<OfflineNotice id="offline-x">Corpo.</OfflineNotice>)
    ).toContain('id="offline-x"');
    expect(
      renderToStaticMarkup(<OfflineNotice>Corpo.</OfflineNotice>)
    ).not.toContain(" id=");
  });
});
