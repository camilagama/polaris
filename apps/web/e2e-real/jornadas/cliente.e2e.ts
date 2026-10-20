import { localDate } from "../calendar";
import { expect, openJourney, runT0, test } from "../fixtures";
import { confirmSale, fillSale } from "../pages/venda";
import { seedProduct, seedStock } from "../seed";

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
  await page.getByLabel("Nome", { exact: true }).fill(name);
  await page.getByLabel("Telefone").fill("+55 11 91234-5678");
  await page
    .getByRole("textbox", { name: EMAIL_FIELD })
    .fill(`maria.${journey.name}@exemplo.com.br`);
  await page.getByRole("button", { name: "Cadastrar cliente" }).click();
  await expect(
    page.getByRole("button", { name: `Editar cliente ${name}` })
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
  await confirmed
    .getByLabel("Cliente", { exact: true })
    .selectOption({ label: name });
  await confirmed.getByRole("button", { name: "Associar cliente" }).click();
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
