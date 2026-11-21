// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  type PlanCardView,
  type PlanNoticeFacts,
  planCardFor,
} from "../subscription/plan-notice";
import { PRO_PITCH } from "../subscription/subscription-model";
import { SidebarProvider } from "@/ui/sidebar";
import { PlanCard } from "./menu-progress";

const USAGE_SENTENCE = /Você usa (\d+) de 50 variantes no plano Free\./;
const BAR_ARIA =
  /aria-hidden="true"[^>]*data-plan-card-bar=""|data-plan-card-bar="" aria-hidden="true"/;
const SVG_HIDDEN = /<svg[^>]*aria-hidden="true"/;
const SVG_PAINT = /<(image|linearGradient|radialGradient)/;
const LITERAL_COLOR = /#[0-9a-fA-F]{3,8}|rgb\(|oklch\(/;

const facts = (
  state: PlanNoticeFacts["state"],
  variants: PlanNoticeFacts["variants"] = { max: 50, used: 12 }
): PlanNoticeFacts => ({
  accessEndsAt: null,
  nextChargeOn: null,
  organizationId: "loja-a",
  readAt: 1,
  state,
  variants,
});

const usageView = (used: number, max = 50): PlanCardView => ({
  usage: { max, used },
});

describe("quem vê o cartão do plano", () => {
  it("o dono vê em free e em free_over_limit, com o uso da leitura", () => {
    for (const state of ["free", "free_over_limit"] as const) {
      expect(planCardFor(facts(state))).toEqual(usageView(12));
    }
  });

  it("não vê em teste, ativo, carência nem cancelado", () => {
    for (const state of [
      "trial_setup",
      "trialing",
      "active",
      "grace",
    ] as const) {
      expect(planCardFor(facts(state)), state).toBeNull();
    }
  });

  it("sem leitura (quem não gerencia a cobrança, loja sem plano lido), não há cartão", () => {
    expect(planCardFor(null)).toBeNull();
  });

  it("sem os dois números a linha de uso some e o cartão fica", () => {
    expect(planCardFor(facts("free", null))).toEqual({ usage: null });
  });
});

describe("o texto do cartão", () => {
  const html = (view: PlanCardView) =>
    renderToStaticMarkup(
      <SidebarProvider>
        <PlanCard view={view} />
      </SidebarProvider>
    );

  it("diz o uso do servidor por escrito, o que o Pro dá e o caminho até a Assinatura", () => {
    const text = html(usageView(12));
    expect(text).toContain("Você usa 12 de 50 variantes no plano Free.");
    expect(text).toContain(PRO_PITCH);
    expect(text).toContain(
      "Catálogo público no ar, vendas sem internet e mais variantes, imagens e metas."
    );
    expect(text).toContain("Conhecer o Pro");
    expect(text).toContain('href="/configuracoes?aba=assinatura"');
  });

  it("não tem faixas: a frase é a mesma com 3, 45 e 50 de 50, e acima do limite só o número muda", () => {
    const sentence = (used: number) =>
      USAGE_SENTENCE.exec(html(usageView(used)));
    for (const used of [3, 45, 50, 62]) {
      expect(sentence(used)?.[1], String(used)).toBe(String(used));
    }
    expect(html(usageView(50))).not.toContain("chegou ao limite");
  });

  it("sem os números não há linha de uso nem barra, e o pitch e o botão ficam", () => {
    const text = html({ usage: null });
    expect(text).not.toContain("Você usa");
    expect(text).not.toContain("data-plan-card-bar");
    expect(text).toContain(PRO_PITCH);
    expect(text).toContain("Conhecer o Pro");
  });

  it("a barra é só desenho, proporcional ao uso e nunca passa de cheia", () => {
    expect(html(usageView(10))).toMatch(BAR_ARIA);
    expect(html(usageView(10))).toContain("width:20%");
    expect(html(usageView(62))).toContain("width:100%");
  });

  it("não tem botão de fechar", () => {
    const text = html(usageView(12));
    expect(text).not.toContain("<button");
    expect(text).not.toContain("Fechar");
  });

  it("a arte é um SVG de tokens, escondida do leitor", () => {
    const withArt = html(usageView(12));
    expect(withArt).toContain("data-plan-card-art");
    expect(withArt).toMatch(SVG_HIDDEN);
    expect(withArt).not.toMatch(SVG_PAINT);
    expect(withArt).not.toMatch(LITERAL_COLOR);
  });
});
