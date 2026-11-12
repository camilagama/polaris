import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ItemEditor } from "./sale-item-editor";
import {
  describeStockRefusal,
  failSubmission,
  type ItemDraft,
  type SaleEvaluation,
} from "./sale-form-model";
import { SummaryPanel } from "./sale-summary-panel";

vi.mock("../lib/orpc", () => ({ orpcClient: {} }));

const variantId = "22222222-2222-4222-8222-222222222222";
const item: ItemDraft = {
  chargedUnitPrice: "10,00",
  draftId: "d1",
  label: "Caneca esmaltada",
  listedUnitPrice: "10,00",
  productId: "11111111-1111-4111-8111-111111111111",
  quantity: "2",
  variantId,
};
const noop = () => undefined;

function renderItem(
  quantity: number,
  canAdjustStock: boolean,
  asked = item.quantity,
  otherLinesQuantity = 0
): string {
  const draft = { ...item, quantity: asked };
  const warning =
    quantity > 0 && Number(asked) + otherLinesQuantity > quantity
      ? `Acima do saldo (${quantity}): a venda é recusada se ele não bastar.`
      : undefined;
  return renderToStaticMarkup(
    <ItemEditor
      canAdjustStock={canAdjustStock}
      canRemove={false}
      errors={{}}
      index={0}
      item={draft}
      localSearch={undefined}
      onChange={noop}
      onPick={noop}
      onRemove={noop}
      organizationId="org"
      otherLinesQuantity={otherLinesQuantity}
      priceHint={null}
      stock={{
        [variantId]: {
          status: "ready",
          value: { movingAverageCost: null, quantity, variantId, version: 1 },
        },
      }}
      stockWarning={warning}
      summaryLine={undefined}
    />
  );
}

const evaluation = {
  dateText: "agora",
  errors: {},
  feePreview: null,
  methodText: "Pix",
  profileText: "Sem perfil",
  summary: null,
} as unknown as SaleEvaluation;

function renderRefusal(canAdjustStock: boolean): string {
  const submission = describeStockRefusal(
    failSubmission(
      {
        code: "CONFLICT",
        data: { reason: "insufficient_stock" },
      },
      []
    ),
    {
      canAdjustStock,
      items: [{ quantity: 2, variantId }],
      labels: new Map([[variantId, item.label]]),
      stock: {
        [variantId]: {
          status: "ready",
          value: {
            movingAverageCost: null,
            quantity: 0,
            variantId,
            version: 1,
          },
        },
      },
    }
  );
  return renderToStaticMarkup(
    <SummaryPanel
      errors={{}}
      evaluation={evaluation}
      offline={false}
      onDiscardCancel={noop}
      onDiscardConfirm={noop}
      onDiscardRequest={noop}
      onKeepOnDevice={undefined}
      onRefresh={noop}
      showRequired={false}
      submission={submission}
      summary={null}
    />
  );
}

describe("o caminho do saldo 0 até a entrada de estoque", () => {
  it("no item com saldo 0 e permissão: o aviso e o link, na mesma aba, com a variante no nome", () => {
    const html = renderItem(0, true);
    expect(html).toContain(
      "Sem estoque: saldo 0. Para vender, dê entrada no estoque."
    );
    expect(html).toContain(
      `href="/inventory?entrada=${variantId}&amp;de=venda&amp;quantidade=2"`
    );
    expect(html).toContain(
      'Dar entrada no estoque<span class="sr-only"> de Caneca esmaltada</span>'
    );
    expect(html).not.toContain("_blank");
    expect(html.indexOf("Sem estoque")).toBeLessThan(
      html.indexOf("Dar entrada no estoque")
    );
    expect(html.indexOf("Trocar")).toBeLessThan(
      html.indexOf("Dar entrada no estoque")
    );
  });

  it("no item com saldo 0 e sem permissão: pede a quem cuida do estoque e não mostra link", () => {
    const html = renderItem(0, false);
    expect(html).toContain(
      "Sem estoque: saldo 0. Peça a quem cuida do estoque para dar entrada."
    );
    expect(html).not.toContain("/inventory");
    expect(html).not.toContain("Dar entrada no estoque");
  });

  it("pedido acima de um saldo que não é zero: o link leva o que falta (pedido menos saldo)", () => {
    const html = renderItem(1, true, "3");
    expect(html).toContain("Acima do saldo (1)");
    expect(html).toContain(
      `href="/inventory?entrada=${variantId}&amp;de=venda&amp;quantidade=2"`
    );
  });

  it("outra linha da mesma variante: o link leva o que falta no total das linhas, não só desta", () => {
    const html = renderItem(4, true, "3", 3);
    expect(html).toContain("Acima do saldo (4)");
    expect(html).toContain(
      `href="/inventory?entrada=${variantId}&amp;de=venda&amp;quantidade=2"`
    );
  });

  it("pedido acima do saldo sem permissão: o aviso fica e o link não aparece", () => {
    const html = renderItem(1, false, "3");
    expect(html).toContain("Acima do saldo (1)");
    expect(html).not.toContain("/inventory");
  });

  it("saldo zero com a quantidade ainda inválida: o link abre com 1, sem número", () => {
    for (const asked of ["", "0", "2,5", "abc"]) {
      expect(renderItem(0, true, asked)).toContain(
        `href="/inventory?entrada=${variantId}&amp;de=venda"`
      );
    }
  });

  it("com saldo, nenhum dos dois aparece", () => {
    const html = renderItem(3, true);
    expect(html).toContain(">Saldo 3</span>");
    expect(html).not.toContain("/inventory");
  });

  it("na recusa: o texto, o link com a variante no nome, antes de Atualizar dados", () => {
    const html = renderRefusal(true);
    expect(html).toContain(
      "A venda não foi registrada: falta estoque de Caneca esmaltada (pediu 2, saldo 0)."
    );
    expect(html).toContain(
      `href="/inventory?entrada=${variantId}&amp;de=venda&amp;quantidade=2"`
    );
    expect(html).toContain('<span class="sr-only"> de Caneca esmaltada</span>');
    expect(html.indexOf("Dar entrada no estoque")).toBeLessThan(
      html.indexOf("Atualizar dados e revisar a venda")
    );
  });

  it("na recusa sem permissão: sem link, só o texto", () => {
    const html = renderRefusal(false);
    expect(html).toContain("Peça a quem cuida do estoque para dar entrada.");
    expect(html).not.toContain("/inventory");
    expect(html).toContain("Atualizar dados e revisar a venda");
  });
});
