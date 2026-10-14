import { describe, expect, it } from "vitest";
import {
  createBlankSaleForm,
  formForOfflineSale,
  formForOnlineSale,
  idleSubmission,
  isFormLocked,
  NO_PROFILE_CHOICE,
  queuedSubmission,
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
