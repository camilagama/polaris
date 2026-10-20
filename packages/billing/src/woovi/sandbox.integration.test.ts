import { describe, expect, it } from "vitest";
import { ProviderNotFoundError } from "../provider-port";
import { createWooviClient } from "./client";
import { alignWooviCustomer } from "./customer";
import { pickWooviSubscription } from "./mapper";
import { createWooviPort } from "./port";

/**
 * Against the real Woovi SANDBOX, only when asked for
 * (`WOOVI_SANDBOX_INTEGRATION=1` with `WOOVI_APP_ID` and
 * `WOOVI_BASE_URL=https://api.woovi-sandbox.com` in the environment). Each run
 * makes its own payer: a random `polaris-payer-<32 hex>` key and a random valid
 * test CPF, so no run meets the customer of another. It reads a key Woovi does
 * not know, creates the customer, reads it back by the key, creates one Pix
 * Automático subscription that starts in 7 days and cancels it, reads resources
 * that do not exist, and runs the port of the checkout (PR 6): journey 2 and
 * journey 3, each given up (`discardCheckout`) or cancelled (`cancelRenewal`)
 * at once. No refund is called. Nothing is printed: no AppID, no `emv`, no tax
 * ID, no resource.
 */
const enabled =
  process.env.WOOVI_SANDBOX_INTEGRATION === "1" &&
  Boolean(process.env.WOOVI_APP_ID) &&
  process.env.WOOVI_BASE_URL === "https://api.woovi-sandbox.com";

/**
 * A valid CPF (check digits computed) made at random for this run. It may be
 * someone's: it only ever goes to the sandbox, and nothing of it is printed.
 * Each run leaves a customer there (Woovi has no route to delete one).
 */
function randomTestCpf(): string {
  for (;;) {
    const digits = Array.from({ length: 9 }, () =>
      Math.floor(Math.random() * 10)
    );
    // 111.111.111-11 and the like pass the check but Woovi refuses them
    if (digits.every((digit) => digit === digits[0])) {
      continue;
    }
    for (const length of [9, 10]) {
      const sum = digits
        .slice(0, length)
        .reduce(
          (total, digit, index) => total + digit * (length + 1 - index),
          0
        );
      const rest = (sum * 10) % 11;
      digits.push(rest === 10 ? 0 : rest);
    }
    return digits.join("");
  }
}

/** A key of the shape Polaris makes (`polaris-payer-` and 32 hex), random for this run. */
const randomPayerKey = () =>
  `polaris-payer-${crypto.randomUUID().replaceAll("-", "")}`;

const TEST_CPF = randomTestCpf();
const PAYER_KEY = randomPayerKey();
const PAYER = {
  correlationId: PAYER_KEY,
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
  it("looks the customer up by its key, creates it, then finds it again", async () => {
    const woovi = client();
    // a key Woovi does not know is an absent customer, not an error
    expect(await woovi.getCustomer(randomPayerKey())).toBeNull();
    expect(await woovi.getCustomer(PAYER_KEY)).toBeNull();

    expect(await alignWooviCustomer(woovi, PAYER)).toBe("created");
    expect(await woovi.getCustomer(PAYER_KEY)).toMatchObject({
      correlationID: PAYER_KEY,
    });
    // created: a second pass finds the same key, document, name and e-mail
    expect(await alignWooviCustomer(woovi, PAYER)).toBe("matches");
  }, 60_000);

  it("creates and cancels a Pix Automático subscription for the customer", async () => {
    const woovi = client();
    expect(["created", "matches"]).toContain(
      await alignWooviCustomer(woovi, PAYER)
    );

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
      randomUuid: () => crypto.randomUUID(),
      timeoutMs: 8000,
    });
    // the port gets the payer's key from the server; this run's customer may already exist
    const payer = {
      customerKey: PAYER_KEY,
      email: PAYER.email,
      name: PAYER.name,
      taxId: PAYER.taxId,
    };

    const trial = await port.prepareSubscription({
      amount: "24.90",
      cycleMonths: 1,
      firstChargeOn: sevenDaysLater(),
      payer,
      trial: true,
    });
    try {
      expect(trial.providerRef).toBe(trial.checkoutId);
      expect(trial.handoff.kind).toBe("pix_authorization");
      expect(["created", "matches"]).toContain(trial.customerAlignment);
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
      payer,
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
