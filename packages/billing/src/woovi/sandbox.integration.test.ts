import { describe, expect, it } from "vitest";
import { ProviderNotFoundError } from "../provider-port";
import { createWooviClient } from "./client";
import { alignWooviCustomer } from "./customer";
import { pickWooviSubscription } from "./mapper";
import { createWooviPort } from "./port";

/**
 * Against the real Woovi SANDBOX, only when asked for
 * (`WOOVI_SANDBOX_INTEGRATION=1` with `WOOVI_APP_ID` and
 * `WOOVI_BASE_URL=https://api.woovi-sandbox.com` in the environment). It aligns
 * the test customer (CPF de teste), creates one Pix Automático subscription
 * that starts in 7 days and cancels it, reads resources that do not exist, and
 * runs the port of the checkout (PR 6): journey 2 and journey 3, each given up
 * (`discardCheckout`) or cancelled (`cancelRenewal`) at once. Nothing is
 * printed: no AppID, no `emv`, no tax ID, no resource.
 */
const enabled =
  process.env.WOOVI_SANDBOX_INTEGRATION === "1" &&
  Boolean(process.env.WOOVI_APP_ID) &&
  process.env.WOOVI_BASE_URL === "https://api.woovi-sandbox.com";

/** The test CPF used by the spikes; never a real person's. */
const TEST_CPF = "52998224725";
const PAYER = {
  email: "pagadora-teste-polaris@example.com",
  name: "Pagadora Teste Polaris",
  taxId: TEST_CPF,
};

const client = () =>
  createWooviClient({
    appId: process.env.WOOVI_APP_ID ?? "",
    baseUrl: process.env.WOOVI_BASE_URL ?? "",
    fetch: (url: string, init: RequestInit) => fetch(url, init),
    timeoutMs: 8000,
  });

const todayInSaoPaulo = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(
    new Date()
  );

const sevenDaysLater = () => {
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
  }).format(new Date());
  const [year = 0, month = 1, day = 1] = today.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + 7))
    .toISOString()
    .slice(0, 10);
};

describe.skipIf(!enabled)("Woovi sandbox", () => {
  it("aligns the customer by CPF, then creates and cancels a Pix Automático subscription", async () => {
    const woovi = client();
    expect(["absent", "matches", "updated"]).toContain(
      await alignWooviCustomer(woovi, PAYER)
    );
    // aligned: a second pass finds the same name and e-mail
    expect(await alignWooviCustomer(woovi, PAYER)).toBe("matches");

    const created = pickWooviSubscription(
      await woovi.createSubscription(
        JSON.stringify({
          comment: "Polaris Pro mensal",
          correlationID: `pol_${crypto.randomUUID()}`,
          customer: { email: PAYER.email, name: PAYER.name, taxID: TEST_CPF },
          dayGenerateCharge: `${sevenDaysLater()}T00:00:00.000Z`,
          frequency: "MONTHLY",
          name: "Polaris Pro mensal",
          pixRecurringOptions: {
            journey: "ONLY_RECURRENCY",
            retryPolicy: "THREE_RETRIES_7_DAYS",
          },
          type: "PIX_RECURRING",
          value: 2490,
        })
      )
    );
    try {
      expect(created.cycleMonths).toBe(1);
      expect(created.journey).toBe("ONLY_RECURRENCY");
      const read = pickWooviSubscription(
        await woovi.getSubscription(created.id)
      );
      expect(read.id).toBe(created.id);
      // nothing before the payer approves (AC-20)
      expect(read.authorization).toBeNull();
      expect(await woovi.listSubscriptionInstallments(created.id)).toEqual([]);
    } finally {
      await woovi.cancelSubscription(created.id);
    }
    // cancelling again is safe
    await woovi.cancelSubscription(created.id);
    const cancelled = pickWooviSubscription(
      await woovi.getSubscription(created.id)
    );
    expect(cancelled.status).toBe("INACTIVE");
  }, 60_000);

  it("a subscription or an installment that does not exist is a 404, the unresolved case", async () => {
    const woovi = client();
    const zeros = "000000000000000000000000";
    await expect(
      woovi.getSubscription(btoa(`PaymentSubscription:${zeros}`))
    ).rejects.toBeInstanceOf(ProviderNotFoundError);
    await expect(
      woovi.getInstallment(btoa(`PaymentSubscriptionInstallment:${zeros}`))
    ).rejects.toBeInstanceOf(ProviderNotFoundError);
  }, 30_000);

  it("the port prepares journey 2 (trial) and journey 3 (no trial), and gives each up", async () => {
    const port = createWooviPort({
      appId: process.env.WOOVI_APP_ID ?? "",
      baseUrl: process.env.WOOVI_BASE_URL ?? "",
      fetch: (url: string, init: RequestInit) => fetch(url, init),
      // the test customer is shared by every run: it is never another organization's
      heldByAnotherOrganization: () => Promise.resolve(false),
      randomUuid: () => crypto.randomUUID(),
      timeoutMs: 8000,
    });
    const organizationId = `sandbox-${crypto.randomUUID()}`;

    const trial = await port.prepareSubscription({
      amount: "24.90",
      cycleMonths: 1,
      firstChargeOn: sevenDaysLater(),
      organizationId,
      payer: PAYER,
      trial: true,
    });
    try {
      expect(trial.providerRef).toBe(trial.checkoutId);
      expect(trial.handoff.kind).toBe("pix_authorization");
      expect(["absent", "matches", "updated"]).toContain(
        trial.customerAlignment
      );
      // not approved: nothing was subscribed yet
      expect(await port.hasSubscription(trial.providerRef)).toBe(false);
    } finally {
      expect(await port.discardCheckout(trial.checkoutId)).toBe("discarded");
    }
    expect(await port.discardCheckout(trial.checkoutId)).toBe("already_closed");

    const paidOnApproval = await port.prepareSubscription({
      amount: "249.00",
      cycleMonths: 12,
      firstChargeOn: todayInSaoPaulo(),
      organizationId,
      payer: PAYER,
      trial: false,
    });
    try {
      expect(paidOnApproval.customerAlignment).toBe("matches");
      expect(
        pickWooviSubscription(
          await client().getSubscription(paidOnApproval.providerRef)
        ).journey
      ).toBe("PAYMENT_ON_APPROVAL");
      expect(
        await port.readState(paidOnApproval.providerRef, new Date())
      ).toEqual([]);
    } finally {
      expect(await port.cancelRenewal(paidOnApproval.providerRef)).toBe(
        "cancelled"
      );
    }
    expect(await port.cancelRenewal(paidOnApproval.providerRef)).toBe(
      "already_cancelled"
    );
  }, 90_000);
});
