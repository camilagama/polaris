import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HelpTip } from "@/ui/help-tip";
import { HELP_TIP_MAX_CHARS, helpTipTextProblem } from "@/ui/help-tip-text";

const OVER_CHARS = /161 characters/;
const OVER_SENTENCES = /3 sentences/;

/**
 * The HelpTip, closed (the static render is the first paint): its name, the dialog it promises and the text that is
 * not in the page until it opens. Open and close by click, keyboard and touch, the focus going in and back, and axe
 * are in e2e-pwa/ui-help-tip.e2e.ts.
 */
const html = (node: React.ReactNode) => renderToStaticMarkup(node);

const TEXT = "Vendas líquidas de hoje. Compara com a média das 4 sextas.";

describe("HelpTip fechado", () => {
  it("é um botão com o nome 'Sobre {título}' que promete um diálogo fechado", () => {
    const markup = html(<HelpTip about="Resultado estimado">{TEXT}</HelpTip>);
    expect(markup).toContain("<button");
    expect(markup).toContain('aria-label="Sobre Resultado estimado"');
    expect(markup).toContain('aria-haspopup="dialog"');
    expect(markup).toContain('aria-expanded="false"');
  });

  it("não põe o texto nem o link na página antes de abrir", () => {
    const markup = html(
      <HelpTip about="Meta" link={{ href: "/dashboard", label: "Ver a meta" }}>
        {TEXT}
      </HelpTip>
    );
    expect(markup).not.toContain("Vendas líquidas");
    expect(markup).not.toContain("Ver a meta");
  });

  it("esconde o ícone do leitor de tela, que ouve só o nome do botão", () => {
    const markup = html(<HelpTip about="Meta">{TEXT}</HelpTip>);
    expect(markup).toContain('aria-hidden="true"');
  });

  it("tem 24 px visíveis e a área de toque, e o anel de foco do app", () => {
    const markup = html(<HelpTip about="Meta">{TEXT}</HelpTip>);
    expect(markup).toContain("size-6");
    expect(markup).toContain("touch-hit");
    expect(markup).toContain("focus-ring");
  });
});

describe("limite do texto da ajuda", () => {
  it("aceita até 2 frases e 160 caracteres", () => {
    expect(helpTipTextProblem(TEXT)).toBeNull();
    expect(helpTipTextProblem("Vendas de 1 a 23/10, R$ 1.234,56")).toBeNull();
    expect(helpTipTextProblem("a".repeat(HELP_TIP_MAX_CHARS))).toBeNull();
  });

  it("reprova acima de 160 caracteres", () => {
    expect(helpTipTextProblem("a".repeat(HELP_TIP_MAX_CHARS + 1))).toMatch(
      OVER_CHARS
    );
  });

  it("reprova a partir da terceira frase", () => {
    expect(helpTipTextProblem("Uma. Duas. Três.")).toMatch(OVER_SENTENCES);
    expect(helpTipTextProblem("Uma? Duas! Três.")).toMatch(OVER_SENTENCES);
  });

  it("não conta o ponto de 'vs.' como fim de frase", () => {
    expect(
      helpTipTextProblem("Vendas do dia. Chip vs. a média dos 4 domingos.")
    ).toBeNull();
  });

  it("reprova o texto vazio", () => {
    expect(helpTipTextProblem("  ")).toBe("empty");
  });
});
