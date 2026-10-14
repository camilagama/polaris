/// <reference lib="dom" />
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

const ORGANIZATIONS = [
  {
    id: "0199c2d0-0000-7000-8000-00000000a001",
    name: "Loja do teste",
    role: "owner",
    timezone: "America/Sao_Paulo",
  },
];
const REVOKE_BUTTON = /^Revogar o aparelho/;
const uuid = (n: number) =>
  `0199c2d0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const device = (n: number, label: string | null, lastSeen: string) => ({
  createdAt: "2026-10-01T12:00:00.000Z",
  id: uuid(n),
  label,
  lastSeenAt: lastSeen,
  revokedAt: null,
});

const json = (body: unknown, status = 200) => ({
  body: JSON.stringify({ json: body, meta: [] }),
  contentType: "application/json",
  status,
});

/** The server of this scenario: the organizations, the devices and the revocation. */
async function serve(
  page: Page,
  state: { devices: ReturnType<typeof device>[]; down?: boolean }
) {
  await page.route("**/rpc/organization/listMine", (route) =>
    route.fulfill(json({ organizations: ORGANIZATIONS }))
  );
  await page.route("**/rpc/device/list", (route) =>
    state.down
      ? route.abort("internetdisconnected")
      : route.fulfill(json({ devices: state.devices }))
  );
  await page.route("**/rpc/device/revoke", async (route) => {
    const { json: input } = route.request().postDataJSON() as {
      json: { deviceId: string };
    };
    const gone = state.devices.find((item) => item.id === input.deviceId);
    state.devices = state.devices.filter((item) => item.id !== input.deviceId);
    await route.fulfill(
      json({
        device: { ...gone, revokedAt: "2026-10-14T13:00:00.000Z" },
        revokedGrantIds: [uuid(900)],
      })
    );
  });
  // everything else the offline runtime asks for is unreachable here
  await page.route("**/rpc/**", async (route) => {
    const url = route.request().url();
    if (
      url.includes("organization/listMine") ||
      url.includes("device/list") ||
      url.includes("device/revoke")
    ) {
      await route.fallback();
      return;
    }
    await route.abort("internetdisconnected");
  });
}

const twoDevices = () => [
  device(1, "Caixa da loja", "2026-10-14T10:00:00.000Z"),
  device(2, "Celular da Ana", "2026-10-13T10:00:00.000Z"),
];

test("lista os aparelhos, pede confirmação clara e revoga um deles", async ({
  page,
}) => {
  const state = { devices: twoDevices() };
  await serve(page, state);
  await page.goto("/devices");

  const list = page.getByRole("list", { name: "Aparelhos" });
  await expect(list.getByRole("listitem")).toHaveCount(2);
  await expect(list.getByRole("listitem").first()).toContainText(
    "Caixa da loja"
  );

  await page
    .getByRole("button", { name: "Revogar o aparelho Celular da Ana" })
    .click();
  await expect(page.getByText("Não dá para desfazer")).toBeVisible();
  // nothing happened yet
  expect(state.devices).toHaveLength(2);

  await page
    .getByRole("button", { name: "Sim, revogar este aparelho" })
    .click();
  await expect(
    page.getByText("Aparelho revogado e 1 autorização offline cancelada")
  ).toBeVisible();
  await expect(list.getByRole("listitem")).toHaveCount(1);
  await expect(list).not.toContainText("Celular da Ana");
});

test("cancelar a confirmação não revoga nada", async ({ page }) => {
  const state = { devices: twoDevices() };
  await serve(page, state);
  await page.goto("/devices");
  await page
    .getByRole("button", { name: "Revogar o aparelho Celular da Ana" })
    .click();
  await page.getByRole("button", { name: "Cancelar" }).click();
  await expect(page.getByText("Não dá para desfazer")).toHaveCount(0);
  expect(state.devices).toHaveLength(2);
});

test("sem conexão diz que não foi possível carregar e não oferece revogar", async ({
  page,
}) => {
  const state = { devices: twoDevices(), down: true };
  await serve(page, state);
  await page.goto("/devices");
  await expect(
    page.getByText("Não foi possível carregar os aparelhos")
  ).toBeVisible();
  await expect(page.getByRole("button", { name: REVOKE_BUTTON })).toHaveCount(
    0
  );
});

test("o menu oferece Aparelhos quando o runtime offline está ligado", async ({
  page,
}) => {
  await serve(page, { devices: twoDevices() });
  await page.goto("/");
  // narrow screens keep the menu closed until it is opened
  const toggle = page.getByRole("button", { name: "Menu" });
  if (await toggle.isVisible()) {
    await toggle.click();
  }
  await expect(page.getByRole("link", { name: "Aparelhos" })).toBeVisible();
});
