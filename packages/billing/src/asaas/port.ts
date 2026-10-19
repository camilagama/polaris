import { isValidCalendarDate } from "@polaris/domain/inventory/calendar-date";
import type { FetchLike } from "../http";
import { AMOUNT_PLACEHOLDER, stringifyWithAmount } from "../json";
import type {
  BillingProviderPort,
  CheckoutReturnUrls,
  PrepareSubscriptionInput,
  ProviderBillingEvent,
} from "../provider-port";
import { createAsaasClient } from "./client";
import { newPolarisReference } from "./ids";
import {
  type AsaasPayment,
  asaasCycle,
  pickAsaasCheckout,
  pickAsaasPayment,
  reconcileAsaasSubscription,
  refundableCharge,
  subscriptionsOfCheckout,
} from "./mapper";

/** How long the payer has to finish the hosted checkout. */
const CHECKOUT_MINUTES_TO_EXPIRE = 60;
const CYCLE_LABELS: Readonly<Record<number, string>> = {
  1: "mensal",
  6: "semestral",
  12: "anual",
};

export interface AsaasPortConfig {
  apiKey: string;
  /** The app's own origin (`BETTER_AUTH_BASE_URL`): the checkout's return URLs are built on it, on the server. */
  appBaseUrl: string;
  baseUrl: string;
  fetch: FetchLike;
  /** A fresh UUID v4 per checkout (`crypto.randomUUID`); injected so a test can name it. */
  randomUuid: () => string;
  timeoutMs: number;
}

/**
 * Where the provider's page sends the payer back, built from the app's origin.
 * The client never names these URLs: an open redirect through the checkout
 * would otherwise be one request away.
 */
export function checkoutReturnUrls(appBaseUrl: string): CheckoutReturnUrls {
  const url = URL.parse(appBaseUrl);
  const local = url?.protocol === "http:" && url.hostname === "localhost";
  if (!(url && (url.protocol === "https:" || local))) {
    throw new TypeError("invalid_app_base_url");
  }
  const { origin } = url;
  const back = (result: string) => `${origin}/?assinatura=${result}`;
  return {
    cancelUrl: back("cancelada"),
    returnUrl: back("expirada"),
    successUrl: back("concluida"),
  };
}

/**
 * The checkout request: a hosted Asaas page for a recurring card charge
 * (`RECURRENT`, `CREDIT_CARD`), the first charge on `firstChargeOn`. Polaris
 * sends no payer data: the payer types it on Asaas's page (ADR 0101, B7). The
 * opaque `pol_<uuid>` still goes in `externalReference`, but Asaas does not carry
 * it to the subscription (S1.3): the facts are tied to the organization by the
 * checkout's ID (`checkoutSession`), which is the `providerRef`.
 */
function checkoutBody(
  input: PrepareSubscriptionInput,
  reference: string,
  urls: CheckoutReturnUrls
): string {
  if (input.payer.taxId !== undefined) {
    // the card path never takes a tax ID (ADR 0101): only Pix Automático needs one
    throw new TypeError("tax_id_not_accepted_for_card");
  }
  if (!isValidCalendarDate(input.firstChargeOn)) {
    throw new TypeError("invalid_first_charge_date");
  }
  const cycle = asaasCycle(input.cycleMonths);
  return stringifyWithAmount(
    {
      billingTypes: ["CREDIT_CARD"],
      callback: {
        cancelUrl: urls.cancelUrl,
        expiredUrl: urls.returnUrl,
        successUrl: urls.successUrl,
      },
      chargeTypes: ["RECURRENT"],
      externalReference: reference,
      items: [
        {
          name: `Polaris Pro ${CYCLE_LABELS[input.cycleMonths] ?? cycle}`,
          quantity: 1,
          value: AMOUNT_PLACEHOLDER,
        },
      ],
      minutesToExpire: CHECKOUT_MINUTES_TO_EXPIRE,
      // a date in São Paulo, as Asaas reads it: it answers in UTC, but the day is the one sent
      subscription: { cycle, nextDueDate: `${input.firstChargeOn} 00:00:00` },
    },
    input.amount
  );
}

/** The outbound port to Asaas (cartão recorrente pelo checkout hospedado). */
export function createAsaasPort(config: AsaasPortConfig): BillingProviderPort {
  const client = createAsaasClient(config);

  /** `providerRef` is the checkout's ID: the subscription it created carries it as `checkoutSession`. */
  async function subscriptionsOf(providerRef: string) {
    return subscriptionsOfCheckout(
      await client.listSubscriptionsByCheckout(providerRef),
      providerRef
    );
  }
  async function chargesOf(subscriptionId: string): Promise<AsaasPayment[]> {
    return (await client.listSubscriptionPayments(subscriptionId)).map(
      pickAsaasPayment
    );
  }

  return {
    async cancelRenewal(providerRef) {
      const subscriptions = await subscriptionsOf(providerRef);
      const live = subscriptions.filter((entry) => !entry.deleted);
      if (subscriptions.length === 0) {
        return "nothing_to_cancel";
      }
      if (live.length === 0) {
        return "already_cancelled";
      }
      for (const subscription of live) {
        // biome-ignore lint/performance/noAwaitInLoops: One subscription per reference, in practice.
        await client.deleteSubscription(subscription.id);
      }
      return "cancelled";
    },
    async discardCheckout(checkoutId) {
      await client.cancelCheckout(checkoutId);
    },
    async prepareSubscription(input) {
      const reference = newPolarisReference(config.randomUuid());
      const body = checkoutBody(
        input,
        reference,
        checkoutReturnUrls(config.appBaseUrl)
      );
      const checkout = pickAsaasCheckout(await client.createCheckout(body));
      return {
        checkoutId: checkout.id,
        handoff: { kind: "redirect", url: checkout.link },
        // the provider copies the checkout's ID into the subscription, not the reference
        providerRef: checkout.id,
      };
    },
    provider: "asaas",
    async readState(providerRef, now) {
      const events: ProviderBillingEvent[] = [];
      for (const subscription of await subscriptionsOf(providerRef)) {
        // biome-ignore lint/performance/noAwaitInLoops: One subscription per reference, in practice.
        const payments = await chargesOf(subscription.id);
        events.push(
          ...reconcileAsaasSubscription({ now, payments, subscription })
        );
      }
      return events;
    },
    async refundCurrentPeriod(providerRef, now) {
      // read first: a refund of a charge that is not paid is a 400 whose text says nothing usable
      for (const subscription of await subscriptionsOf(providerRef)) {
        const charge = refundableCharge(
          // biome-ignore lint/performance/noAwaitInLoops: One subscription per reference, in practice.
          await chargesOf(subscription.id),
          subscription,
          now
        );
        if (charge) {
          await client.refundPayment(charge.id);
          return "refund_requested";
        }
      }
      return "nothing_to_refund";
    },
  };
}
