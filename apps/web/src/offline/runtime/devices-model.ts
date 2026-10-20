import type { DeviceReadModel } from "@polaris/contracts";
import { formatInstant } from "../../lib/format";
import {
  isDefiniteRpcRejection,
  legalAcceptanceMessage,
  rpcErrorCode,
  rpcErrorReason,
} from "../../lib/rpc-error";
import type { RuntimeSnapshot } from "./offline-runtime";

/**
 * The devices of the signed-in user, as the "Aparelhos" screen shows them. A
 * lost phone keeps a valid offline lease for up to 72 hours; revoking its device
 * is how the person cuts it off: the server refuses everything that device sends
 * from then on (ADR 0044).
 */
export interface DeviceRow {
  id: string;
  /** This is the device the screen is open on: it can only leave through "Sair". */
  isCurrent: boolean;
  labelText: string;
  lastSeenText: string;
  registeredText: string;
}

/** This device first, then the most recently seen; revoked devices are not shown. */
export function deviceRows(
  devices: readonly DeviceReadModel[],
  currentDeviceId: string | null
): DeviceRow[] {
  return devices
    .filter((device) => device.revokedAt === null)
    .map((device) => ({
      device,
      isCurrent: device.id === currentDeviceId,
    }))
    .sort(
      (a, b) =>
        Number(b.isCurrent) - Number(a.isCurrent) ||
        b.device.lastSeenAt.localeCompare(a.device.lastSeenAt) ||
        a.device.id.localeCompare(b.device.id)
    )
    .map(({ device, isCurrent }) => ({
      id: device.id,
      isCurrent,
      labelText: device.label?.trim() || "Aparelho sem nome",
      lastSeenText: formatInstant(device.lastSeenAt),
      registeredText: formatInstant(device.createdAt),
    }));
}

/**
 * How recent a login must be to revoke another device or end the other
 * sessions. The server decides (FRESH_SESSION_MAX_AGE_MILLISECONDS); this only
 * words the text, and a test keeps the two equal.
 */
export const RECENT_LOGIN_MINUTES = 15;

/** The confirmation says it in two parts: what is lost (ink) and when to use it. */
export const REVOKE_WARNING =
  "Ele perde o acesso e o que ainda não enviou (vendas, cadastros, movimentos) não será aceito. Não dá para desfazer.";
export const REVOKE_WARNING_NOTE =
  "Use para aparelho perdido ou roubado. Se ele estiver sem internet, só perde o acesso quando conectar.";
export const REVOKE_TITLE = "Revogar este aparelho?";

/** The way out for someone who lost the phone and the runtime does not know this browser's device yet. */
export const RECOGNIZING_TEXT =
  "Estamos reconhecendo este aparelho. Os botões liberam em instantes.";
/** The runtime is still getting ready, but took longer than RECOGNIZING_PATIENCE_MS. */
export const RECOGNIZING_SLOW_TEXT =
  "Não foi possível reconhecer este aparelho agora. Recarregue a página. Se continuar, tente de novo com uma internet melhor.";
/** The runtime is unavailable or absent: waiting will not help, and revoking needs it. */
export const RECOGNIZING_UNAVAILABLE_TEXT =
  "Este navegador não conseguiu preparar o acesso offline, e sem isso não dá para revogar por aqui. Recarregue a página. Se continuar, tente em outro celular ou computador em que o Polaris funcione.";
/** How long the screen waits for the runtime before it stops promising "em instantes". */
export const RECOGNIZING_PATIENCE_MS = 5000;

export type Recognition = "slow" | "unavailable" | "waiting";

/**
 * What the screen says while it still does not know which row is this browser.
 * No runtime (null) or an unavailable one will not get better by waiting; one
 * that is still preparing is "waiting", and "slow" once the patience ran out.
 */
export function recognitionState(
  slow: boolean,
  phase: RuntimeSnapshot["phase"] | null
): Recognition {
  if (phase === null || phase === "unavailable") {
    return "unavailable";
  }
  return slow ? "slow" : "waiting";
}

export const SESSION_GONE_LIST_TEXT = "Entre de novo para usar esta lista.";

export const END_OTHER_SESSIONS_LABEL = "Encerrar também as outras sessões";
export const END_OTHER_SESSIONS_HELP =
  "Sai da sua conta em todos os outros celulares e computadores, menos neste. Eles vão pedir para entrar de novo. Marque se acha que alguém entrou na sua conta.";
export const END_OTHER_SESSIONS_WARNING =
  "Quem estiver usando sua conta em outro aparelho será desconectado agora.";

export function confirmLabel(endOtherSessions: boolean): string {
  return endOtherSessions
    ? "Sim, revogar e encerrar as outras sessões"
    : "Sim, revogar este aparelho";
}

export const LOADING_TEXT = "Carregando seus aparelhos…";
export const EMPTY_TEXT =
  "Nenhum aparelho registrado nesta conta. Um aparelho aparece aqui depois que você abre o Polaris nele com internet.";
export const OFFLINE_TEXT =
  "Sem conexão. Para revogar um aparelho ou encerrar sessões, conecte-se à internet. Nada fica guardado para depois.";
const UNCERTAIN_TEXT =
  "Não conseguimos confirmar se o aparelho foi revogado. Olhe a lista abaixo: se ele ainda aparece, toque em Sim de novo. Repetir é seguro.";
export const REVOKING_LABEL = "Revogando…";

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** What a revocation did: one sentence per count that is not zero. */
export function revokedMessage(counts: {
  grants: number;
  sessions: number;
}): string {
  const parts = ["Aparelho revogado."];
  if (counts.grants > 0) {
    parts.push(
      `${plural(counts.grants, "permissão de uso offline cancelada", "permissões de uso offline canceladas")}.`
    );
  }
  if (counts.sessions > 0) {
    parts.push(
      `${plural(counts.sessions, "acesso encerrado", "acessos encerrados")}.`
    );
  }
  return parts.join(" ");
}

export const SESSION_ENDED_PANEL = {
  body: "O aparelho que você revogou usava a mesma sessão deste navegador, então ela foi encerrada. A revogação foi feita. Para continuar, entre de novo.",
  keptWork:
    "As operações que estavam guardadas neste aparelho continuam nele. Elas são enviadas quando você entrar de novo, com internet.",
  title: "Este navegador saiu da sua conta",
} as const;

/** Which way "Entrar de novo" goes: the session is still alive but old, or already gone. */
type SignInAgain = "session_gone" | "session_old";

export interface SignInAgainPanel {
  body: string;
  kind: SignInAgain;
  title: string;
}

export const SESSION_OLD_PANEL: SignInAgainPanel = {
  body: `Por segurança, para revogar outro aparelho ou encerrar as outras sessões, seu login precisa ter menos de ${RECENT_LOGIN_MINUTES} minutos. Nada foi revogado. Entre de novo e volte aqui para revogar, logo depois de entrar.`,
  kind: "session_old",
  title: "Entre de novo para continuar",
};

export const SESSION_GONE_PANEL: SignInAgainPanel = {
  body: "Sua sessão acabou. Nada foi alterado. Entre de novo para continuar.",
  kind: "session_gone",
  title: "Entre de novo para continuar",
};

/** The list could not be read because the session is gone: no action was taken, so nothing to say about "nada foi alterado". */
export const SESSION_GONE_LOAD_PANEL: SignInAgainPanel = {
  body: "Sua sessão acabou. Entre de novo para continuar.",
  kind: "session_gone",
  title: "Entre de novo para continuar",
};

export function devicesLoadError(error: unknown): string {
  return rpcErrorCode(error) === "UNAUTHORIZED"
    ? SESSION_GONE_LOAD_PANEL.body
    : "Não foi possível carregar os aparelhos. Verifique a conexão e tente de novo.";
}

/** The panel a refusal of the session asks for, if it is one; nothing else is. */
export function signInAgainPanel(error: unknown): SignInAgainPanel | null {
  if (rpcErrorCode(error) === "UNAUTHORIZED") {
    return SESSION_GONE_PANEL;
  }
  if (
    rpcErrorCode(error) === "FORBIDDEN" &&
    rpcErrorReason(error) === "fresh_session_required"
  ) {
    return SESSION_OLD_PANEL;
  }
  return null;
}

export type RevokeFailure =
  | { kind: "message"; text: string; uncertain: boolean }
  | { kind: "sign_in_again"; panel: SignInAgainPanel };

/**
 * What a failed revocation means for the screen. Only an answer from the server
 * (a 4xx) says nothing changed; a network failure or a 5xx may have taken effect,
 * so it never claims either (repeating is safe: the revocation is idempotent).
 */
export function revokeFailure(error: unknown): RevokeFailure {
  const panel = signInAgainPanel(error);
  if (panel) {
    return { kind: "sign_in_again", panel };
  }
  if (!isDefiniteRpcRejection(error)) {
    return { kind: "message", text: UNCERTAIN_TEXT, uncertain: true };
  }
  // a write like any other: with the acceptance pending the server refuses it, and the screen says why
  const unaccepted = legalAcceptanceMessage(error);
  if (unaccepted !== undefined) {
    return { kind: "message", text: unaccepted, uncertain: false };
  }
  return {
    kind: "message",
    text:
      rpcErrorCode(error) === "NOT_FOUND"
        ? "Este aparelho já não existe ou já foi revogado. Atualizamos a lista."
        : "Não foi possível revogar este aparelho. Nada foi alterado.",
    uncertain: false,
  };
}
