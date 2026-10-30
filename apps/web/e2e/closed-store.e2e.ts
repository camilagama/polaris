/// <reference lib="dom" />
import type { Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { serveHealth, WORKER_MARK } from "./worker-mark";

const STORE_ID = "0199c2d0-0000-7000-8000-00000000a001";
const OTHER_ID = "0199c2d0-0000-7000-8000-00000000a002";
const EXPORT_ID = "0199c2d0-0000-7000-8000-0000000000aa";
const SESSION_USER = { email: "dona@exemplo.test", id: "u", name: "Ana Dona" };
const PATH = `/loja-encerrada?loja=${STORE_ID}`;
const NOW = new Date("2026-10-30T12:00:00-03:00");
const TECHNICAL =
  /closing|deletion_scheduled|deletable|purged|not_handled|fresh_session|closed_export|_required|_unavailable/;
const SIGN_IN = /\/entrar\?motivo=sessao&voltar=\/loja-encerrada/;

type Store = Record<string, unknown>;

const store = (overrides: Store = {}): Store => ({
  canRecover: true,
  deletableFrom: "2027-01-18T03:00:00.000Z",
  deletionDate: "2027-01-18",
  exportOpenUntil: "2027-01-18T03:00:00.000Z",
  id: STORE_ID,
  milestones: {
    closure: "2026-10-20T12:00:00.000Z",
    d7: "2027-01-11T03:00:00.000Z",
    d30: "2026-12-19T03:00:00.000Z",
    deletionDay: "2027-01-18T03:00:00.000Z",
  },
  name: "Loja do teste",
  phase: "closing",
  recoverUntil: "2026-11-19T12:00:00.000Z",
  renewal: "not_handled",
  requestedAt: "2026-10-20T12:00:00.000Z",
  timezone: "America/Sao_Paulo",
  ...overrides,
});

const copy = (overrides: Store = {}): Store => ({
  errorCode: null,
  expiresAt: null,
  files: [],
  formats: ["json", "csv"],
  id: EXPORT_ID,
  mode: "closed",
  readyAt: null,
  requestedAt: "2026-10-30T14:10:00.000Z",
  status: "requested",
  totalBytes: null,
  ...overrides,
});
const READY = copy({
  expiresAt: "2026-10-31T14:40:00.000Z",
  files: [{ name: "dados.json", ordinal: 1, sizeBytes: 820_400 }],
  readyAt: "2026-10-30T14:40:00.000Z",
  status: "ready",
  totalBytes: 820_400,
});

const rpc = (json: unknown, status = 200) => ({
  body: JSON.stringify({ json, meta: [] }),
  contentType: "application/json",
  headers: { ...WORKER_MARK },
  status,
});
const refusal = (code: string, status: number, reason?: string) =>
  rpc(
    {
      code,
      data: reason === undefined ? undefined : { reason },
      defined: false,
      message: code,
      status,
    },
    status
  );

type Answer = (route: Route) => Promise<void>;

interface PanelOptions {
  listed?: Store[];
  lists?: readonly Store[][];
  path?: string;
  recover?: Answer;
  request?: Answer;
  statuses?: readonly (Store | null | Answer)[];
}

interface Calls {
  downloads: string[];
  lists: number;
  recovers: Record<string, unknown>[];
  requests: Record<string, unknown>[];
  statuses: number;
}

async function openPanel(
  page: Page,
  {
    lists = [[]],
    listed = [],
    path = PATH,
    recover = (route) => route.fulfill(rpc({ recovered: true })),
    request = (route) => route.fulfill(rpc({ id: EXPORT_ID })),
    statuses = [store()],
  }: PanelOptions = {}
): Promise<Calls> {
  const calls: Calls = {
    downloads: [],
    lists: 0,
    recovers: [],
    requests: [],
    statuses: 0,
  };
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill({
      body: JSON.stringify({ session: { id: "s" }, user: SESSION_USER }),
      contentType: "application/json",
      headers: { ...WORKER_MARK },
    })
  );
  await serveHealth(page);
  await page.route("**/api/closed-exports/**", (route) => {
    calls.downloads.push(new URL(route.request().url()).pathname);
    return route.fulfill({
      body: "{}",
      headers: {
        ...WORKER_MARK,
        "Cache-Control": "private, no-store",
        "Content-Disposition": 'attachment; filename="dados.json"',
        "Content-Type": "application/zip",
      },
    });
  });
  await page.route("**/rpc/**", (route) => {
    const procedure = new URL(route.request().url()).pathname.replace(
      "/rpc/",
      ""
    );
    if (procedure === "organization/closedStatus") {
      const answer = statuses[Math.min(calls.statuses, statuses.length - 1)];
      calls.statuses += 1;
      if (typeof answer === "function") {
        return answer(route);
      }
      return route.fulfill(rpc({ organization: answer ?? null }));
    }
    if (procedure === "organization/listClosed") {
      return route.fulfill(rpc({ organizations: listed }));
    }
    if (procedure === "dataExport/listClosed") {
      const answer = lists[Math.min(calls.lists, lists.length - 1)];
      calls.lists += 1;
      return route.fulfill(rpc({ exports: answer ?? [] }));
    }
    if (procedure === "organization/recoverClosure") {
      calls.recovers.push(
        (route.request().postDataJSON() as { json: Record<string, unknown> })
          .json
      );
      return recover(route);
    }
    if (procedure === "dataExport/requestClosed") {
      calls.requests.push(
        (route.request().postDataJSON() as { json: Record<string, unknown> })
          .json
      );
      return request(route);
    }
    return route.abort("internetdisconnected");
  });
  await page.goto(path);
  return calls;
}

const title = (page: Page, name = "Loja do teste está encerrada") =>
  page.getByRole("heading", { exact: true, level: 1, name });
const dates = (page: Page) => page.locator("dl");
const undoButton = (page: Page) =>
  page.getByRole("button", { exact: true, name: "Desfazer encerramento" });
const askButton = (page: Page) =>
  page.getByRole("button", { name: "Pedir cópia dos dados" });
const copies = (page: Page) =>
  page.getByRole("region", { name: "Suas cópias" });

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(NOW);
});

test.describe("cada fase com a sua frase, as três datas e a renovação (AC-5, AC-6, AC-18)", () => {
  test("encerrando: até quando dá para desfazer, com os dias, e o botão de desfazer", async ({
    page,
  }) => {
    await openPanel(page);
    await expect(title(page)).toBeVisible();
    await expect(page.getByRole("main")).toContainText(
      "Você encerrou esta loja em 20 de outubro de 2026. Até 19 de novembro de 2026, às 09:00 (faltam 20 dias) você pode desfazer o encerramento. Depois disso não dá mais."
    );
    await expect(dates(page)).toContainText("Encerrada em");
    await expect(dates(page)).toContainText("20 de outubro de 2026");
    await expect(dates(page)).toContainText("Desfazer até");
    await expect(dates(page)).toContainText(
      "19 de novembro de 2026, às 09:00 · faltam 20 dias"
    );
    await expect(dates(page)).toContainText(
      "Dados podem ser apagados a partir de"
    );
    await expect(dates(page)).toContainText(
      "18 de janeiro de 2027 · faltam 80 dias"
    );
    await expect(dates(page)).toContainText(
      "Cancele a renovação no provedor de pagamento."
    );
    await expect(dates(page).locator("dt")).toHaveCount(4);
    await expect(undoButton(page)).toBeVisible();
    await expect(
      page.getByRole("link", { exact: true, name: "Baixar meus dados" })
    ).toHaveAttribute("href", "#copia-dos-dados");
    await expect(page.getByRole("main")).not.toContainText(TECHNICAL);
  });

  test("encerrada: não dá mais para desfazer, e não há botão", async ({
    page,
  }) => {
    await openPanel(page, {
      statuses: [
        store({ canRecover: false, phase: "closed", renewal: "pending" }),
      ],
    });
    await expect(page.getByRole("main")).toContainText(
      "O prazo para desfazer acabou. Não dá mais para reabrir esta loja."
    );
    await expect(dates(page)).toContainText(
      "A renovação do plano está sendo cancelada."
    );
    await expect(undoButton(page)).toHaveCount(0);
  });

  test("apagamento marcado: os dados serão apagados em breve, a cópia ainda pode ser pedida", async ({
    page,
  }) => {
    await page.clock.setFixedTime(new Date("2027-01-12T12:00:00-03:00"));
    await openPanel(page, {
      statuses: [
        store({
          canRecover: false,
          phase: "deletion_scheduled",
          renewal: "cancelled",
        }),
      ],
    });
    await expect(page.getByRole("main")).toContainText(
      "Os dados desta loja estão marcados para serem apagados em breve. Baixe agora o que precisar."
    );
    await expect(dates(page)).toContainText(
      "18 de janeiro de 2027 · faltam 6 dias"
    );
    await expect(dates(page)).toContainText(
      "A renovação do plano foi cancelada."
    );
    await expect(askButton(page)).toBeVisible();
  });

  test("depois de D: a frase dos e-mails, e nenhum pedido de cópia (AC-7)", async ({
    page,
  }) => {
    await page.clock.setFixedTime(new Date("2027-01-18T12:00:00-03:00"));
    const calls = await openPanel(page, {
      lists: [[READY]],
      statuses: [
        store({ canRecover: false, phase: "deletable", renewal: null }),
      ],
    });
    await expect(page.getByRole("main")).toContainText(
      "O prazo para pedir uma cópia dos dados terminou em 18 de janeiro de 2027, 00:00 (horário da sua loja). Depois de apagados, os dados não podem ser recuperados."
    );
    await expect(dates(page)).toContainText(
      "Não conseguimos confirmar agora a situação da renovação do plano."
    );
    await expect(dates(page)).toContainText(
      "18 de janeiro de 2027 · já podem ser apagados"
    );
    await expect(askButton(page)).toHaveCount(0);
    await expect(copies(page)).toBeVisible();
    expect(calls.requests).toHaveLength(0);
  });

  test("apagada: sem cópia e sem desfazer", async ({ page }) => {
    const calls = await openPanel(page, {
      statuses: [store({ canRecover: false, phase: "purged" })],
    });
    await expect(page.getByRole("main")).toContainText(
      "Os dados desta loja foram apagados. Não é possível recuperar nem baixar."
    );
    await expect(copies(page)).toHaveCount(0);
    await expect(askButton(page)).toHaveCount(0);
    await expect(undoButton(page)).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "Baixar meus dados" })
    ).toHaveCount(0);
    expect(calls.lists).toBe(0);
  });

  test("nada encontrado: a frase própria e a volta ao início", async ({
    page,
  }) => {
    await openPanel(page, { statuses: [null] });
    await expect(title(page, "Loja encerrada")).toBeVisible();
    await expect(page.getByRole("main")).toContainText(
      "Não encontramos uma loja encerrada nesta conta."
    );
    await expect(
      page.getByRole("link", { name: "Voltar ao início" })
    ).toHaveAttribute("href", "/");
  });
});

test("carregando, sem botão de ação; a leitura que falha dá Tentar novamente sem afirmar o estado (AC-6)", async ({
  page,
}) => {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls = await openPanel(page, {
    statuses: [
      async (route) => {
        await held;
        await route.abort("internetdisconnected");
      },
      store(),
    ],
  });
  const loading = page.getByRole("status").filter({ hasText: "Carregando…" });
  await expect(loading).toHaveAttribute("aria-busy", "true");
  await expect(
    page.getByRole("main").getByRole("button", { name: "Sair" })
  ).toBeVisible();
  await expect(undoButton(page)).toHaveCount(0);
  release();
  await expect(page.getByRole("alert")).toHaveText(
    "Não foi possível carregar os dados da loja. Verifique a conexão e tente de novo."
  );
  await expect(page.getByRole("main")).not.toContainText("está encerrada");
  await page.getByRole("button", { name: "Tentar novamente" }).click();
  await expect(title(page)).toBeVisible();
  expect(calls.statuses).toBe(2);
});

test("sem loja no endereço, lista as encerradas do dono e abre a única ou deixa escolher (e-mail)", async ({
  page,
}) => {
  await openPanel(page, {
    listed: [store(), store({ id: OTHER_ID, name: "Segunda loja" })],
    path: "/loja-encerrada",
  });
  await expect(title(page, "Loja encerrada")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Segunda loja está encerrada" })
  ).toHaveAttribute("href", `/loja-encerrada?loja=${OTHER_ID}`);
  await expect(
    page.getByRole("link", { name: "Loja do teste está encerrada" })
  ).toBeVisible();
});

test("sem sessão, vai à entrada e volta ao painel", async ({ page }) => {
  await openPanel(page, {
    statuses: [(route) => route.fulfill(refusal("UNAUTHORIZED", 401))],
  });
  await expect(page).toHaveURL(SIGN_IN);
});

test("a cópia da encerrada: pede uma vez, atualiza e baixa pela rota da encerrada (AC-7)", async ({
  page,
}) => {
  const calls = await openPanel(page, { lists: [[], [READY]] });
  await expect(copies(page)).toContainText("Nenhuma cópia pedida ainda.");
  await askButton(page).dblclick();
  await expect(
    page.getByRole("status").filter({
      hasText:
        "Cópia pedida. Preparando: pode levar até uma hora. Você pode sair e voltar.",
    })
  ).toBeVisible();
  expect(calls.requests).toEqual([
    { formats: ["json", "csv"], organizationId: STORE_ID },
  ]);
  await copies(page).getByRole("button", { name: "Atualizar" }).click();
  const link = copies(page).getByRole("link", {
    name: "Baixar dados.json (820 KB)",
  });
  await expect(link).toHaveAttribute(
    "href",
    `/api/closed-exports/${EXPORT_ID}/files/1`
  );
  const download = page.waitForEvent("download");
  await link.click();
  await download;
  expect(calls.downloads).toEqual([`/api/closed-exports/${EXPORT_ID}/files/1`]);
});

test("o pedido com entrada de mais de 15 minutos tem texto próprio, e o pedido depois de D diz o prazo", async ({
  page,
}) => {
  let answer: Answer = (route) =>
    route.fulfill(refusal("FORBIDDEN", 403, "fresh_session_required"));
  await openPanel(page, { request: (route) => answer(route) });
  await askButton(page).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Por segurança, para pedir a cópia é preciso ter entrado no Polaris há menos de 15 minutos. Saia, entre de novo e peça a cópia."
  );
  answer = (route) =>
    route.fulfill(refusal("CONFLICT", 409, "closed_export_unavailable"));
  await askButton(page).click();
  await expect(page.getByRole("alert")).toHaveText(
    "O prazo para pedir uma cópia dos dados terminou em 18 de janeiro de 2027, 00:00 (horário da sua loja). Depois de apagados, os dados não podem ser recuperados."
  );
  await expect(askButton(page)).toBeDisabled();
  await expect(page.getByRole("main")).not.toContainText(TECHNICAL);
});

test("logo depois de encerrar, a frase do momento aparece uma vez e sai do endereço", async ({
  page,
}) => {
  await openPanel(page, { path: `${PATH}&encerrou=1` });
  await expect(page.getByRole("status").first()).toContainText(
    "Loja encerrada. Você pode desfazer até 19 de novembro de 2026, às 09:00. Seus dados ficam guardados e você pode baixá-los."
  );
  await expect(page).toHaveURL(`${PATH}`);
  await page.reload();
  await expect(title(page)).toBeVisible();
  await expect(page.getByRole("main")).not.toContainText(
    "Loja encerrada. Você pode"
  );
});

test("o botão de desfazer some quando a janela acaba, sem nova leitura (AC-8, AC-14)", async ({
  page,
}) => {
  await page.clock.install({ time: new Date("2026-11-19T08:59:00-03:00") });
  const calls = await openPanel(page);
  await expect(undoButton(page)).toBeVisible();
  await page.clock.runFor(2 * 60_000);
  await expect(undoButton(page)).toHaveCount(0);
  expect(calls.statuses).toBe(1);
});

const undoDialog = (page: Page) =>
  page.getByRole("dialog", { name: "Desfazer o encerramento?" });
const confirmUndo = (page: Page) =>
  undoDialog(page).getByRole("button", { name: "Sim, desfazer" });
const REOPENED = /reaberta/i;

test.describe("desfazer o encerramento em duas etapas (AC-8, AC-9, AC-10)", () => {
  test("o botão abre a confirmação com os efeitos, e Voltar fecha sem chamar o servidor", async ({
    page,
  }) => {
    const calls = await openPanel(page);
    await undoButton(page).click();
    await expect(undoDialog(page)).toBeVisible();
    await expect(undoDialog(page)).toContainText(
      "A loja volta a funcionar agora. Os aparelhos vão pedir de novo a permissão para usar sem internet quando abrirem com conexão. O que estava guardado neles e não foi enviado continua esperando."
    );
    await expect(confirmUndo(page)).toBeVisible();
    await undoDialog(page).getByRole("button", { name: "Voltar" }).click();
    await expect(undoDialog(page)).toHaveCount(0);
    await undoButton(page).click();
    await page.keyboard.press("Escape");
    await expect(undoDialog(page)).toHaveCount(0);
    expect(calls.recovers).toEqual([]);
    expect(calls.statuses).toBe(1);
  });

  test("Sim, desfazer: um pedido no duplo clique, 'Desfazendo…' enquanto vai, e o Início da loja reaberta", async ({
    page,
  }) => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls = await openPanel(page, {
      recover: async (route) => {
        await held;
        await route.fulfill(rpc({ recovered: true }));
      },
    });
    await page.evaluate(
      ([key, id]) =>
        window.localStorage.setItem(
          key,
          JSON.stringify([{ id, name: "Loja do teste" }])
        ),
      ["polaris.closedStores", STORE_ID] as const
    );
    await undoButton(page).click();
    await confirmUndo(page).dblclick();
    const sending = undoDialog(page).getByRole("button", {
      name: "Desfazendo…",
    });
    await expect(sending).toHaveAttribute("aria-disabled", "true");
    await expect(
      undoDialog(page).getByRole("button", { name: "Voltar" })
    ).toHaveAttribute("aria-disabled", "true");
    await sending.click({ force: true });
    release();
    await page.waitForURL((url) => url.pathname === "/");
    expect(new URL(page.url()).search).toBe("?reaberta=1");
    expect(calls.recovers).toEqual([{ organizationId: STORE_ID }]);
    expect(
      await page.evaluate(() => ({
        closed: window.localStorage.getItem("polaris.closedStores"),
        preferred: window.localStorage.getItem(
          "polaris.preferredOrganizationId"
        ),
      }))
    ).toEqual({ closed: null, preferred: STORE_ID });
  });

  test("recusa por prazo: a releitura confirma a encerrada, e o painel diz que não foi desfeito, sem o botão", async ({
    page,
  }) => {
    const calls = await openPanel(page, {
      recover: (route) =>
        route.fulfill(refusal("CONFLICT", 409, "closure_not_recoverable")),
      statuses: [store(), store({ canRecover: false, phase: "closed" })],
    });
    await undoButton(page).click();
    await confirmUndo(page).click();
    await expect(page.getByRole("alert")).toHaveText(
      "O prazo para desfazer acabou. O encerramento não foi desfeito."
    );
    await expect(page.getByRole("alert")).toBeFocused();
    await expect(undoDialog(page)).toHaveCount(0);
    await expect(page.getByRole("main")).toContainText(
      "O prazo para desfazer acabou. Não dá mais para reabrir esta loja."
    );
    await expect(undoButton(page)).toHaveCount(0);
    await expect(dates(page)).toContainText(
      "19 de novembro de 2026, às 09:00 · prazo encerrado"
    );
    await expect(page.getByRole("main")).not.toContainText(REOPENED);
    await expect(page.getByRole("main")).not.toContainText(TECHNICAL);
    expect(calls.recovers).toHaveLength(1);
    expect(calls.statuses).toBe(2);
  });

  test("recusa com a loja já reaberta em outro aparelho: a releitura não lista a loja, e o painel leva ao Início", async ({
    page,
  }) => {
    const calls = await openPanel(page, {
      recover: (route) =>
        route.fulfill(refusal("CONFLICT", 409, "closure_not_recoverable")),
      statuses: [store(), null],
    });
    await undoButton(page).click();
    await confirmUndo(page).click();
    await page.waitForURL((url) => url.pathname === "/");
    expect(new URL(page.url()).search).toBe("?reaberta=1");
    expect(calls.recovers).toHaveLength(1);
    expect(calls.statuses).toBe(2);
    expect(
      await page.evaluate(() =>
        window.localStorage.getItem("polaris.preferredOrganizationId")
      )
    ).toBe(STORE_ID);
  });

  test("recusa com a releitura falha: o texto neutro, o botão fica, e nada se repete sozinho", async ({
    page,
  }) => {
    const calls = await openPanel(page, {
      recover: (route) =>
        route.fulfill(refusal("CONFLICT", 409, "closure_not_recoverable")),
      statuses: [store(), (route) => route.abort("internetdisconnected")],
    });
    await undoButton(page).click();
    await confirmUndo(page).click();
    await expect(page.getByRole("alert")).toHaveText(
      "O prazo acabou ou a loja já foi reaberta. Toque em Atualizar para ver a situação da loja."
    );
    await expect(undoDialog(page)).toHaveCount(0);
    await expect(undoButton(page)).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/loja-encerrada");
    expect(calls.recovers).toHaveLength(1);
    expect(calls.statuses).toBe(2);
  });

  test("o segundo toque depois de uma resposta perdida: a recusa de uma loja já reaberta leva ao Início, não diz que o prazo acabou", async ({
    page,
  }) => {
    let recovers = 0;
    const calls = await openPanel(page, {
      recover: (route) => {
        recovers += 1;
        return recovers === 1
          ? route.abort("internetdisconnected")
          : route.fulfill(refusal("CONFLICT", 409, "closure_not_recoverable"));
      },
      statuses: [store(), null],
    });
    await undoButton(page).click();
    await confirmUndo(page).click();
    await expect(page.getByRole("alert")).toHaveText(
      "Não deu para confirmar se o encerramento foi desfeito. Toque em Atualizar para conferir."
    );
    await undoButton(page).click();
    await confirmUndo(page).click();
    await page.waitForURL((url) => url.pathname === "/");
    expect(new URL(page.url()).search).toBe("?reaberta=1");
    expect(calls.recovers).toHaveLength(2);
    expect(calls.statuses).toBe(2);
  });

  test("recusa por outra loja ativa (L6): o texto próprio, e nada de reaberta", async ({
    page,
  }) => {
    await openPanel(page, {
      recover: (route) =>
        route.fulfill(refusal("CONFLICT", 409, "another_organization_active")),
    });
    await undoButton(page).click();
    await confirmUndo(page).click();
    await expect(page.getByRole("alert")).toHaveText(
      "Não dá para reabrir: você já tem uma loja ativa. Só uma loja ativa por conta."
    );
    await expect(page.getByRole("main")).not.toContainText(REOPENED);
    await expect(page.getByRole("main")).not.toContainText(TECHNICAL);
  });

  test("recusa por entrada de mais de 15 minutos: o texto próprio, sem releitura nem segunda chamada", async ({
    page,
  }) => {
    const calls = await openPanel(page, {
      recover: (route) =>
        route.fulfill(refusal("FORBIDDEN", 403, "fresh_session_required")),
    });
    await undoButton(page).click();
    await confirmUndo(page).click();
    await expect(page.getByRole("alert")).toHaveText(
      "Por segurança, para desfazer o encerramento é preciso ter entrado há menos de 15 minutos. Saia, entre de novo e desfaça o encerramento. Nada foi alterado."
    );
    await expect(page.getByRole("main")).not.toContainText(REOPENED);
    await expect(page.getByRole("main")).not.toContainText(TECHNICAL);
    await page.waitForTimeout(1500);
    expect(calls.recovers).toHaveLength(1);
    expect(calls.statuses).toBe(1);
  });

  for (const [label, answer] of [
    ["falha de rede", (route: Route) => route.abort("internetdisconnected")],
    [
      "503",
      (route: Route) =>
        route.fulfill(refusal("SERVICE_UNAVAILABLE", 503, "server_busy")),
    ],
  ] as const) {
    test(`${label}: não afirma que reabriu nem que não desfez, e Atualizar confere`, async ({
      page,
    }) => {
      const calls = await openPanel(page, {
        recover: answer,
        statuses: [store(), store({ canRecover: false, phase: "closed" })],
      });
      await undoButton(page).click();
      await confirmUndo(page).click();
      await expect(page.getByRole("alert")).toHaveText(
        "Não deu para confirmar se o encerramento foi desfeito. Toque em Atualizar para conferir."
      );
      await expect(page.getByRole("main")).not.toContainText(REOPENED);
      expect(new URL(page.url()).pathname).toBe("/loja-encerrada");
      await page
        .getByRole("button", { exact: true, name: "Atualizar" })
        .first()
        .click();
      await expect(page.getByRole("alert")).toHaveCount(0);
      await expect(page.getByRole("main")).toContainText(
        "O prazo para desfazer acabou. Não dá mais para reabrir esta loja."
      );
      expect(calls.recovers).toHaveLength(1);
      expect(calls.statuses).toBe(2);
    });
  }

  test("a janela acaba com a confirmação aberta: ela fecha sozinha, sem chamada (AC-14)", async ({
    page,
  }) => {
    await page.clock.install({ time: new Date("2026-11-19T08:59:00-03:00") });
    const calls = await openPanel(page);
    await undoButton(page).click();
    await expect(undoDialog(page)).toBeVisible();
    await page.clock.runFor(2 * 60_000);
    await expect(undoDialog(page)).toHaveCount(0);
    await expect(undoButton(page)).toHaveCount(0);
    expect(calls.recovers).toEqual([]);
    expect(calls.statuses).toBe(1);
  });

  test("o pé do painel leva a abrir outra loja", async ({ page }) => {
    await openPanel(page);
    await expect(
      page.getByRole("link", { exact: true, name: "Abrir outra loja" })
    ).toHaveAttribute("href", "/?nova-loja=1");
  });
});
