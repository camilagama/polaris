import { describe, expect, it } from "vitest";
import {
  canKeepLockedSaleOnDevice,
  createBlankSaleForm,
  evaluateSaleForm,
  formForOfflineSale,
  idleSubmission,
  isFormLocked,
  NO_PROFILE_CHOICE,
  prepareConfirmation,
  queuedSubmission,
  type SaleFormState,
  saleModeIsOffline,
  selectItemProduct,
  selectItemVariant,
  selectPaymentMethod,
  selectProfileChoice,
  startSubmission,
  submitButtonLabel,
  updateItem,
} from "./sale-form-model";

const newId = () => "draft";

describe("the form for a sale kept on the device", () => {
  it("drops a typed date offline and keeps the person's payment profile choice", () => {
    const typed = {
      ...selectProfileChoice(createBlankSaleForm(newId), "profile-1", []),
      occurredAtLocal: "2026-10-01T10:00",
    };
    const offline = formForOfflineSale(typed);
    expect(offline.occurredAtLocal).toBe("");
    expect(offline.profile.choice).toBe("profile-1");
  });

  describe("with a lost answer on the same cart", () => {
    const organizationId = "00000000-0000-4000-8000-0000000000a1";
    const sentAt = new Date("2026-10-14T12:00:00.000Z");
    const FIRST_ID = "00000000-0000-4000-8000-0000000000d1";
    const OTHER_ID = "00000000-0000-4000-8000-0000000000d2";

    function typedDateForm(): SaleFormState {
      let form = createBlankSaleForm(newId);
      const { draftId } = form.items[0] ?? { draftId: "" };
      form = selectItemProduct(
        form,
        draftId,
        "00000000-0000-4000-8000-0000000000b1"
      );
      form = selectItemVariant(
        form,
        draftId,
        "00000000-0000-4000-8000-0000000000c1",
        "Camiseta — Azul / M"
      );
      form = updateItem(form, draftId, {
        chargedUnitPrice: "49,90",
        listedUnitPrice: "55,00",
        quantity: "2",
      });
      form = selectPaymentMethod(form, "pix");
      form = selectProfileChoice(form, NO_PROFILE_CHOICE, []);
      return { ...form, occurredAtLocal: "2026-10-13T08:00" };
    }

    function prepare(form: SaleFormState, ids: () => string) {
      const evaluation = evaluateSaleForm(
        form,
        { profiles: [], stock: {} },
        { now: sentAt, showRequired: true }
      );
      if (evaluation.body === null) {
        throw new Error("expected a valid body");
      }
      const prepared = prepareConfirmation({
        body: evaluation.body,
        createId: ids,
        now: sentAt,
        occurredAtOverride: evaluation.occurredAtOverride,
        organizationId,
        previousAttempt: null,
      });
      if (!prepared.ok) {
        throw new Error("expected a prepared confirmation");
      }
      return { evaluation, prepared };
    }

    function again(form: SaleFormState, previous: ReturnType<typeof prepare>) {
      const evaluation = evaluateSaleForm(
        form,
        { profiles: [], stock: {} },
        { now: sentAt, showRequired: true }
      );
      if (evaluation.body === null) {
        throw new Error("expected a valid body");
      }
      return prepareConfirmation({
        body: evaluation.body,
        createId: () => OTHER_ID,
        now: sentAt,
        occurredAtOverride: evaluation.occurredAtOverride,
        organizationId,
        previousAttempt: previous.prepared.attempt,
      });
    }

    it("keeps the typed date, the body and the command ID while the outcome is unknown", () => {
      const form = typedDateForm();
      const sent = prepare(form, () => FIRST_ID);
      const offline = formForOfflineSale(form, true);
      expect(offline).toBe(form);
      const resent = again(offline, sent);
      expect(resent.ok && resent.attempt.commandId).toBe(FIRST_ID);
      expect(resent.ok && resent.request).toEqual(sent.prepared.request);
    });

    it("drops the date and the command ID changes when no outcome is unknown", () => {
      const form = typedDateForm();
      const sent = prepare(form, () => FIRST_ID);
      const offline = formForOfflineSale(form, false);
      expect(offline.occurredAtLocal).toBe("");
      expect(formForOfflineSale(form)).toEqual(offline);
      const resent = again(offline, sent);
      expect(resent.ok && resent.attempt.commandId).toBe(OTHER_ID);
    });
  });

  it("labels the button for what will happen, and a queued sale does not lock the form", () => {
    expect(submitButtonLabel(idleSubmission)).toBe("Confirmar venda");
    expect(submitButtonLabel(idleSubmission, true)).toBe(
      "Guardar venda neste aparelho"
    );
    expect(submitButtonLabel(startSubmission(idleSubmission), true)).toBe(
      "Guardando venda…"
    );
    const queued = queuedSubmission({
      commandId: "c",
      stockWarnings: [],
      totalDue: "10,00",
    });
    expect(queued.phase).toBe("queued");
    expect(isFormLocked(queued)).toBe(false);
  });
});

describe("keeping a locked sale on the device as the same sale", () => {
  const attempt = {
    commandId: "c",
    occurredAt: "2026-10-14T12:00:00.000Z",
    recordedAt: "2026-10-14T12:00:00.000Z",
    signature: "s",
  };
  const locked = {
    confirmingDiscard: false,
    failure: {
      discardAttempt: false,
      entry: null,
      kind: "network" as const,
      message: "m",
      reason: null,
      refreshData: false,
      unknownOutcome: true,
    },
    phase: "locked" as const,
  };
  const evaluation = (
    overrides: Partial<{ override: string | null; profile: unknown }> = {}
  ) =>
    ({
      body: {
        paymentProfile: "profile" in overrides ? overrides.profile : null,
      },
      occurredAtOverride: "override" in overrides ? overrides.override : null,
    }) as unknown as Parameters<typeof canKeepLockedSaleOnDevice>[2];

  it("is allowed for a locked sale the device command can carry exactly, with or without a payment profile", () => {
    expect(canKeepLockedSaleOnDevice(locked, attempt, evaluation())).toBe(true);
    expect(
      canKeepLockedSaleOnDevice(
        locked,
        attempt,
        evaluation({ profile: { expectedVersion: 1, id: "p" } })
      )
    ).toBe(true);
  });

  it("is refused with a typed date, another instant, no attempt, or any other state", () => {
    expect(
      canKeepLockedSaleOnDevice(
        locked,
        attempt,
        evaluation({ override: "2026-10-01T10:00:00.000Z" })
      )
    ).toBe(false);
    expect(
      canKeepLockedSaleOnDevice(
        locked,
        { ...attempt, recordedAt: "2026-10-14T12:00:05.000Z" },
        evaluation()
      )
    ).toBe(false);
    expect(canKeepLockedSaleOnDevice(locked, null, evaluation())).toBe(false);
    expect(
      canKeepLockedSaleOnDevice(idleSubmission, attempt, evaluation())
    ).toBe(false);
  });
});

describe("the mode of the sale screen", () => {
  const submitting = { phase: "submitting" as const };
  const locked = {
    confirmingDiscard: false,
    failure: {
      discardAttempt: false,
      entry: null,
      kind: "network" as const,
      message: "m",
      reason: null,
      refreshData: false,
      unknownOutcome: true,
    },
    phase: "locked" as const,
  };

  it("follows the connection when no sale is in flight", () => {
    expect(saleModeIsOffline(false, true, idleSubmission)).toBe(true);
    expect(saleModeIsOffline(true, false, idleSubmission)).toBe(false);
    expect(
      saleModeIsOffline(true, false, {
        failure: locked.failure,
        phase: "failed" as const,
      })
    ).toBe(false);
  });

  it("stays as it was while a sale is in flight or its outcome is unknown, whatever the connection does", () => {
    // the server mode, and the connection drops during the request
    expect(saleModeIsOffline(false, true, submitting)).toBe(false);
    expect(saleModeIsOffline(false, true, locked)).toBe(false);
    // the device mode, and the connection returns during the save
    expect(saleModeIsOffline(true, false, submitting)).toBe(true);
  });
});
