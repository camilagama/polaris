import { ProviderNotConfiguredError } from "@polaris/billing/provider-port";
import { describe, expect, it, vi } from "vitest";
import { billingProviderPortOf } from "./provider-ports";

const valid = {
  ASAAS_API_KEY: "$aact_hmlg_fake",
  ASAAS_BASE_URL: "https://api-sandbox.asaas.com/v3",
  BETTER_AUTH_BASE_URL: "https://app.example.test",
};

describe("billingProviderPortOf", () => {
  it.each(["woovi", "unknown", ""])(
    "refuses the provider %j, which has no port here",
    (provider) => {
      expect(() => billingProviderPortOf(valid, provider)).toThrow(
        ProviderNotConfiguredError
      );
    }
  );

  it.each(["ASAAS_API_KEY", "ASAAS_BASE_URL", "BETTER_AUTH_BASE_URL"] as const)(
    "refuses to build the port without %s",
    (missing) => {
      expect(() =>
        billingProviderPortOf({ ...valid, [missing]: undefined }, "asaas")
      ).toThrow(ProviderNotConfiguredError);
      expect(() =>
        billingProviderPortOf({ ...valid, [missing]: "" }, "asaas")
      ).toThrow(ProviderNotConfiguredError);
    }
  );

  it("refuses a production key against the sandbox host", () => {
    expect(() =>
      billingProviderPortOf(
        { ...valid, ASAAS_API_KEY: "$aact_prod_fake" },
        "asaas"
      )
    ).toThrow(ProviderNotConfiguredError);
  });

  it("refuses an app origin that is http and not local, since the payer would be sent there", () => {
    expect(() =>
      billingProviderPortOf(
        { ...valid, BETTER_AUTH_BASE_URL: "http://app.example.test" },
        "asaas"
      )
    ).toThrow(ProviderNotConfiguredError);
  });

  it("builds the Asaas port from valid sandbox settings", () => {
    expect(billingProviderPortOf(valid, "asaas").provider).toBe("asaas");
  });

  it("builds the return URLs of the checkout on the origin of BETTER_AUTH_BASE_URL, with a path in it ignored", async () => {
    const fetched: { body: unknown; url: string }[] = [];
    const fetchFake = vi.fn((url: string | URL, init?: RequestInit) => {
      fetched.push({ body: init?.body, url: String(url) });
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: "c6d42a6f-0000-4000-8000-000000000001",
            link: "https://sandbox.asaas.com/checkoutSession/show?id=c6d42a6f-0000-4000-8000-000000000001",
          }),
          { headers: { "content-type": "application/json" }, status: 200 }
        )
      );
    });
    const port = billingProviderPortOf(
      { ...valid, BETTER_AUTH_BASE_URL: "https://app.example.test/some/path" },
      "asaas",
      {
        fetch: fetchFake,
        randomUuid: () => "11111111-1111-4111-8111-111111111111",
      }
    );

    await port.prepareSubscription({
      amount: "24.90",
      cycleMonths: 1,
      firstChargeOn: "2026-10-26",
    });

    expect(fetched).toHaveLength(1);
    expect(fetched[0]?.url).toContain("api-sandbox.asaas.com");
    const body = JSON.parse(String(fetched[0]?.body));
    expect(body.callback.successUrl).toBe(
      "https://app.example.test/?assinatura=concluida"
    );
    expect(new URL(body.callback.successUrl).origin).toBe(
      "https://app.example.test"
    );
  });
});
