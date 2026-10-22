/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import {
  checkForUpdate,
  openControlled,
  runningVersion,
  test,
} from "./support";

/**
 * The update with work in the outbox (plan PR62). The test plays the part of the
 * outbox through the update store the browser-check build exposes: what is
 * queued, and whether sending works.
 */
interface QueueControl {
  failSync: boolean;
  pending: number;
  rejected: number;
}

declare global {
  interface Window {
    polarisQueue?: QueueControl;
    polarisUpdateStore?: {
      setWorkSource: (source: {
        read: () => Promise<{
          pending: number;
          rejected: number;
          sending: number;
        }>;
        sync: () => Promise<void>;
      }) => void;
    };
    stillHere?: boolean;
  }
}

async function updateWaitingWith(
  page: Page,
  buildVersion: (variant: string) => void,
  queue: Partial<QueueControl>
) {
  buildVersion("1");
  await openControlled(page);
  await page.evaluate((initial) => {
    const control: QueueControl = {
      failSync: false,
      pending: 0,
      rejected: 0,
      ...initial,
    };
    window.polarisQueue = control;
    window.stillHere = true;
    window.polarisUpdateStore?.setWorkSource({
      read: () =>
        Promise.resolve({
          pending: control.pending,
          rejected: control.rejected,
          sending: 0,
        }),
      sync: () => {
        if (control.failSync) {
          return Promise.reject(new Error("sem conexão"));
        }
        control.pending = 0;
        return Promise.resolve();
      },
    });
  }, queue);
  buildVersion("2");
  await checkForUpdate(page);
  await expect(
    page.getByRole("status", { name: "Atualização do aplicativo" })
  ).toContainText("Há uma nova versão do Polaris", { timeout: 20_000 });
}

const stillHere = (page: Page) => page.evaluate(() => window.stillHere);

test("com operações na fila e sem rede, a atualização espera e nada se perde; com rede, envia e só então atualiza", async ({
  buildVersion,
  page,
}) => {
  await updateWaitingWith(page, buildVersion, { failSync: true, pending: 2 });
  const banner = page.getByRole("status", {
    name: "Atualização do aplicativo",
  });
  await expect(banner).toContainText("2 operações");
  await expect(banner).toContainText("enviadas primeiro");

  await page.getByRole("button", { name: "Enviar e atualizar" }).click();
  await expect(banner).toContainText("Não foi possível enviar", {
    timeout: 15_000,
  });
  // nothing was swapped or reloaded, and the queue is untouched
  expect(await runningVersion(page)).toBe("1");
  expect(await stillHere(page)).toBe(true);
  expect(await page.evaluate(() => window.polarisQueue?.pending)).toBe(2);

  // the network is back: it sends first and updates once the queue is empty
  await page.evaluate(() => {
    if (window.polarisQueue) {
      window.polarisQueue.failSync = false;
    }
  });
  await page.getByRole("button", { name: "Enviar e atualizar" }).click();
  await expect.poll(() => runningVersion(page), { timeout: 20_000 }).toBe("2");
  expect(
    await page.evaluate(() => window.polarisQueue?.pending)
  ).toBeUndefined();
});

test("com uma operação recusada não há botão de atualizar: a atualização espera a pessoa resolver", async ({
  buildVersion,
  page,
}) => {
  await updateWaitingWith(page, buildVersion, { pending: 1, rejected: 1 });
  const banner = page.getByRole("status", {
    name: "Atualização do aplicativo",
  });
  await expect(banner).toContainText("O servidor recusou 1 operação");
  await expect(banner).toContainText("Operações que precisam");
  await expect(banner.getByRole("button")).toHaveCount(0);
  await page.waitForTimeout(1500);
  expect(await runningVersion(page)).toBe("1");
  expect(await stillHere(page)).toBe(true);
});
