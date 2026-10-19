import { describe, expect, it } from "vitest";
import { ProviderNotFoundError } from "../provider-port";
import { createAsaasClient } from "./client";
import { createAsaasPort } from "./port";

/**
 * Against the real Asaas SANDBOX, only when asked for
 * (`ASAAS_SANDBOX_INTEGRATION=1` with `ASAAS_API_KEY` and `ASAAS_BASE_URL` of
 * the sandbox in the environment; the client refuses a production key). It
 * creates one hosted checkout and cancels it, and reads a charge that does not
 * exist. Nothing is printed: no key, no link, no resource.
 */
const enabled =
  process.env.ASAAS_SANDBOX_INTEGRATION === "1" &&
  Boolean(process.env.ASAAS_API_KEY) &&
  process.env.ASAAS_BASE_URL === "https://api-sandbox.asaas.com/v3";

const UUID = /^[\da-f-]{36}$/;
const ASAAS_HOST = /asaas\.com$/;

const config = () => ({
  apiKey: process.env.ASAAS_API_KEY ?? "",
  baseUrl: process.env.ASAAS_BASE_URL ?? "",
  fetch: (url: string, init: RequestInit) => fetch(url, init),
  timeoutMs: 8000,
});

const today = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(
    new Date()
  );
const sevenDaysLater = () => {
  const [year = 0, month = 1, day = 1] = today().split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + 7))
    .toISOString()
    .slice(0, 10);
};

describe.skipIf(!enabled)("Asaas sandbox", () => {
  it("creates a hosted recurring card checkout whose ID is the providerRef, then cancels it", async () => {
    const port = createAsaasPort({
      ...config(),
      appBaseUrl: "https://polaris.example.test",
      randomUuid: () => crypto.randomUUID(),
    });
    const prepared = await port.prepareSubscription({
      amount: "24.90",
      cycleMonths: 1,
      firstChargeOn: sevenDaysLater(),
      payer: { email: "pagador.teste@example.com", name: "Pagadora de Teste" },
    });
    try {
      expect(prepared.providerRef).toBe(prepared.checkoutId);
      expect(prepared.checkoutId).toMatch(UUID);
      expect(prepared.handoff.kind).toBe("redirect");
      expect(new URL(prepared.handoff.url).hostname).toMatch(ASAAS_HOST);
    } finally {
      // the checkout is cancelled even if an expectation fails
      await port.discardCheckout(prepared.checkoutId);
    }
    // no subscription exists for a checkout nobody finished
    expect(await port.readState(prepared.providerRef, new Date())).toEqual([]);
    expect(await port.cancelRenewal(prepared.providerRef)).toBe(
      "nothing_to_cancel"
    );
  }, 60_000);

  it("a charge that does not exist is a 404, the unresolved case", async () => {
    const client = createAsaasClient(config());
    await expect(
      client.getPayment("pay_doesnotexist0001")
    ).rejects.toBeInstanceOf(ProviderNotFoundError);
  }, 30_000);
});
