import { describe, expect, it } from "vitest";
import {
  canKeepLockedSaleOnDevice,
  createBlankSaleForm,
  formForOfflineSale,
  formForOnlineSale,
  idleSubmission,
  isFormLocked,
  NO_PROFILE_CHOICE,
  queuedSubmission,
  saleModeIsOffline,
  selectProfileChoice,
  startSubmission,
  submitButtonLabel,
} from "./sale-form-model";

const newId = () => "draft";

describe("the form for a sale kept on the device", () => {
  it("has no payment profile and no typed date offline", () => {
    const typed = {
      ...createBlankSaleForm(newId),
      occurredAtLocal: "2026-10-01T10:00",
    };
    const offline = formForOfflineSale(typed);
    expect(offline.profile.choice).toBe(NO_PROFILE_CHOICE);
    expect(offline.occurredAtLocal).toBe("");
  });

  it("undoes the offline 'no profile' choice when the connection is back, but keeps a real profile choice", () => {
    const offline = formForOfflineSale(createBlankSaleForm(newId));
    expect(formForOnlineSale(offline).profile.choice).toBe("");

    const chosen = selectProfileChoice(
      createBlankSaleForm(newId),
      "profile-1",
      []
    );
    expect(formForOnlineSale(chosen)).toBe(chosen);
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

  it("is allowed only for a locked sale the device command can carry exactly", () => {
    expect(canKeepLockedSaleOnDevice(locked, attempt, evaluation())).toBe(true);
  });

  it("is refused with a payment profile, a typed date, another instant, no attempt, or any other state", () => {
    expect(
      canKeepLockedSaleOnDevice(
        locked,
        attempt,
        evaluation({ profile: { expectedVersion: 1, id: "p" } })
      )
    ).toBe(false);
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
