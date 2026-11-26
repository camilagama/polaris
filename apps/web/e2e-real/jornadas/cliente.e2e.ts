import { localDate } from "../calendar";
import { expect, openJourney, runT0, test } from "../fixtures";
import { cents, numericCents } from "../oracle";
import { choose, confirmSale, fillSale } from "../pages/venda";
import { seedCashSale, seedProduct, seedStock } from "../seed";

const AGENDA = /Agenda 2027/;
const EMAIL_FIELD = /^Email/;

/** Journey 4: a customer registered on screen is in the list, one row in the organization, and is chosen on a sale. */
test("cliente: cadastro, lista e escolha na venda", async ({
  browser,
  sql,
}, testInfo) => {
  const zone = "America/Sao_Paulo";
  const journey = await openJourney(browser, testInfo, "cliente", {
    organization: { timezone: zone },
  });
  const { page, user } = journey;
  const organizationId = journey.organizationId as string;
  const name = "Maria Aparecida Souza";

  await page.goto("/customers");
  await page.getByRole("button", { name: "Novo cliente" }).click();
  // the form is a dialog (the whole screen on a phone)
  const form = page.getByRole("dialog", { name: "Novo cliente" });
  await form.getByLabel("Nome", { exact: true }).fill(name);
  await form.getByLabel("Telefone").fill("+55 11 91234-5678");
  await form
    .getByRole("textbox", { name: EMAIL_FIELD })
    .fill(`maria.${journey.name}@exemplo.com.br`);
  await form.getByRole("button", { name: "Cadastrar cliente" }).click();
  await expect(
    page.getByRole("button", { name: `Mais ações para ${name}` })
  ).toBeVisible();

  const customers = async () =>
    (
      await sql.query<{ id: string; organization_id: string; name: string }>(
        "SELECT c.id, c.organization_id, c.name FROM customers c JOIN organizations o ON o.id = c.organization_id WHERE o.name = $1",
        [journey.name]
      )
    ).rows;
  await expect
    .poll(customers)
    .toEqual([
      expect.objectContaining({ name, organization_id: organizationId }),
    ]);
  const [customer] = await customers();

  // chosen on a sale confirmed on screen
  const product = await seedProduct(
    user.rpc,
    organizationId,
    "Agenda 2027",
    "30.00"
  );
  await seedStock(
    user.rpc,
    organizationId,
    product.variantId,
    3,
    "11.00",
    localDate(runT0(), zone)
  );
  await page.goto("/sales");
  await fillSale(
    page,
    [
      {
        charged: "30,00",
        option: AGENDA,
        quantity: 1,
        search: "Agenda",
      },
    ],
    []
  );
  const confirmed = await confirmSale(page);
  await confirmed
    .getByRole("button", { name: "Associar cliente a esta venda (opcional)" })
    .click();
  // "Associar cliente" opens the dialog that picks the customer and sends the association
  await confirmed
    .getByRole("button", { exact: true, name: "Associar cliente" })
    .click();
  const choosing = page.getByRole("dialog", { name: "Associar cliente" });
  await choose(page, choosing, "Cliente", name);
  await choosing.getByRole("button", { name: "Associar cliente" }).click();
  await expect(confirmed.getByText("Cliente associado à venda.")).toBeVisible();
  await expect
    .poll(async () =>
      (
        await sql.query<{ customer_id: string }>(
          "SELECT l.customer_id FROM sale_customer_links l JOIN sales s ON s.id = l.sale_id WHERE s.organization_id = $1",
          [organizationId]
        )
      ).rows.map((row) => row.customer_id)
    )
    .toEqual([customer?.id]);
});

type Sql = Parameters<Parameters<typeof test>[2]>[0]["sql"];
type Page = Awaited<ReturnType<typeof openJourney>>["page"];

interface CustomerRow {
  anonymized_at: Date | null;
  archived_at: Date | null;
  email: string | null;
  id: string;
  name: string;
  notes: string | null;
  organization_id: string;
  phone: string | null;
}

const CUSTOMER_COLUMNS =
  "id, organization_id, name, phone, email, notes, archived_at, anonymized_at";

async function customersOf(sql: Sql, organizationId: string) {
  return (
    await sql.query<CustomerRow>(
      `SELECT ${CUSTOMER_COLUMNS} FROM customers WHERE organization_id = $1 ORDER BY id`,
      [organizationId]
    )
  ).rows;
}

async function customerById(sql: Sql, id: string) {
  const [row] = (
    await sql.query<CustomerRow>(
      `SELECT ${CUSTOMER_COLUMNS} FROM customers WHERE id = $1`,
      [id]
    )
  ).rows;
  return row as CustomerRow;
}

async function openNewCustomerForm(page: Page, name: string, email: string) {
  await page.goto("/customers");
  await page.getByRole("button", { name: "Novo cliente" }).click();
  const form = page.getByRole("dialog", { name: "Novo cliente" });
  await form.getByLabel("Nome", { exact: true }).fill(name);
  await form.getByRole("textbox", { name: EMAIL_FIELD }).fill(email);
  await form.getByRole("button", { name: "Cadastrar cliente" }).click();
  return form;
}

const POSSIBLE_DUPLICATES = "Encontramos possíveis clientes existentes";

/**
 * The suggestion of a possible duplicate (same e-mail without regard to case) is inside the store: "Criar mesmo
 * assim" makes a second customer and merges nothing, and another store that registers the same e-mail is not
 * offered anyone and keeps its row under its own organization. With the offline runtime on, the screen looks for
 * duplicates in the device's own storage and each store here is its own browser profile, so the screen only shows
 * that the local search offers nothing for the other store; the isolation of the server search between stores is
 * proven by calling `customer.findPossibleDuplicates` directly.
 */
test("cliente: duplicado sugerido na mesma loja; sem sugestão local na outra e busca do servidor isolada por loja", async ({
  browser,
  sql,
}, testInfo) => {
  const storeA = await openJourney(browser, testInfo, "cliente-duplicado");
  const organizationA = storeA.organizationId as string;
  const first = `Maria Primeira ${storeA.name}`;
  const second = `Maria Segunda ${storeA.name}`;
  const typedFirst = `Maria.${storeA.name}@Exemplo.com.br`;
  const typedSecond = typedFirst.toLowerCase();

  const firstForm = await openNewCustomerForm(storeA.page, first, typedFirst);
  await expect(
    storeA.page.getByRole("button", { name: `Mais ações para ${first}` })
  ).toBeVisible();
  await expect(firstForm).toBeHidden();
  await expect
    .poll(async () => (await customersOf(sql, organizationA)).length)
    .toBe(1);
  const [original] = await customersOf(sql, organizationA);
  expect(original?.name).toBe(first);

  const form = await openNewCustomerForm(storeA.page, second, typedSecond);
  await expect(
    form.getByRole("heading", { name: POSSIBLE_DUPLICATES })
  ).toBeVisible();
  await expect(
    form.getByRole("button", { name: `Usar existente: ${first}` })
  ).toBeVisible();
  expect(await customersOf(sql, organizationA)).toEqual([original]);

  await form.getByRole("button", { name: "Criar mesmo assim" }).click();
  await expect(
    storeA.page.getByRole("button", { name: `Mais ações para ${second}` })
  ).toBeVisible();
  await expect
    .poll(async () => (await customersOf(sql, organizationA)).length)
    .toBe(2);
  const rowsA = await customersOf(sql, organizationA);
  expect(new Set(rowsA.map((row) => row.id)).size).toBe(2);
  expect(rowsA.map((row) => row.name).sort()).toEqual([first, second].sort());
  expect(rowsA.find((row) => row.id === original?.id)).toEqual(original);

  const storeB = await openJourney(browser, testInfo, "cliente-duplicado-b");
  const organizationB = storeB.organizationId as string;
  expect(organizationB).not.toBe(organizationA);
  const third = `Maria Outra Loja ${storeB.name}`;
  const formB = await openNewCustomerForm(storeB.page, third, typedSecond);
  await expect(
    storeB.page.getByRole("button", { name: `Mais ações para ${third}` })
  ).toBeVisible();
  await expect(
    storeB.page.getByRole("heading", { name: POSSIBLE_DUPLICATES })
  ).toHaveCount(0);
  await expect(formB).toBeHidden();
  await expect
    .poll(() => customersOf(sql, organizationB))
    .toEqual([
      expect.objectContaining({ name: third, organization_id: organizationB }),
    ]);
  expect(await customersOf(sql, organizationA)).toEqual(rowsA);

  const searchOf = (store: typeof storeA, organizationId: string) =>
    store.user.rpc.customer.findPossibleDuplicates({
      email: typedSecond,
      organizationId,
    });
  await expect
    .poll(
      async () =>
        (await searchOf(storeA, organizationA)).matches
          .map((match) => match.customer.id)
          .sort(),
      { message: "a busca do servidor acha o e-mail dentro da loja A" }
    )
    .toEqual(rowsA.map((row) => row.id).sort());
  await expect
    .poll(
      async () =>
        (await searchOf(storeB, organizationB)).matches.map(
          (match) => match.customer.name
        ),
      {
        message: "a busca do servidor na loja B não devolve cliente da loja A",
      }
    )
    .toEqual([third]);
});

/**
 * Archive and restore keep the same customer (the id) and only move `archived_at`; anonymizing is asked twice,
 * "Cancelar" writes nothing, and the confirmed one scrubs the personal data and archives the customer while the
 * sale linked to it keeps its total and its link.
 */
test("cliente: arquivar, restaurar e anonimizar; a venda ligada não muda", async ({
  browser,
  sql,
}, testInfo) => {
  const zone = "America/Sao_Paulo";
  const journey = await openJourney(browser, testInfo, "cliente-ciclo", {
    organization: { timezone: zone },
  });
  const { page, user } = journey;
  const organizationId = journey.organizationId as string;
  const name = `Maria Ciclo ${journey.name}`;
  const control = `Maria Controle ${journey.name}`;
  const created = await user.rpc.customer.create({
    email: `ciclo.${journey.name}@exemplo.com.br`,
    name,
    notes: `Observação de ${journey.name}`,
    organizationId,
    phone: "11912345678",
  });
  const bystander = await user.rpc.customer.create({
    email: null,
    name: control,
    notes: null,
    organizationId,
    phone: "11987654321",
  });

  const product = await seedProduct(
    user.rpc,
    organizationId,
    "Agenda 2027",
    "30.00"
  );
  await seedStock(
    user.rpc,
    organizationId,
    product.variantId,
    3,
    "11.00",
    localDate(runT0(), zone)
  );
  const saleId = await seedCashSale(
    user.rpc,
    organizationId,
    [{ price: "30.00", quantity: 1, variantId: product.variantId }],
    new Date(runT0()).toISOString()
  );
  await user.rpc.sale.assignCustomer({
    customerId: created.id,
    expectedVersion: 0,
    organizationId,
    saleId,
  });

  const saleFacts = async () =>
    (
      await sql.query<{
        customer_id: string | null;
        link_version: number;
        total: string;
      }>(
        `SELECT l.customer_id, l.version AS link_version,
                (SELECT sum(i.quantity * i.charged_unit_price) FROM sale_items i WHERE i.sale_id = s.id)::text AS total
           FROM sales s JOIN sale_customer_links l ON l.sale_id = s.id
          WHERE s.id = $1`,
        [saleId]
      )
    ).rows.map((row) => ({
      customerId: row.customer_id,
      linkVersion: row.link_version,
      total: numericCents(row.total),
    }));
  const factsBefore = await saleFacts();
  expect(factsBefore).toEqual([
    { customerId: created.id, linkVersion: 1, total: cents("30,00") },
  ]);
  const rowOf = (id: string) => page.locator(`[data-customer-id="${id}"]`);
  const menuOf = (id: string, label: string) =>
    rowOf(id).getByRole("button", { name: `Mais ações para ${label}` });

  const anonymizeCalls: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("anonymizeForPrivacy")) {
      anonymizeCalls.push(request.url());
    }
  });
  await page.goto("/customers");
  await expect(rowOf(created.id)).toBeVisible();
  const active = await customerById(sql, created.id);
  expect(active.archived_at).toBeNull();

  // archive: out of the default list, `archived_at` set, same customer
  await menuOf(created.id, name).click();
  await page.getByRole("menuitem", { name: "Arquivar" }).click();
  await expect(rowOf(created.id)).toBeHidden();
  await expect
    .poll(async () => (await customerById(sql, created.id)).archived_at)
    .not.toBeNull();
  await page.getByRole("tab", { name: "Arquivados" }).click();
  await expect(rowOf(created.id)).toBeVisible();

  // restore: back in the default list, `archived_at` cleared, nothing else changed
  await menuOf(created.id, name).click();
  await page.getByRole("menuitem", { name: "Restaurar" }).click();
  await expect(rowOf(created.id)).toBeHidden();
  await expect
    .poll(async () => (await customerById(sql, created.id)).archived_at)
    .toBeNull();
  await page.getByRole("tab", { name: "Ativos" }).click();
  await expect(rowOf(created.id)).toBeVisible();
  const restored = await customerById(sql, created.id);
  expect(restored).toEqual(active);

  // anonymize: asked twice; "Cancelar" writes nothing
  await menuOf(created.id, name).click();
  await page.getByRole("menuitem", { name: "Anonimizar" }).click();
  const confirmation = page.getByRole("group", {
    name: `Confirmar a anonimização de ${name}`,
  });
  await expect(confirmation.getByText("Não dá para desfazer.")).toBeVisible();
  await confirmation.getByRole("button", { name: "Cancelar" }).click();
  await expect(confirmation).toBeHidden();
  await expect(rowOf(created.id)).toBeVisible();
  expect(anonymizeCalls).toEqual([]);
  expect(await customerById(sql, created.id)).toEqual(restored);

  await menuOf(created.id, name).click();
  await page.getByRole("menuitem", { name: "Anonimizar" }).click();
  await confirmation
    .getByRole("button", { name: "Anonimizar definitivamente" })
    .click();
  await expect(rowOf(created.id)).toBeHidden();
  expect(anonymizeCalls).toHaveLength(1);
  await expect
    .poll(async () => (await customerById(sql, created.id)).anonymized_at)
    .not.toBeNull();
  const scrubbed = await customerById(sql, created.id);
  expect(scrubbed).toEqual({
    anonymized_at: expect.any(Date),
    archived_at: expect.any(Date),
    email: null,
    id: created.id,
    name: "Cliente anonimizado",
    notes: null,
    organization_id: organizationId,
    phone: null,
  });
  expect(await saleFacts()).toEqual(factsBefore);

  // the row is in Arquivados with no way to edit or restore it; the other customer is as it was
  await page.getByRole("tab", { name: "Arquivados" }).click();
  const anonymized = rowOf(created.id);
  await expect(anonymized).toContainText("Cliente anonimizado");
  await expect(anonymized).toContainText("não dá para editar nem restaurar");
  await expect(anonymized.getByRole("button")).toHaveCount(0);
  await expect(page.getByText(name)).toHaveCount(0);
  await page.getByRole("tab", { name: "Ativos" }).click();
  await expect(rowOf(bystander.id)).toBeVisible();
  expect(await customerById(sql, bystander.id)).toEqual(
    expect.objectContaining({
      anonymized_at: null,
      archived_at: null,
      name: control,
      phone: "11987654321",
    })
  );
});
