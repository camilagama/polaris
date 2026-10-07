/// <reference lib="dom" />
import { expect, test } from "@playwright/test";

const sharedEditButtonName = /Editar registro compartilhado pela aba/;

async function openLab(
  page: import("@playwright/test").Page,
  release: 1 | 2 = 1,
  requireLeader = true
) {
  await page.goto(`/offline-poc?release=${release}`);
  await expect(
    page.getByRole("heading", { name: "Persistência offline" })
  ).toBeVisible();
  if (requireLeader) {
    await expect(page.getByTestId("offline-enabled")).toHaveText("Disponível", {
      timeout: 15_000,
    });
  }
}

async function queueNote(page: import("@playwright/test").Page, title: string) {
  await page.getByLabel("Título da nota sintética").fill(title);
  await page.getByRole("button", { name: "Gravar mutation offline" }).click();
  await expect(page.getByTestId("outbox-count")).toHaveText("1", {
    timeout: 10_000,
  });
  await expect(page.getByText(title, { exact: false })).toBeVisible();
}

test("restaura dados e outbox após reload e executa com idempotency key", async ({
  page,
}) => {
  await openLab(page);

  const recordTitle = `persistência ${crypto.randomUUID()}`;
  await queueNote(page, recordTitle);
  await expect(page.getByTestId("mock-online")).toHaveText("Indisponível");

  await page.reload();
  await openLab(page);
  await expect(page.getByTestId("outbox-count")).toHaveText("1");
  await expect(page.getByText(recordTitle, { exact: false })).toBeVisible();

  await page
    .getByRole("button", { name: "Colocar mock server online" })
    .click();
  await expect(page.getByTestId("outbox-count")).toHaveText("0", {
    timeout: 10_000,
  });
  await expect(page.getByTestId("mock-server-receipts")).toHaveText("1");
});

test("mantém dados e outbox ao fechar e reabrir a aba", async ({ context }) => {
  const firstPage = await context.newPage();
  await openLab(firstPage);

  const recordTitle = `reabertura ${crypto.randomUUID()}`;
  await queueNote(firstPage, recordTitle);
  await firstPage.close();

  const reopenedPage = await context.newPage();
  await openLab(reopenedPage);
  await expect(reopenedPage.getByTestId("outbox-count")).toHaveText("1");
  await expect(
    reopenedPage.getByText(recordTitle, { exact: false })
  ).toBeVisible();
});

test("limpa collections, outbox e receipts e reabre sem dados antigos", async ({
  page,
}) => {
  await openLab(page);
  await queueNote(page, `receipt ${crypto.randomUUID()}`);
  await page
    .getByRole("button", { name: "Colocar mock server online" })
    .click();
  await expect(page.getByTestId("outbox-count")).toHaveText("0");
  await expect(page.getByTestId("mock-server-receipts")).toHaveText("1");

  await page
    .getByRole("button", { name: "Colocar mock server offline" })
    .click();
  await queueNote(page, `reset ${crypto.randomUUID()}`);
  await page.getByRole("button", { name: "Limpar dados sintéticos" }).click();

  await expect(page.getByTestId("offline-enabled")).toHaveText("Disponível", {
    timeout: 15_000,
  });
  await expect(page.getByTestId("v1-count")).toHaveText("0");
  await expect(page.getByTestId("outbox-count")).toHaveText("0");
  await expect(page.getByTestId("mock-server-receipts")).toHaveText("0");
});

test("serializa o recovery de reset interrompido entre duas abas", async ({
  page,
  context,
}) => {
  await openLab(page);
  await queueNote(page, `reset interrompido ${crypto.randomUUID()}`);
  const secondPage = await context.newPage();
  await openLab(secondPage, 1, false);

  const markerBeforeReload = await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(
        "polaris-pr12-offline-poc-reset-journal",
        1
      );
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    const transaction = database.transaction("journal", "readwrite");
    transaction.objectStore("journal").put("pending", "reset");
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    const readTransaction = database.transaction("journal", "readonly");
    const readRequest = readTransaction.objectStore("journal").get("reset");
    const marker = await new Promise<unknown>((resolve, reject) => {
      readRequest.onsuccess = () => resolve(readRequest.result);
      readRequest.onerror = () => reject(readRequest.error);
    });
    database.close();
    return marker;
  });
  expect(markerBeforeReload).toBe("pending");

  await Promise.all([page.reload(), secondPage.reload()]);
  await Promise.all(
    [page, secondPage].map((tab) =>
      expect(tab.getByTestId("offline-enabled")).toBeVisible()
    )
  );
  await Promise.all(
    [page, secondPage].flatMap((tab) => [
      expect(tab.getByTestId("v1-count")).toHaveText("0"),
      expect(tab.getByTestId("outbox-count")).toHaveText("0"),
      expect(tab.getByTestId("mock-server-receipts")).toHaveText("0"),
    ])
  );
  await secondPage.close();
});
test("recupera uma mutation pendente após eviction apenas do arquivo OPFS", async ({
  page,
}) => {
  await openLab(page);

  const recordTitle = `recuperação ${crypto.randomUUID()}`;
  await queueNote(page, recordTitle);
  await page
    .getByRole("button", { name: "Simular eviction do arquivo OPFS" })
    .click();

  await expect(page.getByRole("status")).toContainText(
    "Eviction OPFS simulada",
    { timeout: 15_000 }
  );
  await expect(page.getByTestId("offline-enabled")).toHaveText("Disponível");
  await expect(page.getByTestId("outbox-count")).toHaveText("1");
  await expect(page.getByText(recordTitle, { exact: false })).toBeVisible();
});

test("copia dados v1 para v2 sem apagar a origem e mantém o outbox", async ({
  page,
}) => {
  await page.goto("/offline-poc?release=2");
  await openLab(page, 2);
  const migrateButton = page.getByRole("button", {
    name: "Copiar v1→v2 (idempotente; preserva v1)",
  });
  await expect(page.getByTestId("v1-count")).toHaveText("0");
  await expect(migrateButton).toBeDisabled();

  await page.goto("/offline-poc?release=1");
  await openLab(page);
  const recordTitle = `migração ${crypto.randomUUID()}`;
  await queueNote(page, recordTitle);
  await page.goto("/offline-poc?release=2");
  await openLab(page, 2);

  await expect(page.getByTestId("v1-count")).toHaveText("1");
  await expect(page.getByTestId("v2-count")).toHaveText("0");
  await expect(migrateButton).toBeEnabled();
  await migrateButton.click();

  await expect(page.getByTestId("v1-count")).toHaveText("1");
  await expect(page.getByTestId("v2-count")).toHaveText("1");
  await expect(page.getByTestId("outbox-count")).toHaveText("1");
  await expect(page.getByRole("status")).toContainText(
    "Migração local idempotente"
  );
  await expect(page.getByText(recordTitle, { exact: false })).toHaveCount(2);

  await page
    .getByRole("button", { name: "Copiar v1→v2 (idempotente; preserva v1)" })
    .click();
  await expect(page.getByTestId("v2-count")).toHaveText("1");
  await expect(page.getByRole("status")).toContainText(
    "0 registro(s) copiado(s)"
  );
});

test("coordena duas abas e converge para o mesmo registro compartilhado", async ({
  page,
}) => {
  await openLab(page);
  await page.getByRole("button", { name: sharedEditButtonName }).click();

  const secondPage = await page.context().newPage();
  await openLab(secondPage, 1, false);
  await expect(secondPage.getByTestId("shared-record-v1")).toBeVisible();

  await expect
    .poll(async () => {
      const leaders = await Promise.all(
        [page, secondPage].map(
          async (tab) =>
            (await tab.getByTestId("offline-enabled").innerText()) ===
            "Disponível"
        )
      );
      return leaders.filter(Boolean).length;
    })
    .toBe(1);

  await Promise.all([
    page.getByRole("button", { name: sharedEditButtonName }).click(),
    secondPage.getByRole("button", { name: sharedEditButtonName }).click(),
  ]);

  await expect
    .poll(async () => {
      const first = await page.getByTestId("shared-record-v1").innerText();
      const second = await secondPage
        .getByTestId("shared-record-v1")
        .innerText();
      return first === second;
    })
    .toBe(true);
});

test("permite writes locais sem rede depois que o app já carregou", async ({
  page,
  context,
}) => {
  await openLab(page);
  await context.setOffline(true);
  await expect(page.getByTestId("browser-network")).toHaveText("Indisponível");

  const recordTitle = `sem rede ${crypto.randomUUID()}`;
  await queueNote(page, recordTitle);
  await expect(page.getByTestId("outbox-count")).toHaveText("1");

  await context.setOffline(false);
  await page
    .getByRole("button", { name: "Colocar mock server online" })
    .click();
  await expect(page.getByTestId("outbox-count")).toHaveText("0", {
    timeout: 10_000,
  });
});
