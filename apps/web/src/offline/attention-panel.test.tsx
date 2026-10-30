import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AttentionItem, AttentionSummary } from "./attention";
import {
  AttentionPanel,
  type AttentionPanelProps,
  refusedText,
} from "./attention-panel";

const none = () => undefined;
const item = (overrides: Partial<AttentionItem> = {}): AttentionItem => ({
  actions: ["resubmit", "discard"],
  blocksQueue: true,
  cause: "insufficient_stock",
  code: "insufficient_stock",
  commandId: "0199c2d0-0000-7000-8000-000000000101",
  detail: "O estoque do servidor não cobre esta venda.",
  kind: "sale",
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
      onReviewAccount={none}
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
    expect(html).toContain("Nada precisa de atenção");
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

  it("offers an account review, not a retry, for a refusal about the account", () => {
    const html = render({
      items: [
        item({
          actions: ["review_account"],
          cause: "entitlement_changed",
          code: "entitlement_changed",
        }),
      ],
      waitingBehind: 0,
    });
    expect(html).toContain("Revisar acesso e plano");
    expect(html).not.toContain("Reenviar");
    expect(html).not.toContain("Descartar");
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

  it("disables the buttons of the item being resolved and shows a failure", () => {
    const html = render(
      { items: [item()], waitingBehind: 0 },
      {
        busyCommandId: "0199c2d0-0000-7000-8000-000000000101",
        errorMessage: "Não foi possível descartar.",
      }
    );
    expect(html).toContain("Não foi possível descartar.");
    expect(html.match(/ disabled=""/g)).toHaveLength(2);
  });
});
