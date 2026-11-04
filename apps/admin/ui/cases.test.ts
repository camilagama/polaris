import { describe, expect, it } from "vitest";
import { PROBLEM_TEXT } from "./api";
import {
  allElements,
  buttons,
  byId,
  byTag,
  type FakeElement,
  visibleText,
} from "./test-dom";
import {
  type Answer,
  alertOf,
  type Call,
  flush,
  json,
  mount,
  OWNER,
  screenContext,
  summary,
} from "./test-page";
import type {
  ClosedSupportCase,
  OpenedSupportCase,
  SupportCaseDetail,
  SupportCasePage,
  SupportCaseSummary,
} from "./types";
import {
  CLOSE_EFFECT,
  CLOSE_UNDO,
  CLOSE_UNKNOWN,
  CLOSED_NOT_SHOWN,
} from "./views/case";

/**
 * The screens of the support cases in a small DOM, against a simulated API (corte admin-v2, Parte 1): the list
 * (AC-P1.4), opening a case (AC-P1.5), the case and its close in two steps (AC-P1.6), the sentence of each answer
 * (AC-C3), hostile text (AC-C7) and what opening a screen asks (AC-C5). The clock is the one of `mount`, fixed.
 */

const CASE = "0199a0a0-0000-7000-8000-00000000c0de";
const OTHER_CASE = "0199a0a0-0000-7000-8000-00000000c0df";
const STORE = "0199a0a0-0000-7000-8000-0000000000a1";
const OPENED_AT = "2026-10-28T13:05:00.000Z";
const CLOSED_AT = "2026-10-28T15:05:00.000Z";
const CLOSED_TEXT = "28/10/2026 12:05";
const CLOSE_DONE = "Caso fechado. Os acessos temporários dele foram revogados.";
const HOSTILE = [
  "<img src=x onerror=alert(1)>",
  "<script>alert(1)</script>",
  "javascript:alert(1)",
  "‮abc",
  '"><svg onload=1>',
];
const NEVER_CREATED = ["script", "img", "svg", "iframe"];

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

function detail(
  overrides: Partial<SupportCaseDetail["case"]> = {}
): SupportCaseDetail {
  return {
    audit: [],
    case: {
      ...summaryOf(),
      context: null,
      openedBy: OWNER.principal.id,
      resolution: null,
      ...overrides,
    },
    grants: [],
  };
}

const closedDetail = (resolution: string | null = null) =>
  detail({ closedAt: CLOSED_AT, resolution, status: "closed" });

const closedAnswer = (changed = true): ClosedSupportCase => ({
  changed,
  id: CASE,
  status: "closed",
});

const search = (call: Call | undefined) =>
  new URL(call?.path ?? "", "http://admin.test").searchParams;

const bodyOf = (call: Call | undefined) =>
  JSON.parse(String(call?.init.body ?? "null"));

const linksOf = (root: FakeElement) =>
  byTag(root, "a").map((link) => link.getAttribute("href"));

const rowsOf = (root: FakeElement) =>
  byTag(root, "tbody").flatMap((body) => byTag(body, "tr"));

function factOf(root: FakeElement, label: string): string | undefined {
  const term = byTag(root, "dt").find((item) => item.textContent === label);
  return term?.parent?.querySelector("dd")?.textContent;
}

function pending() {
  let release: (response: Response) => void = () => undefined;
  const answer: Answer = () =>
    new Promise<Response>((resolve) => {
      release = resolve;
    });
  return { answer, release: (response: Response) => release(response) };
}

const listContext = (overrides = {}) =>
  screenContext({ screen: "casos", ...overrides });

describe("the list of cases (AC-P1.4)", () => {
  it("reads the open cases once when the screen opens", async () => {
    const { calls } = await mount(
      [json(page([summaryOf()]))],
      undefined,
      undefined,
      listContext()
    );

    expect(calls.map((call) => call.path)).toHaveLength(2);
    expect(calls[1]?.init.method).toBe("GET");
    expect(search(calls[1]).get("status")).toBe("open");
    expect(search(calls[1]).get("limit")).toBe("25");
    expect(search(calls[1]).has("organizationId")).toBe(false);
  });

  it("reads the closed cases when the screen is on the closed tab", async () => {
    const { calls, root } = await mount(
      [json(page([summaryOf({ closedAt: CLOSED_AT, status: "closed" })]))],
      undefined,
      undefined,
      listContext({ listState: "fechados" })
    );

    expect(search(calls[1]).get("status")).toBe("closed");
    expect(visibleText(rowsOf(root)[0] as FakeElement)).toContain(
      `Fechado em ${CLOSED_TEXT}`
    );
  });

  it("sends the store filter as it was typed, untrimmed, and not in the URL of the screen", async () => {
    const { calls, root } = await mount(
      [json(page([])), json(page([]))],
      undefined,
      undefined,
      listContext()
    );

    byId(root, "casos-loja").value = " abc ";
    buttons(root, "Filtrar")[0]?.click();
    await flush();

    expect(calls).toHaveLength(3);
    expect(search(calls[2]).get("organizationId")).toBe(" abc ");
    expect(search(calls[2]).get("status")).toBe("open");
  });

  it("starts with the store of the screen's context in the filter and sends it", async () => {
    const { calls, root } = await mount(
      [json(page([]))],
      undefined,
      undefined,
      listContext({ store: STORE })
    );

    expect(byId(root, "casos-loja").value).toBe(STORE);
    expect(search(calls[1]).get("organizationId")).toBe(STORE);
  });

  it.each([
    ["a filter of 129 characters", "a".repeat(129)],
    ["a filter with a control character", "ab\u0007c"],
    ["a filter with a line break", "ab\nc"],
  ])("refuses %s without a request", async (_name, typed) => {
    const { calls, root } = await mount(
      [json(page([]))],
      undefined,
      undefined,
      listContext()
    );

    byId(root, "casos-loja").value = typed;
    buttons(root, "Filtrar")[0]?.click();
    await flush();

    expect(calls).toHaveLength(2);
    expect(alertOf(root)?.textContent).toContain(
      "O filtro aceita só o ID da loja"
    );
  });

  it("accepts a filter of exactly 128 characters", async () => {
    const { calls, root } = await mount(
      [json(page([])), json(page([]))],
      undefined,
      undefined,
      listContext()
    );

    byId(root, "casos-loja").value = "a".repeat(128);
    buttons(root, "Filtrar")[0]?.click();
    await flush();

    expect(search(calls[2]).get("organizationId")).toBe("a".repeat(128));
  });

  it("shows the store name and ID, the type, the reason and the state of an open support case, with a link to it", async () => {
    const { root } = await mount(
      [json(page([summaryOf()]))],
      undefined,
      undefined,
      listContext()
    );

    const text = visibleText(rowsOf(root)[0] as FakeElement);
    expect(text).toContain("Loja da Ana");
    expect(text).toContain(STORE);
    expect(text).toContain("Suporte");
    expect(text).toContain("Dono pediu ajuda com o estoque");
    expect(text).toContain("Aberto");
    expect(text).toContain("Ver caso");
    expect(linksOf(root)).toContain(`/casos/${CASE}`);
  });

  it("lists a privacy case for reading only: no link, no reason", async () => {
    const { root } = await mount(
      [
        json(
          page([
            summaryOf({
              id: OTHER_CASE,
              kind: "privacy",
              reason: "pedido de apagamento do titular",
            }),
          ])
        ),
      ],
      undefined,
      undefined,
      listContext()
    );

    const text = visibleText(rowsOf(root)[0] as FakeElement);
    expect(text).toContain("Privacidade");
    expect(text).toContain("Só leitura");
    expect(text).not.toContain("pedido de apagamento");
    expect(linksOf(root)).not.toContain(`/casos/${OTHER_CASE}`);
    expect(byTag(rowsOf(root)[0] as FakeElement, "a")).toHaveLength(0);
  });

  it("makes no link from an ID that is not a UUID", async () => {
    const { root } = await mount(
      [json(page([summaryOf({ id: "../../admin" })]))],
      undefined,
      undefined,
      listContext()
    );

    expect(byTag(rowsOf(root)[0] as FakeElement, "a")).toHaveLength(0);
    expect(linksOf(root).some((href) => href?.includes(".."))).toBe(false);
  });

  it("asks for the next page with `after` when Carregar mais is used", async () => {
    const { calls, root } = await mount(
      [
        json(page([summaryOf()], "cursor-1")),
        json(page([summaryOf({ id: OTHER_CASE })])),
      ],
      undefined,
      undefined,
      listContext()
    );

    const more = buttons(root, "Carregar mais")[0] as FakeElement;
    expect(more.hasAttribute("hidden")).toBe(false);
    more.click();
    await flush();

    expect(search(calls[2]).get("after")).toBe("cursor-1");
    expect(search(calls[2]).get("status")).toBe("open");
    expect(rowsOf(root)).toHaveLength(2);
    expect(more.hasAttribute("hidden")).toBe(true);
  });

  it("says there are no open cases when the list is empty", async () => {
    const { root } = await mount(
      [json(page([]))],
      undefined,
      undefined,
      listContext()
    );

    expect(visibleText(root)).toContain("Nenhum caso aberto.");
    expect(
      byTag(root, "table").every((table) => table.hasAttribute("hidden"))
    ).toBe(true);
  });

  it("says there are no closed cases on the closed tab", async () => {
    const { root } = await mount(
      [json(page([]))],
      undefined,
      undefined,
      listContext({ listState: "fechados" })
    );

    expect(visibleText(root)).toContain("Nenhum caso fechado.");
  });

  it.each([
    ["abertos", "Abertos"],
    ["fechados", "Fechados"],
  ] as const)(
    "marks only the current tab (%s) with aria-current",
    async (state, label) => {
      const { root } = await mount(
        [json(page([]))],
        undefined,
        undefined,
        listContext({ listState: state })
      );

      const tabs = byTag(root, "a").filter((link) =>
        ["Abertos", "Fechados"].includes(link.textContent)
      );
      const current = tabs.filter(
        (link) => link.getAttribute("aria-current") === "page"
      );
      expect(current.map((link) => link.textContent)).toEqual([label]);
      expect(tabs.map((link) => link.getAttribute("href"))).toEqual([
        "/casos",
        "/casos?estado=fechados",
      ]);
    }
  );

  it("keeps the store in the tab links when the list is of one store", async () => {
    const { root } = await mount(
      [json(page([]))],
      undefined,
      undefined,
      listContext({ store: STORE })
    );

    expect(linksOf(root)).toContain(`/casos?loja=${STORE}`);
    expect(linksOf(root)).toContain(`/casos?estado=fechados&loja=${STORE}`);
    expect(linksOf(root)).toContain(`/casos/novo?loja=${STORE}`);
  });

  it("says the sentence of the problem and shows no rows when the read fails", async () => {
    const { root } = await mount(
      [json({ error: "boom" }, 503)],
      undefined,
      undefined,
      listContext()
    );

    expect(alertOf(root)?.textContent).toBe(PROBLEM_TEXT.unavailable);
    expect(visibleText(root)).not.toContain("boom");
  });
});

describe("opening a case (AC-P1.5)", () => {
  const newContext = (overrides = {}) =>
    screenContext({ screen: "caso-novo", store: STORE, ...overrides });
  const namePage = json({
    next: null,
    organizations: [summary({ id: STORE, name: "Loja da Ana" })],
  });
  const opened: OpenedSupportCase = {
    id: CASE,
    kind: "support",
    openedAt: OPENED_AT,
    organizationId: STORE,
    reason: "x",
    status: "open",
  };

  async function ready(answers: Answer[] = []) {
    const mounted = await mount(
      [namePage, ...answers],
      undefined,
      undefined,
      newContext()
    );
    return mounted;
  }

  const type = (root: FakeElement, text: string) => {
    byId(root, "motivo").value = text;
    byId(root, "motivo").dispatch("input");
  };

  const submit = async (root: FakeElement) => {
    buttons(root, "Abrir caso")[0]?.click();
    await flush();
  };

  it("reads the name of the store of the context by its exact ID and shows it", async () => {
    const { calls, root } = await ready();

    expect(calls).toHaveLength(2);
    expect(search(calls[1]).get("limit")).toBe("1");
    expect(search(calls[1]).get("query")).toBe(STORE);
    expect(calls[1]?.path.startsWith("/api/organizations?")).toBe(true);
    expect(visibleText(byId(root, "caso-loja"))).toContain("Loja da Ana");
    expect(visibleText(byId(root, "caso-loja"))).toContain(STORE);
  });

  it("sends a reason of exactly 500 characters, as JSON in the body and nothing in the URL", async () => {
    const reason = "a".repeat(500);
    const { calls, navigations, root } = await ready([json(opened, 201)]);

    type(root, `  ${reason}  `);
    await submit(root);

    const [, , post] = calls;
    expect(post?.init.method).toBe("POST");
    expect(post?.path).toBe("/api/support-cases");
    expect(post?.init.body).toBeTypeOf("string");
    expect(bodyOf(post)).toEqual({
      kind: "support",
      organizationId: STORE,
      reason,
    });
    expect(navigations).toEqual([`/casos/${CASE}`]);
  });

  it("refuses a reason of 501 characters without a request", async () => {
    const { calls, navigations, root } = await ready();

    type(root, "a".repeat(501));
    await submit(root);

    expect(calls).toHaveLength(2);
    expect(navigations).toEqual([]);
    expect(byId(root, "motivo-erro").textContent).toBe(
      "O motivo aceita até 500 caracteres."
    );
  });

  it("counts the characters of the reason as a person counts them", async () => {
    const { root } = await ready();

    type(root, "ação 😀");

    expect(byId(root, "motivo-contador").textContent).toBe(
      "6 de 500 caracteres"
    );
  });

  it("refuses an empty reason and a reason with a control character without a request", async () => {
    const { calls, root } = await ready();

    type(root, "   ");
    await submit(root);
    expect(byId(root, "motivo-erro").textContent).toBe(
      "Escreva o motivo do caso."
    );

    type(root, "linha um\nlinha dois");
    await submit(root);
    expect(byId(root, "motivo-erro").textContent).toContain(
      "não aceita caracteres de controle"
    );
    expect(calls).toHaveLength(2);
  });

  it("offers no privacy kind", async () => {
    const { root } = await ready();

    expect(byTag(root, "select")).toHaveLength(0);
    expect(
      byTag(root, "input").filter((input) =>
        ["radio", "checkbox"].includes(input.getAttribute("type") ?? "")
      )
    ).toHaveLength(0);
    expect(visibleText(root).toLowerCase()).not.toContain("privacidade");
  });

  it("goes to the case opened when the server answers 201", async () => {
    const { navigations, root } = await ready([json(opened, 201)]);

    type(root, "Dono pediu ajuda");
    await submit(root);

    expect(navigations).toEqual([`/casos/${CASE}`]);
  });

  it("does not navigate to a case whose ID is not a UUID", async () => {
    const { navigations, root } = await ready([
      json({ ...opened, id: "../x" }, 201),
    ]);

    type(root, "Dono pediu ajuda");
    await submit(root);

    expect(navigations).toEqual([]);
    expect(alertOf(root)?.textContent).toContain(
      "Não foi possível confirmar se o caso foi aberto"
    );
  });

  it("sends one request when the form is submitted twice while the answer is on its way", async () => {
    const wait = pending();
    const { calls, navigations, root } = await ready([wait.answer]);

    type(root, "Dono pediu ajuda");
    buttons(root, "Abrir caso")[0]?.click();
    buttons(root, "Abrir caso")[0]?.click();
    await flush();

    expect(calls.filter((call) => call.init.method === "POST")).toHaveLength(1);

    wait.release(json(opened, 201));
    await flush();

    expect(calls.filter((call) => call.init.method === "POST")).toHaveLength(1);
    expect(navigations).toEqual([`/casos/${CASE}`]);
  });

  it("shows the reason error on a 400 and does not navigate", async () => {
    const { navigations, root } = await ready([
      json({ error: "invalid_reason" }, 400),
    ]);

    type(root, "Dono pediu ajuda");
    await submit(root);

    expect(byId(root, "motivo-erro").textContent).toContain(
      "O motivo não foi aceito"
    );
    expect(byId(root, "motivo").getAttribute("aria-invalid")).toBe("true");
    expect(navigations).toEqual([]);
    expect(visibleText(root)).not.toContain("invalid_reason");
  });

  it("says it could not confirm the opening on a network error, and does not navigate", async () => {
    const { navigations, root } = await ready([new Error("offline")]);

    type(root, "Dono pediu ajuda");
    await submit(root);

    expect(alertOf(root)?.textContent).toContain(
      "Não foi possível confirmar se o caso foi aberto"
    );
    expect(navigations).toEqual([]);
  });

  it("allows another try after a failure", async () => {
    const { calls, navigations, root } = await ready([
      new Error("offline"),
      json(opened, 201),
    ]);

    type(root, "Dono pediu ajuda");
    await submit(root);
    await submit(root);

    expect(calls.filter((call) => call.init.method === "POST")).toHaveLength(2);
    expect(navigations).toEqual([`/casos/${CASE}`]);
  });

  it("says the store was not found on a 404", async () => {
    const { navigations, root } = await ready([json({}, 404)]);

    type(root, "Dono pediu ajuda");
    await submit(root);

    expect(alertOf(root)?.textContent).toBe("Esta loja não foi encontrada.");
    expect(navigations).toEqual([]);
  });

  it("says the store was not found when the search does not list it", async () => {
    const { root } = await mount(
      [json({ next: null, organizations: [] })],
      undefined,
      undefined,
      newContext()
    );

    expect(alertOf(root)?.textContent).toBe("Esta loja não foi encontrada.");
  });

  it("asks to choose the store before opening a case without one", async () => {
    const { calls, root } = await mount(
      [],
      undefined,
      undefined,
      screenContext({ screen: "caso-novo" })
    );

    type(root, "Dono pediu ajuda");
    await submit(root);

    expect(calls).toHaveLength(1);
    expect(alertOf(root)?.textContent).toBe(
      "Escolha a loja antes de abrir o caso."
    );
  });

  it("picks the store by the search when the context has none, and opens the case on it", async () => {
    const {
      calls,
      navigations,
      root,
      search: find,
    } = await mount(
      [
        json({
          next: null,
          organizations: [summary({ id: STORE, name: "Loja da Ana" })],
        }),
        json(opened, 201),
      ],
      undefined,
      undefined,
      screenContext({ screen: "caso-novo" })
    );

    await find("Ana");
    expect(search(calls[1]).get("query")).toBe("Ana");
    buttons(root, "Escolher loja")[0]?.click();
    expect(visibleText(byId(root, "caso-loja"))).toContain("Loja da Ana");

    type(root, "Dono pediu ajuda");
    await submit(root);

    expect(bodyOf(calls[2])).toEqual({
      kind: "support",
      organizationId: STORE,
      reason: "Dono pediu ajuda",
    });
    expect(navigations).toEqual([`/casos/${CASE}`]);
  });

  it("does not offer the store search without the capability to diagnose, and says how to open the case", async () => {
    const { calls, root } = await mount(
      [],
      json({ ...OWNER, capabilities: ["support_case:manage"] }),
      undefined,
      screenContext({ screen: "caso-novo" })
    );

    expect(calls).toHaveLength(1);
    expect(visibleText(root)).toContain(
      "Sem permissão para buscar loja: abra o caso pela tela da loja."
    );
    expect(
      byTag(root, "input").map((input) => input.getAttribute("id"))
    ).not.toContain("busca");
  });
});

describe("the screen of a case and its close (AC-P1.6)", () => {
  const caseContext = (overrides = {}) =>
    screenContext({ id: CASE, screen: "caso", ...overrides });

  const open = (
    answers: Answer[],
    detailBody = detail(),
    context = caseContext()
  ) => mount([json(detailBody), ...answers], undefined, undefined, context);

  const posts = (calls: Call[]) =>
    calls.filter((call) => call.init.method === "POST");

  async function toReview(
    mounted: Awaited<ReturnType<typeof open>>,
    text = "Resolvido por telefone"
  ) {
    buttons(mounted.root, "Fechar caso")[0]?.click();
    byId(mounted.root, "resolucao").value = text;
    buttons(mounted.root, "Revisar o fechamento")[0]?.click();
    await flush();
  }

  const confirm = async (root: FakeElement) => {
    buttons(root, "Confirmar o fechamento do caso")[0]?.click();
    await flush();
  };

  it("reads the case by its ID when the screen opens", async () => {
    const { calls, root } = await open([]);

    expect(calls).toHaveLength(2);
    expect(calls[1]?.path).toBe(`/api/support-cases/${CASE}`);
    expect(calls[1]?.init.method).toBe("GET");
    expect(factOf(root, "Tipo")).toBe("Suporte");
    expect(factOf(root, "Motivo")).toBe("Dono pediu ajuda com o estoque");
  });

  it("offers Fechar caso and says what closing does before anything is sent", async () => {
    const { calls, root } = await open([]);

    expect(buttons(root, "Fechar caso")).toHaveLength(1);
    expect(visibleText(root)).toContain(
      "Fechar o caso revoga todos os acessos temporários dele. Caso fechado não reabre."
    );
    expect(CLOSE_EFFECT).toBe(
      "Fechar o caso revoga todos os acessos temporários dele. Caso fechado não reabre."
    );
    expect(posts(calls)).toHaveLength(0);
  });

  it("closes in two steps: form, review with its facts, then one POST with the resolution", async () => {
    const mounted = await open([
      json(closedAnswer()),
      json(closedDetail("Resolvido por telefone")),
    ]);
    const { calls, root } = mounted;

    buttons(root, "Fechar caso")[0]?.click();
    expect(byId(root, "resolucao")).toBeDefined();
    expect(posts(calls)).toHaveLength(0);

    byId(root, "resolucao").value = "  Resolvido por telefone  ";
    buttons(root, "Revisar o fechamento")[0]?.click();
    await flush();

    expect(posts(calls)).toHaveLength(0);
    expect(factOf(root, "Ambiente")).toBe("STAGING");
    expect(visibleText(root)).toContain("Loja da Ana");
    expect(factOf(root, "Resolução")).toBe("Resolvido por telefone");
    expect(factOf(root, "O que acontece")).toBe(CLOSE_EFFECT);
    expect(factOf(root, "Dá para desfazer")).toBe(
      "Não: isso não poderá ser desfeito."
    );
    expect(CLOSE_UNDO).toBe("Não: isso não poderá ser desfeito.");
    expect(factOf(root, "Fica na auditoria")).toContain("auditoria");

    await confirm(root);

    expect(posts(calls)).toHaveLength(1);
    expect(calls[2]?.path).toBe(`/api/support-cases/${CASE}/close`);
    expect(bodyOf(calls[2])).toEqual({ resolution: "Resolvido por telefone" });
  });

  it("says PRODUÇÃO in the review when the environment is production", async () => {
    const mounted = await open(
      [],
      detail(),
      caseContext({ environment: "production" })
    );

    await toReview(mounted);

    expect(factOf(mounted.root, "Ambiente")).toBe("PRODUÇÃO");
  });

  it("sends an empty resolution when none was typed, and the review says so", async () => {
    const mounted = await open([json(closedAnswer()), json(closedDetail())]);

    await toReview(mounted, "");
    expect(factOf(mounted.root, "Resolução")).toBe("Sem resolução escrita.");
    await confirm(mounted.root);

    expect(bodyOf(mounted.calls[2])).toEqual({ resolution: "" });
  });

  it("re-reads the case once after the close and shows it closed, with no action left", async () => {
    const mounted = await open([
      json(closedAnswer()),
      json(closedDetail("Resolvido por telefone")),
    ]);

    await toReview(mounted);
    await confirm(mounted.root);

    const { calls, root } = mounted;
    expect(calls).toHaveLength(4);
    expect(calls[3]?.path).toBe(`/api/support-cases/${CASE}`);
    expect(calls[3]?.init.method).toBe("GET");
    expect(visibleText(root)).toContain(CLOSE_DONE);
    expect(buttons(root, "Fechar caso")).toHaveLength(0);
    expect(buttons(root, "Confirmar o fechamento do caso")).toHaveLength(0);
    expect(visibleText(root)).toContain(
      `Caso fechado em ${CLOSED_TEXT}. Para agir de novo, abra outro caso.`
    );
    expect(factOf(root, "Resolução")).toBe("Resolvido por telefone");
    expect(linksOf(root)).toContain(`/casos/novo?loja=${STORE}`);
  });

  it("says the case was already closed when the server says nothing changed", async () => {
    const mounted = await open([
      json(closedAnswer(false)),
      json(closedDetail()),
    ]);

    await toReview(mounted);
    await confirm(mounted.root);

    expect(visibleText(mounted.root)).toContain("Este caso já estava fechado.");
    expect(visibleText(mounted.root)).not.toContain(CLOSE_DONE);
  });

  it("sends one POST when Confirmar is clicked twice while the answer is on its way", async () => {
    const wait = pending();
    const mounted = await open([wait.answer, json(closedDetail())]);

    await toReview(mounted);
    const confirmButton = buttons(
      mounted.root,
      "Confirmar o fechamento do caso"
    )[0] as FakeElement;
    confirmButton.click();
    confirmButton.click();
    await flush();

    expect(posts(mounted.calls)).toHaveLength(1);

    wait.release(json(closedAnswer()));
    await flush();

    expect(posts(mounted.calls)).toHaveLength(1);
    expect(mounted.calls).toHaveLength(4);
  });

  it("does not go back from the review while the close is on its way", async () => {
    const wait = pending();
    const mounted = await open([wait.answer, json(closedDetail())]);

    await toReview(mounted);
    buttons(mounted.root, "Confirmar o fechamento do caso")[0]?.click();
    buttons(mounted.root, "Voltar")[0]?.click();
    await flush();

    expect(buttons(mounted.root, "Revisar o fechamento")).toHaveLength(0);
    wait.release(json(closedAnswer()));
    await flush();
  });

  it("goes back from the review to the form keeping the typed text, and sends nothing", async () => {
    const mounted = await open([]);

    await toReview(mounted, "Resolvido por telefone");
    buttons(mounted.root, "Voltar")[0]?.click();

    expect(byId(mounted.root, "resolucao").value).toBe(
      "Resolvido por telefone"
    );
    expect(buttons(mounted.root, "Revisar o fechamento")).toHaveLength(1);
    expect(posts(mounted.calls)).toHaveLength(0);
  });

  it("cancels the form and offers Fechar caso again", async () => {
    const mounted = await open([]);

    buttons(mounted.root, "Fechar caso")[0]?.click();
    buttons(mounted.root, "Cancelar")[0]?.click();

    expect(buttons(mounted.root, "Fechar caso")).toHaveLength(1);
    expect(posts(mounted.calls)).toHaveLength(0);
  });

  it("refuses a resolution of 501 characters without a request, and accepts 500", async () => {
    const mounted = await open([json(closedAnswer()), json(closedDetail())]);
    const { root } = mounted;

    buttons(root, "Fechar caso")[0]?.click();
    byId(root, "resolucao").value = "a".repeat(501);
    buttons(root, "Revisar o fechamento")[0]?.click();
    await flush();

    expect(byId(root, "resolucao-erro").textContent).toBe(
      "A resolução aceita até 500 caracteres."
    );
    expect(buttons(root, "Confirmar o fechamento do caso")).toHaveLength(0);
    expect(mounted.calls).toHaveLength(2);

    byId(root, "resolucao").value = "a".repeat(500);
    buttons(root, "Revisar o fechamento")[0]?.click();
    await confirm(root);

    expect(bodyOf(mounted.calls[2])).toEqual({ resolution: "a".repeat(500) });
  });

  it("refuses a resolution with a control character without a request", async () => {
    const mounted = await open([]);

    buttons(mounted.root, "Fechar caso")[0]?.click();
    byId(mounted.root, "resolucao").value = "um\ndois";
    buttons(mounted.root, "Revisar o fechamento")[0]?.click();

    expect(byId(mounted.root, "resolucao-erro").textContent).toContain(
      "não aceita caracteres de controle"
    );
    expect(mounted.calls).toHaveLength(2);
  });

  it("shows no action on a case that is already closed, and links to open another", async () => {
    const { calls, root } = await open([], closedDetail("Feito"));

    expect(buttons(root, "Fechar caso")).toHaveLength(0);
    expect(visibleText(root)).toContain(
      `Caso fechado em ${CLOSED_TEXT}. Para agir de novo, abra outro caso.`
    );
    expect(posts(calls)).toHaveLength(0);
  });

  it("reads a privacy case without any action and without its reason", async () => {
    const { root } = await open(
      [],
      detail({ kind: "privacy", reason: "pedido de apagamento do titular" })
    );

    expect(buttons(root, "Fechar caso")).toHaveLength(0);
    expect(visibleText(root)).not.toContain("pedido de apagamento");
    expect(factOf(root, "Motivo")).toBe("Fica no fluxo de privacidade.");
    expect(visibleText(root)).toContain("só leitura");
  });

  it("shows the history: access grants and audit events, by whom", async () => {
    const { root } = await open([], {
      ...detail(),
      audit: [
        {
          createdAt: OPENED_AT,
          detail: null,
          entityId: null,
          entityType: null,
          eventType: "support_case.opened",
          id: "a1",
          principalId: OWNER.principal.id,
        },
      ],
      grants: [
        {
          active: true,
          expiresAt: "2026-10-28T16:05:00.000Z",
          id: "g1",
          principalId: OWNER.principal.id,
          revokedAt: null,
          startsAt: "2026-10-28T14:05:00.000Z",
        },
      ],
    });

    const text = visibleText(root);
    expect(text).toContain(
      "Acesso aos dados de 28/10/2026 11:05 até 28/10/2026 13:05: ativo."
    );
    expect(text).toContain("28/10/2026 10:05");
    expect(text).toContain("por você");
  });

  it("links to the store only with the capability to diagnose", async () => {
    const withIt = await open([]);
    expect(linksOf(withIt.root)).toContain(`/lojas/${STORE}`);

    const without = await mount(
      [json(detail())],
      json({ ...OWNER, capabilities: ["support_case:manage"] }),
      undefined,
      caseContext()
    );
    expect(linksOf(without.root)).not.toContain(`/lojas/${STORE}`);
  });

  it("says the case was not found, with no request, when the context has no ID", async () => {
    const { calls, root } = await mount(
      [],
      undefined,
      undefined,
      caseContext({ id: null })
    );

    expect(calls).toHaveLength(1);
    expect(alertOf(root)?.textContent).toBe("Este caso não foi encontrado.");
  });

  it("says the case was not found on a 404 of the read", async () => {
    const { root } = await mount(
      [json({ error: "support_case_not_found" }, 404)],
      undefined,
      undefined,
      caseContext()
    );

    expect(alertOf(root)?.textContent).toBe("Este caso não foi encontrado.");
    expect(visibleText(root)).not.toContain("support_case_not_found");
  });
});

describe("what each answer of the close says (AC-C3)", () => {
  const caseContext = screenContext({ id: CASE, screen: "caso" });

  async function closeWith(answer: Answer) {
    const mounted = await mount(
      [json(detail()), answer],
      undefined,
      undefined,
      caseContext
    );
    buttons(mounted.root, "Fechar caso")[0]?.click();
    byId(mounted.root, "resolucao").value = "Feito";
    buttons(mounted.root, "Revisar o fechamento")[0]?.click();
    buttons(mounted.root, "Confirmar o fechamento do caso")[0]?.click();
    await flush();
    return mounted;
  }

  it("goes back to the form with the field error on a 400, keeping the text", async () => {
    const { calls, root } = await closeWith(
      json({ error: "invalid_resolution" }, 400)
    );

    expect(byId(root, "resolucao-erro").textContent).toContain(
      "A resolução não foi aceita"
    );
    expect(byId(root, "resolucao").value).toBe("Feito");
    expect(byId(root, "resolucao").getAttribute("aria-invalid")).toBe("true");
    expect(buttons(root, "Revisar o fechamento")).toHaveLength(1);
    expect(visibleText(root)).not.toContain("invalid_resolution");
    expect(calls).toHaveLength(3);
  });

  it.each([
    ["403", json({ error: "forbidden_code" }, 403), "Sem permissão para isto."],
    [
      "404",
      json({ error: "support_case_not_found" }, 404),
      "Este caso não foi encontrado.",
    ],
    ["429", json({}, 429), PROBLEM_TEXT.rate_limited],
  ])(
    "says its own sentence on a %s, with the confirm button still there",
    async (_status, answer, sentence) => {
      const { document, root } = await closeWith(answer);

      expect(alertOf(root)?.textContent).toBe(sentence);
      expect(visibleText(root)).not.toContain("_code");
      expect(visibleText(root)).not.toContain("support_case_not_found");
      expect(
        buttons(root, "Confirmar o fechamento do caso")[0]?.hasAttribute(
          "hidden"
        )
      ).toBe(false);
      expect(document.activeElement).toBe(alertOf(root));
    }
  );

  it.each([
    ["503", json({ error: "database_down" }, 503)],
    ["500", json({ error: "internal" }, 500)],
    ["a network error", new Error("offline")],
  ])(
    "says it could not confirm the close on %s, hides Confirmar and offers to reload",
    async (_name, answer) => {
      const { document, root } = await closeWith(answer);

      expect(alertOf(root)?.textContent).toBe(CLOSE_UNKNOWN);
      expect(CLOSE_UNKNOWN).toContain(
        "Não deu para confirmar se o caso foi fechado"
      );
      expect(
        buttons(root, "Confirmar o fechamento do caso")[0]?.hasAttribute(
          "hidden"
        )
      ).toBe(true);
      expect(
        buttons(root, "Recarregar o caso")[0]?.hasAttribute("hidden")
      ).toBe(false);
      expect(visibleText(root)).not.toContain("database_down");
      expect(document.activeElement).toBe(alertOf(root));
    }
  );

  it("reads the case again, once, when Recarregar o caso is used, and shows what the server has", async () => {
    const mounted = await mount(
      [json(detail()), new Error("offline"), json(closedDetail())],
      undefined,
      undefined,
      caseContext
    );
    buttons(mounted.root, "Fechar caso")[0]?.click();
    buttons(mounted.root, "Revisar o fechamento")[0]?.click();
    buttons(mounted.root, "Confirmar o fechamento do caso")[0]?.click();
    await flush();

    buttons(mounted.root, "Recarregar o caso")[0]?.click();
    await flush();

    expect(mounted.calls).toHaveLength(4);
    expect(mounted.calls[3]?.init.method).toBe("GET");
    expect(buttons(mounted.root, "Fechar caso")).toHaveLength(0);
    expect(visibleText(mounted.root)).toContain("Caso fechado em");
  });

  it("says the case was closed when the read after the close fails, and leaves only Recarregar o caso", async () => {
    const mounted = await mount(
      [
        json(detail()),
        json({ changed: true, id: CASE, status: "closed" }),
        json({ error: "unavailable" }, 503),
        json(closedDetail()),
      ],
      undefined,
      undefined,
      caseContext
    );
    buttons(mounted.root, "Fechar caso")[0]?.click();
    buttons(mounted.root, "Revisar o fechamento")[0]?.click();
    buttons(mounted.root, "Confirmar o fechamento do caso")[0]?.click();
    await flush();

    expect(alertOf(mounted.root)?.textContent).toBe(CLOSED_NOT_SHOWN);
    expect(
      buttons(mounted.root, "Confirmar o fechamento do caso")[0]?.hasAttribute(
        "hidden"
      )
    ).toBe(true);
    expect(buttons(mounted.root, "Voltar")[0]?.hasAttribute("hidden")).toBe(
      true
    );
    buttons(mounted.root, "Recarregar o caso")[0]?.click();
    await flush();
    expect(mounted.calls.map((call) => call.init.method)).toEqual([
      "GET",
      "GET",
      "POST",
      "GET",
      "GET",
    ]);
    expect(visibleText(mounted.root)).toContain("Caso fechado em");
  });

  it("allows the close again after a refusal that did not close it", async () => {
    const mounted = await mount(
      [
        json(detail()),
        json({}, 429),
        json(closedAnswer()),
        json(closedDetail()),
      ],
      undefined,
      undefined,
      caseContext
    );
    buttons(mounted.root, "Fechar caso")[0]?.click();
    buttons(mounted.root, "Revisar o fechamento")[0]?.click();
    buttons(mounted.root, "Confirmar o fechamento do caso")[0]?.click();
    await flush();
    buttons(mounted.root, "Confirmar o fechamento do caso")[0]?.click();
    await flush();

    expect(
      mounted.calls.filter((call) => call.init.method === "POST")
    ).toHaveLength(2);
    expect(visibleText(mounted.root)).toContain(CLOSE_DONE);
  });
});

describe("hostile text is shown as text (AC-C7)", () => {
  const created = (document: { created: string[] }) =>
    document.created.filter((tag) => NEVER_CREATED.includes(tag));

  it.each(HOSTILE)("keeps %j as text in the list", async (hostile) => {
    const { document, root } = await mount(
      [json(page([summaryOf({ organizationName: hostile, reason: hostile })]))],
      undefined,
      undefined,
      listContext()
    );

    const text = visibleText(rowsOf(root)[0] as FakeElement);
    expect(text).toContain(hostile);
    expect(created(document)).toEqual([]);
  });

  it.each(HOSTILE)("keeps %j as text in the case", async (hostile) => {
    const { document, root } = await mount(
      [
        json(
          detail({
            closedAt: CLOSED_AT,
            context: hostile,
            organizationName: hostile,
            reason: hostile,
            resolution: hostile,
            status: "closed",
          })
        ),
      ],
      undefined,
      undefined,
      screenContext({ id: CASE, screen: "caso" })
    );

    expect(factOf(root, "Motivo")).toBe(hostile);
    expect(factOf(root, "Contexto")).toBe(hostile);
    expect(factOf(root, "Resolução")).toBe(hostile);
    expect(visibleText(root)).toContain(hostile);
    expect(created(document)).toEqual([]);
  });

  it.each(HOSTILE)(
    "keeps %j as text in the review of the close",
    async (hostile) => {
      const { document, root } = await mount(
        [json(detail({ organizationName: hostile, reason: hostile }))],
        undefined,
        undefined,
        screenContext({ id: CASE, screen: "caso" })
      );

      buttons(root, "Fechar caso")[0]?.click();
      byId(root, "resolucao").value = hostile;
      buttons(root, "Revisar o fechamento")[0]?.click();

      expect(factOf(root, "Resolução")).toBe(hostile);
      expect(visibleText(root)).toContain(hostile);
      expect(created(document)).toEqual([]);
    }
  );

  it.each(HOSTILE)(
    "keeps %j as text as store name and typed reason when opening a case",
    async (hostile) => {
      const {
        calls,
        document,
        root,
        search: find,
      } = await mount(
        [
          json({
            next: null,
            organizations: [summary({ id: STORE, name: hostile })],
          }),
          json(
            {
              id: CASE,
              kind: "support",
              openedAt: OPENED_AT,
              organizationId: STORE,
              reason: hostile,
              status: "open",
            },
            201
          ),
        ],
        undefined,
        undefined,
        screenContext({ screen: "caso-novo" })
      );

      await find("x");
      buttons(root, "Escolher loja")[0]?.click();
      byId(root, "motivo").value = hostile;
      buttons(root, "Abrir caso")[0]?.click();
      await flush();

      expect(visibleText(byId(root, "caso-loja"))).toContain(hostile);
      expect(bodyOf(calls[2]).reason).toBe(hostile);
      expect(created(document)).toEqual([]);
    }
  );
});

describe("opening a screen reads and never writes (AC-C5)", () => {
  const screens: [string, Answer[], Parameters<typeof screenContext>[0]][] = [
    ["casos", [json(page([summaryOf()]))], { screen: "casos" }],
    [
      "caso-novo",
      [json({ next: null, organizations: [summary({ id: STORE })] })],
      { screen: "caso-novo", store: STORE },
    ],
    ["caso", [json(detail())], { id: CASE, screen: "caso" }],
  ];

  it.each(screens)(
    "asks the same, with no POST, each time the %s screen opens",
    async (_name, answers, context) => {
      const first = await mount(
        [...answers],
        undefined,
        undefined,
        screenContext(context)
      );
      const second = await mount(
        [...answers],
        undefined,
        undefined,
        screenContext(context)
      );

      const summarize = (calls: Call[]) =>
        calls.map((call) => [call.init.method, call.path]);
      expect(summarize(second.calls)).toEqual(summarize(first.calls));
      expect(first.calls.every((call) => call.init.method === "GET")).toBe(
        true
      );
      expect(allElements(first.root).length).toBeGreaterThan(0);
    }
  );
});
