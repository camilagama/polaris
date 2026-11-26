import type { Page } from "@playwright/test";
import { extremeTimeZone, localDate } from "../calendar";
import { expect, openJourney, runT0, test } from "../fixtures";
import { cents, numericCents, percentOfCents } from "../oracle";
import { chainValue } from "../pages/resultado";
import { choose, confirmSale, fillSale } from "../pages/venda";
import { seedProduct, seedStock } from "../seed";

const PROFILE = "Maquininha da jornada";
const SHIRT = /Camiseta lisa/;
const PROCESSING_FEES = "(−) Taxas de processamento";
const SALE_CENTS = 10_000;
const FIRST_PERCENT = "3,5";
const SECOND_PERCENT = "4,2";
const OTHER_PROFILE = "Outra forma da jornada";

type Sql = Parameters<Parameters<typeof test>[2]>[0]["sql"];

interface StoredProfile {
  archived: boolean;
  name: string;
  rules: { method: string; mode: string; percentage: number | null }[];
  version: number;
}

async function storedProfiles(
  sql: Sql,
  organizationId: string
): Promise<StoredProfile[]> {
  const profiles = (
    await sql.query<{
      archived: boolean;
      id: string;
      name: string;
      version: number;
    }>(
      `SELECT id, name, version, archived_at IS NOT NULL AS archived
         FROM payment_profiles WHERE organization_id = $1 ORDER BY created_at`,
      [organizationId]
    )
  ).rows;
  return Promise.all(
    profiles.map(async (profile) => ({
      archived: profile.archived,
      name: profile.name,
      rules: (
        await sql.query<{
          method: string;
          mode: string;
          percentage: string | null;
        }>(
          `SELECT method, processing_fee_mode AS mode, processing_fee_percentage::text AS percentage
             FROM payment_profile_rules
            WHERE organization_id = $1 AND payment_profile_id = $2 AND archived_at IS NULL`,
          [organizationId, profile.id]
        )
      ).rows.map((rule) => ({
        method: rule.method,
        mode: rule.mode,
        percentage: rule.percentage === null ? null : Number(rule.percentage),
      })),
      version: profile.version,
    }))
  );
}

async function storedPayments(sql: Sql, organizationId: string) {
  return (
    await sql.query<{
      amount: string;
      fee: string | null;
      fee_mode: string | null;
      fee_percentage: string | null;
      method: string;
      profile_id: string | null;
      profile_name: string | null;
      profile_version: number | null;
    }>(
      `SELECT p.method, p.amount::text AS amount, p.payment_profile_id AS profile_id,
              p.payment_profile_name_snapshot AS profile_name,
              p.payment_profile_version_snapshot AS profile_version,
              p.processing_fee_mode_snapshot AS fee_mode,
              p.processing_fee_percentage_snapshot::text AS fee_percentage,
              p.processing_fee_amount_snapshot::text AS fee
         FROM sale_payments p WHERE p.organization_id = $1 ORDER BY p.position`,
      [organizationId]
    )
  ).rows.map((row) => ({
    amount: numericCents(row.amount),
    fee: row.fee === null ? null : numericCents(row.fee),
    feeMode: row.fee_mode,
    feePercentage:
      row.fee_percentage === null ? null : Number(row.fee_percentage),
    method: row.method,
    profileId: row.profile_id,
    profileName: row.profile_name,
    profileVersion: row.profile_version,
  }));
}

const profileRow = (page: Page) =>
  page.locator("[data-profile-id]").filter({ hasText: PROFILE });

async function openProfiles(page: Page) {
  await page.goto("/payment-profiles");
  await expect(
    page.getByRole("heading", { exact: true, name: "Formas de receber" })
  ).toBeVisible();
}

async function createProfile(page: Page) {
  await page.getByRole("button", { name: "Novo perfil" }).first().click();
  const form = page.getByRole("dialog", { name: "Novo perfil" });
  await form.getByLabel("Nome do perfil").fill(PROFILE);
  await choose(page, form, "Método", "Pix");
  await choose(
    page,
    form.getByRole("group", { name: "Taxa de processamento" }),
    "Como a taxa é informada",
    "Percentual"
  );
  await form
    .getByRole("group", { name: "Taxa de processamento" })
    .getByLabel("Percentual efetivo sobre o total devido")
    .fill(FIRST_PERCENT);
  await form.getByRole("button", { name: "Criar perfil" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText(`Perfil “${PROFILE}” criado.`)).toBeVisible();
}

async function sellWithProfile(page: Page) {
  await page.goto("/sales");
  await fillSale(
    page,
    [
      {
        charged: "100,00",
        option: SHIRT,
        quantity: 1,
        search: "Camiseta",
      },
    ],
    []
  );
  await page
    .getByRole("radiogroup", { name: "Método de pagamento" })
    .getByRole("radio", { name: "Pix" })
    .check();
  await choose(page, page, "Perfil de pagamento", PROFILE);
  await confirmSale(page);
}

async function expectProcessingFees(page: Page, expected: number) {
  await page.goto("/dashboard");
  await expect(chainValue(page, PROCESSING_FEES)).toContainText("R$");
  await expect
    .poll(async () =>
      Math.abs(cents(await chainValue(page, PROCESSING_FEES).innerText()))
    )
    .toBe(expected);
}

/**
 * The Formas de receber screen against the real database, from the registration to the sale and back: a profile with
 * a percentage fee is created on screen, a sale snapshots its version and the fee in cents, and neither editing nor
 * archiving the profile touches that sale, the Resultado's fee line included. The expected fee comes from the
 * hand-written oracle, never from the domain.
 */
test("forma de receber: cadastrada, vendida, editada e arquivada sem mexer na venda antiga", async ({
  browser,
  sql,
}, testInfo) => {
  test.setTimeout(180_000);
  const zone = extremeTimeZone(runT0());
  const journey = await openJourney(browser, testInfo, "forma-de-receber", {
    organization: { timezone: zone },
  });
  const { page, user } = journey;
  const organizationId = journey.organizationId as string;
  const shirt = await seedProduct(
    user.rpc,
    organizationId,
    "Camiseta lisa",
    "100.00"
  );
  await seedStock(
    user.rpc,
    organizationId,
    shirt.variantId,
    5,
    "40.00",
    localDate(runT0(), zone)
  );
  const firstFee = percentOfCents(SALE_CENTS, FIRST_PERCENT);
  expect(firstFee, "oracle").toBe(350);

  // AC-3.1: one row, version 1, the percentage as typed, "Ativo" in the list
  await openProfiles(page);
  await createProfile(page);
  await expect(profileRow(page)).toContainText("Ativo");
  expect(await storedProfiles(sql, organizationId)).toEqual([
    {
      archived: false,
      name: PROFILE,
      rules: [{ method: "pix", mode: "percentage", percentage: 3.5 }],
      version: 1,
    },
  ]);

  // AC-3.2: the sale snapshots the profile, its version and the fee in cents
  await sellWithProfile(page);
  await expect
    .poll(async () => (await storedPayments(sql, organizationId)).length)
    .toBe(1);
  const [profile] = (
    await sql.query<{ id: string }>(
      "SELECT id FROM payment_profiles WHERE organization_id = $1",
      [organizationId]
    )
  ).rows;
  expect(profile?.id).toBeDefined();
  const sold = {
    amount: SALE_CENTS,
    fee: firstFee,
    feeMode: "percentage",
    feePercentage: 3.5,
    method: "pix",
    profileId: profile?.id,
    profileName: PROFILE,
    profileVersion: 1,
  };
  expect(await storedPayments(sql, organizationId)).toEqual([sold]);
  await expectProcessingFees(page, firstFee);

  // AC-3.3: editing the fee raises the version to 2; the sale keeps version 1 and the old fee
  await openProfiles(page);
  await page
    .getByRole("button", { name: `Mais ações para ${PROFILE}` })
    .click();
  await page
    .getByRole("menuitem", { name: `Editar perfil ${PROFILE}` })
    .click();
  const editForm = page.getByRole("dialog", { name: "Editar perfil" });
  await editForm
    .getByRole("group", { name: "Taxa de processamento" })
    .getByLabel("Percentual efetivo sobre o total devido")
    .fill(SECOND_PERCENT);
  await editForm.getByRole("button", { name: "Salvar alterações" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect
    .poll(async () => (await storedProfiles(sql, organizationId))[0]?.version)
    .toBe(2);
  expect(await storedProfiles(sql, organizationId)).toEqual([
    {
      archived: false,
      name: PROFILE,
      rules: [{ method: "pix", mode: "percentage", percentage: 4.2 }],
      version: 2,
    },
  ]);
  expect(await storedPayments(sql, organizationId)).toEqual([sold]);
  await expectProcessingFees(page, firstFee);

  // AC-3.4: archived, the list says "Arquivado", Vender no longer offers it, the sale stays as it was
  // a second active profile is the proof that the list of Vender loaded when the archived one is missing from it
  const noFee = { fixedAmount: null, mode: "none" as const, percentage: null };
  await user.rpc.paymentProfile.create({
    name: OTHER_PROFILE,
    organizationId,
    rules: [
      {
        anticipationFee: noFee,
        expectedSettlementDays: 1,
        installmentPlan: null,
        installments: null,
        method: "pix",
        processingFee: noFee,
      },
    ],
  });
  await openProfiles(page);
  await page
    .getByRole("button", { name: `Mais ações para ${PROFILE}` })
    .click();
  await page
    .getByRole("menuitem", { name: `Arquivar perfil ${PROFILE}` })
    .click();
  await expect(page.getByText(`Perfil “${PROFILE}” arquivado.`)).toBeVisible();
  await expect(profileRow(page)).toHaveCount(0);
  await page.getByRole("checkbox", { name: "Incluir arquivados" }).check();
  await expect(profileRow(page)).toContainText("Arquivado");
  await expect
    .poll(async () => (await storedProfiles(sql, organizationId))[0]?.archived)
    .toBe(true);

  await page.goto("/sales");
  await page
    .getByRole("radiogroup", { name: "Método de pagamento" })
    .getByRole("radio", { name: "Pix" })
    .check();
  await page
    .getByRole("combobox", { exact: true, name: "Perfil de pagamento" })
    .click();
  await expect(
    page.getByRole("option", { exact: true, name: OTHER_PROFILE })
  ).toBeVisible();
  await expect(
    page.getByRole("option", { exact: true, name: PROFILE })
  ).toHaveCount(0);
  expect(await storedPayments(sql, organizationId)).toEqual([sold]);
  await expectProcessingFees(page, firstFee);
});
