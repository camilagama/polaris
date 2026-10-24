import { isValidCalendarDate } from "@polaris/domain/inventory/calendar-date";
import { newPolarisReference } from "../asaas/ids";
import type { FetchLike } from "../http";
import { AMOUNT_PLACEHOLDER, stringifyWithAmount } from "../json";
import {
  assertFirstCharge,
  type BillingProviderPort,
  type CheckoutHandoff,
  type PrepareSubscriptionInput,
  ProviderNotConfiguredError,
  ProviderNotFoundError,
  ProviderResponseMalformedError,
  requireRecordedFirstCharge,
} from "../provider-port";
import { createWooviClient, type WooviClient } from "./client";
import { alignWooviCustomer } from "./customer";
import { isWooviGlobalId } from "./ids";
import {
  installmentPeriodEndsAt,
  pickWooviEndToEndId,
  pickWooviInstallment,
  pickWooviSubscription,
  reconcileWooviSubscription,
  refundableInstallment,
  type WooviSubscription,
  wooviRefundCorrelationId,
  wooviRefundEvent,
} from "./mapper";

/**
 * The outbound port to Woovi, Pix Automático (ADR 0101, emenda do PR 6). The
 * subscription is created at once (there is no hosted checkout): its
 * `globalID` is the `providerRef` and the "checkout" a command may give up.
 * The payer approves the authorization in the bank app from the Pix "copia e
 * cola" (`emv`) or Woovi's page; Polaris draws no QR.
 */

const CYCLE_FREQUENCIES: Readonly<Record<number, string>> = {
  1: "MONTHLY",
  6: "SEMIANNUALLY",
  12: "ANNUALLY",
};
const CYCLE_LABELS: Readonly<Record<number, string>> = {
  1: "mensal",
  6: "semestral",
  12: "anual",
};
/** The hosts of Woovi's page of an authorization; any other link is not handed over. */
const PAYMENT_LINK_DOMAINS = [
  "woovi.com",
  "woovi-sandbox.com",
  "openpix.com.br",
];
const emvPattern = /^[\x20-\x7E]{1,1024}$/;

export interface WooviPortConfig {
  /** The AppID (secret). */
  appId: string;
  baseUrl: string;
  fetch: FetchLike;
  /** A fresh UUID v4 per subscription (`crypto.randomUUID`). */
  randomUuid: () => string;
  /**
   * Whether `refundCurrentPeriod` may call Woovi. Off until the refund of an
   * installment is proven in the sandbox (S3.2, Gate 7): off, it throws
   * `ProviderNotConfiguredError` and calls nothing.
   */
  refundEnabled?: boolean;
  timeoutMs: number;
}

/**
 * The creation request. The first charge is on `firstChargeOn` at noon UTC
 * (09:00 in São Paulo): Woovi writes the day in UTC, and midnight would fall on
 * the day before in São Paulo (ADR 0101, limits of the Woovi amendment). With
 * the trial it is journey 2 (`ONLY_RECURRENCY`, the payer only authorizes;
 * Woovi wants the day 3 or more days ahead); without, journey 3
 * (`PAYMENT_ON_APPROVAL`, the first charge is paid on approval; Woovi wants
 * today). The amount goes in integer cents, never through `number`.
 */
function subscriptionBody(
  input: PrepareSubscriptionInput,
  payer: { email: string; name: string; taxId: string },
  reference: string
): string {
  if (!isValidCalendarDate(input.firstChargeOn)) {
    throw new TypeError("invalid_first_charge_date");
  }
  const frequency = CYCLE_FREQUENCIES[input.cycleMonths];
  const label = CYCLE_LABELS[input.cycleMonths];
  if (!(frequency && label)) {
    throw new TypeError("invalid_cycle");
  }
  const name = `Polaris Pro ${label}`;
  return stringifyWithAmount(
    {
      comment: name,
      correlationID: reference,
      customer: {
        email: payer.email.trim(),
        name: payer.name.trim(),
        taxID: payer.taxId,
      },
      dayGenerateCharge: `${input.firstChargeOn}T12:00:00.000Z`,
      frequency,
      name,
      pixRecurringOptions: {
        journey: input.trial ? "ONLY_RECURRENCY" : "PAYMENT_ON_APPROVAL",
        retryPolicy: "THREE_RETRIES_7_DAYS",
      },
      type: "PIX_RECURRING",
      value: AMOUNT_PLACEHOLDER,
    },
    input.amount,
    "cents"
  );
}

/** Woovi's page of the authorization, only over https on one of its hosts; otherwise none. */
function paymentLinkOf(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const url = URL.parse(value);
  if (
    url?.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    !PAYMENT_LINK_DOMAINS.some(
      (domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`)
    )
  ) {
    return null;
  }
  return url.href;
}

/** The ID and the handoff of a subscription just created; nothing else of it (the customer) is read. */
function pickCreated(raw: unknown): {
  handoff: Extract<CheckoutHandoff, { kind: "pix_authorization" }>;
  id: string;
} {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ProviderResponseMalformedError();
  }
  const { globalID, paymentLink, pixRecurring } = raw as Record<
    string,
    unknown
  >;
  const pix =
    typeof pixRecurring === "object" && pixRecurring !== null
      ? (pixRecurring as Record<string, unknown>)
      : {};
  if (
    !isWooviGlobalId("subscription", globalID) ||
    typeof pix.emv !== "string" ||
    !emvPattern.test(pix.emv)
  ) {
    throw new ProviderResponseMalformedError();
  }
  return {
    handoff: {
      emv: pix.emv,
      kind: "pix_authorization",
      url: paymentLinkOf(paymentLink),
    },
    id: globalID,
  };
}

/** The payer with what Pix Automático needs; the CPF or CNPJ and the key are checked by the customer lookup. */
function payerOf(input: PrepareSubscriptionInput): {
  correlationId: string;
  email: string;
  name: string;
  taxId: string;
} {
  const { payer } = input;
  if (!(payer?.taxId && payer.customerKey)) {
    throw new TypeError("payer_required_for_pix");
  }
  return {
    correlationId: payer.customerKey,
    email: payer.email,
    name: payer.name,
    taxId: payer.taxId,
  };
}

export function createWooviPort(config: WooviPortConfig): BillingProviderPort {
  const client: WooviClient = createWooviClient(config);

  /** The subscription: the stored ID when there is one (the same, for Woovi), else the reference. */
  async function subscriptionOf(
    providerRef: string,
    providerSubscriptionId: string | null | undefined
  ): Promise<WooviSubscription> {
    return pickWooviSubscription(
      await client.getSubscription(providerSubscriptionId || providerRef)
    );
  }

  /** Cancels a subscription not cancelled yet; one already `INACTIVE` is left as it is. */
  async function cancel(
    subscription: WooviSubscription
  ): Promise<"already_cancelled" | "cancelled"> {
    if (subscription.status === "INACTIVE") {
      return "already_cancelled";
    }
    await client.cancelSubscription(subscription.id);
    return "cancelled";
  }

  return {
    async cancelRenewal(providerRef, providerSubscriptionId) {
      let subscription: WooviSubscription;
      try {
        subscription = await subscriptionOf(
          providerRef,
          providerSubscriptionId
        );
      } catch (error: unknown) {
        if (error instanceof ProviderNotFoundError) {
          return "nothing_to_cancel";
        }
        throw error;
      }
      // `PUT …/cancel` answers 200 again for one cancelled (sandbox, t092); it is read first
      // so the answer says what happened. Woovi sends no webhook for it: the command writes the fact
      return await cancel(subscription);
    },
    async discardCheckout(checkoutId) {
      let subscription: WooviSubscription;
      try {
        subscription = pickWooviSubscription(
          await client.getSubscription(checkoutId)
        );
      } catch (error: unknown) {
        if (error instanceof ProviderNotFoundError) {
          return "already_closed";
        }
        throw error;
      }
      if (subscription.authorization === "APPROVED") {
        // the payer authorized it: it is a subscription, no longer a checkout to give up
        // (the caller asks `hasSubscription` and cancels it as a renewal when it must)
        return "already_closed";
      }
      return (await cancel(subscription)) === "cancelled"
        ? "discarded"
        : "already_closed";
    },
    async hasSubscription(providerRef, providerSubscriptionId) {
      const subscription = await subscriptionOf(
        providerRef,
        providerSubscriptionId
      );
      if (subscription.authorization === "APPROVED") {
        return true;
      }
      // installments exist only after the approval (sandbox, t092): one approved and
      // then revoked by the payer still made a subscription
      return (
        (await client.listSubscriptionInstallments(subscription.id)).length > 0
      );
    },
    async prepareSubscription(input) {
      const payer = payerOf(input);
      const reference = newPolarisReference(config.randomUuid());
      const body = subscriptionBody(input, payer, reference);
      // one read of the payer's customer by its key (and its creation when there is none);
      // never a list of the account (ADR 0101, emenda do PR 6)
      const customerAlignment = await alignWooviCustomer(client, payer);
      const created = pickCreated(await client.createSubscription(body));
      return {
        checkoutId: created.id,
        customerAlignment,
        handoff: created.handoff,
        providerRef: created.id,
      };
    },
    // Pix Automático has no page to pay an installment that failed: Woovi tries again by itself (ADR 0104, decision 9)
    overduePaymentPage: () => Promise.resolve(null),
    provider: "woovi",
    async readState(providerRef, now, providerSubscriptionId) {
      const subscription = await subscriptionOf(
        providerRef,
        providerSubscriptionId
      );
      const installments = (
        await client.listSubscriptionInstallments(subscription.id)
      ).map(pickWooviInstallment);
      return reconcileWooviSubscription({ installments, now, subscription });
    },
    async refundCurrentPeriod(
      providerRef,
      now,
      providerSubscriptionId,
      firstCharge
    ) {
      if (config.refundEnabled !== true) {
        // the refund of an installment is not proven in the sandbox yet (S3.2): nothing is called
        throw new ProviderNotConfiguredError();
      }
      requireRecordedFirstCharge(firstCharge);
      const subscription = await subscriptionOf(
        providerRef,
        providerSubscriptionId
      );
      const raw = await client.listSubscriptionInstallments(subscription.id);
      const installments = raw.map(pickWooviInstallment);
      const installment = refundableInstallment(
        installments,
        subscription,
        now
      );
      if (!installment) {
        return "nothing_to_refund";
      }
      // the owner's refund: only the first charge recorded, never one the provider put in its place
      assertFirstCharge(
        firstCharge,
        installmentPeriodEndsAt(installment, subscription)
      );
      const endToEndId = pickWooviEndToEndId(
        raw[installments.indexOf(installment)]
      );
      await client.refundPix(
        stringifyWithAmount(
          {
            comment: "Reembolso Polaris Pro",
            correlationID: wooviRefundCorrelationId(subscription, installment),
            transactionEndToEndId: endToEndId,
            value: AMOUNT_PLACEHOLDER,
          },
          installment.amount,
          "cents"
        )
      );
      // Woovi's refund event names no subscription (it is ignored by the webhook): the
      // command writes this fact through the inbox, with the refund's correlationID as its ID
      return {
        event: wooviRefundEvent({ installment, occurredAt: now, subscription }),
        kind: "refund_requested",
      };
    },
    refundsEnabled: config.refundEnabled === true,
  };
}
