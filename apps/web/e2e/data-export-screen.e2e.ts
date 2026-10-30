/// <reference lib="dom" />
import type { Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { serveHealth, WORKER_MARK } from "./worker-mark";

/**
 * Seus dados in Configurações (corte exportar-meus-dados-na-configuracao) in the real route, with the API answered by
 * the test: the owner asks for a copy (one call for a double click), reads the list again with Atualizar and downloads
 * the file from the route; each state of a copy and each refusal with its own text; the 503 not sent again; one read in
 * five minutes with the tab open; nothing leaves offline; and whoever is not the owner sees the text without the tab.
 */
const ORGANIZATION = {
  id: "0199c2d0-0000-7000-8000-00000000a001",
  name: "Loja do teste",
  role: "owner",
  timezone: "America/Sao_Paulo",
};
const SESSION_USER = {
  email: "dona@exemplo.test",
  id: "u",
  name: "Ana Dona",
};
const EXPORT_ID = "0199c2d0-0000-7000-8000-0000000000aa";
const PATH = "/configuracoes?aba=seus-dados";
/** 30/10/2026 12:00 in São Paulo. */
const NOW = new Date("2026-10-30T15:00:00.000Z");
const TECHNICAL = /export_|_error|server_busy|requested|running/;

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

type Export = Record<string, unknown>;

const copy = (overrides: Export = {}): Export => ({
  errorCode: null,
  expiresAt: null,
  files: [],
  formats: ["json", "csv"],
  id: EXPORT_ID,
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

type Answer = Export[] | ((route: Route) => Promise<void>);

interface ScreenOptions {
  /** What `dataExport/list` answers, in order; the last one repeats. */
  lists?: readonly Answer[];
  path?: string;
  /** What `dataExport/request` answers, in order; the last one repeats. */
  requests?: readonly ((route: Route) => Promise<void>)[];
  role?: string;
}

interface Calls {
  downloads: string[];
  reads: number;
  requests: Record<string, unknown>[];
}

async function openScreen(
  page: Page,
  {
    lists = [[]],
    path = PATH,
    requests = [(route) => route.fulfill(rpc({ id: EXPORT_ID }))],
    role = "owner",
  }: ScreenOptions = {}
): Promise<Calls> {
  const calls: Calls = { downloads: [], reads: 0, requests: [] };
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill({
      body: JSON.stringify({ session: { id: "s" }, user: SESSION_USER }),
      contentType: "application/json",
      headers: { ...WORKER_MARK },
    })
  );
  await serveHealth(page);
  await page.route("**/api/data-exports/**", (route) => {
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
    if (procedure === "organization/listMine") {
      return route.fulfill(
        rpc({
          billingSelfService: false,
          organizations: [{ ...ORGANIZATION, role }],
        })
      );
    }
    if (procedure === "dataExport/list") {
      const answer = lists[Math.min(calls.reads, lists.length - 1)];
      calls.reads += 1;
      if (typeof answer === "function") {
        return answer(route);
      }
      return route.fulfill(rpc({ exports: answer ?? [] }));
    }
    if (procedure === "dataExport/request") {
      const { json } = route.request().postDataJSON() as {
        json: Record<string, unknown>;
      };
      calls.requests.push(json);
      const answer =
        requests[Math.min(calls.requests.length - 1, requests.length - 1)];
      return answer ? answer(route) : route.abort("internetdisconnected");
    }
    return route.abort("internetdisconnected");
  });
  await page.goto(path);
  return calls;
}

const title = (page: Page) =>
  page.getByRole("heading", { exact: true, level: 2, name: "Seus dados" });
const askButton = (page: Page) =>
  page.getByRole("button", { name: "Pedir cópia dos dados" });
const format = (page: Page, name: string) =>
  page.getByRole("checkbox", { exact: true, name });
const list = (page: Page) => page.getByRole("region", { name: "Suas cópias" });

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(NOW);
});

test("o dono pede uma cópia (um pedido para dois cliques), atualiza e baixa pela rota (AC-2, AC-4)", async ({
  page,
}) => {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls = await openScreen(page, {
    lists: [[], [READY]],
    requests: [
      async (route) => {
        await held;
        await route.fulfill(rpc({ id: EXPORT_ID }));
      },
    ],
  });
  await expect(title(page)).toBeVisible();
  const tabs = page.getByRole("tablist", { name: "Configurações" });
  await expect(tabs.getByRole("tab").last()).toHaveText("Seus dados");
  await expect(
    tabs.getByRole("tab", { exact: true, name: "Seus dados" })
  ).toHaveAttribute("aria-selected", "true");
  await expect(list(page)).toContainText("Nenhuma cópia pedida ainda.");
  await expect(format(page, "Dados em JSON")).toBeChecked();
  await expect(format(page, "Dados em planilha (CSV)")).toBeChecked();
  await expect(format(page, "Imagens dos produtos")).not.toBeChecked();

  await askButton(page).dblclick();
  await expect(askButton(page)).toBeDisabled();
  release();
  await expect(
    page.getByRole("status").filter({ hasText: "Pedido feito." })
  ).toBeVisible();
  expect(calls.requests).toEqual([
    { formats: ["json", "csv"], organizationId: ORGANIZATION.id },
  ]);
  // shown as the server accepted it, without reading the list again
  await expect(list(page)).toContainText(
    "Preparando sua cópia. Pode levar até uma hora. Você pode sair e voltar."
  );
  expect(calls.reads).toBe(1);
  // one copy in flight: asking again is off and says why
  await expect(askButton(page)).toHaveAttribute("aria-disabled", "true");
  await expect(
    page.getByText("Já há uma cópia sendo preparada. Espere ela ficar pronta.")
  ).toBeVisible();

  await list(page).getByRole("button", { name: "Atualizar" }).click();
  await expect(list(page)).toContainText(
    "Sua cópia está pronta. Baixe até 31/10/2026 11:40."
  );
  expect(calls.reads).toBe(2);
  const link = list(page).getByRole("link", {
    name: "Baixar dados.json (820 KB)",
  });
  await expect(link).toHaveAttribute(
    "href",
    `/api/data-exports/${EXPORT_ID}/files/1?organizationId=${ORGANIZATION.id}`
  );
  const download = page.waitForEvent("download");
  await link.click();
  expect((await download).suggestedFilename()).toBe("dados.json");
  expect(calls.downloads).toEqual([`/api/data-exports/${EXPORT_ID}/files/1`]);
});

test("sem formato marcado o botão não envia e o campo diz o que falta (AC-2)", async ({
  page,
}) => {
  const calls = await openScreen(page);
  await format(page, "Dados em JSON").click();
  await format(page, "Dados em planilha (CSV)").click();
  await askButton(page).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Marque pelo menos um formato."
  );
  expect(calls.requests).toEqual([]);
  // with images only, the request carries images only
  await format(page, "Imagens dos produtos").click();
  await expect(page.getByText("Marque pelo menos um formato.")).toHaveCount(0);
  await askButton(page).click();
  await expect
    .poll(() => calls.requests)
    .toEqual([{ formats: ["images"], organizationId: ORGANIZATION.id }]);
});

test("cada estado da cópia tem o seu texto, sem código técnico (AC-3)", async ({
  page,
}) => {
  await openScreen(page, {
    lists: [
      [
        copy({ id: "0199c2d0-0000-7000-8000-0000000000a1", status: "running" }),
        READY,
        copy({ id: "0199c2d0-0000-7000-8000-0000000000a2", status: "expired" }),
        copy({
          errorCode: "storage_failed",
          id: "0199c2d0-0000-7000-8000-0000000000a3",
          status: "failed",
        }),
        copy({
          errorCode: "export_too_large",
          formats: ["json", "images"],
          id: "0199c2d0-0000-7000-8000-0000000000a4",
          status: "failed",
        }),
      ],
    ],
  });
  const region = list(page);
  await expect(
    region.getByRole("listitem").filter({ hasText: "Pedida em" })
  ).toHaveCount(5);
  await expect(region).toContainText("Preparando sua cópia.");
  await expect(region).toContainText("Sua cópia está pronta.");
  await expect(region).toContainText("Esta cópia expirou. Peça outra.");
  await expect(region).toContainText(
    "Não foi possível preparar a cópia. Tente de novo."
  );
  await expect(region).toContainText(
    "Sua loja é grande demais para uma cópia com imagens. Peça só os dados (JSON ou planilha)."
  );
  await expect(region.getByRole("link")).toHaveCount(1);
  expect(await page.locator("main").innerText()).not.toMatch(TECHNICAL);
});

test("a 360 e a 320 px, nomes longos de arquivo não fazem a página rolar de lado (AC-9)", async ({
  page,
}) => {
  await openScreen(page, {
    lists: [
      [
        copy({
          ...READY,
          files: [
            {
              name: "polaris-imagens-2026-10-30-parte-1-de-3.zip",
              ordinal: 1,
              sizeBytes: 31_500_000,
            },
          ],
          formats: ["json", "csv", "images"],
        }),
      ],
    ],
  });
  for (const width of [360, 320]) {
    // biome-ignore lint/performance/noAwaitInLoops: one width after the other
    await page.setViewportSize({ height: 740, width });
    await expect(list(page)).toContainText("Sua cópia está pronta.");
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth
    );
    expect(overflow, `${width} px`).toBeLessThanOrEqual(0);
    const link = await list(page).getByRole("link").boundingBox();
    const card = await list(page).boundingBox();
    expect(
      (link?.x ?? 0) + (link?.width ?? 0),
      `${width} px`
    ).toBeLessThanOrEqual((card?.x ?? 0) + (card?.width ?? 0));
  }
});

test("as recusas do pedido: limite de 3, já em preparo e o 503 que não se repete sozinho", async ({
  page,
}) => {
  const calls = await openScreen(page, {
    requests: [
      (route) =>
        route.fulfill(refusal("CONFLICT", 409, "export_limit_reached")),
    ],
  });
  await askButton(page).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Você já pediu 3 cópias nas últimas 24 horas. Tente de novo mais tarde."
  );
  await expect(askButton(page)).toHaveAttribute("aria-disabled", "true");
  await askButton(page).click({ force: true });
  expect(calls.requests).toHaveLength(1);

  await page.unrouteAll({ behavior: "ignoreErrors" });
  const running = await openScreen(page, {
    requests: [
      (route) =>
        route.fulfill(refusal("CONFLICT", 409, "export_already_running")),
    ],
  });
  await askButton(page).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Já há uma cópia sendo preparada. Espere ela ficar pronta."
  );
  expect(running.requests).toHaveLength(1);

  await page.unrouteAll({ behavior: "ignoreErrors" });
  await page.clock.install({ time: NOW });
  const busy = await openScreen(page, {
    requests: [
      (route) =>
        route.fulfill(refusal("SERVICE_UNAVAILABLE", 503, "server_busy")),
    ],
  });
  await askButton(page).click();
  await expect(page.getByRole("alert")).toHaveText(
    "O pedido não foi confirmado. Pode ter sido feito: toque em Atualizar antes de repetir."
  );
  await page.clock.runFor(10 * 60_000);
  expect(busy.requests).toHaveLength(1);
  expect(busy.reads).toBe(1);
  // the person reads the list, and only then asks again
  await list(page).getByRole("button", { name: "Atualizar" }).click();
  await expect.poll(() => busy.reads).toBe(2);
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(busy.requests).toHaveLength(1);
});

test("com a aba aberta 5 minutos, a lista é lida uma vez: sem temporizador e sem leitura ao voltar o foco (AC-6)", async ({
  page,
}) => {
  await page.clock.install({ time: NOW });
  const calls = await openScreen(page, {
    lists: [[copy({ status: "running" })]],
  });
  await expect(list(page)).toContainText("Preparando sua cópia.");
  for (let minute = 0; minute < 5; minute += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: one minute after the other
    await page.clock.runFor(60_000);
    await page.evaluate(() => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("online"));
    });
  }
  expect(calls.reads).toBe(1);
});

test("sem conexão: um só aviso, nada sai e a volta não lê sozinha (AC-7)", async ({
  page,
}) => {
  const calls = await openScreen(page, { lists: [[READY]] });
  await expect(list(page)).toContainText("Sua cópia está pronta.");
  await page.context().setOffline(true);
  await expect(page.getByText("Sem internet.")).toHaveCount(1);
  await expect(page.getByRole("alert")).toHaveCount(0);
  // off with the notice's reason, still focusable; a forced click sends nothing
  await expect(askButton(page)).toHaveAttribute("aria-disabled", "true");
  await askButton(page).click({ force: true });
  const link = list(page).getByRole("link", {
    name: "Baixar dados.json (820 KB)",
  });
  await expect(link).toHaveAttribute("aria-disabled", "true");
  await link.click({ force: true });
  await expect(
    list(page).getByRole("button", { name: "Atualizar" })
  ).toHaveAttribute("aria-disabled", "true");
  expect(calls.requests).toEqual([]);
  expect(calls.downloads).toEqual([]);
  const { reads } = calls;
  await page.context().setOffline(false);
  await expect(page.getByText("Sem internet.")).toHaveCount(0);
  await expect(list(page)).toContainText("Sua cópia está pronta.");
  expect(calls.reads).toBe(reads);
  expect(calls.requests).toEqual([]);
});

test("quem não é dono não vê a aba; o endereço direto diz que só o dono pede a cópia (AC-1)", async ({
  page,
}) => {
  const calls = await openScreen(page, {
    path: "/configuracoes",
    role: "cashier",
  });
  const tabs = page.getByRole("tablist", { name: "Configurações" });
  await expect(
    tabs.getByRole("tab", { exact: true, name: "Catálogo público" })
  ).toBeVisible();
  await expect(
    tabs.getByRole("tab", { exact: true, name: "Seus dados" })
  ).toHaveCount(0);

  await page.goto(PATH);
  await expect(
    page.getByText("Só o dono da loja pode pedir e baixar a cópia dos dados.")
  ).toBeVisible();
  await expect(askButton(page)).toHaveCount(0);
  expect(calls.reads).toBe(0);
});
