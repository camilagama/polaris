import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  createBlankSaleForm,
  evaluateSaleForm,
  type ItemDraft,
  joinSaleDate,
  type SaleFormState,
  saleExtrasSummary,
  splitSaleDate,
  stockLineText,
  stockView,
  timeOfDay,
} from "./sale-form-model";
import { ItemEditor } from "./sale-item-editor";
import { PaymentSection } from "./sale-payment-section";
import { SummaryPanel } from "./sale-summary-panel";
import { pickerView, storeHasNothingToSell } from "./sale-variant-picker-model";

vi.mock("../lib/orpc", () => ({ orpcClient: {} }));

const noop = () => undefined;
const variantId = "22222222-2222-4222-8222-222222222222";
const NOW = new Date(2026, 10, 3, 14, 5);
const chosenItem: ItemDraft = {
  chargedUnitPrice: "49,90",
  draftId: "d1",
  label: "Camiseta · Preta",
  listedUnitPrice: "59,90",
  productId: "11111111-1111-4111-8111-111111111111",
  quantity: "1",
  variantId,
};
const blankItem: ItemDraft = {
  ...chosenItem,
  chargedUnitPrice: "",
  label: "",
  listedUnitPrice: "",
  productId: "",
  variantId: "",
};

function renderItem(item: ItemDraft, canRemove = true): string {
  return renderToStaticMarkup(
    <ItemEditor
      canAdjustStock
      canRemove={canRemove}
      errors={{}}
      index={1}
      item={item}
      localSearch={undefined}
      onChange={noop}
      onPick={noop}
      onRemove={noop}
      organizationId="org"
      priceHint={null}
      stock={{
        [variantId]: {
          status: "ready",
          value: {
            movingAverageCost: "12.000000",
            quantity: 6,
            variantId,
            version: 1,
          },
        },
      }}
      stockWarning={undefined}
      summaryLine={undefined}
    />
  );
}

const CONTROL_TAG = /<(?:input|button)[^>]*>/g;
const ID_ATTRIBUTE = /\sid="([^"]+)"/;

describe("o item da venda, enxuto", () => {
  it("antes da escolha, só a busca: nem quantidade nem preços, e a lista fechada", () => {
    const html = renderItem(blankItem);
    expect(html).toContain("Produto ou variante");
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("Quantidade");
    expect(html).not.toContain("Preço cobrado");
    expect(html).not.toContain("Preço de tabela");
    expect(html).not.toContain("Variantes encontradas");
    expect(html).toContain('aria-label="Remover item 2"');
  });

  it("escolhida: uma linha com a marca, o saldo curto e Trocar; quantidade e preços abaixo", () => {
    const html = renderItem(chosenItem);
    expect(html).not.toContain("Produto ou variante");
    expect(html).toContain("lucide-circle-check");
    expect(html).toContain(">Camiseta · Preta</span>");
    expect(html).toContain(">Saldo 6</span>");
    expect(html).toContain("Custo médio: R$ 12,00.");
    expect(html).toContain(
      'Trocar<span class="sr-only"> variante de Camiseta · Preta</span>'
    );
    expect(html.indexOf("Trocar")).toBeLessThan(html.indexOf("Quantidade"));
    expect(html).toContain("Preço cobrado");
  });

  it("os botões repetidos por item levam o nome do produto", () => {
    const html = renderItem(chosenItem);
    expect(html).toContain('aria-label="Remover Camiseta · Preta"');
    expect(html).toContain(
      'aria-label="Menos uma unidade de Camiseta · Preta"'
    );
    expect(html).toContain('aria-label="Mais uma unidade de Camiseta · Preta"');
  });

  it("o saldo é curto quando é só número; zero, erro e leitura em curso dizem a frase inteira", () => {
    const ok = stockView(
      {
        status: "ready",
        value: {
          movingAverageCost: null,
          quantity: 1234,
          variantId,
          version: 1,
        },
      },
      true
    );
    expect(ok && stockLineText(ok)).toBe("Saldo 1.234");
    const zero = stockView(
      {
        status: "ready",
        value: { movingAverageCost: null, quantity: 0, variantId, version: 1 },
      },
      true
    );
    expect(zero && stockLineText(zero)).toBe(
      "Sem estoque: saldo 0. Para vender, dê entrada no estoque."
    );
    const loading = stockView({ status: "loading" }, true);
    expect(loading && stockLineText(loading)).toBe("Consultando estoque…");
  });
});

describe("a loja sem nada para vender", () => {
  it("diz sob o campo; a busca sem resultado diz dentro da lista", () => {
    const empty = {
      status: "ready",
      value: { entries: [], more: false },
    } as const;
    expect(storeHasNothingToSell(pickerView(empty, ""))).toBe(true);
    expect(storeHasNothingToSell(pickerView(empty, "xyz"))).toBe(false);
    expect(storeHasNothingToSell(pickerView({ status: "loading" }, ""))).toBe(
      false
    );
  });
});

describe("Data e ajustes numa linha fechada", () => {
  const form = createBlankSaleForm(() => "d1");

  it("Agora · Sem ajuste; com data e ajustes, o que foi escolhido", () => {
    expect(saleExtrasSummary(form, false)).toBe("Agora · Sem ajuste");
    const dated: SaleFormState = {
      ...form,
      adjustments: [
        { draftId: "a1", kind: "discount", value: "5", valueType: "fixed" },
      ],
      occurredAtLocal: "2026-11-02T09:30",
    };
    expect(saleExtrasSummary(dated, false)).toBe("02/11/2026 09:30 · 1 ajuste");
    expect(
      saleExtrasSummary(
        { ...dated, adjustments: [...dated.adjustments, ...dated.adjustments] },
        false
      )
    ).toBe("02/11/2026 09:30 · 2 ajustes");
    // sem conexão a venda fica com a hora de agora: a data digitada não vale
    expect(saleExtrasSummary(dated, true)).toBe("Agora · 1 ajuste");
  });

  it("o dia do DatePicker e a hora digitada viram um texto só, e voltam", () => {
    expect(joinSaleDate("2026-11-02", "09:30")).toBe("2026-11-02T09:30");
    expect(joinSaleDate("", "")).toBe("");
    expect(splitSaleDate("2026-11-02T09:30")).toEqual({
      day: "2026-11-02",
      time: "09:30",
    });
    expect(splitSaleDate("")).toEqual({ day: "", time: "" });
    expect(splitSaleDate(joinSaleDate("2026-11-02", ""))).toEqual({
      day: "2026-11-02",
      time: "",
    });
    expect(timeOfDay(NOW)).toBe("14:05");
  });

  it("um dia sem hora é recusado com a mensagem da data", () => {
    const evaluation = evaluateSaleForm(
      { ...form, occurredAtLocal: joinSaleDate("2026-11-02", "") },
      { profiles: [], stock: {} },
      { now: NOW, showRequired: false }
    );
    expect(evaluation.errors.occurredAt).toBe(
      "Informe uma data e hora válidas."
    );
  });

  function renderPayment(
    state: SaleFormState,
    offline: boolean,
    errors: Record<string, string> = {}
  ): string {
    return renderToStaticMarkup(
      <PaymentSection
        disabled={false}
        errors={errors}
        form={state}
        offline={offline}
        onAcknowledgeReview={noop}
        onAddAdjustment={noop}
        onAdjustmentChange={noop}
        onAnticipationChange={noop}
        onDateChange={noop}
        onInstallmentPlanChange={noop}
        onInstallmentsChange={noop}
        onMethodChange={noop}
        onProfileChange={noop}
        onRemoveAdjustment={noop}
        onRetry={noop}
        profileOptions={[]}
        profilesView={{
          kind: "empty",
          message: "Nenhum perfil de pagamento ativo.",
        }}
        singlePaymentText="Um pagamento só."
      />
    );
  }

  it("fechada: a linha e Alterar, sem o campo de data nem Adicionar ajuste, e sem datetime-local", () => {
    const html = renderPayment(form, false);
    expect(html).toContain("Agora · Sem ajuste");
    expect(html).toContain(
      'Alterar<span class="sr-only"> data e ajustes</span>'
    );
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("Adicionar ajuste");
    expect(html).not.toContain("datetime-local");
  });

  it("a hora digitada sem ':' vale, e o erro de hora fica no campo Hora, não no Dia", () => {
    const typed = {
      ...form,
      occurredAtLocal: joinSaleDate("2026-11-02", "930"),
    };
    expect(saleExtrasSummary(typed, false)).toBe(
      "02/11/2026 09:30 · Sem ajuste"
    );
    const message = "Informe uma data e hora válidas.";
    const invalidIds = (html: string) =>
      [...html.matchAll(CONTROL_TAG)]
        .map((tag) => tag[0])
        .filter((tag) => tag.includes('aria-invalid="true"'))
        .map((tag) => ID_ATTRIBUTE.exec(tag)?.[1]);
    const badTime = renderPayment(
      { ...form, occurredAtLocal: joinSaleDate("2026-11-02", "9") },
      false,
      { occurredAt: message }
    );
    expect(invalidIds(badTime)).toEqual(["sale-occurred-time"]);
    expect(badTime).toContain(message);
    const future = renderPayment(
      { ...form, occurredAtLocal: joinSaleDate("2026-11-02", "23:59") },
      false,
      { occurredAt: "A data e hora da venda não podem estar no futuro." }
    );
    expect(invalidIds(future)).toEqual(["sale-occurred-day"]);
  });

  it("com Sem perfil já escolhido numa loja sem perfil, sem o parágrafo do vazio", () => {
    const html = renderPayment(
      {
        ...form,
        profile: { choice: "none", reviewNotice: null, seenVersion: null },
      },
      false
    );
    expect(html).not.toContain("Nenhum perfil de pagamento ativo.");
    expect(renderPayment(form, false)).toContain(
      "Nenhum perfil de pagamento ativo."
    );
  });
});

describe("o Resumo só mostra o que já foi escolhido", () => {
  function renderSummary(state: SaleFormState): string {
    const evaluation = evaluateSaleForm(
      state,
      { profiles: [], stock: {} },
      { now: NOW, showRequired: false }
    );
    return renderToStaticMarkup(
      <SummaryPanel
        errors={evaluation.errors}
        evaluation={evaluation}
        offline={false}
        onDiscardCancel={noop}
        onDiscardConfirm={noop}
        onDiscardRequest={noop}
        onKeepOnDevice={undefined}
        onRefresh={noop}
        showRequired={false}
        submission={{ phase: "idle" }}
        summary={evaluation.summary}
      />
    );
  }

  it("nada escolhido: nem data, nem pagamento, nem perfil, nem prévia, nem 'ainda não escolhido'", () => {
    const html = renderSummary(createBlankSaleForm(() => "d1"));
    expect(html).not.toContain("ainda não escolhido");
    expect(html).not.toContain("Data e hora da venda");
    expect(html).not.toContain(">Pagamento<");
    expect(html).not.toContain("Perfil de pagamento");
    expect(html).not.toContain("Prévia de taxas e prazo");
    expect(html).not.toContain(">Ajustes<");
  });

  it("com método, perfil e data: cada um na sua linha", () => {
    const base = createBlankSaleForm(() => "d1");
    const html = renderSummary({
      ...base,
      occurredAtLocal: "2026-11-02T09:30",
      payment: { ...base.payment, method: "pix" },
      profile: { choice: "none", reviewNotice: null, seenVersion: null },
    });
    expect(html).toContain("Data e hora da venda");
    expect(html).toContain(">Pagamento<");
    expect(html).toContain("Pix");
    expect(html).toContain("Sem perfil de pagamento");
  });
});
