import { MediaUploadHttpError } from "../lib/media-upload";
import { SESSION_ENDED_MESSAGE } from "../lib/session-ended-text";

/** Where a media failure happened; the same server code reads differently in each. */
export type MediaFailureContext =
  | "list"
  | "prepare"
  | "remove"
  | "reorder"
  | "upload";

export type MoveDirection = "earlier" | "later";

/**
 * The whole new order after moving the image at `index` one place, or null
 * when it is already at that end (or the index is not in the list).
 */
export function movedAssetOrder(
  assetIds: readonly string[],
  index: number,
  direction: MoveDirection
): string[] | null {
  const target = direction === "earlier" ? index - 1 : index + 1;
  if (
    !Number.isInteger(index) ||
    index < 0 ||
    index >= assetIds.length ||
    target < 0 ||
    target >= assetIds.length
  ) {
    return null;
  }
  const next = [...assetIds];
  const [moved] = next.splice(index, 1);
  if (moved === undefined) {
    return null;
  }
  next.splice(target, 0, moved);
  return next;
}

export interface ImageActionAvailability {
  moveEarlier: boolean;
  moveLater: boolean;
  remove: boolean;
  replace: boolean;
}

/**
 * Which actions of the image at `index` can be used. While any command runs
 * (`busy`), none can: commands never overlap. The ends of the list cannot move
 * further out.
 */
export function imageActionAvailability(input: {
  busy: boolean;
  count: number;
  index: number;
}): ImageActionAvailability {
  const { busy, count, index } = input;
  return {
    moveEarlier: !busy && index > 0,
    moveLater: !busy && index < count - 1,
    remove: !busy,
    replace: !busy,
  };
}

/** Accessible name of an action on the image at the 0-based `index`. */
export function imageActionLabel(
  action: "moveEarlier" | "moveLater" | "remove" | "replace",
  index: number
): string {
  const position = index + 1;
  switch (action) {
    case "moveEarlier":
      return `Mover imagem ${position} para antes`;
    case "moveLater":
      return `Mover imagem ${position} para depois`;
    case "remove":
      return `Remover imagem ${position}`;
    default:
      return `Substituir imagem ${position}`;
  }
}

export function removeConfirmationText(input: {
  position: number;
  variantCount: number;
}): string {
  const variants =
    input.variantCount > 0
      ? " As variantes que a usam deixam de mostrá-la."
      : "";
  return `Remover a imagem ${input.position}? Ela sai do produto e isso libera um lugar para imagens no plano.${variants} Para voltar a usá-la, será preciso enviar o arquivo de novo.`;
}

export function replaceConfirmationText(input: {
  position: number;
  variantCount: number;
}): string {
  const variants =
    input.variantCount > 0
      ? " As variantes que a usam deixam de mostrá-la."
      : "";
  return `Substituir a imagem ${input.position}? Ela é removida do produto agora, para abrir lugar à nova, e você escolhe o arquivo em seguida.${variants} Se você desistir ou o envio falhar, o produto fica com uma imagem a menos.`;
}

export function movedNotice(input: { from: number; to: number }): string {
  return `Imagem ${input.from} movida para a posição ${input.to}.`;
}

export function removedNotice(removed: boolean, position: number): string {
  return removed
    ? `Imagem ${position} removida do produto. Um lugar foi liberado no plano.`
    : "Esta imagem já tinha sido removida. A lista foi atualizada.";
}

export const replacementPendingText =
  "A imagem anterior foi removida. Escolha o novo arquivo e envie; enquanto isso, o produto tem uma imagem a menos. A nova imagem entra no fim da lista e pode ser movida depois.";

export const replacementAbandonedText =
  "Substituição cancelada. A imagem anterior já foi removida, então o produto ficou com uma imagem a menos.";

export const replacementDoneText =
  "Imagem substituída. A nova imagem entrou no fim da lista; use Mover para ajustar a posição.";

const networkMessage =
  "Sem conexão com o servidor. Verifique a internet e tente novamente.";

export interface MediaFailure {
  message: string;
  /** The list on screen may be out of date: fetch it again. */
  reloadList: boolean;
}

function isNetworkFailure(error: unknown): boolean {
  return error instanceof TypeError;
}

function defaultMessage(context: MediaFailureContext): string {
  switch (context) {
    case "list":
      return "Não foi possível carregar as imagens. Tente novamente.";
    case "remove":
      return "Não foi possível remover a imagem. Tente novamente.";
    case "reorder":
      return "Não foi possível mudar a ordem das imagens. Tente novamente.";
    case "upload":
      return "Não foi possível carregar a imagem. Tente novamente.";
    default:
      return "Não foi possível preparar a imagem. Escolha outro arquivo e tente novamente.";
  }
}

function codeMessage(code: string): MediaFailure | null {
  switch (code) {
    case "forbidden":
    case "tenant_access_denied":
      return {
        message: "Sua conta não tem permissão para alterar este produto.",
        reloadList: false,
      };
    case "session_required":
      return {
        message: SESSION_ENDED_MESSAGE,
        reloadList: false,
      };
    case "invalid_media_order":
      return {
        message:
          "A lista de imagens mudou em outro lugar. Recarregamos a lista; confira a ordem e tente novamente.",
        reloadList: true,
      };
    case "not_found":
      return {
        message:
          "Este produto ou esta imagem não foi encontrado. Recarregamos a lista.",
        reloadList: true,
      };
    case "entitlement_limit_reached":
      return {
        message:
          "O plano atingiu o limite de imagens. Remova uma imagem para liberar um lugar e envie de novo.",
        reloadList: true,
      };
    case "product_media_limit":
      return {
        message:
          "Este produto já tem o máximo de imagens. Remova uma imagem para liberar um lugar e envie de novo.",
        reloadList: true,
      };
    case "media_transform_quota_exceeded":
      return {
        message:
          "O envio de imagens está pausado: o limite mensal de processamento de imagens foi atingido. Nada foi perdido; tente de novo no próximo ciclo (início do mês).",
        reloadList: false,
      };
    case "media_image_too_large":
      return {
        message:
          "A imagem original ultrapassa 20 MB. Escolha um arquivo menor.",
        reloadList: false,
      };
    case "unsupported_media_image":
      return {
        message: "O arquivo não é uma imagem JPEG, PNG ou WebP válida.",
        reloadList: false,
      };
    case "invalid_media_crop":
      return {
        message:
          "A área de recorte não é válida. Ajuste a seleção e tente novamente.",
        reloadList: false,
      };
    case "media_upload_command_conflict":
      return {
        message:
          "A tentativa de envio mudou. Selecione a imagem novamente para tentar de novo.",
        reloadList: false,
      };
    case "media_processing_unavailable":
      return {
        message:
          "O processamento de imagens está indisponível. Tente novamente.",
        reloadList: false,
      };
    default:
      return null;
  }
}

/**
 * Turns a failed media request into text for the person, never a raw code.
 * Errors that are not HTTP failures from the media client (domain checks on the
 * file) are the caller's to describe; here they fall to the context default.
 */
export function describeMediaFailure(
  context: MediaFailureContext,
  error: unknown
): MediaFailure {
  if (error instanceof MediaUploadHttpError) {
    return (
      codeMessage(error.code) ?? {
        message: defaultMessage(context),
        reloadList: false,
      }
    );
  }
  if (context !== "prepare" && isNetworkFailure(error)) {
    return { message: networkMessage, reloadList: false };
  }
  return { message: defaultMessage(context), reloadList: false };
}
