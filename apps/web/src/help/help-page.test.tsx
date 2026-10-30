import { LEGAL_PATHS } from "@polaris/domain/legal/legal-documents";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DPO_EMAIL, SUPPORT_EMAIL } from "../lib/support-contact";
import { HelpPage } from "./help-page";

const AN_ANSWER_TIME = /respond|prazo|horas|dias úteis|em até|breve/u;
const TOKEN = /\{\{|\}\}/u;
const H1 = /<h1[^>]*>Ajuda e contato<\/h1>/u;
const LINKS = /<a [^>]*>/gu;

const markup = () => renderToStaticMarkup(<HelpPage />);
const text = () =>
  markup()
    .replaceAll(/<[^>]+>/gu, " ")
    .replaceAll(/\s+/gu, " ");

describe("the page Ajuda e contato", () => {
  it("has the title as the h1 and the supporting text of the design", () => {
    expect(markup()).toMatch(H1);
    expect(text()).toContain(
      "O Polaris não tem chat nem telefone. Escreva um e-mail e diga o nome da loja e o que aconteceu."
    );
  });

  it("gives the support address as a mailto link whose text is the address, with the name of the design (AC-3, AC-7)", () => {
    const html = markup();
    expect(html).toContain(`href="mailto:${SUPPORT_EMAIL}"`);
    expect(html).toContain(
      `aria-label="Escrever para o suporte: ${SUPPORT_EMAIL}"`
    );
    expect(html).toContain(`>${SUPPORT_EMAIL}</a>`);
  });

  it("gives the DPO address as a second link, in the card Dados pessoais (AC-3)", () => {
    const html = markup();
    expect(html).toContain(`href="mailto:${DPO_EMAIL}"`);
    expect(html).toContain(
      `aria-label="Escrever ao encarregado de dados: ${DPO_EMAIL}"`
    );
    expect(text()).toContain(
      "Pedidos e dúvidas sobre os seus dados pessoais ou sobre a Política de Privacidade vão ao encarregado (DPO)."
    );
    expect(text()).toContain(
      "Suporte Dúvidas sobre o app, a assinatura ou um erro."
    );
    expect(text()).toContain("Dados pessoais Pedidos e dúvidas sobre");
  });

  it("names its sections, with the two cards as regions", () => {
    const html = markup();
    expect(html).toContain('aria-labelledby="ajuda-suporte"');
    expect(html).toContain('aria-labelledby="ajuda-dados-pessoais"');
    expect(html).toContain('aria-labelledby="ajuda-antes"');
    expect(html).toContain(">Antes de escrever</h2>");
  });

  it("tells what to do before writing, with the link to the version at the foot of Configurações", () => {
    const html = markup();
    expect(text()).toContain(
      "Se o app não abre ou mostra erro, recarregue a página e tente de novo."
    );
    expect(text()).toContain(
      "Anote a versão do app: ela fica no fim de Configurações."
    );
    expect(html).toContain('href="/configuracoes#versao-do-app"');
    expect(html).toContain(">Ver a versão</a>");
  });

  it("links the Terms and the Policy", () => {
    const html = markup();
    expect(html).toContain(`href="${LEGAL_PATHS.terms}"`);
    expect(html).toContain(`href="${LEGAL_PATHS.privacy}"`);
  });

  it("never shows a token, an empty address or a promise of answer time (AC-2, AC-6)", () => {
    expect(markup()).not.toMatch(TOKEN);
    expect(markup()).not.toContain('href="mailto:"');
    expect(text().toLowerCase()).not.toMatch(AN_ANSWER_TIME);
  });

  it("asks nothing of the server: no form, no field, no script", () => {
    const html = markup();
    for (const tag of ["<form", "<input", "<textarea", "<script", "<img"]) {
      expect(html).not.toContain(tag);
    }
    // only the two mailto links, the version, and the two legal pages leave it
    expect(html.match(LINKS)?.length).toBe(5);
  });
});
