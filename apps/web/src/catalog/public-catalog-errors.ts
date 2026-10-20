import { rpcErrorCode, rpcErrorReason } from "../lib/rpc-error";

export type PublicCatalogAction = "load" | "products" | "profile" | "switch";

const REFUSALS: Readonly<Record<string, string>> = {
  invalid_description:
    "A descrição pode ter no máximo 280 caracteres e não aceita caracteres ocultos.",
  invalid_instagram:
    "Use só o nome do Instagram (letras minúsculas, números, ponto e sublinhado, até 30 caracteres), sem o @.",
  invalid_name:
    "Informe o nome público (até 80 caracteres, sem caracteres ocultos).",
  invalid_slug:
    "O endereço precisa ter de 3 a 40 caracteres: letras minúsculas, números e hífens, sem hífen no começo nem no fim.",
  invalid_whatsapp:
    "Informe o WhatsApp com DDD (e o código do país, se quiser): de 10 a 15 números.",
  reserved_slug: "Este endereço é reservado. Escolha outro.",
};

function fallback(action: PublicCatalogAction): string {
  if (action === "load") {
    return "Não foi possível carregar o catálogo público. Tente novamente.";
  }
  return "Não foi possível concluir a operação. Tente novamente.";
}

/** Portuguese text for a failed public catalog request. */
export function publicCatalogErrorMessage(
  error: unknown,
  action: PublicCatalogAction
): string {
  const code = rpcErrorCode(error);
  const reason = rpcErrorReason(error);
  if (code === "UNAUTHORIZED") {
    return action === "load"
      ? "Não foi possível carregar o catálogo público."
      : "A alteração do catálogo público não foi salva.";
  }
  if (code === "FORBIDDEN") {
    return "Sua conta não pode gerir o catálogo público desta organização.";
  }
  if (code === "BAD_REQUEST") {
    return (reason && REFUSALS[reason]) ?? "Confira os dados informados.";
  }
  if (code === "CONFLICT") {
    if (reason === "entitlement_denied") {
      return "O catálogo público não está incluído no plano atual. Seus dados ficam guardados e voltam a valer quando o plano incluir.";
    }
    if (reason === "public_catalog_slug_taken") {
      return "Este endereço já está em uso por outra loja. Escolha outro.";
    }
    if (reason === "public_catalog_version_conflict") {
      return "O perfil mudou em outra solicitação. A tela foi atualizada; confira e salve de novo.";
    }
    if (reason === "public_catalog_profile_missing") {
      return "Salve o perfil público antes de ligar o catálogo.";
    }
    if (reason === "public_catalog_product_unavailable") {
      return "Algum produto já não está disponível (arquivado ou removido). A lista foi atualizada.";
    }
  }
  if (code === "SERVICE_UNAVAILABLE") {
    return "O catálogo público está temporariamente indisponível. Tente novamente.";
  }
  return fallback(action);
}
