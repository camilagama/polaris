import { describe, expect, it } from "vitest";
import {
  acceptanceCheckboxLabel,
  acceptanceIntro,
  acceptanceLoadAfterFailure,
  acceptanceLoadFrom,
  acceptanceSubmitFailure,
  type PendingLegalDocument,
} from "./acceptance-model";

function pending(
  document: "terms" | "privacy",
  changes: string | null = null
): PendingLegalDocument {
  return { changes, document, effectiveFrom: null, version: 1 };
}

describe("acceptanceLoadFrom", () => {
  it("is done when nothing is pending, and pending with the list otherwise", () => {
    expect(acceptanceLoadFrom([])).toEqual({ status: "done" });
    const list = [pending("terms")];
    expect(acceptanceLoadFrom(list)).toEqual({
      pending: list,
      status: "pending",
    });
  });
});

describe("acceptanceLoadAfterFailure", () => {
  it("asks for the session when the server says not signed in", () => {
    expect(acceptanceLoadAfterFailure({ code: "UNAUTHORIZED" }, true)).toEqual({
      status: "session_required",
    });
  });

  it("any other failure is an error, and says whether the device is offline", () => {
    expect(
      acceptanceLoadAfterFailure(new TypeError("Failed to fetch"), false)
    ).toEqual({ offline: true, status: "error" });
    expect(
      acceptanceLoadAfterFailure({ code: "INTERNAL_SERVER_ERROR" }, true)
    ).toEqual({ offline: false, status: "error" });
    expect(acceptanceLoadAfterFailure({ code: "FORBIDDEN" }, true)).toEqual({
      offline: false,
      status: "error",
    });
  });
});

describe("acceptanceIntro", () => {
  it("says it is a new version when any pending document has what changed", () => {
    expect(
      acceptanceIntro([pending("terms"), pending("privacy", "Novo prazo.")])
    ).toBe("Atualizamos os termos. Leia e aceite para continuar.");
  });

  it("says it is the first time when nothing changed", () => {
    expect(acceptanceIntro([pending("terms"), pending("privacy")])).toBe(
      "Para usar o Polaris, leia e aceite."
    );
  });
});

describe("acceptanceCheckboxLabel", () => {
  it("names only what is being accepted", () => {
    expect(acceptanceCheckboxLabel([pending("terms")])).toBe(
      "Li e aceito os Termos de Uso."
    );
    expect(acceptanceCheckboxLabel([pending("privacy")])).toBe(
      "Li e aceito a Política de Privacidade."
    );
    expect(
      acceptanceCheckboxLabel([pending("privacy"), pending("terms")])
    ).toBe("Li e aceito os Termos de Uso e a Política de Privacidade.");
  });
});

describe("acceptanceSubmitFailure", () => {
  it("tells a lost session, a version that changed, and any other failure", () => {
    expect(acceptanceSubmitFailure({ code: "UNAUTHORIZED" })).toBe(
      "session_required"
    );
    expect(
      acceptanceSubmitFailure({
        code: "CONFLICT",
        data: { reason: "legal_version_mismatch" },
      })
    ).toBe("version_changed");
    expect(acceptanceSubmitFailure({ code: "CONFLICT" })).toBe("failed");
    expect(
      acceptanceSubmitFailure({
        code: "BAD_REQUEST",
        data: { reason: "legal_version_mismatch" },
      })
    ).toBe("failed");
    expect(acceptanceSubmitFailure(new TypeError("Failed to fetch"))).toBe(
      "failed"
    );
  });
});
