import { describe, expect, it } from "vitest";
import { PROBLEM_TEXT } from "./api";
import { mountAdmin } from "./app";
import { NAME_LIMIT } from "./dom";
import {
  allElements,
  buttons,
  byId,
  byTag,
  FakeDocument,
  type FakeElement,
  visibleText,
} from "./test-dom";
import type {
  OrganizationDiagnostics,
  OrganizationSummary,
  WhoAmI,
} from "./types";

/**
 * The Admin page in a small DOM (ui/test-dom.ts), against a simulated API: what it asks the server, what it shows
 * and how it fails (corte admin-tela-v1, AC-3 to AC-6, AC-11, AC-12 and AC-14). Nothing here sets a clock: the page
 * has no timer, and the dates are fixed instants checked in Brasília.
 */

interface Call {
  init: RequestInit;
  path: string;
}

type Answer = Response | Error | (() => Promise<Response>);

const OWNER: WhoAmI = {
  capabilities: [
    "organization:diagnose",
    "platform:read",
    "support_case:manage",
    "billing:operate",
  ],
  principal: {
    emailSnapshot: "dona@polaris.example",
    id: "0199a0a0-0000-7000-8000-000000000001",
    role: "platform_owner",
  },
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });

/** The answer Access gives a `fetch` with `redirect: "manual"` once its session is over. */
const accessRedirect = () =>
  ({ ok: false, status: 0, type: "opaqueredirect" }) as Response;

function summary(
  overrides: Partial<OrganizationSummary> = {}
): OrganizationSummary {
  return {
    accessEndsAt: null,
    billingState: "free",
    createdAt: "2026-10-01T12:00:00.000Z",
    id: "org-free-1",
    name: "Loja da Ana",
    planInForce: "free",
    status: "active",
    ...overrides,
  };
}

function diagnostics(
  overrides: {
    attention?: OrganizationDiagnostics["attention"];
    billing?: Partial<NonNullable<OrganizationDiagnostics["billing"]>> | null;
    entitlements?: Partial<OrganizationDiagnostics["entitlements"]>;
    grants?: OrganizationDiagnostics["grants"];
    name?: string;
    quotas?: OrganizationDiagnostics["quotas"];
  } = {}
): OrganizationDiagnostics {
  const billing =
    overrides.billing === null
      ? null
      : {
          accessEndsAt: "2026-11-15T02:59:59.000Z",
          cancelAtPeriodEnd: false,
          cycleMonths: 1,
          lastFactAt: "2026-10-15T15:00:00.000Z",
          overLimitSince: null,
          pendingCycleMonths: null,
          provider: "asaas",
          revokedReason: null,
          revokedThrough: null,
          state: "active",
          trialStartedAt: "2026-10-01T15:00:00.000Z",
          version: 3,
          ...overrides.billing,
        };
  return {
    attention: overrides.attention ?? [],
    billing,
    billingEvents: {
      byStatus: {},
      lastReceivedAt: null,
      maxAttempts: 0,
      oldestUnprocessedAt: null,
    },
    entitlements: {
      accessEndsAt: "2026-11-15T02:59:59.000Z",
      flags: { "offline.write": true, public_catalog: true },
      overLimit: false,
      plan: "pro",
      raisedByGrant: [],
      state: "active",
      ...overrides.entitlements,
    },
    grants: overrides.grants ?? [],
    offline: { activeGrants: 0, devices: 2, lastSeenAt: null },
    organization: {
      authorizationEpoch: 1,
      createdAt: "2026-10-01T12:00:00.000Z",
      currency: "BRL",
      id: "org-pro-1",
      members: 1,
      name: overrides.name ?? "Loja do Bruno",
      status: "active",
      timezone: "America/Sao_Paulo",
    },
    quotas: overrides.quotas ?? [
      { key: "goals.active.max", limit: 10, status: "ok", used: 1 },
      { key: "images.active.max", limit: 500, status: "ok", used: 20 },
      { key: "images.per_product.max", limit: 5, status: "at_limit", used: 5 },
      { key: "variants.active.max", limit: 1000, status: "ok", used: 40 },
    ],
    sync: {
      last7Days: {},
      lastReceivedAt: "2026-10-27T03:30:00.000Z",
      rejectedByCode: {},
    },
    usage: {
      activeGoals: 1,
      archivedProducts: 0,
      images: 20,
      maxImagesPerProduct: 5,
      products: 12,
      variants: 40,
    },
  };
}

/** A status code or an error code of the server: never shown to the operator. */
const TECHNICAL_TEXT = /\b(401|403|404|500|503)\b|error|not_found|plan_catalog/;

function withoutControls(text: string): string {
  return [...text]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 0x20 && !(code >= 0x7f && code <= 0x9f);
    })
    .join("");
}

// the tests run in Node; the page's own types are the browser's, which have no setImmediate
declare function setImmediate(callback: () => void): unknown;

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

/** The page mounted on a fresh document; `answers` are given in the order the page asks. */
async function mount(answers: Answer[], who: Answer = json(OWNER)) {
  const document = new FakeDocument();
  const root = document.createElement("div");
  document.body.append(root);
  const calls: Call[] = [];
  const queue = [who, ...answers];
  const fetchJson = (path: string, init: RequestInit) => {
    calls.push({ init, path });
    const answer = queue.shift();
    if (answer === undefined) {
      throw new Error(`unexpected request to ${path}`);
    }
    if (answer instanceof Error) {
      return Promise.reject(answer);
    }
    return typeof answer === "function" ? answer() : Promise.resolve(answer);
  };
  await mountAdmin(root as unknown as HTMLElement, fetchJson);
  await flush();
  const search = async (text: string) => {
    byId(root, "busca").value = text;
    buttons(root, "Buscar")[0]?.click();
    await flush();
  };
  return { calls, document, queue, root, search };
}

const alertOf = (root: FakeElement) =>
  allElements(root).find(
    (element) =>
      element.getAttribute("role") === "alert" &&
      !element.hasAttribute("hidden")
  );

const queryOf = (path: string) =>
  new URL(path, "https://admin.example.invalid").searchParams;

describe("opening the page", () => {
  it("asks only who the operator is, shows their e-mail and reads nothing else until asked", async () => {
    const { calls, root } = await mount([]);
    expect(calls.map((call) => call.path)).toEqual(["/api/whoami"]);
    expect(visibleText(root)).toContain("Operador: dona@polaris.example");
    expect(byId(root, "busca").getAttribute("maxlength")).toBe("100");
  });

  it("asks the same origin, never follows a redirect and keeps nothing in a cache", async () => {
    const { calls } = await mount([]);
    expect(calls[0]?.init).toMatchObject({
      cache: "no-store",
      credentials: "same-origin",
      method: "GET",
      redirect: "manual",
    });
  });

  it("hides the stores from an operator without the capability, and says why (AC-3)", async () => {
    const { calls, root } = await mount(
      [],
      json({ ...OWNER, capabilities: ["platform:read"] })
    );
    expect(byTag(root, "form")).toEqual([]);
    expect(visibleText(root)).toContain("Sem permissão para isto.");
    expect(calls).toHaveLength(1);
  });

  it.each([
    ["the Access session ended (redirect)", accessRedirect(), "session"],
    [
      "the Access session ended (401)",
      json({ error: "unauthenticated" }, 401),
      "session",
    ],
    ["not an operator", json({ error: "forbidden" }, 403), "forbidden"],
    ["no network", new TypeError("Failed to fetch"), "network"],
    ["the Admin is down", json({ error: "unavailable" }, 503), "unavailable"],
  ] as const)(
    "says what went wrong when %s, and focuses it",
    async (_name, answer, problem) => {
      const { document, root } = await mount([], answer);
      const alert = alertOf(root);
      expect(alert?.textContent).toBe(PROBLEM_TEXT[problem]);
      expect(document.activeElement).toBe(alert);
      expect(byTag(root, "form")).toEqual([]);
    }
  );
});

describe("searching for a store (AC-4, AC-11)", () => {
  it("sends the text exactly as typed: no wildcard, no trim, as a parameter", async () => {
    const typed = "  Loja d'Água %_* ";
    const { calls, search } = await mount([
      json({ next: null, organizations: [] }),
    ]);
    await search(typed);
    const [, request] = calls;
    expect(request?.path.startsWith("/api/organizations?")).toBe(true);
    expect(queryOf(request?.path ?? "").get("query")).toBe(typed);
    expect(queryOf(request?.path ?? "").get("limit")).toBe("25");
    expect(queryOf(request?.path ?? "").has("after")).toBe(false);
  });

  it("refuses a text the server would refuse, without asking it", async () => {
    const { calls, root, search } = await mount([]);
    await search("loja\u0000");
    expect(alertOf(root)?.textContent).toBe(
      "A busca não aceita caracteres de controle."
    );
    await search("x".repeat(101));
    expect(alertOf(root)?.textContent).toBe(
      "A busca aceita até 100 caracteres."
    );
    expect(calls).toHaveLength(1);
  });

  it("says when nothing was found", async () => {
    const { root, search } = await mount([
      json({ next: null, organizations: [] }),
    ]);
    await search("ninguém");
    expect(visibleText(root)).toContain("Nenhuma loja encontrada.");
    expect(byTag(root, "table")[0]?.hasAttribute("hidden")).toBe(true);
  });

  it("lists each store with its ID, state and plan as the server gives them, and loads more on request", async () => {
    const first = summary({
      accessEndsAt: "2026-11-15T02:59:59.000Z",
      billingState: "trialing",
      id: "org-a",
      name: "Loja A",
      planInForce: "pro",
    });
    const second = summary({ id: "org-b", name: "Loja B" });
    const { calls, root, search } = await mount([
      json({ next: "org-a", organizations: [first] }),
      json({ next: null, organizations: [second] }),
    ]);
    await search("Loja");
    expect(visibleText(root)).toContain("1 loja encontrada. Há mais");
    const rows = byTag(byTag(root, "tbody")[0] as FakeElement, "tr");
    expect(
      rows.map((row) => row.children.map((cell) => cell.textContent))
    ).toEqual([
      [
        "Loja A org-a",
        "Ativa",
        "Pro em teste",
        "Pro",
        "14/11/2026",
        "Ver loja",
      ],
    ]);
    buttons(root, "Carregar mais")[0]?.click();
    await flush();
    expect(queryOf(calls[2]?.path ?? "").get("after")).toBe("org-a");
    expect(queryOf(calls[2]?.path ?? "").get("query")).toBe("Loja");
    expect(byTag(root, "tr")).toHaveLength(3);
    expect(visibleText(root)).toContain("2 lojas encontradas.");
    expect(buttons(root, "Carregar mais")[0]?.hasAttribute("hidden")).toBe(
      true
    );
  });

  it("turns off the buttons while the server answers, so a double click asks once", async () => {
    let answer: (response: Response) => void = () => undefined;
    const pending = () =>
      new Promise<Response>((resolve) => {
        answer = resolve;
      });
    const { calls, root } = await mount([pending]);
    byId(root, "busca").value = "Loja";
    buttons(root, "Buscar")[0]?.click();
    buttons(root, "Buscar")[0]?.click();
    expect(calls).toHaveLength(2);
    answer(json({ next: null, organizations: [] }));
    await flush();
    expect(buttons(root, "Buscar")[0]?.hasAttribute("disabled")).toBe(false);
  });

  const hostile = [
    "<script>alert(1)</script>",
    '"><img src=x onerror=alert(1)>',
    'Loja d\'Ana & "Filhos"',
    "<b>negrito</b><style>*{display:none}</style>",
    "javascript:alert(1)",
    "Loja\u0000com\u0007controle\u009b",
    "‮anaj al od aloj",
    "A".repeat(10_000),
  ];

  it("shows hostile names as text, in <bdi>, cut, with the ID next to them, and never makes an element from them", async () => {
    const organizations = hostile.map((name, index) =>
      summary({ id: `org-${index}`, name })
    );
    const { document, root, search } = await mount([
      json({ next: null, organizations }),
    ]);
    await search("");
    const names = byTag(root, "bdi");
    expect(names).toHaveLength(hostile.length);
    for (const [index, element] of names.entries()) {
      const name = hostile[index] ?? "";
      const shown = element.textContent;
      expect(element.parent?.textContent).toBe(`${shown} org-${index}`);
      expect([...shown].length).toBeLessThanOrEqual(NAME_LIMIT + 1);
      // what is shown is the name itself, cut, with control characters made visible
      expect(shown.replaceAll("�", "")).toBe(
        [...withoutControls(name)]
          .slice(0, NAME_LIMIT)
          .join("") + ([...name].length > NAME_LIMIT ? "…" : "")
      );
    }
    expect(names[0]?.textContent).toBe("<script>alert(1)</script>");
    expect(names[5]?.textContent).toBe("Loja�com�controle�");
    expect(names[6]?.textContent).toBe("‮anaj al od aloj");
    expect(names[7]?.textContent).toBe(`${"A".repeat(NAME_LIMIT)}…`);
    expect(names[7]?.getAttribute("title")?.length).toBeLessThanOrEqual(301);
    for (const tag of ["script", "style", "img", "iframe", "a", "b", "link"]) {
      expect(document.created).not.toContain(tag);
    }
  });
});

describe("a store's diagnostics (AC-5)", () => {
  async function opened(report: Answer) {
    const page = await mount([
      json({ next: null, organizations: [summary({ id: "org/1 ?x" })] }),
      report,
    ]);
    await page.search("Loja");
    buttons(page.root, "Ver loja")[0]?.click();
    await flush();
    const section = allElements(page.root).find(
      (element) => element.getAttribute("aria-labelledby") === "loja-titulo"
    ) as FakeElement;
    const fact = (label: string) => {
      const term = byTag(section, "dt").find(
        (element) => element.textContent === label
      );
      return term?.parent?.children[1]?.textContent;
    };
    return { ...page, fact, section };
  }

  it("asks the diagnostics of the chosen store only, with its ID escaped in the path", async () => {
    const { calls } = await opened(json(diagnostics()));
    expect(calls.map((call) => call.path)).toEqual([
      "/api/whoami",
      "/api/organizations?limit=25&query=Loja",
      "/api/organizations/org%2F1%20%3Fx/diagnostics",
    ]);
  });

  it("shows plan, subscription, end of access and the last billing fact field by field", async () => {
    const { fact, section } = await opened(json(diagnostics()));
    expect(fact("Plano em vigor")).toBe("Pro");
    expect(fact("Assinatura")).toBe("Pro ativo");
    // 02:59:59 UTC is 23:59:59 of the day before in Brasília
    expect(fact("Fim do acesso")).toBe("14/11/2026");
    expect(fact("Ciclo")).toBe("Mensal");
    expect(fact("Forma de pagamento")).toBe("Cartão (Asaas)");
    expect(fact("Renovação")).toBe("Sem cancelamento pedido");
    expect(fact("Último fato de cobrança")).toBe("15/10/2026");
    expect(fact("Última sincronização")).toBe("27/10/2026");
    expect(visibleText(section)).toContain("Loja: Loja do Bruno org-pro-1");
    expect(visibleText(section)).toContain("Nenhum ponto de atenção.");
  });

  it.each([
    [null, "Free (sem registro de cobrança)"],
    ["free", "Free"],
    ["trial_setup", "Free, com o teste do Pro em preparação"],
    ["trialing", "Pro em teste"],
    ["active", "Pro ativo"],
    ["grace", "Pro em carência"],
    ["free_over_limit", "Free acima do limite"],
    ["paused", "estado desconhecido: paused"],
  ] as const)(
    "names the subscription state %s as %s, never an unknown one as Free",
    async (state, text) => {
      const { fact } = await opened(
        json(
          diagnostics({
            billing: state === null ? null : { state },
            entitlements: { plan: "free", state: "free" },
          })
        )
      );
      expect(fact("Assinatura")).toBe(text);
    }
  );

  it("says in words when a quota is at or over the limit, and lists the grants and the attention points", async () => {
    const { section } = await opened(
      json(
        diagnostics({
          attention: [{ code: "over_free_limit" }, { code: "novo" as never }],
          entitlements: { raisedByGrant: ["variants.active.max"] },
          grants: [
            {
              expiresAt: "2026-12-01T03:00:00.000Z",
              flagValue: null,
              key: "variants.active.max",
              limitValue: 2000,
              revokedAt: null,
              startsAt: "2026-10-01T03:00:00.000Z",
            },
          ],
          quotas: [
            { key: "variants.active.max", limit: 30, status: "over", used: 31 },
            { key: "goals.active.max", limit: 1, status: "at_limit", used: 1 },
          ],
        })
      )
    );
    const quotaRows = byTag(byTag(section, "tbody")[0] as FakeElement, "tr");
    expect(
      quotaRows.map((row) => row.children.map((cell) => cell.textContent))
    ).toEqual([
      ["Variantes ativas", "31", "30", "Acima do limite"],
      ["Metas ativas", "1", "1", "No limite"],
    ]);
    const text = visibleText(section);
    expect(text).toContain("Variantes ativas20000");
    expect(text).toContain(
      "Acima do plano por concessão agora: Variantes ativas."
    );
    expect(text).toContain("A loja passou dos limites do Free.");
    expect(text).toContain("Ponto de atenção desconhecido: novo");
  });

  it.each([
    [
      json({ error: "plan_catalog_incomplete" }, 503),
      "plan_catalog_incomplete",
    ],
    [json({ error: "not_found" }, 404), "not_found"],
    [json({ error: "forbidden" }, 403), "forbidden"],
    [json({ error: "unauthenticated" }, 401), "session"],
    [accessRedirect(), "session"],
    [new TypeError("Failed to fetch"), "network"],
    [json({ error: "internal_error" }, 500), "failed"],
    [new Response("<html>proxy</html>", { status: 200 }), "failed"],
  ] as const)(
    "shows its own sentence and no code for each failure (%#)",
    async (answer, problem) => {
      const { document, root } = await opened(answer);
      const alert = alertOf(root);
      expect(alert?.textContent).toBe(PROBLEM_TEXT[problem]);
      expect(document.activeElement).toBe(alert);
      expect(visibleText(root)).not.toMatch(
        TECHNICAL_TEXT
      );
    }
  );

  it("shows the store chosen last when an earlier answer arrives late", async () => {
    let late: (response: Response) => void = () => undefined;
    const page = await mount([
      json({
        next: null,
        organizations: [
          summary({ id: "org-1", name: "Primeira" }),
          summary({ id: "org-2", name: "Segunda" }),
        ],
      }),
      () =>
        new Promise<Response>((resolve) => {
          late = resolve;
        }),
      json(diagnostics({ name: "Segunda" })),
    ]);
    await page.search("");
    const [first, second] = buttons(page.root, "Ver loja");
    first?.click();
    second?.click();
    await flush();
    late(json(diagnostics({ name: "Primeira" })));
    await flush();
    expect(visibleText(page.root)).toContain("Loja: Segunda");
    expect(visibleText(page.root)).not.toContain("Loja: Primeira");
  });
});
