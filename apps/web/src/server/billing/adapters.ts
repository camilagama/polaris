import type { BillingProviderAdapter } from "./provider-adapter";

/**
 * The payment providers that can send webhooks, by the name in the route. It is
 * empty until the adapters exist (plan PR77 for the Asaas card, PR78 for the
 * Woovi Pix Automático): a webhook for a provider that is not listed is a 404.
 * Adding a provider is writing its adapter and listing it here.
 */
export const billingProviderAdapters: Readonly<
  Record<string, BillingProviderAdapter>
> = Object.freeze({});
