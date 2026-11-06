import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SUPPORT_EMAIL } from "../lib/support-contact";
import type { AttentionItem, AttentionSummary } from "./attention";
import {
  AttentionPanel,
  type AttentionPanelProps,
  refusedText,
  signInAgainButtonId,
} from "./attention-panel";

const SIGN_IN_AGAIN_OFF = /disabled=""[^>]*>Sair e entrar de novo/;
const none = () => undefined;
const item = (overrides: Partial<AttentionItem> = {}): AttentionItem => ({
  actions: ["resubmit", "discard"],
  blocksQueue: true,
  cause: "insufficient_stock",
  code: "insufficient_stock",
  commandId: "0199c2d0-0000-7000-8000-000000000101",
  detail: "O estoque do servidor não cobre esta venda.",
  kind: "sale",
  redone: false,
  title: "Venda de 2 itens",
  ...overrides,
});

function render(
  summary: AttentionSummary,
  extra: Partial<AttentionPanelProps> = {}
): string {
  return renderToStaticMarkup(
    <AttentionPanel
      onDiscard={none}
      onResubmit={none}
      onSignInAgain={none}
      summary={summary}
      {...extra}
    />
  );
}

describe("the attention panel", () => {
  it("is the page of the screen: one h1 with the title, with or without items", () => {
    for (const summary of [
      { items: [], waitingBehind: 0 },
      { items: [item()], waitingBehind: 0 },
    ]) {
      const html = render(summary);
      expect(html.match(/<h1[ >]/g)).toHaveLength(1);
      expect(html).toContain("Pendências</h1>");
    }
  });

  it("says under the title what the page holds, with or without items, and never promises what changed", () => {
    for (const summary of [
      { items: [], waitingBehind: 0 },
      { items: [item()], waitingBehind: 0 },
    ]) {
      const html = render(summary);
      expect(html).toContain(
        '<p class="text-muted-foreground" id="attention-subtitle">O que o servidor recusou e espera uma decisão sua.</p>'
      );
      expect(html.indexOf("Pendências</h1>")).toBeLessThan(
        html.indexOf("attention-subtitle")
      );
      expect(html.toLowerCase()).not.toContain("o que mudou");
    }
  });

  it("tells the cause of the account apart from the cause of the data without relying on color: an icon and the text", () => {
    const html = render({
      items: [
        item({ cause: "entitlement_changed", code: "entitlement_changed" }),
      ],
      waitingBehind: 0,
    });
    expect(html).toContain("lucide-circle-alert");
    expect(html).toContain('aria-hidden="true"');
    expect(render({ items: [item()], waitingBehind: 0 })).toContain(
      "lucide-triangle-alert"
    );
  });

  it("says so when nothing needs attention", () => {
    const html = render({ items: [], waitingBehind: 0 });
    expect(html).toContain("Nenhuma pendência de envio");
    expect(html).not.toContain("<button");
  });

  it("says the count in the strip, in the singular and without the queue", () => {
    expect(refusedText({ items: [item()], waitingBehind: 0 })).toBe(
      "1 registro recusado"
    );
    expect(refusedText({ items: [item()], waitingBehind: 1 })).toBe(
      "1 registro recusado · 1 na fila atrás dele"
    );
    expect(
      refusedText({
        items: [
          item(),
          item({ commandId: "0199c2d0-0000-7000-8000-000000000103" }),
        ],
        waitingBehind: 1,
      })
    ).toBe("2 registros recusados · 1 na fila atrás deles");
  });

  it("has no strip when nothing needs attention", () => {
    expect(render({ items: [], waitingBehind: 0 })).not.toContain(
      "Precisa de ação"
    );
  });

  it("shows each refused operation with its cause, code and only its own actions", () => {
    const html = render({
      items: [
        item(),
        item({
          actions: ["discard"],
          blocksQueue: false,
          cause: "sku_conflict",
          code: "sku_conflict",
          commandId: "0199c2d0-0000-7000-8000-000000000102",
          detail: "Outro produto já usa este SKU.",
          kind: "product",
          title: "Produto Camiseta",
        }),
      ],
      waitingBehind: 3,
    });
    expect(html).toContain("Venda de 2 itens");
    expect(html).toContain("Produto Camiseta");
    expect(html).toContain("Código: sku_conflict");
    expect(html).toContain("parando a fila");
    expect(html).toContain("Precisa de ação");
    expect(html).toContain("2 registros recusados · 3 na fila atrás deles");
    expect(html).not.toContain("O servidor recusou");
    expect(html.match(/Reenviar venda/g)).toHaveLength(1);
    expect(html.match(/Descartar…/g)).toHaveLength(2);
  });

  it("offers Refazer esta venda in the primary action, then the discard, for a sale refused by authorization", () => {
    const html = render({
      items: [
        item({
          actions: ["redo_sale", "sign_in_again", "discard"],
          cause: "authorization_revoked",
          code: "authorization_revoked",
        }),
      ],
      waitingBehind: 0,
    });
    expect(html).toContain("Refazer esta venda");
    expect(html.indexOf("Refazer esta venda")).toBeLessThan(
      html.indexOf("Descartar…")
    );
  });

  it("says Descartar a venda recusada, and no redo, once the sale was redone", () => {
    const html = render({
      items: [
        item({
          actions: ["discard"],
          cause: "authorization_revoked",
          code: "authorization_revoked",
          redone: true,
        }),
      ],
      waitingBehind: 0,
    });
    expect(html).toContain("Descartar a venda recusada…");
    expect(html).not.toContain("Refazer esta venda");
  });

  it("says what stopped the redo, line by line, in an alert of the card of that sale only", () => {
    const refused = item({
      actions: ["redo_sale", "discard"],
      cause: "authorization_revoked",
      code: "authorization_revoked",
    });
    const other = item({
      actions: ["discard"],
      commandId: "0199c2d0-0000-7000-8000-000000000199",
    });
    const html = render(
      { items: [refused, other], waitingBehind: 0 },
      {
        redoProblem: {
          commandId: refused.commandId,
          lines: [
            { available: 1, kind: "short", label: "Caneca", requested: 3 },
          ],
          message: "Não preenchi a venda.",
        },
      }
    );
    expect(html.match(/role="alert"/g)).toHaveLength(1);
    expect(html.indexOf('role="alert"')).toBeGreaterThan(
      html.indexOf("Refazer esta venda")
    );
    expect(html).toContain("Não preenchi a venda.");
    expect(html).toContain("Caneca: a venda tinha 3 un. e o saldo é 1.");
  });

  it("takes a plan refusal to Assinatura with a real link, not to a button that does nothing", () => {
    const html = render({
      items: [
        item({
          actions: ["open_subscription", "retry"],
          cause: "entitlement_changed",
          code: "entitlement_changed",
        }),
      ],
      waitingBehind: 0,
    });
    expect(html).toContain('href="/configuracoes?aba=assinatura"');
    expect(html).toContain("Ver Assinatura");
    expect(html).not.toContain("Revisar acesso e plano");
    expect(html).not.toContain("Descartar");
  });

  it("shows only Tentar novamente for a plan refusal when Assinatura is unavailable", () => {
    const html = render({
      items: [
        item({
          actions: ["retry"],
          cause: "entitlement_changed",
          code: "entitlement_changed",
          detail: `O plano desta loja não permite mais este registro; nada foi perdido. Regularize o plano com o suporte (${SUPPORT_EMAIL}) e toque em Tentar novamente.`,
        }),
      ],
      waitingBehind: 0,
    });
    expect(html).toContain("Tentar novamente");
    expect(html).toContain("Regularize o plano com o suporte");
    expect(html).not.toContain("Ver Assinatura");
    expect(html).not.toContain("aba=assinatura");
    expect(html).not.toContain("Descartar");
  });

  it("offers signing in again, not a retry, for a refusal about the session or the access", () => {
    const html = render({
      items: [
        item({
          actions: ["sign_in_again", "discard"],
          cause: "authorization_revoked",
          code: "authorization_revoked",
        }),
      ],
      waitingBehind: 0,
    });
    expect(html).toContain("Sair e entrar de novo");
    expect(html).not.toContain("Tentar novamente");
    expect(html).not.toContain("Reenviar");
  });

  it("turns signing in again off while the sign-out runs", () => {
    const html = render(
      {
        items: [item({ actions: ["sign_in_again", "discard"] })],
        waitingBehind: 0,
      },
      { signingOut: true }
    );
    expect(html.match(/ disabled=""/g)).toHaveLength(1);
    expect(html).toMatch(SIGN_IN_AGAIN_OFF);
  });

  it("has no control that forces the synchronization", () => {
    const html = render({
      items: [item(), item({ cause: "version_conflict", kind: "stock" })],
      waitingBehind: 1,
    }).toLowerCase();
    expect(html).not.toContain("forç");
    expect(html).not.toContain("forcar");
    expect(html).not.toContain("sincronizar mesmo assim");
  });

  it("disables the buttons of the item being resolved and shows its failure inside its card", () => {
    const first = "0199c2d0-0000-7000-8000-000000000101";
    const second = "0199c2d0-0000-7000-8000-000000000102";
    const html = render(
      {
        items: [
          item({ commandId: first }),
          item({ commandId: second, title: "Venda de R$ 5,00 · 01/11 10:00" }),
        ],
        waitingBehind: 0,
      },
      {
        busyCommandId: first,
        error: { commandId: first, message: "Não foi possível descartar." },
      }
    );
    const cards = html.split("<li ").slice(1);
    expect(cards).toHaveLength(2);
    expect(cards[0]).toContain("Não foi possível descartar.");
    expect(cards[1]).not.toContain("Não foi possível descartar.");
    expect(html.indexOf("Não foi possível descartar.")).toBeGreaterThan(
      html.indexOf("Código: insufficient_stock")
    );
    expect(html.indexOf("Não foi possível descartar.")).toBeGreaterThan(
      html.indexOf("Reenviar venda")
    );
    expect(html.indexOf("Não foi possível descartar.")).toBeGreaterThan(
      html.indexOf("Descartar…")
    );
    expect(html.match(/ disabled=""/g)).toHaveLength(2);
  });

  it("keeps what the sign-out says under the list, and under the empty card too", () => {
    const notices = <p>Os dados deste aparelho foram apagados.</p>;
    expect(
      render({ items: [item()], waitingBehind: 0 }, { notices })
    ).toContain("Os dados deste aparelho foram apagados.");
    expect(render({ items: [], waitingBehind: 0 }, { notices })).toContain(
      "Os dados deste aparelho foram apagados."
    );
  });

  it("gives the sign-in button an id of its card, where the focus returns when the person stays", () => {
    const html = render({
      items: [item({ actions: ["sign_in_again", "discard"] })],
      waitingBehind: 0,
    });
    expect(html).toContain(
      `id="${signInAgainButtonId("0199c2d0-0000-7000-8000-000000000101")}"`
    );
  });

  it("says the list is empty in terms of sending, so it does not contradict the stock warnings", () => {
    const html = render({ items: [], waitingBehind: 0 });
    expect(html).toContain("Nenhuma pendência de envio.");
    expect(html).not.toContain("Nada precisa de atenção");
  });
});
