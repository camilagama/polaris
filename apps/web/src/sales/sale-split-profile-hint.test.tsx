import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  createBlankSaleForm,
  formFieldKeys,
  startSplit,
} from "./sale-form-model";
import {
  PaymentSection,
  SPLIT_PROFILE_HINT,
  SPLIT_PROFILE_HINT_ID,
} from "./sale-payment-section";

vi.mock("../lib/orpc", () => ({ orpcClient: {} }));

const noop = () => undefined;
const SPLIT = {
  blocker: null,
  evaluation: null,
  handlers: {
    onAcknowledgeSecondReview: noop,
    onAction: noop,
    onEnd: noop,
    onFirstAmountChange: noop,
    onSecondAmountChange: noop,
    onSecondAnticipationChange: noop,
    onSecondInstallmentPlanChange: noop,
    onSecondInstallmentsChange: noop,
    onSecondMethodChange: noop,
    onSecondProfileChange: noop,
    onStart: noop,
  },
};

function render(split: boolean, errors: Record<string, string> = {}): string {
  const base = createBlankSaleForm(() => "d1");
  return renderToStaticMarkup(
    <PaymentSection
      disabled={false}
      errors={errors}
      form={split ? startSplit(base) : base}
      offline={false}
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
      profilesView={{ kind: "empty", message: "Nenhum perfil." }}
      singlePaymentText="Um pagamento só."
      split={SPLIT}
      timezone="America/Sao_Paulo"
    />
  );
}

const occurrences = (html: string, text: string) => html.split(text).length - 1;

const DESCRIBED_BY = /aria-describedby="([^"]*)"/;

function describedByOf(html: string, id: string): string[] {
  const tag = new RegExp(`<button[^>]*\\sid="${id}"[^>]*>`).exec(html)?.[0];
  const value = DESCRIBED_BY.exec(tag ?? "")?.[1];
  return value ? value.split(" ") : [];
}

describe("a dica do perfil no pagamento dividido", () => {
  it("diz a frase do desenho uma vez, depois das partes e antes da linha de estado", () => {
    const html = render(true);
    expect(SPLIT_PROFILE_HINT).toBe(
      "O perfil define taxas e prazo estimados de cada parte. Sem perfil, ficam desconhecidos."
    );
    expect(occurrences(html, SPLIT_PROFILE_HINT)).toBe(1);
    expect(occurrences(html, `id="${SPLIT_PROFILE_HINT_ID}"`)).toBe(1);
    expect(html.indexOf(SPLIT_PROFILE_HINT)).toBeGreaterThan(
      html.indexOf('id="sale-part-2-profile"')
    );
    expect(html.indexOf(SPLIT_PROFILE_HINT)).toBeLessThan(
      html.indexOf("Voltar a um pagamento")
    );
  });

  it("os dois campos de perfil apontam para ela em aria-describedby", () => {
    const html = render(true);
    expect(describedByOf(html, "sale-part-1-profile")).toContain(
      SPLIT_PROFILE_HINT_ID
    );
    expect(describedByOf(html, "sale-part-2-profile")).toContain(
      SPLIT_PROFILE_HINT_ID
    );
  });

  it("com erro no perfil, o erro vem primeiro e a dica continua na lista", () => {
    const html = render(true, {
      [formFieldKeys.profile]: "Escolha um perfil.",
      [formFieldKeys.secondProfile]: "Escolha um perfil.",
    });
    expect(describedByOf(html, "sale-part-1-profile")).toEqual([
      "sale-part-1-profile-error",
      SPLIT_PROFILE_HINT_ID,
    ]);
    expect(describedByOf(html, "sale-part-2-profile")).toEqual([
      "sale-part-2-profile-error",
      SPLIT_PROFILE_HINT_ID,
    ]);
  });

  it("o pagamento de uma parte só não ganha a dica do dividido", () => {
    const html = render(false);
    expect(html).not.toContain(SPLIT_PROFILE_HINT_ID);
    expect(html).not.toContain(SPLIT_PROFILE_HINT);
  });
});
