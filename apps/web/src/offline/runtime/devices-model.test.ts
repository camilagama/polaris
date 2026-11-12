import type { DeviceReadModel } from "@polaris/contracts";
import { describe, expect, it } from "vitest";
import { OFFLINE_PLAN_REASON } from "../attention-panel";
import {
  confirmLabel,
  deviceRows,
  devicesLoadError,
  END_OTHER_SESSIONS_HELP,
  END_OTHER_SESSIONS_LABEL,
  END_OTHER_SESSIONS_WARNING,
  RECOGNIZING_ACCOUNT_TEXT,
  RECOGNIZING_LEGAL_TEXT,
  RECOGNIZING_PLAN_TEXT,
  RECOGNIZING_SLOW_TEXT,
  RECOGNIZING_TEXT,
  RECOGNIZING_UNAVAILABLE_TEXT,
  REVOKE_WARNING,
  REVOKE_WARNING_NOTE,
  recognitionState,
  recognitionText,
  revokedMessage,
  revokeFailure,
  SESSION_GONE_PANEL,
  SESSION_OLD_PANEL,
  signInAgainPanel,
} from "./devices-model";
import {
  ACCOUNT_UNAVAILABLE_REASONS,
  PLAN_REFUSED_REASON,
} from "./offline-runtime";

const uuid = (n: number) =>
  `0199c2d0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const device = (
  n: number,
  overrides: Partial<DeviceReadModel> = {}
): DeviceReadModel => ({
  createdAt: "2026-10-01T12:00:00.000Z",
  id: uuid(n),
  label: null,
  lastSeenAt: `2026-10-${String(10 + n).padStart(2, "0")}T12:00:00.000Z`,
  revokedAt: null,
  ...overrides,
});
const rpcError = (code: string) => Object.assign(new Error(code), { code });

describe("the devices screen rows", () => {
  it("puts this device first, then the most recently seen, and hides revoked ones", () => {
    const rows = deviceRows(
      [
        device(1, { label: "Caixa" }),
        device(2),
        device(3, { revokedAt: "2026-10-12T12:00:00.000Z" }),
        device(4, { label: "  Celular da Ana  " }),
      ],
      uuid(1)
    );
    expect(rows.map((row) => row.id)).toEqual([uuid(1), uuid(4), uuid(2)]);
    expect(rows[0]?.isCurrent).toBe(true);
    expect(rows[1]?.isCurrent).toBe(false);
  });

  it("names a device without a label, and trims a label", () => {
    const rows = deviceRows([device(1), device(2, { label: " Loja " })], null);
    expect(rows.find((row) => row.id === uuid(1))?.labelText).toBe(
      "Aparelho sem nome"
    );
    expect(rows.find((row) => row.id === uuid(2))?.labelText).toBe("Loja");
    expect(rows.every((row) => !row.isCurrent)).toBe(true);
  });
});

const forbidden = (reason: string) =>
  Object.assign(rpcError("FORBIDDEN"), { data: { reason } });
const TECHNICAL = /fresh_session_required|FORBIDDEN|UNAUTHORIZED|401|403/;

describe("the result of a revocation", () => {
  it("counts the sessions ended and the offline authorizations cancelled, one sentence each", () => {
    expect(revokedMessage({ grants: 0, sessions: 0 })).toBe(
      "Aparelho revogado."
    );
    expect(revokedMessage({ grants: 1, sessions: 0 })).toBe(
      "Aparelho revogado. 1 permissão de uso offline cancelada."
    );
    expect(revokedMessage({ grants: 3, sessions: 0 })).toBe(
      "Aparelho revogado. 3 permissões de uso offline canceladas."
    );
    expect(revokedMessage({ grants: 0, sessions: 1 })).toBe(
      "Aparelho revogado. 1 acesso encerrado."
    );
    expect(revokedMessage({ grants: 0, sessions: 2 })).toBe(
      "Aparelho revogado. 2 acessos encerrados."
    );
    expect(revokedMessage({ grants: 1, sessions: 2 })).toBe(
      "Aparelho revogado. 1 permissão de uso offline cancelada. 2 acessos encerrados."
    );
  });

  it("changes the confirm button with the choice", () => {
    expect(confirmLabel(false)).toBe("Sim, revogar este aparelho");
    expect(confirmLabel(true)).toBe(
      "Sim, revogar e encerrar as outras sessões"
    );
  });

  it("does not say before the answer whether this browser leaves, because only the answer tells", () => {
    for (const text of [
      REVOKE_WARNING,
      REVOKE_WARNING_NOTE,
      END_OTHER_SESSIONS_LABEL,
      END_OTHER_SESSIONS_HELP,
      END_OTHER_SESSIONS_WARNING,
      confirmLabel(false),
      confirmLabel(true),
    ]) {
      expect(text.toLowerCase()).not.toContain("navegador");
    }
  });
});

describe("the failures", () => {
  it("an old login asks to sign in again, says nothing was revoked and cites the minutes", () => {
    const failure = revokeFailure(forbidden("fresh_session_required"));
    expect(failure).toEqual({
      kind: "sign_in_again",
      panel: SESSION_OLD_PANEL,
    });
    expect(SESSION_OLD_PANEL.body).toContain("Nada foi revogado");
    expect(SESSION_OLD_PANEL.body).toContain("15 minutos");
    expect(SESSION_OLD_PANEL.body).toContain("logo depois de entrar");
    expect(SESSION_OLD_PANEL.title + SESSION_OLD_PANEL.body).not.toMatch(
      TECHNICAL
    );
    expect(SESSION_OLD_PANEL.kind).toBe("session_old");
  });

  it("a session that ended during the action goes to the same panel with its own text", () => {
    expect(revokeFailure(rpcError("UNAUTHORIZED"))).toEqual({
      kind: "sign_in_again",
      panel: SESSION_GONE_PANEL,
    });
    expect(SESSION_GONE_PANEL.body).toBe(
      "Sua sessão acabou. Nada foi alterado. Entre de novo para continuar."
    );
    expect(SESSION_GONE_PANEL.kind).toBe("session_gone");
    expect(signInAgainPanel(rpcError("UNAUTHORIZED"))).toBe(SESSION_GONE_PANEL);
    expect(devicesLoadError(rpcError("UNAUTHORIZED"))).toBe(
      "Sua sessão acabou. Entre de novo para continuar."
    );
  });

  it("a forbidden for another reason is not a call to sign in again", () => {
    expect(signInAgainPanel(forbidden("other"))).toBeNull();
    expect(revokeFailure(forbidden("other"))).toMatchObject({
      kind: "message",
      uncertain: false,
    });
  });

  it("a definite refusal says nothing changed; an unknown outcome never claims either way", () => {
    expect(revokeFailure(rpcError("NOT_FOUND"))).toMatchObject({
      text: expect.stringContaining("já foi revogado"),
      uncertain: false,
    });
    expect(revokeFailure(rpcError("PAYLOAD_TOO_LARGE"))).toEqual({
      kind: "message",
      text: "Não foi possível revogar este aparelho. Nada foi alterado.",
      uncertain: false,
    });
    for (const unknown of [
      new TypeError("Failed to fetch"),
      rpcError("INTERNAL_SERVER_ERROR"),
      rpcError("BAD_GATEWAY"),
    ]) {
      expect(revokeFailure(unknown)).toEqual({
        kind: "message",
        text: "Não conseguimos confirmar se o aparelho foi revogado. Feche este aviso e olhe a lista. Se o aparelho ainda aparecer, revogue de novo. Repetir é seguro.",
        uncertain: true,
      });
    }
  });

  it("a list that fails to load says to check the connection", () => {
    expect(devicesLoadError(new TypeError("Failed to fetch"))).toBe(
      "Não foi possível carregar os aparelhos. Verifique a conexão e tente de novo."
    );
  });
});

describe("what the screen says while it does not know this device", () => {
  it("slow: the runtime is still preparing after the patience ran out, and the text stays the one about a better connection", () => {
    expect(recognitionState(false, "starting")).toBe("waiting");
    expect(recognitionState(true, "starting")).toBe("slow");
    expect(RECOGNIZING_SLOW_TEXT).toBe(
      "Não foi possível reconhecer este aparelho agora. Recarregue a página. Se continuar, tente de novo com uma internet melhor."
    );
  });

  it("unavailable or absent: says right away, with or without the wait, that this browser could not prepare offline access", () => {
    for (const slow of [false, true]) {
      expect(recognitionState(slow, "unavailable")).toBe("unavailable");
      expect(recognitionState(slow, null)).toBe("unavailable");
    }
    expect(RECOGNIZING_UNAVAILABLE_TEXT).toBe(
      "Este navegador não conseguiu preparar o acesso offline, e sem isso não dá para revogar por aqui. Recarregue a página. Se continuar, tente em outro celular ou computador em que o Polaris funcione."
    );
    expect(RECOGNIZING_UNAVAILABLE_TEXT).not.toBe(RECOGNIZING_SLOW_TEXT);
  });

  it.each([
    ["no reason is known", null],
    ["the local queue does not open", "queue_open_failed"],
    ["the last sync failed", "sync_failed"],
  ])("blames the browser when %s", (_name, reason) => {
    for (const slow of [false, true]) {
      expect(recognitionState(slow, "unavailable", reason)).toBe("unavailable");
    }
  });

  it.each([
    "legal_acceptance_required",
    "organization_closed",
    "purge_failed",
    "session_changed",
    "session_refused",
    PLAN_REFUSED_REASON,
  ])(
    "does not blame the browser when the reason is about the account or the plan (%s)",
    (reason) => {
      for (const slow of [false, true]) {
        expect(recognitionState(slow, "unavailable", reason)).toBe("slow");
      }
    }
  );

  it("an absent runtime blames the browser whatever the stale reason", () => {
    expect(recognitionState(false, null, "session_refused")).toBe(
      "unavailable"
    );
  });
});

const ERROR_OR_CODE = /erro|c[oó]digo|\d{3}/i;
const CONNECTION_WORD = /internet|conex|rede/i;
const SENTENCE_END = /[.!?]/g;

describe("the sentence for each cause while this device is not known", () => {
  const cases = [
    [
      "the browser is still preparing, patience over",
      "starting",
      null,
      RECOGNIZING_SLOW_TEXT,
    ],
    [
      "the browser failed (no reason)",
      "unavailable",
      null,
      RECOGNIZING_UNAVAILABLE_TEXT,
    ],
    [
      "the browser failed (queue_open_failed)",
      "unavailable",
      "queue_open_failed",
      RECOGNIZING_UNAVAILABLE_TEXT,
    ],
    [
      "the plan refused",
      "unavailable",
      PLAN_REFUSED_REASON,
      RECOGNIZING_PLAN_TEXT,
    ],
    [
      "the acceptance is pending",
      "unavailable",
      "legal_acceptance_required",
      RECOGNIZING_LEGAL_TEXT,
    ],
    [
      "the store is closed",
      "unavailable",
      "organization_closed",
      RECOGNIZING_ACCOUNT_TEXT,
    ],
    [
      "the copy could not be dropped",
      "unavailable",
      "purge_failed",
      RECOGNIZING_ACCOUNT_TEXT,
    ],
    [
      "another account signed in",
      "unavailable",
      "session_changed",
      RECOGNIZING_ACCOUNT_TEXT,
    ],
    [
      "the session was refused",
      "unavailable",
      "session_refused",
      RECOGNIZING_ACCOUNT_TEXT,
    ],
  ] as const;

  it.each(cases)(
    "%s: says its own sentence and only it",
    (_name, phase, reason, text) => {
      const waits = phase === "starting" ? [true] : [false, true];
      for (const slow of waits) {
        const state = recognitionState(slow, phase, reason);
        expect(recognitionText(state, phase, reason)).toBe(text);
      }
    }
  );

  it("covers every reason the runtime treats as not the browser's", () => {
    const covered = new Set<string | null>(cases.map(([, , reason]) => reason));
    for (const reason of [
      PLAN_REFUSED_REASON,
      ...ACCOUNT_UNAVAILABLE_REASONS,
    ]) {
      expect(covered.has(reason), reason).toBe(true);
    }
  });

  it("waiting says the promise, and a stale reason does not change a runtime still preparing", () => {
    expect(recognitionText("waiting", "starting")).toBe(RECOGNIZING_TEXT);
    expect(recognitionText("slow", "starting", "session_refused")).toBe(
      RECOGNIZING_SLOW_TEXT
    );
    expect(recognitionText("unavailable", null, "session_refused")).toBe(
      RECOGNIZING_UNAVAILABLE_TEXT
    );
  });

  it("only the browser sentence about the connection mentions it", () => {
    for (const text of [
      RECOGNIZING_PLAN_TEXT,
      RECOGNIZING_LEGAL_TEXT,
      RECOGNIZING_ACCOUNT_TEXT,
    ]) {
      expect(text).not.toMatch(CONNECTION_WORD);
    }
    expect(RECOGNIZING_SLOW_TEXT).toMatch(CONNECTION_WORD);
  });

  it("each new sentence is one line of action: no error word, no code, one sentence", () => {
    for (const text of [
      RECOGNIZING_PLAN_TEXT,
      RECOGNIZING_LEGAL_TEXT,
      RECOGNIZING_ACCOUNT_TEXT,
    ]) {
      expect(text).not.toMatch(ERROR_OR_CODE);
      expect(text.match(SENTENCE_END)).toHaveLength(1);
      expect(text.length).toBeLessThanOrEqual(90);
    }
  });

  it("the plan sentence is the one Pendências uses for the same cause", () => {
    expect(RECOGNIZING_PLAN_TEXT).toBe(OFFLINE_PLAN_REASON);
  });
});
