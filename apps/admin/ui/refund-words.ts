import type { ProviderCommandResult } from "./types";

export type SettledResult = Exclude<
  ProviderCommandResult,
  | "amount_changed"
  | "amount_mismatch"
  | "command_in_progress"
  | "provider_unavailable"
>;

/**
 * The words of the billing area of a support case (ADR 0105), apart from the screen. The
 * effect lines are the design's and the server's: they say what the command does, never a code, a provider reference
 * or a status.
 */

/** An amount as `money.md` writes it, above zero, with the two decimal places: the server refuses any other. */
export const AMOUNT_PATTERN = /^(?:0|[1-9]\d{0,8})\.\d{2}$/;

export const FIRST_CHARGE_AMOUNT_LABEL =
  "Valor da primeira cobrança deste vínculo";
export const CURRENT_CHARGE_AMOUNT_LABEL = "Valor da cobrança em vigor";
export const CURRENT_CHARGE_NOT_RECORDED = "Não registrado";
export const AUDIT_TEXT = "Esta consulta fica registrada na auditoria.";
export const SEPARATE_ACTIONS =
  "Cancelar a renovação e reembolsar são ações separadas, cada uma com a sua confirmação.";
export const PIX_OUTSIDE = "Reembolso de Pix é feito fora do Polaris.";
export const PROVIDER_NOT_HERE =
  "O provedor desta loja não reembolsa por esta tela.";
export const REFUND_NEEDS_OTHER_PERMISSION =
  "Reembolsar exige outra permissão.";
export const RENEWAL_ALREADY_CANCELLED = "A renovação já está cancelada.";
export const NO_RENEWAL = "Não há renovação para cancelar.";
export const NO_CHARGE = "Nenhuma cobrança a reembolsar.";
/** A paid store whose charge in force has no amount recorded: the only case the provider's panel is still the way. */
export const NO_CURRENT_AMOUNT =
  "O valor da cobrança em vigor não está registrado. Por enquanto, o reembolso é feito pelo painel do provedor.";
/** The refund button is gone after the server refused for a divergence, until the page is loaded again. */
export const REFUND_HELD =
  "Reembolso suspenso nesta página: o valor registrado não confere com o do provedor. Recarregue a página depois da correção.";
export const NOTHING_TO_DO = "Nada a fazer aqui na cobrança desta loja.";
export const REFUND_LIMIT =
  "O limite é de até 3 reembolsos por hora, por operador.";

export const CANCEL_TITLE = "Revise antes de cancelar a renovação";
export const REFUND_TITLE = "Revise antes de reembolsar";
export const CANCEL_BUTTON = "Cancelar a renovação";
export const CANCEL_CONFIRM = "Confirmar o cancelamento da renovação";
export const RETRY_BUTTON = "Tentar de novo (mesmo pedido)";
export const REREAD_BUTTON = "Reler a cobrança";

const PERIOD_END = "o fim do período já pago";
const PERIOD_END_BARE = "fim do período já pago";

export function cancelEffectText(accessUntil: string | null): string {
  return `A renovação será cancelada no provedor. O acesso já pago continua até ${accessUntil ?? PERIOD_END}. O cliente não é avisado por esta tela.`;
}

export function cancelUndoText(resubscribeFrom: string | null): string {
  return `Não. O dono da loja pode assinar de novo pelo app a partir ${resubscribeFrom === null ? `do ${PERIOD_END_BARE}` : `de ${resubscribeFrom}`}, quando o período pago termina.`;
}

export const CANCEL_AUDIT =
  "O pedido e o resultado ficam na auditoria com o seu e-mail e o atendimento. O motivo fica no registro de cobrança.";

export function refundEffectText(amount: string): string {
  return `O pedido de reembolso de ${amount} vai ao provedor, pelo mesmo meio de pagamento. Se a renovação ainda estiver viva, ela é cancelada antes. Quando o provedor confirmar o estorno, o acesso Pro da loja acaba na hora, sem carência. O fato do reembolso chega depois, pelo provedor ou pela reconciliação, e aparece no registro da loja. O cliente não é avisado por esta tela.`;
}

export const REFUND_UNDO =
  "Não: isso não poderá ser desfeito. O valor volta ao cliente e a renovação é cancelada. Quando o provedor confirmar o estorno, o Pro acaba na hora e o dono pode assinar de novo; até essa confirmação, uma nova assinatura espera.";

export const REFUND_AUDIT =
  "O pedido e o resultado ficam na auditoria com o seu e-mail, o atendimento e o valor. O motivo fica no registro de cobrança.";

export const REASON_HINT = "Obrigatório. Fica no registro de cobrança.";

export function environmentLine(
  environment: "production" | "staging" | "unknown"
): string {
  if (environment === "production") {
    return "PRODUÇÃO: dinheiro real";
  }
  return environment === "staging"
    ? "STAGING: conta de teste do provedor, sem dinheiro real"
    : "não informado";
}

export const UNKNOWN_OUTCOME =
  "Não sabemos se o provedor fez. Nada foi feito duas vezes por repetir: tente de novo com o mesmo pedido.";
export const RENEWAL_LABEL = "Renovação (pelo registro da loja)";
export const MAYBE_SENT_HINT =
  "Se o pedido chegou, repetir usa o mesmo pedido e não cobra nem estorna de novo. Para um pedido novo, volte e abra a confirmação de novo.";
export const NOT_RECORDED_SUFFIX =
  "O registro do resultado na auditoria não foi confirmado; o pedido ficou registrado.";
export const UNKNOWN_HINT =
  "A auditoria guardou o pedido sem resultado. Repetir usa o mesmo pedido e não cobra nem estorna de novo. Para um pedido novo, volte e abra a confirmação de novo.";
export const WRITE_MAY_HAVE_HAPPENED =
  "Não deu para confirmar se a ação foi feita. Releia a cobrança antes de tentar de novo.";
export const IN_PROGRESS =
  "Outra ação de cobrança desta loja está em andamento (do dono ou de outro comando). Nada foi feito agora. Tente de novo em alguns instantes.";
export const OUTCOME_NOT_RECORDED =
  "A ação foi feita, mas o registro do resultado na auditoria não foi confirmado. O pedido ficou registrado. Não repita a ação; avise a engenharia.";
export const CASE_GONE =
  "O atendimento não está aberto ou não é desta loja. Nada foi feito. Recarregue a página.";
export const NOT_ACCEPTED =
  "O pedido não foi aceito. Nada foi feito. Releia a cobrança e confira o motivo.";

export function limitReachedText(wait: string | null): string {
  return `Limite de 3 reembolsos por hora atingido. Nada foi feito. ${wait === null ? "Tente mais tarde." : `Tente de novo em ${wait}.`}`;
}

export const AMOUNT_CHANGED_AWAY =
  "O valor da cobrança em vigor mudou desde a leitura. Nada foi feito.";

export function amountChangedText(now: string | null, same: boolean): string {
  if (now === null) {
    return "O valor da cobrança em vigor mudou desde a leitura e não está mais registrado. Nada foi feito.";
  }
  return same
    ? `O valor da cobrança em vigor mudou desde a leitura, mas a nova leitura trouxe o mesmo valor (${now}). Nada foi feito. Recarregue a página antes de tentar de novo.`
    : `O valor da cobrança em vigor mudou desde a leitura: agora é ${now}. Nada foi feito. Revise de novo antes de reembolsar.`;
}

/**
 * The server refused because the amount it records for the charge in force is not the provider's, and recorded an
 * incident (`amount_mismatch`): the operator is told not to repeat, and how to try again after the fix.
 */
export function amountMismatchText(recorded: string | null): string {
  const amount = recorded === null ? "" : ` (${recorded})`;
  return `O valor registrado da cobrança em vigor${amount} não é o que o provedor tem. Nada foi feito. A engenharia recebe um incidente; não repita a ação. Para tentar de novo depois da correção, recarregue a página.`;
}

export const RESULT_TEXT: Readonly<
  Record<
    SettledResult,
    (context: { accessUntil: string | null; amount: string }) => string
  >
> = {
  already_cancelled: () => "A renovação já estava cancelada. Nada foi mudado.",
  cancelled: ({ accessUntil }) =>
    `Renovação cancelada no provedor. O acesso já pago continua até ${accessUntil ?? PERIOD_END}.`,
  not_linked: () => "Esta loja não está ligada ao provedor. Nada foi feito.",
  nothing_to_cancel: () =>
    "Esta loja não tem renovação para cancelar. Nada foi mudado.",
  nothing_to_refund: () =>
    "Não há cobrança a reembolsar: ela já foi reembolsada ou está em reembolso. Nada foi feito.",
  refund_not_supported: () => `${PIX_OUTSIDE} Nada foi feito.`,
  refund_requested: ({ amount }) =>
    `Reembolso de ${amount} pedido ao provedor. O dinheiro volta pelo provedor; o fato chega depois e aparece no registro da loja.`,
};
