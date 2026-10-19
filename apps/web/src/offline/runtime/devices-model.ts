import type { DeviceReadModel } from "@polaris/contracts";
import { formatInstant } from "../../lib/format";
import { rpcErrorCode, rpcErrorReason } from "../../lib/rpc-error";

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

export const REVOKE_WARNING =
  "Revogar tira o acesso offline deste aparelho: ele deixa de enviar e o que estiver guardado nele (vendas, cadastros, movimentos) não será aceito pelo servidor. Use para um aparelho perdido ou roubado. Não dá para desfazer; o aparelho só volta registrando-se de novo.";

export function revokedMessage(grants: number): string {
  if (grants === 0) {
    return "Aparelho revogado.";
  }
  return `Aparelho revogado e ${grants} ${grants === 1 ? "autorização offline cancelada" : "autorizações offline canceladas"}.`;
}

export function devicesLoadError(error: unknown): string {
  const code = rpcErrorCode(error);
  if (code === "UNAUTHORIZED") {
    return "Sua sessão não está ativa. Entre novamente para ver os aparelhos.";
  }
  return "Não foi possível carregar os aparelhos. Verifique a conexão e tente de novo.";
}

export function revokeError(error: unknown): string {
  const code = rpcErrorCode(error);
  if (code === "NOT_FOUND") {
    return "Este aparelho já não existe ou já foi revogado. Atualizamos a lista.";
  }
  if (code === "UNAUTHORIZED") {
    return "Sua sessão não está ativa. Entre novamente para revogar.";
  }
  if (rpcErrorReason(error) === "fresh_session_required") {
    return "Para revogar outro aparelho, entre novamente: o login precisa ter sido feito há menos de 15 minutos. Nada foi revogado.";
  }
  return "Não foi possível confirmar a revogação agora. Atualize a lista e tente de novo: revogar um aparelho já revogado é seguro.";
}
