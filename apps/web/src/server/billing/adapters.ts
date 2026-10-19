import { createAsaasAdapter } from "./asaas-adapter";
import type { BillingProviderAdapter } from "./provider-adapter";

/**
 * The payment providers that can send webhooks, by the name in the route. A
 * webhook for a provider that is not listed is a 404. Asaas (cartão recorrente,
 * plan PR77) is here; Woovi (Pix Automático, PR78) comes with its adapter.
 * Adding a provider is writing its adapter and listing it here.
 */
export const billingProviderAdapters: Readonly<
  Record<string, BillingProviderAdapter>
> = Object.freeze({ asaas: createAsaasAdapter() });
