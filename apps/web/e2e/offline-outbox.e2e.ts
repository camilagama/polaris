/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

const rejectedPattern = /rejected:stock_insufficient/;
const wipeRefusedPattern = /PendingCommandsError/;
const wipeSettledPattern = /^(ok|PendingCommandsError)$/;
const raceLinePattern = /([a-z-]+)=([A-Za-z]+)\/(\d+)/g;
const persistentPattern = /granted|denied|unsupported/;

async function openLab(page: Page) {
  await page.goto("/offline-outbox-lab");
  await expect(
    page.getByRole("heading", { name: "Outbox de comandos" })
  ).toBeVisible();
}

async function useNamespace(page: Page, user: string, organization = "org-1") {
  await page.getByLabel("Usuário").fill(user);
  await page.getByLabel("Organização").fill(organization);
}

async function click(page: Page, name: string, expected: RegExp | string) {
  await page.getByRole("button", { exact: true, name }).click();
  await expect(page.getByTestId("message")).toContainText(expected, {
    timeout: 15_000,
  });
}

const list = (page: Page) => page.getByTestId("outbox-list").locator("li");

test("os comandos enfileirados sobrevivem a recarregar e mantêm a ordem", async ({
  page,
}) => {
  const user = `user-${crypto.randomUUID()}`;
  await openLab(page);
  await useNamespace(page, user);
  for (let n = 1; n <= 3; n += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: commands are queued in order
    await click(page, "Enfileirar", "Enfileirar: ok");
  }
  await expect(page.getByTestId("count-pending")).toHaveText("3");

  await page.reload();
  await openLab(page);
  await useNamespace(page, user);
  await click(page, "Abrir", "Abrir: ok");
  await expect(list(page)).toHaveCount(3);
  await expect(list(page).nth(0)).toContainText("1:pending");
  await expect(list(page).nth(2)).toContainText("3:pending");
});

test("o mesmo comando repetido não entra duas vezes", async ({ page }) => {
  await openLab(page);
  await useNamespace(page, `user-${crypto.randomUUID()}`);
  await click(page, "Enfileirar", "Enfileirar: ok");
  await click(page, "Repetir comando", "Repetir comando: ok");
  await expect(list(page)).toHaveCount(1);
});

test("um comando enviado cuja resposta se perdeu volta à fila e mantém a posição", async ({
  page,
}) => {
  const user = `user-${crypto.randomUUID()}`;
  await openLab(page);
  await useNamespace(page, user);
  await click(page, "Enfileirar", "Enfileirar: ok");
  await click(page, "Enfileirar", "Enfileirar: ok");
  await click(page, "Enviar", "Enviar: ok");
  await expect(page.getByTestId("count-sending")).toHaveText("1");

  // the app dies mid-request: reload, reopen, recover
  await page.reload();
  await openLab(page);
  await useNamespace(page, user);
  await click(page, "Abrir", "Abrir: ok");
  await expect(list(page).nth(0)).toContainText("1:sending");
  await click(page, "Recuperar", "1 recuperados");
  await expect(list(page).nth(0)).toContainText("1:pending");
  await expect(list(page).nth(0)).toContainText("a1");
  await expect(list(page).nth(1)).toContainText("2:pending");
});

test("um comando rejeitado bloqueia a fila até ser tratado", async ({
  page,
}) => {
  await openLab(page);
  await useNamespace(page, `user-${crypto.randomUUID()}`);
  await click(page, "Enfileirar", "Enfileirar: ok");
  await click(page, "Enfileirar", "Enfileirar: ok");
  await click(page, "Enviar", "Enviar: ok");
  await click(page, "Rejeitar", "Rejeitar: ok");
  await expect(list(page).nth(0)).toHaveText(rejectedPattern);
  await click(page, "Enviar", "nada para enviar");

  await click(page, "Tentar novamente", "Tentar novamente: ok");
  await click(page, "Enviar", "Enviar: ok");
  await click(page, "Confirmar", "Confirmar: ok");
  await expect(list(page)).toHaveCount(1);
  await expect(list(page).nth(0)).toContainText("2:pending");
});

test("um lease vencido bloqueia comandos novos mas preserva os da fila", async ({
  page,
}) => {
  await openLab(page);
  await useNamespace(page, `user-${crypto.randomUUID()}`);
  await click(page, "Enfileirar", "Enfileirar: ok");
  await page.getByLabel("Lease vencido").check();
  await click(page, "Enfileirar", "OfflineLeaseUnusableError");
  await expect(list(page)).toHaveCount(1);
  await expect(list(page).nth(0)).toContainText("1:pending");
});

test("usuários e organizações diferentes têm outboxes separados", async ({
  page,
}) => {
  const first = `user-${crypto.randomUUID()}`;
  await openLab(page);
  await useNamespace(page, first);
  await click(page, "Enfileirar", "Enfileirar: ok");
  await click(page, "Enfileirar", "Enfileirar: ok");

  await useNamespace(page, `user-${crypto.randomUUID()}`);
  await click(page, "Abrir", "Abrir: ok");
  await expect(list(page)).toHaveCount(0);

  await useNamespace(page, first, "org-2");
  await click(page, "Abrir", "Abrir: ok");
  await expect(list(page)).toHaveCount(0);

  await useNamespace(page, first);
  await click(page, "Abrir", "Abrir: ok");
  await expect(list(page)).toHaveCount(2);
});

test("apagar o outbox nunca descarta comandos pendentes sem o aceite explícito", async ({
  page,
}) => {
  await openLab(page);
  await useNamespace(page, `user-${crypto.randomUUID()}`);
  await click(page, "Enfileirar", "Enfileirar: ok");
  await click(page, "Apagar", wipeRefusedPattern);
  await click(page, "Abrir", "Abrir: ok");
  await expect(list(page)).toHaveCount(1);

  await click(page, "Apagar descartando", "1 descartados");
  await click(page, "Abrir", "Abrir: ok");
  await expect(list(page)).toHaveCount(0);
});

test("a posição de um comando nunca é reutilizada, nem depois de apagar a fila", async ({
  page,
}) => {
  const user = `user-${crypto.randomUUID()}`;
  await openLab(page);
  await useNamespace(page, user);
  await click(page, "Enfileirar", "Enfileirar: ok");
  await click(page, "Enviar", "Enviar: ok");
  await click(page, "Confirmar", "Confirmar: ok");
  await click(page, "Enfileirar", "seq 2");
});

test("pede o armazenamento persistente e mostra a resposta", async ({
  page,
}) => {
  await openLab(page);
  await page
    .getByRole("button", { name: "Pedir armazenamento persistente" })
    .click();
  await expect(page.getByTestId("persistent")).toHaveText(persistentPattern);
});

test("duas abas do mesmo usuário compartilham a fila e cada comando é enviado uma única vez", async ({
  context,
}) => {
  const user = `user-${crypto.randomUUID()}`;
  const first = await context.newPage();
  const second = await context.newPage();
  await openLab(first);
  await useNamespace(first, user);
  await click(first, "Enfileirar", "Enfileirar: ok");
  await click(first, "Enfileirar", "Enfileirar: ok");

  await openLab(second);
  await useNamespace(second, user);
  await click(second, "Abrir", "Abrir: ok");
  await expect(list(second)).toHaveCount(2);

  // the first tab starts sending the head: the second must not send it again
  await click(first, "Enviar", "Enviar: ok");
  await click(second, "Enviar", "nada para enviar");
  await expect(second.getByTestId("count-sending")).toHaveText("1");
  await expect(list(second).nth(0)).toContainText("1:sending");

  // once the head is confirmed, the next command goes out, from whichever tab
  await click(first, "Confirmar", "Confirmar: ok");
  await click(second, "Enviar", "Enviar: ok");
  await expect(list(second)).toHaveCount(1);
  await expect(list(second).nth(0)).toContainText("2:sending");
});

test("a limpeza da fila numa aba não apaga a venda que a outra aba faz depois", async ({
  context,
}) => {
  const user = `user-${crypto.randomUUID()}`;
  const leaving = await context.newPage();
  const selling = await context.newPage();
  await openLab(leaving);
  await useNamespace(leaving, user);
  await click(leaving, "Abrir", "Abrir: ok");
  await openLab(selling);
  await useNamespace(selling, user);
  await click(selling, "Abrir", "Abrir: ok");

  // "Sair" in the first tab: its store closes, then the queue is wiped while the second tab keeps its connection
  await click(leaving, "Apagar", "Apagar:");
  await click(selling, "Enfileirar", "Enfileirar: ok");
  await expect(list(selling)).toHaveCount(1);
  await selling.close();

  const fresh = await context.newPage();
  await openLab(fresh);
  await useNamespace(fresh, user);
  await click(fresh, "Abrir", "Abrir: ok");
  await expect(list(fresh)).toHaveCount(1);
  await expect(leaving.getByTestId("message")).toHaveText(
    "Apagar: ok (0 descartados)"
  );
});

test("limpeza e venda em duas conexões, nas duas ordens e juntas: a venda fica ou a limpeza recusa", async ({
  page,
}) => {
  await openLab(page);
  await useNamespace(page, `user-${crypto.randomUUID()}`);
  await click(page, "Corrida limpeza × venda", "Corrida:");
  const message = (await page.getByTestId("message").textContent()) ?? "";
  const results = Object.fromEntries(
    [...message.matchAll(raceLinePattern)].map(([, order, wiped, left]) => [
      order,
      { left: Number(left), wiped },
    ])
  );
  expect(results).toEqual({
    "juntas-limpeza": {
      left: 1,
      wiped: expect.stringMatching(wipeSettledPattern),
    },
    "juntas-venda": {
      left: 1,
      wiped: expect.stringMatching(wipeSettledPattern),
    },
    "limpeza-antes": { left: 1, wiped: "ok" },
    "venda-antes": { left: 1, wiped: "PendingCommandsError" },
  });
});

test("fila no disco: um outbox esvaziado fica como banco vazio e não conta, e perguntar não cria banco", async ({
  page,
}) => {
  await openLab(page);
  await useNamespace(page, `user-${crypto.randomUUID()}`);
  await click(page, "Fila no disco", "Fila no disco: ok (não, 0 bancos)");
  await click(page, "Enfileirar", "Enfileirar: ok");
  await click(page, "Fila no disco", "Fila no disco: ok (sim, 1 bancos)");
  await click(page, "Apagar descartando", "1 descartados");
  await click(page, "Fila no disco", "Fila no disco: ok (não, 1 bancos)");

  // a name listed but gone by the time it is opened (another tab deleted it): counted as empty, never recreated
  await page.evaluate(() => {
    const real = IDBFactory.prototype.databases;
    (window as unknown as { realDatabases: typeof real }).realDatabases = real;
    IDBFactory.prototype.databases = async function databases(
      this: IDBFactory
    ) {
      return [
        ...(await real.call(this)),
        { name: "polaris-outbox-sumiu", version: 1 },
      ];
    };
  });
  await click(page, "Fila no disco", "Fila no disco: ok (não, 2 bancos)");
  expect(
    await page.evaluate(async () => {
      const { realDatabases } = window as unknown as {
        realDatabases: IDBFactory["databases"];
      };
      return (await realDatabases.call(indexedDB)).map(({ name }) => name);
    })
  ).not.toContain("polaris-outbox-sumiu");
});
