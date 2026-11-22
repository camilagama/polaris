import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_KEYED_METHODS,
  methodForKey,
  methodKeysEnabled,
} from "./payment-method-keys";
import { createBlankSaleForm, SALE_METHOD_CARDS } from "./sale-form-model";
import { PaymentSection } from "./sale-payment-section";

vi.mock("../lib/orpc", () => ({ orpcClient: {} }));

const noop = () => undefined;
const bare = {
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  target: null,
};

function stubTouch(touch: boolean) {
  vi.stubGlobal("window", {
    matchMedia: () => ({
      addEventListener: noop,
      matches: touch,
      removeEventListener: noop,
    }),
  });
}

function renderPayment(): string {
  return renderToStaticMarkup(
    <PaymentSection
      disabled={false}
      errors={{}}
      form={createBlankSaleForm(() => "d1")}
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
      timezone="America/Sao_Paulo"
    />
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("methodForKey", () => {
  const methods = ["a", "b", "c"];

  it("a tecla do número escolhe a opção daquela posição", () => {
    expect(methodForKey({ ...bare, key: "1" }, methods)).toBe("a");
    expect(methodForKey({ ...bare, key: "3" }, methods)).toBe("c");
  });

  it("número além das opções, zero e outras teclas não escolhem nada", () => {
    for (const key of ["4", "0", "a", "Enter", " ", "10", "ArrowDown"]) {
      expect(methodForKey({ ...bare, key }, methods), key).toBeNull();
    }
  });

  it("só as nove primeiras opções têm tecla", () => {
    const many = Array.from({ length: 12 }, (_, index) => index);
    expect(MAX_KEYED_METHODS).toBe(9);
    expect(methodForKey({ ...bare, key: "9" }, many)).toBe(8);
  });

  it("Ctrl, Alt e ⌘ cancelam a tecla", () => {
    for (const modifier of ["altKey", "ctrlKey", "metaKey"]) {
      expect(
        methodForKey({ ...bare, [modifier]: true, key: "1" }, methods),
        modifier
      ).toBeNull();
    }
  });

  it("no AZERTY o dígito sai com Shift e escolhe a opção", () => {
    expect(methodForKey({ ...bare, key: "2", shiftKey: true }, methods)).toBe(
      "b"
    );
  });

  it("em QWERTY e ABNT2 Shift mais o número escreve um símbolo e não escolhe nada", () => {
    for (const key of ["!", "@", "#", "\u00a8", "\u00a3"]) {
      expect(
        methodForKey({ ...bare, key, shiftKey: true }, methods),
        key
      ).toBeNull();
    }
  });
});

describe("methodKeysEnabled", () => {
  it("liga só com ponteiro fino e a partir de 760 px (o contrário da consulta touch)", () => {
    stubTouch(false);
    expect(methodKeysEnabled()).toBe(true);
    stubTouch(true);
    expect(methodKeysEnabled()).toBe(false);
  });

  it("sem matchMedia fica desligada", () => {
    vi.stubGlobal("window", {});
    expect(methodKeysEnabled()).toBe(false);
  });
});

describe("Método de pagamento numerado", () => {
  it("com ponteiro fino cada opção traz o número decorativo e aria-keyshortcuts", () => {
    stubTouch(false);
    const html = renderPayment();
    SALE_METHOD_CARDS.forEach(([method], index) => {
      const position = String(index + 1);
      expect(html, method).toContain(`data-method-key="${position}"`);
      expect(html, method).toContain(`aria-keyshortcuts="${position}"`);
    });
    expect(html.match(/aria-keyshortcuts=/g)).toHaveLength(
      SALE_METHOD_CARDS.length
    );
    expect(html.match(/data-method-key=/g)).toHaveLength(
      SALE_METHOD_CARDS.length
    );
  });

  it("no toque (ou abaixo de 760 px) não há número nem aria-keyshortcuts", () => {
    stubTouch(true);
    const html = renderPayment();
    expect(html).not.toContain("data-method-key");
    expect(html).not.toContain("aria-keyshortcuts");
  });

  it("o grupo segue radiogroup com o mesmo nome", () => {
    stubTouch(false);
    const html = renderPayment();
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-label="Método de pagamento"');
  });
});
