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
