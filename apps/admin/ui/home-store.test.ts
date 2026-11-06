import { describe, expect, it } from "vitest";
import { PROBLEM_TEXT } from "./api";
import { allElements, buttons, byId, byTag, visibleText } from "./test-dom";
import {
  type Answer,
  alertOf,
  type Call,
  diagnostics,
  flush,
  json,
  mount,
  OWNER,
  screenContext,
  summary,
} from "./test-page";
import type {
  PrivacyCasePage,
  PrivacyCaseSummary,
  SupportCasePage,
  SupportCaseSummary,
} from "./types";

/**
 * Início and Loja in a small DOM, against a simulated API (corte admin-v2, Parte 1): what waits for the operator
 * (AC-P1.2b), the store's own screen, hostile text (AC-C7) and what opening a screen asks (AC-C5). Nothing sets a
 * clock: the page has no timer outside the reveal's and `mount` gives it a fixed one.
 */

const CASE = "0199a0a0-0000-7000-8000-00000000c0de";
const OTHER_CASE = "0199a0a0-0000-7000-8000-00000000c0df";
const STORE = "0199a0a0-0000-7000-8000-0000000000a1";
const ANOTHER_STORE = "0199a0a0-0000-7000-8000-0000000000a2";
const OPENED_AT = "2026-10-28T13:05:00.000Z";
const OPENED_TEXT = "28/10/2026 10:05";
const HOSTILE = [
  "<img src=x onerror=alert(1)>",
  "<script>alert(1)</script>",
  "javascript:alert(1)",
  "‮abc",
  '"><svg onload=1>',
];
const ACTION_IN_ATENDIMENTO = /(ação|ações) do atendimento aberto desta loja/;
const NEVER_CREATED = ["script", "img", "svg", "iframe"];
const MANAGE_ONLY = {
  ...OWNER,
  capabilities: ["support_case:manage"],
};
const DIAGNOSE_ONLY = {
  ...OWNER,
  capabilities: ["organization:diagnose"],
};

function summaryOf(
  overrides: Partial<SupportCaseSummary> = {}
): SupportCaseSummary {
  return {
    closedAt: null,
    id: CASE,
    kind: "support",
    openedAt: OPENED_AT,
    organizationId: STORE,
    organizationName: "Loja da Ana",
    reason: "Dono pediu ajuda com o estoque",
    status: "open",
    ...overrides,
  };
}

const page = (
  cases: SupportCaseSummary[],
  next: string | null = null
): SupportCasePage => ({ cases, next });

const search = (call: Call | undefined) =>
  new URL(call?.path ?? "", "http://admin.test").searchParams;

const hrefs = (root: Parameters<typeof byTag>[0]) =>
  byTag(root, "a").map((link) => link.getAttribute("href"));

const home = (answers: Answer[], who?: Answer) =>
  mount(answers, who, undefined, screenContext({ screen: "inicio" }));

const storeScreen = (answers: Answer[], who?: Answer) =>
  mount(answers, who, undefined, screenContext({ id: STORE, screen: "loja" }));

const PRIVACY_CASE = "0199a0a0-0000-7000-8000-00000000d0de";
const WITH_PRIVACY = {
  ...OWNER,
  capabilities: [...OWNER.capabilities, "privacy_case:manage"],
};

function privacyOf(
  overrides: Partial<PrivacyCaseSummary> = {}
): PrivacyCaseSummary {
  return {
    dueAt: "2026-11-10T15:00:00.000Z",
    dueInDays: 13,
    id: PRIVACY_CASE,
    openedAt: OPENED_AT,
    organizationId: STORE,
    organizationName: "Loja da Ana",
    overdue: false,
    requesterKind: "data_subject",
    requestType: "deletion",
    stage: "opened",
    status: "open",
    ...overrides,
  };
}

const privacyPage = (
  cases: PrivacyCaseSummary[],
  next: string | null = null
): PrivacyCasePage => ({ cases, next });

const waitingItems = (root: Parameters<typeof byTag>[0]) =>
  byTag(root, "a").filter(
    (item) => item.getAttribute("class") === "waiting-item"
  );

describe("Início: o que pede atenção, antes da busca (AC-CL5, AC-CP2, AC-CL7)", () => {
  const privacyHome = (answers: Answer[]) => home(answers, json(WITH_PRIVACY));

  it("puts Esperando por você before Lojas", async () => {
    const { root } = await privacyHome([
      json(privacyPage([])),
      json(page([summaryOf()])),
    ]);

    expect(byTag(root, "h2").map((heading) => heading.textContent)).toEqual([
      "Esperando por você",
      "Lojas",
    ]);
  });

  it("reads the open privacy cases without audit and counts them, with the most urgent due day the server counted", async () => {
    const { calls, root } = await privacyHome([
      json(
        privacyPage([
          privacyOf({ dueInDays: 5 }),
          privacyOf({ dueInDays: 2, id: OTHER_CASE }),
        ])
      ),
      json(page([])),
    ]);

    expect(calls[1]?.path.startsWith("/api/privacy-cases?")).toBe(true);
    expect(calls[1]?.init.method).toBe("GET");
    expect(search(calls[1]).get("filter")).toBe("open");
    expect(search(calls[1]).get("limit")).toBe("50");
    const [link] = waitingItems(root);
    expect(link?.getAttribute("href")).toBe("/privacidade");
    expect(link?.textContent).toContain("2 pedidos de dados abertos");
    expect(link?.textContent).toContain("o mais urgente vence em 2 dias");
    expect(link?.getAttribute("aria-label")).toBe(
      "2 pedidos de dados abertos, o mais urgente vence em 2 dias: ver pedidos de dados"
    );
  });

  it.each([
    [
      "is past, by the server's own flag",
      { dueInDays: 0, overdue: true },
      "o mais urgente está vencido",
    ],
    ["is days behind", { dueInDays: -3 }, "o mais urgente está vencido"],
    ["is today", { dueInDays: 0 }, "o mais urgente vence hoje"],
    ["is tomorrow", { dueInDays: 1 }, "o mais urgente vence em 1 dia"],
  ])(
    "says in words that the most urgent due day %s",
    async (_name, fields, words) => {
      const { root } = await privacyHome([
        json(privacyPage([privacyOf(fields)])),
        json(page([])),
      ]);

      expect(visibleText(root)).toContain(words);
    }
  );

  it("takes the days from the server, never from the date: a due date far in the past with 7 days says 7", async () => {
    const { root } = await privacyHome([
      json(
        privacyPage([
          privacyOf({ dueAt: "2020-01-01T00:00:00.000Z", dueInDays: 7 }),
        ])
      ),
      json(page([])),
    ]);

    expect(visibleText(root)).toContain("o mais urgente vence em 7 dias");
  });

  it("says nothing of a due day when the server has none, and says 'ou mais' when there is another page", async () => {
    const { root } = await privacyHome([
      json(privacyPage([privacyOf({ dueInDays: null })], PRIVACY_CASE)),
      json(page([])),
    ]);

    const [link] = waitingItems(root);
    expect(link?.textContent).toContain("1 ou mais pedidos de dados abertos");
    expect(link?.textContent).not.toContain("urgente");
  });

  it("says the due day of the most urgent is among the newest when there is another page", async () => {
    const { root } = await privacyHome([
      json(privacyPage([privacyOf({ dueInDays: 4 })], PRIVACY_CASE)),
      json(page([])),
    ]);

    expect(visibleText(root)).toContain(
      "entre os 50 mais recentes, o mais urgente vence em 4 dias"
    );
  });

  it("shows no line for no privacy case, and says nothing waits when nothing does", async () => {
    const { root } = await privacyHome([json(privacyPage([])), json(page([]))]);

    expect(waitingItems(root)).toEqual([]);
    expect(visibleText(root)).toContain("Nada esperando por você.");
  });

  it("says the privacy cases could not be counted when the read fails, and still counts the rest", async () => {
    const { root } = await privacyHome([
      json({ error: "boom" }, 503),
      json(page([summaryOf()])),
    ]);

    expect(alertOf(root)?.textContent).toContain(
      "Não foi possível contar os pedidos de dados."
    );
    expect(visibleText(root)).toContain("1 atendimento de suporte aberto");
  });

  it("does not read the privacy cases without the capability", async () => {
    const { calls } = await home([json(page([]))]);

    expect(calls.some((call) => call.path.includes("privacy-cases"))).toBe(
      false
    );
  });

  it("makes each item one link around its line, with the figure apart and the name 'N o quê: destino'", async () => {
    const { root } = await privacyHome([
      json(privacyPage([privacyOf()])),
      json(page([summaryOf(), summaryOf({ id: OTHER_CASE })])),
    ]);

    const items = waitingItems(root);
    expect(items.map((item) => item.getAttribute("href"))).toEqual([
      "/privacidade",
      "/casos",
    ]);
    const [, support] = items;
    expect(support?.getAttribute("aria-label")).toBe(
      "2 atendimentos de suporte abertos: ver atendimentos"
    );
    const figure = byTag(support as never, "span").find(
      (span) => span.getAttribute("class") === "waiting-count"
    );
    expect(figure?.textContent).toBe("2");
    for (const item of items) {
      expect(item.parent?.tagName).toBe("li");
      expect(item.parent?.parent?.getAttribute("class")).toBe("waiting");
    }
  });

  it("shows the three-line guide always, as fixed text with no button, with nothing to dismiss", async () => {
    const empty = await home([json(page([]))]);
    const full = await home([json(page([summaryOf()]))]);
    for (const { root } of [empty, full]) {
      const guide = allElements(root).find((element) =>
        (element.getAttribute("class") ?? "").includes("guide")
      );
      expect(guide?.tagName).toBe("ol");
      expect(
        byTag(guide as never, "li").map((line) => line.textContent)
      ).toEqual([
        "Ache a loja em Lojas.",
        "Para agir, abra um atendimento: ele autoriza e registra.",
        "Pedidos de dados e falhas aparecem aqui quando houver.",
      ]);
      expect(byTag(guide as never, "button")).toEqual([]);
    }
  });
});

describe("Início (AC-P1.2b)", () => {
  it("asks only who is signed in and the open cases, and nothing audited or heavy", async () => {
    const { calls } = await home([json(page([summaryOf()]))]);

    expect(calls.map((call) => call.init.method)).toEqual(["GET", "GET"]);
    expect(calls[0]?.path).toBe("/api/whoami");
    expect(calls[1]?.path.startsWith("/api/support-cases?")).toBe(true);
    expect(search(calls[1]).get("limit")).toBe("50");
    expect(search(calls[1]).get("status")).toBe("open");
    expect(search(calls[1]).get("kind")).toBe("support");
    expect(search(calls[1]).has("organizationId")).toBe(false);
    for (const call of calls) {
      expect(call.path).not.toContain("funnel");
      expect(call.path).not.toContain("refund-window");
      expect(call.path).not.toContain("access-log");
    }
  });

  it("says how many support cases are open, with a link to the list", async () => {
    const { root } = await home([
      json(page([summaryOf(), summaryOf({ id: OTHER_CASE })])),
    ]);

    expect(visibleText(root)).toContain("2 atendimentos de suporte abertos");
    expect(visibleText(root)).not.toContain("Nada esperando por você.");
    const link = byTag(root, "a").find(
      (item) => item.getAttribute("class") === "waiting-item"
    );
    expect(link?.getAttribute("href")).toBe("/casos");
    expect(link?.textContent).toContain("Ver atendimentos");
  });

  it("says 1 atendimento in the singular", async () => {
    const { root } = await home([json(page([summaryOf()]))]);

    expect(visibleText(root)).toContain("1 atendimento de suporte aberto");
    expect(visibleText(root)).not.toContain("1 atendimentos");
  });

  it("takes the count from the answer to the support kind, never from a filter on the screen", async () => {
    const { calls, root } = await home([
      json(
        page(
          [summaryOf(), summaryOf({ id: OTHER_CASE }), summaryOf({ id: "x1" })],
          "cursor-1"
        )
      ),
    ]);

    expect(search(calls[1]).get("kind")).toBe("support");
    expect(visibleText(root)).toContain(
      "3 ou mais atendimentos de suporte abertos"
    );
    expect(visibleText(root)).not.toContain("0 ou mais");
  });

  it("shows nothing for a support list that comes back empty, with no next page", async () => {
    const { calls, root } = await home([json(page([]))]);

    expect(search(calls[1]).get("kind")).toBe("support");
    expect(visibleText(root)).toContain("Nada esperando por você.");
    expect(visibleText(root)).not.toContain("atendimentos de suporte abertos");
    expect(visibleText(root)).not.toContain("0 ou mais");
  });

  it('says "ou mais" when the server has another page', async () => {
    const { root } = await home([
      json(page([summaryOf(), summaryOf({ id: OTHER_CASE })], "cursor-1")),
    ]);

    expect(visibleText(root)).toContain(
      "2 ou mais atendimentos de suporte abertos"
    );
  });

  it("says nothing waits when there is no open case", async () => {
    const { root } = await home([json(page([]))]);

    expect(visibleText(root)).toContain("Nada esperando por você.");
    expect(
      byTag(root, "a").some((link) => link.textContent === "Ver atendimentos")
    ).toBe(false);
  });

  it("does not read the cases without the capability to manage them", async () => {
    const { calls, root } = await home([], json(DIAGNOSE_ONLY));

    expect(calls.map((call) => call.path)).toEqual(["/api/whoami"]);
    expect(visibleText(root)).toContain("Nada esperando por você.");
    expect(byId(root, "busca")).toBeDefined();
  });

  it("offers no store search without the capability to diagnose", async () => {
    const { root } = await home([json(page([]))], json(MANAGE_ONLY));

    expect(() => byId(root, "busca")).toThrow();
    expect(visibleText(root)).toContain("Nada esperando por você.");
  });

  it("says the count could not be made, with the sentence of the problem and no code", async () => {
    const { root } = await home([json({ error: "database_down" }, 503)]);

    expect(alertOf(root)?.textContent).toBe(
      `Não foi possível contar os atendimentos abertos. ${PROBLEM_TEXT.unavailable}`
    );
    expect(visibleText(root)).not.toContain("database_down");
  });

  it("goes to the store's screen when Ver loja is used on a search result", async () => {
    const {
      calls,
      navigations,
      root,
      search: find,
    } = await home([
      json(page([])),
      json({
        next: null,
        organizations: [summary({ id: STORE, name: "Loja da Ana" })],
      }),
    ]);

    await find("Ana");
    expect(search(calls[2]).get("query")).toBe("Ana");
    buttons(root, "Ver loja")[0]?.click();

    expect(navigations).toEqual([`/lojas/${STORE}`]);
    expect(calls).toHaveLength(3);
  });

  it("does not navigate from a store ID that is not a UUID", async () => {
    const {
      navigations,
      root,
      search: find,
    } = await home([
      json(page([])),
      json({
        next: null,
        organizations: [summary({ id: "../admin", name: "Loja da Ana" })],
      }),
    ]);

    await find("Ana");
    buttons(root, "Ver loja")[0]?.click();

    expect(navigations).toEqual([]);
  });
});

describe("Loja", () => {
  const diagnosticsFailure = json({ error: "x" }, 404);

  it("reads the store's open cases and then its diagnostics, and writes nothing", async () => {
    const { calls } = await storeScreen([
      json(page([summaryOf()])),
      diagnosticsFailure,
    ]);

    expect(calls).toHaveLength(3);
    expect(calls[1]?.path.startsWith("/api/support-cases?")).toBe(true);
    expect(search(calls[1]).get("organizationId")).toBe(STORE);
    expect(search(calls[1]).get("status")).toBe("open");
    expect(search(calls[1]).get("limit")).toBe("50");
    expect(calls[2]?.path).toBe(`/api/organizations/${STORE}/diagnostics`);
    expect(calls.every((call) => call.init.method === "GET")).toBe(true);
  });

  it("links to each open case and to opening a new one for this store", async () => {
    const { root } = await storeScreen([
      json(page([summaryOf(), summaryOf({ id: OTHER_CASE })])),
      diagnosticsFailure,
    ]);

    expect(hrefs(root)).toContain(`/casos/${CASE}`);
    expect(hrefs(root)).toContain(`/casos/${OTHER_CASE}`);
    expect(hrefs(root)).toContain(`/casos/novo?loja=${STORE}`);
    expect(hrefs(root)).toContain(`/casos?estado=fechados&loja=${STORE}`);
    expect(visibleText(root)).toContain("2 atendimentos abertos.");
    expect(visibleText(root)).toContain(`Aberto em ${OPENED_TEXT}`);
  });

  it("lists only the open support cases of this store, whatever the server sent", async () => {
    const { root } = await storeScreen([
      json(
        page([
          summaryOf(),
          summaryOf({ id: OTHER_CASE, organizationId: ANOTHER_STORE }),
          summaryOf({
            id: "0199a0a0-0000-7000-8000-00000000c0e1",
            kind: "privacy",
          }),
          summaryOf({
            closedAt: OPENED_AT,
            id: "0199a0a0-0000-7000-8000-00000000c0e2",
            status: "closed",
          }),
        ])
      ),
      diagnosticsFailure,
    ]);

    expect(visibleText(root)).toContain("1 atendimento aberto.");
    expect(
      hrefs(root).filter((href) => href?.startsWith("/casos/0199"))
    ).toEqual([`/casos/${CASE}`]);
  });

  it("still offers to open a case when the store has none", async () => {
    const { root } = await storeScreen([json(page([])), diagnosticsFailure]);

    expect(visibleText(root)).toContain(
      "Nenhum atendimento aberto desta loja."
    );
    expect(hrefs(root)).toContain(`/casos/novo?loja=${STORE}`);
  });

  it.each([
    ["with an open atendimento", [summaryOf()], `/casos/${CASE}`],
    ["with none open", [], `/casos/novo?loja=${STORE}`],
  ])(
    "says in each section that acts that the action is done inside an atendimento, and leads to it, %s (AC-IA5)",
    async (_name, open, destination) => {
      const { root } = await storeScreen(
        [json(page(open)), diagnosticsFailure],
        json({
          ...OWNER,
          capabilities: [
            ...OWNER.capabilities,
            "organization:suspend",
            "organization:classify",
          ],
        })
      );
      const section = (id: string) =>
        allElements(root).find(
          (element) => element.getAttribute("aria-labelledby") === id
        );

      const stores = section("casos-loja-titulo");
      const billing = section("cobranca-titulo");
      expect(stores).toBeDefined();
      expect(billing).toBeDefined();
      for (const found of [stores, billing]) {
        if (found === undefined) {
          continue;
        }
        expect(visibleText(found)).toMatch(ACTION_IN_ATENDIMENTO);
        expect(byTag(found, "a").map((l) => l.getAttribute("href"))).toContain(
          found === billing ? `/casos/novo?loja=${STORE}` : destination
        );
      }
    }
  );

  it("reads only the diagnostics without the capability to manage cases", async () => {
    const { calls, root } = await storeScreen(
      [diagnosticsFailure],
      json(DIAGNOSE_ONLY)
    );

    expect(calls.map((call) => call.path)).toEqual([
      "/api/whoami",
      `/api/organizations/${STORE}/diagnostics`,
    ]);
    expect(hrefs(root)).not.toContain(`/casos/novo?loja=${STORE}`);
  });

  it("has no form to open a case, and says no paid subscription instead of rows of dashes", async () => {
    const { root } = await storeScreen([
      json(page([])),
      json(diagnostics({ billing: null, entitlements: { plan: "free" } })),
    ]);
    await flush();

    expect(byTag(root, "form")).toEqual([]);
    expect(visibleText(root)).not.toContain("Motivo do novo atendimento");
    expect(visibleText(root)).toContain("Sem assinatura paga.");
    const dashes = byTag(root, "dd").filter((cell) => cell.textContent === "—");
    expect(dashes).toEqual([]);
    const labels = byTag(root, "dt").map((term) => term.textContent);
    expect(labels).toContain("Plano em vigor");
    expect(labels).not.toContain("Ciclo");
    expect(labels).not.toContain("Último fato de cobrança");
  });

  it("says the store never synced instead of leaving the fact out", async () => {
    const { root } = await storeScreen([
      json(page([])),
      json(diagnostics({ lastReceivedAt: null })),
    ]);
    await flush();

    const terms = byTag(root, "dt");
    const index = terms.findIndex(
      (term) => term.textContent === "Última sincronização"
    );
    expect(index).toBeGreaterThanOrEqual(0);
    expect(byTag(root, "dd")[index]?.textContent).toBe("nunca");
  });

  it("names the store above its cases once the diagnostics are read", async () => {
    const { root } = await storeScreen([
      json(page([summaryOf()])),
      json(diagnostics({ name: "Loja da Ana" })),
    ]);
    await flush();

    const head = allElements(root).find(
      (element) => element.getAttribute("class") === "store-head"
    );
    const areas = head?.parent;
    expect(areas?.children[0]).toBe(head);
    expect(head?.textContent).toContain("Loja da Ana");
    expect(areas?.children[1]?.getAttribute("aria-labelledby")).toBe(
      "casos-loja-titulo"
    );
  });

  it("says the sentence of the problem when the cases cannot be read", async () => {
    const { root } = await storeScreen([
      json({ error: "boom" }, 503),
      diagnosticsFailure,
    ]);

    expect(visibleText(root)).toContain(PROBLEM_TEXT.unavailable);
    expect(visibleText(root)).not.toContain("boom");
  });

  it("says the store was not found, with no request, when the context has no ID", async () => {
    const { calls, root } = await mount(
      [],
      undefined,
      undefined,
      screenContext({ id: null, screen: "loja" })
    );

    expect(calls).toHaveLength(1);
    expect(alertOf(root)?.textContent).toBe("Esta loja não foi encontrada.");
  });
});

describe("hostile text is shown as text (AC-C7)", () => {
  it.each(HOSTILE)(
    "keeps %j as text on the store's screen",
    async (hostile) => {
      const { document, root } = await storeScreen([
        json(page([summaryOf({ reason: hostile })])),
        json({ error: "x" }, 404),
      ]);

      // the reason is shown as a label: an invisible bidi control turns into the replacement character
      expect(visibleText(root)).toContain(hostile.replace("‮", "�"));
      expect(
        document.created.filter((tag) => NEVER_CREATED.includes(tag))
      ).toEqual([]);
    }
  );

  it.each(HOSTILE)(
    "keeps %j as text in a search result of Início",
    async (hostile) => {
      const {
        document,
        root,
        search: find,
      } = await home([
        json(page([])),
        json({
          next: null,
          organizations: [summary({ id: STORE, name: hostile })],
        }),
      ]);

      await find("x");

      expect(visibleText(root)).toContain(hostile);
      expect(
        document.created.filter((tag) => NEVER_CREATED.includes(tag))
      ).toEqual([]);
    }
  );
});

describe("opening a screen reads and never writes (AC-C5)", () => {
  const screens: [string, () => Promise<{ calls: Call[] }>][] = [
    ["inicio", () => home([json(page([summaryOf()]))])],
    [
      "loja",
      () => storeScreen([json(page([summaryOf()])), json({ error: "x" }, 404)]),
    ],
  ];

  it.each(screens)(
    "asks the same, with no POST, each time the %s screen opens",
    async (_name, open) => {
      const first = await open();
      const second = await open();

      const summarize = (calls: Call[]) =>
        calls.map((call) => [call.init.method, call.path]);
      expect(summarize(second.calls)).toEqual(summarize(first.calls));
      expect(first.calls.every((call) => call.init.method === "GET")).toBe(
        true
      );
      expect(first.calls.length).toBeGreaterThan(1);
    }
  );

  it("builds elements on every screen only from the page's own tags", async () => {
    const { document, root } = await home([json(page([summaryOf()]))]);

    expect(allElements(root).length).toBeGreaterThan(1);
    expect(
      document.created.filter((tag) => NEVER_CREATED.includes(tag))
    ).toEqual([]);
  });
});
