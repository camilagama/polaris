import {
  createJourneyUser,
  expect,
  openJourney,
  refusedWith,
  test,
} from "../fixtures";
import { journeyClientIp } from "../journey-names";
import {
  ensureRunEnvironment,
  unsubscribeTokenSecretOf,
} from "../run-environment";
import {
  createUnsubscribeToken,
  TIPS_STOP_PATH,
  UNSUBSCRIBE_TOKEN_PARAMETER,
} from "../../src/server/tips-stop/unsubscribe-token";

const ZONE = "America/Sao_Paulo";
const SEUS_DADOS = "/configuracoes?aba=seus-dados";

/**
 * Journey: the preference of the tips e-mails has two doors, the link of the e-mail and the switch in Seus dados, and
 * they are one preference. Turning it off by the link (what the mail reader posts, no `Origin`) shows "off" on the
 * screen; turning it on by the screen takes the row away; off again by the screen is what the link would have
 * written. A second account, with its own store, never moves with the first (AC-8b.1, AC-8b.6a).
 */
test("dicas: desligar pelo link do e-mail vale na tela, religar pela tela volta a valer, e outra conta não se mexe", async ({
  browser,
  sql,
}, testInfo) => {
  const journey = await openJourney(browser, testInfo, "dicas-duas-portas", {
    organization: { timezone: ZONE },
  });
  const { page, user } = journey;
  const organizationId = journey.organizationId as string;
  const origin = String(testInfo.project.use.baseURL);

  const other = await createJourneyUser(origin, `${journey.name}-b`);
  const otherStore = await other.rpc.organization.createInitial({
    name: `${journey.name}-b`,
    timezone: ZONE,
  });
  const otherOrganizationId = otherStore.organization.id;

  const optedOut = async (userId: string) =>
    (
      await sql.query<{ user_id: string }>(
        "SELECT user_id FROM email_opt_outs WHERE user_id = $1",
        [userId]
      )
    ).rows.length === 1;
  const tips = page.getByRole("switch", { name: "Dicas para começar" });

  await page.goto(SEUS_DADOS);
  await expect(tips).toBeChecked();
  expect(await optedOut(user.id)).toBe(false);

  // door 1: the link of the e-mail, posted the way a mail reader does it
  const token = await createUnsubscribeToken(
    { current: unsubscribeTokenSecretOf(ensureRunEnvironment().secret) },
    user.id
  );
  const posted = await page.request.post(
    `${origin}${TIPS_STOP_PATH}?${UNSUBSCRIBE_TOKEN_PARAMETER}=${encodeURIComponent(token)}`,
    {
      data: "List-Unsubscribe=One-Click",
      headers: {
        "cf-connecting-ip": journeyClientIp(`${journey.name}-link`),
        "content-type": "application/x-www-form-urlencoded",
      },
    }
  );
  expect(posted.status()).toBe(200);
  expect(await optedOut(user.id)).toBe(true);

  await page.goto(SEUS_DADOS);
  await expect(tips).not.toBeChecked();

  // the other account is where it was, on the screen's own read and in the table
  expect(await optedOut(other.id)).toBe(false);
  await expect(
    other.rpc.account.emailPreference({ organizationId: otherOrganizationId })
  ).resolves.toEqual({ sent: 0, tips: true });

  // door 2: the screen turns it on again, and the row of the link is gone
  await tips.click();
  await expect(tips).toBeChecked();
  await expect(
    page.getByRole("status").filter({ hasText: "Salvo." })
  ).toBeVisible();
  await expect.poll(() => optedOut(user.id)).toBe(false);
  await page.reload();
  await expect(tips).toBeChecked();

  // and off again by the screen is the same row the link writes
  await tips.click();
  await expect(tips).not.toBeChecked();
  await expect.poll(() => optedOut(user.id)).toBe(true);
  await page.reload();
  await expect(tips).not.toBeChecked();

  // the second account writes only its own row, and the first one keeps what it chose
  await other.rpc.account.setTips({
    on: false,
    organizationId: otherOrganizationId,
  });
  expect(await optedOut(other.id)).toBe(true);
  await other.rpc.account.setTips({
    on: true,
    organizationId: otherOrganizationId,
  });
  expect(await optedOut(other.id)).toBe(false);
  expect(await optedOut(user.id)).toBe(true);
  await expect(
    user.rpc.account.emailPreference({ organizationId })
  ).resolves.toEqual({ sent: 0, tips: false });

  // a store that is not theirs does not open the preference of anybody (capability and membership)
  expect(
    await refusedWith(other.rpc.account.emailPreference({ organizationId }))
  ).toBe("FORBIDDEN");
});
