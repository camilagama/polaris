/// <reference lib="dom" />
import type { Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { serveHealth, WORKER_MARK } from "./worker-mark";

/**
 * Formas de receber is a screen that works only with a connection: while the tab does not reach the Worker the shell
 * shows the strip "Sem internet.", the buttons that write are `aria-disabled` and point at the strip with
 * `aria-describedby`, and nothing is sent. The route is the real one, with the API answered by the test.
 */
const ORGANIZATION = {
  id: "0199c2d0-0000-7000-8000-00000000a001",
  name: "Loja do teste",
  role: "owner",
  timezone: "America/Sao_Paulo",
};
const rpc = (json: unknown, status = 200) => ({
  body: JSON.stringify({ json, meta: [] }),
  contentType: "application/json",
  headers: { ...WORKER_MARK },
  status,
});

const NOW = new Date(Date.UTC(2026, 10, 18, 15));
const DAY = 24 * 60 * 60 * 1000;
const CREATED = new Date(NOW.getTime() - 30 * DAY).toISOString();

const MACHINE = {
  archivedAt: null,
  createdAt: CREATED,
  id: "0199c2d0-0000-7000-8000-0000000000c1",
  name: "Maquininha da loja",
  organizationId: ORGANIZATION.id,
  rules: [
    {
      anticipationFee: { fixedAmount: null, mode: "unknown", percentage: null },
      expectedSettlementDays: 30,
      id: "rule-1",
      installmentPlan: "merchant",
      installments: 3,
      method: "credit_card",
      processingFee: {
        fixedAmount: null,
        mode: "percentage",
        percentage: "3.000000",
      },
    },
  ],
  status: "active",
  updatedAt: CREATED,
  version: 1,
};

const STRIP_TITLE = "Sem internet.";
const STRIP_TEXT = "Esta tela precisa de conexão.";
const STRIP_TEXT_ID = "connection-required-text";
const DIALOG_TEXT_ID = "connection-required-dialog-text";
const SENTINEL = "sentinel/settled";
const STRIP_TEXT_START = /^Esta tela precisa de conexão\./;
const ANY_VALUE = /./;
const NOT_LOADED = "Os perfis não carregaram.";

const title = (page: Page) =>
  page.getByRole("heading", {
    exact: true,
    name: "Formas de receber",
  });

interface Scene {
  /** While true the list read and the health probe fail, as a network that is gone. */
  cut: { value: boolean };
  /** The `/health` calls that started after `holdFirstRead.release()`: the ones before it are no proof of the probe of `workerAnswers`. */
  probesSinceRelease: () => number;
  /** With `startCut`, the first list read waits here: it fails only once the test says the page is offline. */
  holdFirstRead: { release: () => void };
  listReads: () => number;
  /** Every call of `paymentProfile/*` other than `list` that reached the network layer. */
  writes: string[];
}

async function openScreen(
  page: Page,
  { startCut = false }: { startCut?: boolean } = {}
): Promise<Scene> {
  const cut = { value: startCut };
  const writes: string[] = [];
  let reads = 0;
  let probes = 0;
  let probesAtRelease = 0;
  let release: () => void = () => undefined;
  const firstReadHeld = startCut
    ? new Promise<void>((resolve) => {
        release = () => {
          probesAtRelease = probes;
          resolve();
        };
      })
    : Promise.resolve();
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill({
      body: JSON.stringify({ session: { id: "s" }, user: { id: "u" } }),
      contentType: "application/json",
      headers: { ...WORKER_MARK },
    })
  );
  await serveHealth(page, () => cut.value);
  await page.route("**/health", (route) => {
    probes += 1;
    return route.fallback();
  });
  await page.route("**/rpc/**", async (route: Route) => {
    const procedure = new URL(route.request().url()).pathname.replace(
      "/rpc/",
      ""
    );
    if (procedure === SENTINEL) {
      return route.fulfill(rpc({}));
    }
    if (procedure === "organization/listMine") {
      return route.fulfill(rpc({ organizations: [ORGANIZATION] }));
    }
    if (procedure === "paymentProfile/list") {
      reads += 1;
      if (reads === 1) {
        await firstReadHeld;
      }
      return cut.value
        ? route.abort("internetdisconnected")
        : route.fulfill(rpc({ profiles: [MACHINE] }));
    }
    if (procedure.startsWith("paymentProfile/")) {
      writes.push(procedure);
      return procedure === "paymentProfile/create"
        ? route.fulfill(rpc(MACHINE))
        : route.abort("internetdisconnected");
    }
    return route.abort("internetdisconnected");
  });
  await page.clock.setFixedTime(NOW);
  await page.goto("/payment-profiles");
  await expect(title(page)).toBeVisible();
  return {
    cut,
    holdFirstRead: { release },
    listReads: () => reads,
    probesSinceRelease: () => probes - probesAtRelease,
    writes,
  };
}

const strip = (page: Page) =>
  page.getByRole("status").filter({ hasText: STRIP_TITLE });

/**
 * A request sent before this one reaches the route handler before it does: once the sentinel went through, whatever the
 * click sent has been counted, so "nothing was sent" is read after the fact and not before the request could arrive.
 */
async function settled(page: Page) {
  await page.evaluate(
    (procedure) => fetch(`/rpc/${procedure}`, { method: "POST" }),
    SENTINEL
  );
}

async function goOffline(page: Page, scene: Scene) {
  scene.cut.value = true;
  await page.context().setOffline(true);
}

async function goOnline(page: Page, scene: Scene) {
  scene.cut.value = false;
  await page.context().setOffline(false);
}

test("sem conexão: a faixa diz que a tela precisa de internet e 'Arquivar' fica aria-disabled, lê a faixa e não envia nada", async ({
  page,
}) => {
  const scene = await openScreen(page);
  const archive = page.getByRole("button", {
    name: "Arquivar perfil Maquininha da loja",
  });
  await expect(archive).toBeVisible();
  await expect(page.getByText(STRIP_TEXT)).toHaveCount(0);
  await expect(archive).not.toHaveAttribute("aria-disabled", "true");

  await goOffline(page, scene);
  await expect(strip(page)).toContainText(STRIP_TEXT);
  await expect(strip(page)).toContainText("O que você digitou fica aqui");
  await expect(
    strip(page).getByRole("button", { name: "Tentar agora" })
  ).toBeVisible();

  // off by aria-disabled, not by `disabled`: it keeps the focus, and with it the reason it reads
  await expect(archive).toHaveAttribute("aria-disabled", "true");
  await expect(archive).not.toHaveAttribute("disabled", "");
  await expect(archive).toHaveAttribute("aria-describedby", STRIP_TEXT_ID);
  await expect(archive).toHaveAccessibleDescription(STRIP_TEXT_START);
  await expect(page.locator(`#${STRIP_TEXT_ID}`)).toBeVisible();

  // Playwright does not click what is aria-disabled and the class takes its pointer events: the event is sent to it
  await archive.dispatchEvent("click");
  await archive.focus();
  await page.keyboard.press("Enter");
  await expect(archive).toBeFocused();
  await settled(page);
  await expect(
    page.getByText("Perfil “Maquininha da loja” arquivado.")
  ).toHaveCount(0);
  expect(scene.writes).toEqual([]);

  // "Novo perfil" and "Editar" only open the form, which keeps the draft in memory: what writes is its button
  await page.getByRole("button", { name: "Novo perfil" }).click();
  const dialog = page.getByRole("dialog", { name: "Novo perfil" });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Criar perfil" })
  ).toHaveAttribute("aria-disabled", "true");
  expect(scene.writes).toEqual([]);
});

test("sem conexão ao abrir: a lista não carregou, não aparece como vazia e a faixa diz que a tela precisa de conexão", async ({
  page,
}) => {
  const scene = await openScreen(page, { startCut: true });
  await page.context().setOffline(true);
  await expect(strip(page)).toBeVisible();
  await expect(strip(page)).toContainText(STRIP_TEXT);
  await expect(strip(page)).toContainText("O que você digitou fica aqui");
  await expect(page.getByText(NOT_LOADED)).toBeVisible();
  await expect(page.getByText("Nenhum perfil cadastrado")).toHaveCount(0);
  await expect(page.getByText("Maquininha da loja")).toHaveCount(0);
  expect(scene.writes).toEqual([]);
});

test("a rede cai com o formulário preenchido: o que foi digitado fica, 'Criar perfil' não envia e volta a gravar com a rede", async ({
  page,
}) => {
  const scene = await openScreen(page);
  await page.getByRole("button", { name: "Novo perfil" }).click();
  const dialog = page.getByRole("dialog", { name: "Novo perfil" });
  const name = dialog.getByLabel("Nome do perfil");
  await name.fill("Link de pagamento");
  const create = dialog.getByRole("button", { name: "Criar perfil" });
  await expect(create).not.toHaveAttribute("aria-disabled", "true");
  await expect(dialog.getByText(STRIP_TITLE)).toHaveCount(0);

  await goOffline(page, scene);
  // the veil of the dialog covers the strip of the shell: the dialog says it above its buttons
  await expect(dialog.getByText(STRIP_TITLE)).toBeVisible();
  await expect(dialog.getByText(STRIP_TEXT)).toBeVisible();
  await expect(name).toHaveValue("Link de pagamento");
  await expect(create).toHaveAttribute("aria-disabled", "true");
  await expect(create).not.toHaveAttribute("disabled", "");
  await expect(create).toHaveAttribute("aria-describedby", DIALOG_TEXT_ID);
  await expect(create).toHaveAccessibleDescription(STRIP_TEXT_START);

  await create.dispatchEvent("click");
  await create.focus();
  await page.keyboard.press("Enter");
  await settled(page);
  await expect(dialog).toBeVisible();
  await expect(name).toHaveValue("Link de pagamento");
  await expect(create).toBeFocused();
  expect(scene.writes).toEqual([]);

  await goOnline(page, scene);
  await expect(dialog.getByText(STRIP_TITLE)).toHaveCount(0);
  await expect(page.getByText(STRIP_TEXT)).toHaveCount(0);
  await expect(create).not.toHaveAttribute("aria-disabled", "true");
  await expect(create).not.toHaveAttribute("aria-describedby", ANY_VALUE);
  await expect(name).toHaveValue("Link de pagamento");

  await create.click();
  await expect(
    page.getByText("Perfil “Link de pagamento” criado.")
  ).toBeVisible();
  expect(scene.writes).toEqual(["paymentProfile/create"]);
});

test("a rede volta: a lista que não carregava é lida de novo, sem recarregar a página", async ({
  page,
}) => {
  const scene = await openScreen(page, { startCut: true });
  // the first read is in flight and held: the page goes offline before it fails, so `readWithRetry` has no second try
  // to give and only the return of the connection can read the list again
  await expect.poll(scene.listReads).toBe(1);
  await page.context().setOffline(true);
  await expect(strip(page)).toBeVisible();
  scene.holdFirstRead.release();
  // "não carregaram" shows while the read is still loading offline: it is settled once the probe of `workerAnswers` ran,
  // and the probes the connection scheduled before the release (2 s after the cut, 4 s on a slow call) do not count
  await expect.poll(scene.probesSinceRelease).toBeGreaterThan(0);
  await settled(page);
  await expect(page.getByText(NOT_LOADED)).toBeVisible();
  expect(scene.listReads()).toBe(1);

  await goOnline(page, scene);
  await expect(page.getByText("Maquininha da loja")).toBeVisible();
  await expect(page.getByText(NOT_LOADED)).toHaveCount(0);
  await expect(page.getByText(STRIP_TEXT)).toHaveCount(0);
  expect(scene.listReads()).toBe(2);
  await expect(
    page.getByRole("button", { name: "Arquivar perfil Maquininha da loja" })
  ).not.toHaveAttribute("aria-disabled", "true");
  expect(scene.writes).toEqual([]);
});
