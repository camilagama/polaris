import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OperationFailureNotice } from "./operation-failure-notice";
import {
  CANCELLATION_REASONS,
  type OperationSubmission,
} from "./sale-cancellation-model";
import { SaleIdMissing } from "./sale-id-missing";
import { OperationActions } from "./sale-operation-actions";
import { ReasonFields } from "./sale-reason-fields";
import { ReturnTable } from "./sale-return-table";

const NOOP = () => undefined;

const ROWS = [
  {
    available: 1,
    label: "Calça jeans — 42",
    position: 0,
    restocked: 0,
    returned: 1,
    sold: 2,
  },
  {
    available: 0,
    label: "Cinto",
    position: 1,
    restocked: 1,
    returned: 1,
    sold: 1,
  },
];

const renderTable = (errors: Parameters<typeof ReturnTable>[0]["errors"]) =>
  renderToStaticMarkup(
    <ReturnTable
      disabled={false}
      draft={{
        lines: [
          {
            available: 1,
            label: "Calça jeans — 42",
            position: 0,
            restocked: "",
            restockedTouched: false,
            returned: "5",
          },
        ],
        reasonCode: "",
        reasonNote: "",
      }}
      errors={errors}
      onRestocked={NOOP}
      onReturned={NOOP}
      rows={ROWS}
    />
  );

describe("ReturnTable", () => {
  it("names every cell by its column, for the cards of a narrow card (container below 48rem)", () => {
    const html = renderTable({ lines: {} });
    for (const label of [
      "Item",
      "Vendido",
      "Já devolvido",
      "Já voltou ao estoque",
      "Disponível",
      "Devolvido",
      "Volta ao estoque",
    ]) {
      // one cell per row of the two rows
      expect(html.split(`data-label="${label}"`)).toHaveLength(3);
    }
    expect(html).toContain("@max-3xl:before:content-[attr(data-label)]");
    expect(html).toContain("@max-3xl:sr-only");
  });

  it("gives each field the item and the most that can be returned, and shows a dash where nothing can", () => {
    const html = renderTable({ lines: {} });
    expect(html).toContain('aria-label="Devolvido: Calça jeans — 42 (até 1)"');
    expect(html).toContain('aria-label="Volta ao estoque: Calça jeans — 42"');
    expect(html).not.toContain('aria-label="Devolvido: Cinto');
    expect(html.match(/>—</g)).toHaveLength(2);
  });

  it("ties a line's error to its field and says the error of the whole table as an alert", () => {
    const html = renderTable({
      items: "Informe ao menos uma quantidade.",
      lines: { 0: { returned: "Use um número inteiro de 1 a 1." } },
    });
    expect(html).toContain('aria-describedby="sale-return-0-returned-error"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('id="sale-return-0-returned-error"');
    expect(html).toContain("Use um número inteiro de 1 a 1.");
    expect(html).toContain("Informe ao menos uma quantidade.");
    expect(html.match(/role="alert"/g)).toHaveLength(2);
  });
});

const renderReason = (reasonCode: string, note?: string) =>
  renderToStaticMarkup(
    <ReasonFields
      disabled={false}
      errors={note ? { note } : {}}
      legend="Motivo do cancelamento (opcional)"
      noteCounter="0/500"
      onNoteChange={NOOP}
      onReasonChange={NOOP}
      prefix="sale-cancel"
      reasonCode={reasonCode}
      reasonNote=""
      reasons={CANCELLATION_REASONS}
    />
  );

describe("ReasonFields", () => {
  it("starts on 'Sem motivo informado', with no note to write", () => {
    const html = renderReason("");
    expect(html).toContain("Motivo do cancelamento (opcional)");
    expect(html).toContain("Sem motivo informado");
    expect(html).not.toContain("sale-cancel-note");
  });

  it("asks for the note of 'Outro' and reads its counter and its error", () => {
    const html = renderReason("other", "Escreva a observação.");
    expect(html).toContain("Observação (obrigatória para “Outro”)");
    expect(html).toContain(
      'aria-describedby="sale-cancel-note-error sale-cancel-note-hint"'
    );
    expect(html).toContain("0/500");
    expect(html).toContain("Escreva a observação.");
  });
});

const failure = {
  discardAttempt: false,
  message: "Não foi possível confirmar se o cancelamento foi registrado.",
  reason: null,
  reloadDetail: false,
  unknownOutcome: true,
};

const renderFailure = (submission: OperationSubmission) =>
  renderToStaticMarkup(
    <OperationFailureNotice
      onDiscardCancel={NOOP}
      onDiscardConfirm={NOOP}
      onDiscardRequest={NOOP}
      submission={submission}
      warning="O cancelamento pode já ter sido registrado."
    />
  );

describe("OperationFailureNotice", () => {
  it("says nothing while idle", () => {
    expect(renderFailure({ phase: "idle" })).toBe("");
  });

  it("offers to discard a locked attempt, and asks again before discarding", () => {
    const first = renderFailure({
      confirmingDiscard: false,
      failure,
      phase: "locked",
    });
    expect(first).toContain('role="alert"');
    expect(first).toContain("Descartar esta tentativa");
    expect(first).not.toContain("Sim, descartar");

    const second = renderFailure({
      confirmingDiscard: true,
      failure,
      phase: "locked",
    });
    expect(second).toContain("O cancelamento pode já ter sido registrado.");
    expect(second).toContain("Sim, descartar esta tentativa");
    expect(second).toContain("Voltar");
  });
});

describe("SaleIdMissing", () => {
  it("sends to the history, without a field for an identifier", () => {
    for (const kind of ["absent", "invalid"] as const) {
      const html = renderToStaticMarkup(<SaleIdMissing param={{ kind }} />);
      expect(html).toContain('href="/sales/history"');
      expect(html).not.toContain("<input");
    }
    expect(
      renderToStaticMarkup(<SaleIdMissing param={{ kind: "invalid" }} />)
    ).toContain("Este endereço não aponta para uma venda.");
  });
});

const renderActions = (
  step: { confirming: boolean; locked: boolean },
  destructive = true
) =>
  renderToStaticMarkup(
    <OperationActions
      closeLabel="Não cancelar"
      confirming={step.confirming}
      confirmLabel="Confirmar cancelamento"
      destructive={destructive}
      locked={step.locked}
      onBack={NOOP}
      onClose={NOOP}
      onConfirm={NOOP}
      onReview={NOOP}
      reviewLabel="Revisar cancelamento"
      submitting={false}
    />
  );
const DESTRUCTIVE = "bg-destructive/10";
const DESTRUCTIVE_CONFIRM = /bg-destructive\/10[^>]*>Confirmar cancelamento</;

describe("OperationActions", () => {
  it("has no destructive button while the draft is edited", () => {
    const html = renderActions({ confirming: false, locked: false });
    expect(html).toContain("Revisar cancelamento");
    expect(html).toContain("Não cancelar");
    expect(html).not.toContain("Confirmar cancelamento");
    expect(html).not.toContain(DESTRUCTIVE);
  });

  it("puts the destructive confirm on the last step, with a way back", () => {
    const html = renderActions({ confirming: true, locked: false });
    expect(html).toMatch(DESTRUCTIVE_CONFIRM);
    expect(html).toContain("Voltar");
    // a locked attempt only goes on (the same request) or is discarded in the notice above
    expect(renderActions({ confirming: true, locked: true })).not.toContain(
      "Voltar"
    );
  });

  it("keeps the confirm of a return as the main action, not a destructive one", () => {
    expect(
      renderActions({ confirming: true, locked: false }, false)
    ).not.toContain(DESTRUCTIVE);
  });
});
