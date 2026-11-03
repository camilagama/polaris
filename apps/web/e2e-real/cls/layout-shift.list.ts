/**
 * The screens and states the layout shift check measures (`layout-shift.e2e.ts`), the limit, and the exact list of the
 * ones still known to be over it. A scenario is `<address> <store> <how it was reached>`: `frio` is a load of the page
 * in a new context, `quente` a step inside the app from the Início (the way the menu goes, `navigateInApp`), and
 * `sem-conexao`/`volta-a-conexao` the Início when the device loses and gets back the network.
 *
 * The list works like `scripts/verify-no-blind-waits.list.mjs`: a scenario over the limit that is not in the list
 * fails, and a scenario in the list that is now under the limit fails too, so the change that fixes a screen takes its
 * line out in the same pull request and the list only goes down.
 */

/** Cumulative Layout Shift of the "good" band is 0.1; the screens of the app aim at half of it. */
export const CLS_LIMIT = 0.05;

export const CLS_SCENARIOS = [
  "/ vazia frio",
  "/ com-vendas frio",
  "/ com-vendas quente",
  "/ com-vendas sem-conexao",
  "/ com-vendas volta-a-conexao",
  "/sales com-vendas frio",
  "/sales com-vendas quente",
  "/sales/history com-vendas frio",
  "/sales/history com-vendas quente",
  "/inventory com-vendas frio",
  "/inventory com-vendas quente",
  "/dashboard com-vendas frio",
  "/dashboard com-vendas quente",
  "/entrar sem-sessao frio",
] as const;

export type ClsScenario = (typeof CLS_SCENARIOS)[number];

export interface ClsException {
  /** What still moves and which correction takes it out. */
  reason: string;
}

const HOME_SKELETONS =
  'o esqueleto da Meta, do Gráfico e do Ritmo tem outra altura que o "Primeiros passos" e o "Definir meta" da loja nova; sai com os esqueletos na forma final (correção F2 do desenho de layout shift)';
const SALE_SUGGESTIONS =
  "a lista de variantes encontradas entra no fluxo e empurra Quantidade, Adicionar item e Pagamento 168 px; sai com a lista em popup ancorado à busca (correção F4, Vender enxuta)";
const HOME_OFFLINE =
  "sem conexão e sem cópia guardada, os quatro cartões viram dois blocos curtos e a Meta outro texto, e voltam com a rede; sai com os cartões no lugar e na altura de sempre (correção F3)";

export const CLS_EXCEPTIONS: Partial<Record<ClsScenario, ClsException>> = {
  "/ com-vendas sem-conexao": { reason: HOME_OFFLINE },
  "/ com-vendas volta-a-conexao": { reason: HOME_OFFLINE },
  "/ vazia frio": { reason: HOME_SKELETONS },
  "/entrar sem-sessao frio": {
    reason:
      'o cartão centrado na vertical cresce para os dois lados quando "Verificando se você já entrou…" dá lugar ao formulário; sai com a entrada alinhada ao topo (correção F7)',
  },
  "/sales com-vendas frio": { reason: SALE_SUGGESTIONS },
  "/sales com-vendas quente": { reason: SALE_SUGGESTIONS },
};

/**
 * What is wrong with one measurement, as a sentence that says what to do, or null. `exceptions` and `limit` are
 * parameters so the control cases can plant a list.
 */
export function clsProblem(
  scenario: string,
  cls: number,
  exceptions: Partial<Record<string, ClsException>> = CLS_EXCEPTIONS,
  limit: number = CLS_LIMIT
): string | null {
  const listed = exceptions[scenario];
  const value = cls.toFixed(4);
  if (cls > limit && !listed) {
    return `${scenario}: CLS ${value}, acima do limite de ${limit}. Reserve o espaço do que chega depois (min-height do estado final, esqueleto com a mesma altura, visibility em vez de montar e desmontar, overlay em vez de empurrar); os deslocamentos estão abaixo.`;
  }
  if (cls <= limit && listed) {
    return `${scenario}: CLS ${value}, dentro do limite de ${limit}, e a tela está na lista de exceções de e2e-real/cls/layout-shift.list.ts. Tire a entrada no mesmo PR.`;
  }
  return null;
}

/** Entries of the list that name no measured scenario, or have no reason. */
export function exceptionListProblems(
  exceptions: Partial<Record<string, ClsException>> = CLS_EXCEPTIONS,
  scenarios: readonly string[] = CLS_SCENARIOS
): string[] {
  return Object.entries(exceptions).flatMap(([scenario, entry]) => {
    const problems: string[] = [];
    if (!scenarios.includes(scenario)) {
      problems.push(
        `${scenario}: na lista de exceções e não é um cenário medido. Tire a entrada ou corrija o nome.`
      );
    }
    if (typeof entry?.reason !== "string" || entry.reason.trim() === "") {
      problems.push(`${scenario}: a entrada da lista precisa de um motivo.`);
    }
    return problems;
  });
}

/** Web Vitals CLS: the largest session window (gap under 1 s, length up to 5 s). */
export function sessionWindowCls(
  entries: readonly { t: number; value: number }[]
): number {
  let best = 0;
  let current = 0;
  let first = -1;
  let last = -1;
  for (const entry of entries) {
    if (first >= 0 && entry.t - last < 1000 && entry.t - first < 5000) {
      current += entry.value;
    } else {
      current = entry.value;
      first = entry.t;
    }
    last = entry.t;
    best = Math.max(best, current);
  }
  return best;
}
