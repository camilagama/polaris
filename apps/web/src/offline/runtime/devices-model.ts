import type { DeviceReadModel } from "@polaris/contracts";
import { formatInstant } from "../../lib/format";
import {
  isDefiniteRpcRejection,
  rpcErrorCode,
  rpcErrorReason,
} from "../../lib/rpc-error";

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

export const REVOKE_WARNING =
  "Revogar tira o acesso offline deste aparelho: ele deixa de enviar e o que estiver guardado nele (vendas, cadastros, movimentos) não será aceito pelo servidor. Use para um aparelho perdido ou roubado. Não dá para desfazer; o aparelho só volta registrando-se de novo. Se ele estiver sem internet, só perde o acesso quando se conectar de novo.";

export const END_OTHER_SESSIONS_LABEL = "Encerrar também as outras sessões";
export const END_OTHER_SESSIONS_HELP =
  "Sai da sua conta em todos os outros celulares e computadores, menos neste. Eles vão pedir a senha de novo. Marque se acha que alguém entrou na sua conta.";
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
  "Não foi possível confirmar agora. Atualize a lista e tente de novo: repetir é seguro.";

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
      `${plural(counts.grants, "autorização offline cancelada", "autorizações offline canceladas")}.`
    );
  }
  if (counts.sessions > 0) {
    parts.push(
      `${plural(counts.sessions, "sessão encerrada", "sessões encerradas")}.`
    );
  }
  return parts.join(" ");
}

export const SESSION_ENDED_PANEL = {
  body: "O aparelho que você revogou usava a mesma sessão deste navegador, então ela foi encerrada. A revogação foi feita. Para continuar, entre de novo.",
  keptWork: "O que estava guardado aqui para enviar continua guardado.",
  title: "Este navegador também saiu da sua conta",
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
  return {
    kind: "message",
    text:
      rpcErrorCode(error) === "NOT_FOUND"
        ? "Este aparelho já não existe ou já foi revogado. Atualizamos a lista."
        : "Não foi possível revogar este aparelho. Nada foi alterado.",
    uncertain: false,
  };
}
