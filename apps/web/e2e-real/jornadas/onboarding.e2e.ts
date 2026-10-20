import { extremeTimeZone, localDate } from "../calendar";
import { expect, openJourney, runT0, test } from "../fixtures";

/** Journey 1: a user with no organization opens one on screen; the database has one, owned by the user, in the zone. */
test("onboarding: abre a organização com nome e fuso, e repetir não duplica", async ({ browser, sql }, testInfo) => {
  const journey = await openJourney(browser, testInfo, "onboarding", { organization: false });
  const { page } = journey;
  const zone = extremeTimeZone(runT0());
  console.log(`fuso da organização: ${zone} (data local ${localDate(runT0(), zone)}, UTC ${localDate(runT0(), "UTC")})`);

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Abra a sua organização" })).toBeVisible();
  await page.getByLabel("Nome da organização").fill(journey.name);
  await page.getByLabel("Fuso horário da organização").fill(zone);
  await page.getByRole("button", { name: "Criar ou abrir organização" }).click();
  await expect(page.getByRole("heading", { name: "Abra a sua organização" })).toBeHidden();
  await expect(page.getByRole("navigation").getByRole("link", { name: "Vender" }).first()).toBeVisible();

  const organizations = async () =>
    (
      await sql.query<{ id: string; name: string; timezone: string; role: string; user_id: string }>(
        `SELECT o.id, o.name, o.timezone, m.role, m.user_id
           FROM organizations o JOIN memberships m ON m.organization_id = o.id
          WHERE m.user_id = $1`,
        [journey.user.id]
      )
    ).rows;
  await expect.poll(organizations).toHaveLength(1);
  const [organization] = await organizations();
  expect(organization).toMatchObject({ name: journey.name, role: "owner", timezone: zone });

  // the same command again (another tab, a double tap): the same organization, nothing new
  const again = await journey.user.rpc.organization.createInitial({ name: `${journey.name}-outra`, timezone: "Etc/UTC" });
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
