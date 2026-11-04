import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBlankSaleForm, joinSaleDate } from "./sale-form-model";

const seen = vi.hoisted(() => ({
  props: [] as { id: string; max?: string; today?: string }[],
}));

vi.mock("../lib/orpc", () => ({ orpcClient: {} }));
vi.mock("./sale-fields", async (importOriginal) => {
  const original = await importOriginal<typeof import("./sale-fields")>();
  return {
    ...original,
    DateField: (props: { id: string; max?: string; today?: string }) => {
      seen.props.push(props);
      return null;
    },
  };
});

const { PaymentSection } = await import("./sale-payment-section");

const noop = () => undefined;
const SAO_PAULO = "America/Sao_Paulo";
const AUCKLAND = "Pacific/Auckland";
const originalZone = process.env.TZ;

function renderDay(timezone: string | null): { max?: string; today?: string } {
  seen.props = [];
  renderToStaticMarkup(
    <PaymentSection
      disabled={false}
      errors={{}}
      form={{
        ...createBlankSaleForm(() => "d1"),
        occurredAtLocal: joinSaleDate("2026-11-02", "10:00"),
      }}
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
      timezone={timezone}
    />
  );
  const field = seen.props.find((props) => props.id === "sale-occurred-day");
  expect(field).toBeDefined();
  return field ?? { id: "" };
}

describe("o campo Dia da venda segue o dia da loja", () => {
  beforeEach(() => {
    seen.props = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalZone === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = originalZone;
    }
  });

  it("aparelho adiantado: perto da meia-noite da loja o aparelho já está no dia seguinte, e o limite fica no dia da loja", () => {
    process.env.TZ = "Pacific/Kiritimati";
    vi.useFakeTimers({
      now: new Date("2026-11-03T02:30:00Z"),
      toFake: ["Date"],
    });
    expect(new Date().getDate()).toBe(3);
    const field = renderDay(SAO_PAULO);
    expect(field.max).toBe("2026-11-02");
    expect(field.today).toBe("2026-11-02");
  });

  it("aparelho atrasado: a loja já virou o dia e o aparelho não, e o limite é o dia novo da loja", () => {
    process.env.TZ = "Pacific/Pago_Pago";
    vi.useFakeTimers({
      now: new Date("2026-11-03T12:00:00Z"),
      toFake: ["Date"],
    });
    expect(new Date().getDate()).toBe(3);
    const field = renderDay(AUCKLAND);
    expect(field.max).toBe("2026-11-04");
    expect(field.today).toBe("2026-11-04");
  });
});
