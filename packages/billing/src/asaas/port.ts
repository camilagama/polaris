import { isValidCalendarDate } from "@polaris/domain/inventory/calendar-date";
import type { FetchLike } from "../http";
import { AMOUNT_PLACEHOLDER, stringifyWithAmount } from "../json";
import {
  assertFirstCharge,
  type BillingProviderPort,
  type CheckoutReturnUrls,
  type PrepareSubscriptionInput,
  type ProviderBillingEvent,
  ProviderNotFoundError,
  ProviderRejectedError,
  ProviderResponseMalformedError,
  requireRecordedFirstCharge,
} from "../provider-port";
import { createAsaasClient } from "./client";
import { asaasPaymentPageUrl } from "./payment-page";
import { newPolarisReference } from "./ids";
import {
  type AsaasPayment,
  asaasCycle,
  chargePeriodEndsAt,
  overdueCharge,
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
 * Where the provider's page sends the payer back, built from the app's origin: the Assinatura screen, which reads
 * the plan again. The client never names these URLs: an open redirect through the checkout
 * would otherwise be one request away.
 */
export function checkoutReturnUrls(appBaseUrl: string): CheckoutReturnUrls {
  const url = URL.parse(appBaseUrl);
  const local = url?.protocol === "http:" && url.hostname === "localhost";
  if (!(url && (url.protocol === "https:" || local))) {
    throw new TypeError("invalid_app_base_url");
  }
  const { origin } = url;
  const back = (result: string) => `${origin}/subscription?retorno=${result}`;
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
  if (input.payer?.taxId !== undefined) {
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
  // the sandbox's payment page only with the sandbox's API (the client already ties the key to the host)
  const sandbox =
    URL.parse(config.baseUrl)?.hostname === "api-sandbox.asaas.com";

  /**
   * The subscription a checkout created. `providerRef` is the checkout's ID, and
   * the subscription carries it as `checkoutSession`. With the stored `sub_` the
   * subscription is read directly (any age); it counts only while it is still
   * that checkout's (a reference attached since gives the list instead), and a
   * stored ID the provider no longer knows falls back to the list too. Without
   * it (no webhook matched yet), the newest subscriptions are listed.
   *
   * The checkout is checked twice on purpose (defense): the client keeps only
   * the subscriptions whose `checkoutSession` is the checkout's, and
   * `subscriptionsOfCheckout` checks each one again before any fact or command
   * uses it, so neither a bug in the client nor a provider that starts
   * filtering differently can hand over another checkout's subscription.
   */
  async function subscriptionsOf(
    providerRef: string,
    providerSubscriptionId: string | null | undefined
  ) {
    if (providerSubscriptionId) {
      try {
        const stored = subscriptionsOfCheckout(
          [await client.getSubscription(providerSubscriptionId)],
          providerRef
        );
        if (stored.length > 0) {
          return stored;
        }
      } catch (error: unknown) {
        if (!(error instanceof ProviderNotFoundError)) {
          throw error;
        }
      }
    }
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
    async cancelRenewal(providerRef, providerSubscriptionId) {
      const subscriptions = await subscriptionsOf(
        providerRef,
        providerSubscriptionId
      );
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
      try {
        await client.cancelCheckout(checkoutId);
        return "discarded";
      } catch (error: unknown) {
        // a checkout cancelled before answers 400 to a second cancel, and one Asaas
        // does not know answers 404 (sandbox): nothing is left to give up.
        // The ID is checked before the call, so a 400 is not a malformed one; an
        // expired or paid checkout was not measured and is read the same way (the
        // fact paid without a reservation still starts no trial). A refused key
        // (401, 403) or an outage still throws
        if (
          error instanceof ProviderRejectedError &&
          (error.status === 400 || error.status === 404)
        ) {
          return "already_closed";
        }
        throw error;
      }
    },
    async hasSubscription(providerRef, providerSubscriptionId) {
      return (
        (await subscriptionsOf(providerRef, providerSubscriptionId)).length > 0
      );
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
    async overduePaymentPage(providerRef, providerSubscriptionId) {
      for (const subscription of await subscriptionsOf(
        providerRef,
        providerSubscriptionId
      )) {
        if (subscription.deleted) {
          continue;
        }
        // biome-ignore lint/performance/noAwaitInLoops: One subscription per reference, in practice.
        const raw = await client.listSubscriptionPayments(subscription.id);
        const payments = raw.map(pickAsaasPayment);
        const charge = overdueCharge(payments, subscription);
        if (charge) {
          const page = asaasPaymentPageUrl(
            (raw[payments.indexOf(charge)] as { invoiceUrl?: unknown })
              .invoiceUrl,
            { sandbox }
          );
          if (page === null) {
            // an address of another host is never passed on (and never logged)
            throw new ProviderResponseMalformedError();
          }
          return page;
        }
      }
      return null;
    },
    provider: "asaas",
    async readState(providerRef, now, providerSubscriptionId) {
      const events: ProviderBillingEvent[] = [];
      for (const subscription of await subscriptionsOf(
        providerRef,
        providerSubscriptionId
      )) {
        // biome-ignore lint/performance/noAwaitInLoops: One subscription per reference, in practice.
        const payments = await chargesOf(subscription.id);
        events.push(
          ...reconcileAsaasSubscription({ now, payments, subscription })
        );
      }
      return events;
    },
    async refundCurrentPeriod(
      providerRef,
      now,
      providerSubscriptionId,
      refundable
    ) {
      requireRecordedFirstCharge(refundable);
      // read first: a refund of a charge that is not paid is a 400 whose text says nothing usable
      for (const subscription of await subscriptionsOf(
        providerRef,
        providerSubscriptionId
      )) {
        const charge = refundableCharge(
          // biome-ignore lint/performance/noAwaitInLoops: One subscription per reference, in practice.
          await chargesOf(subscription.id),
          subscription,
          now
        );
        if (charge) {
          // the owner's refund: only the first charge recorded, never one the provider put in its place
          assertFirstCharge(
            refundable,
            chargePeriodEndsAt(charge, subscription)
          );
          await client.refundPayment(charge.id);
          return "refund_requested";
        }
      }
      return "nothing_to_refund";
    },
    refundsEnabled: true,
  };
}
