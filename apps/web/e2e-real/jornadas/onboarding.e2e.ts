import { localDate } from "../calendar";
import { expect, openJourney, runT0, test } from "../fixtures";

/**
 * Journey 1: a user with no organization opens one on screen; the database has one, owned by the user, in the zone
 * chosen on the screen. The screen offers the zones of Brazil; Fernando de Noronha is the one that is not the default.
 * The extreme zones (+14 h, −11 h) are covered by the journeys that open the organization by the API.
 */
test("onboarding: abre a loja com nome e fuso, e repetir não duplica", async ({
  browser,
  sql,
}, testInfo) => {
  const journey = await openJourney(browser, testInfo, "onboarding", {
    organization: false,
  });
  const { page } = journey;
  const zone = "America/Noronha";
  console.log(
    `fuso da loja: ${zone} (data local ${localDate(runT0(), zone)}, UTC ${localDate(runT0(), "UTC")})`
  );

  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Abra a sua loja" })
  ).toBeVisible();
  await page.getByLabel("Nome da loja").fill(journey.name);
  await page.getByRole("combobox", { name: "Horário da loja" }).click();
  await page
    .getByRole("option", { name: "Horário de Fernando de Noronha" })
    .click();
  await page.getByRole("button", { name: "Abrir loja" }).click();
  await expect(
    page.getByRole("heading", { name: "Abra a sua loja" })
  ).toBeHidden();
  await expect(
    page.getByRole("navigation").getByRole("link", { name: "Vender" }).first()
  ).toBeVisible();
  // the store opens on the Início with the checklist of a store with no sale (AC-22): the next step is the product
  const checklist = page.getByRole("region", { name: "Primeiros passos" });
  await expect(checklist).toContainText("Loja criada");
  await expect(
    checklist.getByRole("link", { name: "Cadastrar produto" })
  ).toHaveAttribute("href", "/products?novo=1");

  const organizations = async () =>
    (
      await sql.query<{
        id: string;
        name: string;
        timezone: string;
        role: string;
        user_id: string;
      }>(
        `SELECT o.id, o.name, o.timezone, m.role, m.user_id
           FROM organizations o JOIN memberships m ON m.organization_id = o.id
          WHERE m.user_id = $1`,
        [journey.user.id]
      )
    ).rows;
  await expect.poll(organizations).toHaveLength(1);
  const [organization] = await organizations();
  expect(organization).toMatchObject({
    name: journey.name,
    role: "owner",
    timezone: zone,
  });

  // the same command again (another tab, a double tap): the same organization, nothing new
  const again = await journey.user.rpc.organization.createInitial({
    name: `${journey.name}-outra`,
    timezone: "Etc/UTC",
  });
  expect(again.created).toBe(false);
  expect(again.organization.id).toBe(organization?.id);
  expect(await organizations()).toHaveLength(1);
  // the zone is accepted by the server's "today" too: a read that needs it answers
  await expect(
    journey.user.rpc.report.periodSummary({
      from: localDate(runT0(), zone),
      organizationId: organization?.id as string,
      to: localDate(runT0(), zone),
    })
  ).resolves.toBeTruthy();
});
