import type { Api } from "../api";
import { PROBLEM_TEXT } from "../api";
import { facts, table } from "../blocks";
import { type Dom, storeName } from "../dom";
import {
  attentionText,
  billingStateText,
  brasiliaDay,
  cycleText,
  entitlementText,
  grantValueText,
  paymentText,
  planText,
  quotaStatusText,
  quotaText,
  revokedText,
  storeStatusText,
} from "../format";
import { createNotice } from "../notice";
import type { OrganizationDiagnostics } from "../types";

export interface DiagnosticsView {
  element: HTMLElement;
  /** Reads one store's diagnostics and shows them; a later choice wins over an answer still on its way. */
  show: (organization: { id: string; name: string }) => Promise<void>;
}

function storeFacts(dom: Dom, report: OrganizationDiagnostics) {
  return facts(dom, [
    ["Situação", storeStatusText(report.organization.status)],
    ["Criada em", brasiliaDay(report.organization.createdAt)],
    ["Pessoas com acesso", String(report.organization.members)],
    ["Aparelhos com venda offline", String(report.offline.devices)],
    ["Última sincronização", brasiliaDay(report.sync.lastReceivedAt)],
  ]);
}

function renewalText(billing: OrganizationDiagnostics["billing"]): string {
  if (billing === null) {
    return "—";
  }
  return billing.cancelAtPeriodEnd
    ? "Cancelamento pedido: acaba no fim do período"
    : "Sem cancelamento pedido";
}

function planFacts(dom: Dom, report: OrganizationDiagnostics) {
  const { billing, entitlements } = report;
  return facts(dom, [
    ["Plano em vigor", planText(entitlements.plan)],
    ["Assinatura", billingStateText(billing?.state ?? null)],
    ["Fim do acesso", brasiliaDay(entitlements.accessEndsAt)],
    ["Ciclo", cycleText(billing?.cycleMonths ?? null)],
    ["Forma de pagamento", paymentText(billing?.provider ?? null)],
    ["Renovação", renewalText(billing)],
    ["Teste do Pro começou em", brasiliaDay(billing?.trialStartedAt ?? null)],
    ["Último fato de cobrança", brasiliaDay(billing?.lastFactAt ?? null)],
    ["Pagamento revogado", revokedText(billing?.revokedReason ?? null)],
  ]);
}

function quotaTable(dom: Dom, report: OrganizationDiagnostics) {
  return table(
    dom,
    "Uso contra o limite do plano",
    ["Cota", "Uso", "Limite", "Situação"],
    report.quotas.map((quota) => [
      quotaText(quota.key),
      String(quota.used),
      String(quota.limit),
      quotaStatusText(quota.status),
    ])
  );
}

function grantsBlock(dom: Dom, report: OrganizationDiagnostics) {
  if (report.grants.length === 0) {
    return dom.el("p", {}, "Nenhuma concessão.");
  }
  const raised = report.entitlements.raisedByGrant;
  return dom.el(
    "div",
    {},
    table(
      dom,
      "Concessões",
      ["Direito", "Valor", "Começa", "Acaba", "Revogada em"],
      report.grants.map((grant) => [
        entitlementText(grant.key),
        grantValueText(grant.limitValue, grant.flagValue),
        brasiliaDay(grant.startsAt),
        brasiliaDay(grant.expiresAt),
        brasiliaDay(grant.revokedAt),
      ])
    ),
    dom.el(
      "p",
      {},
      raised.length === 0
        ? "Nenhum direito está acima do plano por concessão agora."
        : `Acima do plano por concessão agora: ${raised.map(entitlementText).join(", ")}.`
    )
  );
}

function attentionBlock(dom: Dom, report: OrganizationDiagnostics) {
  if (report.attention.length === 0) {
    return dom.el("p", {}, "Nenhum ponto de atenção.");
  }
  return dom.el(
    "ul",
    { class: "attention" },
    ...report.attention.map((item) =>
      dom.el("li", {}, attentionText(item.code))
    )
  );
}

function subheading(dom: Dom, text: string) {
  return dom.el("h3", {}, text);
}

/**
 * Loja (AC-5): the diagnostics as the server reports them, field by field. The page computes nothing of its own:
 * no state from a date, no plan from a state, no total; a code it does not know is said to be unknown.
 */
export function diagnosticsView(dom: Dom, api: Api): DiagnosticsView {
  const notice = createNotice(dom);
  const title = dom.el("h2", { id: "loja-titulo", tabindex: "-1" }, "Loja");
  const body = dom.el("div", { class: "report" });
  const element = dom.el(
    "section",
    { "aria-labelledby": "loja-titulo", class: "area", hidden: "" },
    title,
    notice.element,
    body
  );
  let turn = 0;

  const render = (report: OrganizationDiagnostics) => {
    dom.fill(
      title,
      "Loja: ",
      storeName(dom, report.organization.name, report.organization.id)
    );
    dom.fill(
      body,
      storeFacts(dom, report),
      subheading(dom, "Plano e assinatura"),
      planFacts(dom, report),
      subheading(dom, "Uso e limites"),
      quotaTable(dom, report),
      subheading(dom, "Concessões"),
      grantsBlock(dom, report),
      subheading(dom, "Pontos de atenção"),
      attentionBlock(dom, report)
    );
  };

  return {
    element,
    show: async (organization) => {
      turn += 1;
      const mine = turn;
      element.removeAttribute("hidden");
      dom.fill(
        title,
        "Loja: ",
        storeName(dom, organization.name, organization.id)
      );
      body.replaceChildren();
      title.focus();
      notice.status("Carregando a loja…");
      const answer = await api.get<OrganizationDiagnostics>(
        `/api/organizations/${encodeURIComponent(organization.id)}/diagnostics`
      );
      if (mine !== turn) {
        return;
      }
      if (!answer.ok) {
        notice.alert(PROBLEM_TEXT[answer.problem]);
        return;
      }
      notice.status("Loja carregada.");
      render(answer.data);
    },
  };
}
