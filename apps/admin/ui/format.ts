/**
 * What the page says of each code the server returns, in Portuguese and without jargon ("loja", never
 * "organização"). A code the page does not know is shown as itself after "desconhecido", never as a known one:
 * a new billing state is not Free (AC-5).
 */

const DAY = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit",
  month: "2-digit",
  timeZone: "America/Sao_Paulo",
  year: "numeric",
});

/** A moment the server gave, as dd/mm/aaaa in Brasília; "—" when there is none or it is not a date. */
export function brasiliaDay(moment: string | null): string {
  if (moment === null) {
    return "—";
  }
  const date = new Date(moment);
  return Number.isNaN(date.getTime()) ? "—" : DAY.format(date);
}

const MOMENT = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
  minute: "2-digit",
  month: "2-digit",
  timeZone: "America/Sao_Paulo",
  year: "numeric",
});

/** A moment as dd/mm/aaaa HH:mm in Brasília (24 h; midnight is 00:00, never 24:00). */
export function brasiliaMoment(moment: Date): string {
  const parts = MOMENT.formatToParts(moment);
  const part = (type: string) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("day")}/${part("month")}/${part("year")} ${part("hour")}:${part("minute")}`;
}

const BILLING_STATES: Readonly<Record<string, string>> = {
  active: "Pro ativo",
  free: "Free",
  free_over_limit: "Free acima do limite",
  grace: "Pro em carência",
  trial_setup: "Free, com o teste do Pro em preparação",
  trialing: "Pro em teste",
};

/** The subscription's state; a store without a billing record is on Free (the server's own default). */
export function billingStateText(state: string | null): string {
  if (state === null) {
    return "Free (sem registro de cobrança)";
  }
  return BILLING_STATES[state] ?? `estado desconhecido: ${state}`;
}

const PLANS: Readonly<Record<string, string>> = { free: "Free", pro: "Pro" };

export function planText(plan: string): string {
  return PLANS[plan] ?? `plano desconhecido: ${plan}`;
}

const STORE_STATUSES: Readonly<Record<string, string>> = {
  active: "Ativa",
  closed: "Encerrada",
  suspended: "Suspensa",
};

export function storeStatusText(status: string): string {
  return STORE_STATUSES[status] ?? `situação desconhecida: ${status}`;
}

const CYCLES: Readonly<Record<number, string>> = {
  1: "Mensal",
  6: "Semestral",
  12: "Anual",
};

export function cycleText(months: number | null): string {
  if (months === null) {
    return "—";
  }
  return CYCLES[months] ?? `${months} meses`;
}

const PROVIDERS: Readonly<Record<string, string>> = {
  asaas: "Cartão (Asaas)",
  woovi: "Pix Automático (Woovi)",
};

export function paymentText(provider: string | null): string {
  if (provider === null) {
    return "—";
  }
  return PROVIDERS[provider] ?? `forma desconhecida: ${provider}`;
}

const REVOKED: Readonly<Record<string, string>> = {
  chargeback: "Pagamento contestado (chargeback)",
  refund: "Pagamento reembolsado",
  won: "Contestação ganha",
};

export function revokedText(reason: string | null): string {
  if (reason === null) {
    return "—";
  }
  return REVOKED[reason] ?? `motivo desconhecido: ${reason}`;
}

const QUOTAS: Readonly<Record<string, string>> = {
  "goals.active.max": "Metas ativas",
  "images.active.max": "Imagens",
  "images.per_product.max": "Imagens no produto com mais imagens",
  "variants.active.max": "Variantes ativas",
};

export function quotaText(key: string): string {
  return QUOTAS[key] ?? `cota desconhecida: ${key}`;
}

const QUOTA_STATUSES: Readonly<Record<string, string>> = {
  at_limit: "No limite",
  ok: "Dentro do limite",
  over: "Acima do limite",
};

export function quotaStatusText(status: string): string {
  return QUOTA_STATUSES[status] ?? `situação desconhecida: ${status}`;
}

const ENTITLEMENTS: Readonly<Record<string, string>> = {
  ...QUOTAS,
  "offline.write": "Venda offline",
  public_catalog: "Catálogo público",
};

export function entitlementText(key: string): string {
  return ENTITLEMENTS[key] ?? `direito desconhecido: ${key}`;
}

const ATTENTION: Readonly<Record<string, string>> = {
  billing_events_failed: "Há eventos de cobrança com falha.",
  billing_events_stuck: "Há eventos de cobrança parados há mais de 1 hora.",
  billing_state_unknown: "O estado da assinatura é desconhecido.",
  grant_ending_soon: "Uma concessão acaba nos próximos 7 dias.",
  organization_not_active: "A loja não está ativa.",
  over_free_limit: "A loja passou dos limites do Free.",
  sync_rejections: "Houve sincronizações recusadas nos últimos 7 dias.",
};

export function attentionText(code: string): string {
  return ATTENTION[code] ?? `Ponto de atenção desconhecido: ${code}`;
}

/** A grant's value: a number for a limit, yes or no for a flag. */
export function grantValueText(
  limitValue: number | null,
  flagValue: boolean | null
): string {
  if (limitValue !== null) {
    return String(limitValue);
  }
  if (flagValue === null) {
    return "—";
  }
  return flagValue ? "Ligado" : "Desligado";
}

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A calendar day the server wrote as `aaaa-mm-dd` (a week's start), as dd/mm/aaaa: a day, not a moment, so no zone. */
export function isoDayText(day: string): string {
  const match = ISO_DAY.exec(day);
  return match === null ? "—" : `${match[3]}/${match[2]}/${match[1]}`;
}

export function weekText(week: {
  inProgress: boolean;
  weekStart: string;
}): string {
  const start = `semana de ${isoDayText(week.weekStart)}`;
  return week.inProgress ? `${start} (em andamento)` : start;
}

const FUNNEL_REASONS: Readonly<Record<string, string>> = {
  activation_window_open: "não disponível (os 7 dias ainda correm)",
  suppressed: "não disponível (grupo pequeno)",
  week_not_closed: "não disponível (semana em andamento)",
};

/** Why the funnel has no number here, always with "não disponível": never a 0 nor an empty cell (AC-8). */
export function funnelReasonText(reason: string | null): string {
  if (reason === null) {
    return "não disponível";
  }
  return (
    FUNNEL_REASONS[reason] ?? `não disponível (motivo desconhecido: ${reason})`
  );
}

export function funnelCountText(cell: {
  reason: string | null;
  value: number | null;
}): string {
  return cell.value === null
    ? funnelReasonText(cell.reason)
    : String(cell.value);
}

const PERCENT = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 });

/** A share the server computed, as it sent it (one decimal, comma): the page does no arithmetic of its own. */
export function funnelPercentText(cell: {
  reason: string | null;
  value: number | null;
}): string {
  return cell.value === null
    ? funnelReasonText(cell.reason)
    : `${PERCENT.format(cell.value)}%`;
}

/** A count with its share next to it, as two facts of the server. */
export function funnelCountAndShare(
  count: { reason: string | null; value: number | null },
  share: { reason: string | null; value: number | null }
): string {
  return count.value === null
    ? funnelReasonText(count.reason)
    : `${count.value} (${funnelPercentText(share)})`;
}

const DECIMAL = /^(\d+)(?:\.(\d+))?$/;
const LEADING_ZEROS = /^0+(?=\d)/;
const THOUSANDS = /\B(?=(\d{3})+$)/g;

/**
 * An amount the server wrote as a decimal text (`49.9`, `1234.5000`), as R$ with a comma and a dot per thousand,
 * read as text: no float ever holds it and nothing is rounded; a digit past the cents that is not 0 stays shown
 * (docs/business-rules/money.md).
 */
export function moneyText(amount: string | null): string {
  if (amount === null) {
    return "—";
  }
  const match = DECIMAL.exec(amount);
  if (match === null) {
    return `valor desconhecido: ${amount}`;
  }
  const whole = (match[1] ?? "0").replace(LEADING_ZEROS, "");
  let cents = (match[2] ?? "").padEnd(2, "0");
  while (cents.length > 2 && cents.endsWith("0")) {
    cents = cents.slice(0, -1);
  }
  return `R$ ${whole.replace(THOUSANDS, ".")},${cents}`;
}

const METHODS: Readonly<Record<string, string>> = {
  card: "Cartão",
  pix_automatic: "Pix Automático",
};

export function methodText(method: string | null): string {
  if (method === null) {
    return "—";
  }
  return METHODS[method] ?? `forma desconhecida: ${method}`;
}

const CASE_KINDS: Readonly<Record<string, string>> = {
  privacy: "Privacidade",
  support: "Suporte",
};

export function caseKindText(kind: string): string {
  return CASE_KINDS[kind] ?? `tipo desconhecido: ${kind}`;
}

/** The wait the server gave, in whole minutes rounded up (a wait of 61 seconds is 2 minutes, never 1). */
export function minutesText(seconds: number): string {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return minutes === 1 ? "1 minuto" : `${minutes} minutos`;
}

/** A moment the server gave, as dd/mm/aaaa HH:mm in Brasília; "—" when there is none or it is not a date. */
export function brasiliaMomentText(moment: string | null): string {
  if (moment === null) {
    return "—";
  }
  const date = new Date(moment);
  return Number.isNaN(date.getTime()) ? "—" : brasiliaMoment(date);
}
