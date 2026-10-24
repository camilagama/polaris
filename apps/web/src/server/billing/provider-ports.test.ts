import {
  ProviderNotConfiguredError,
  ProviderNotFoundError,
} from "@polaris/billing/provider-port";
import { describe, expect, it, vi } from "vitest";
import { billingProviderPortOf } from "./provider-ports";

const valid = {
  ASAAS_API_KEY: "$aact_hmlg_fake",
  ASAAS_BASE_URL: "https://api-sandbox.asaas.com/v3",
  BETTER_AUTH_BASE_URL: "https://app.example.test",
};

describe("billingProviderPortOf", () => {
  it.each(["unknown", "Woovi", ""])(
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

  describe("the caller's signal (ADR 0104: one call of an owner's command)", () => {
    const CHECKOUT_ID = "c6d42a6f-0000-4000-8000-000000000001";
    const WOOVI_SUBSCRIPTION_ID = btoa(
      "PaymentSubscription:0123456789abcdef01234567"
    );
    const emptyList = () =>
      Promise.resolve(
        new Response(
          '{"object":"list","hasMore":false,"totalCount":0,"limit":100,"offset":0,"data":[]}',
          { headers: { "content-type": "application/json" }, status: 200 }
        )
      );

    it("hands the fetch a signal that is already aborted when the caller's signal is", async () => {
      const seen: AbortSignal[] = [];
      const fetchFake = vi.fn((_url: string | URL, init?: RequestInit) => {
        seen.push(init?.signal as AbortSignal);
        return emptyList();
      });
      const controller = new AbortController();
      controller.abort();
      const port = billingProviderPortOf(valid, "asaas", {
        fetch: fetchFake,
        signal: controller.signal,
      });

      await port.hasSubscription(CHECKOUT_ID, null).catch(() => undefined);

      expect(seen).toHaveLength(1);
      expect(seen[0]?.aborted).toBe(true);
    });

    it("aborts the request in flight when the caller's signal aborts later, on top of the client's own timeout", async () => {
      const seen: AbortSignal[] = [];
      const fetchFake = vi.fn((_url: string | URL, init?: RequestInit) => {
        seen.push(init?.signal as AbortSignal);
        return emptyList();
      });
      const controller = new AbortController();
      const port = billingProviderPortOf(valid, "asaas", {
        fetch: fetchFake,
        signal: controller.signal,
      });

      await port.hasSubscription(CHECKOUT_ID, null);
      expect(seen[0]?.aborted).toBe(false);
      controller.abort();

      expect(seen[0]?.aborted).toBe(true);
    });

    it("keeps the Woovi port on the same rule", async () => {
      const seen: AbortSignal[] = [];
      const fetchFake = vi.fn((_url: string | URL, init?: RequestInit) => {
        seen.push(init?.signal as AbortSignal);
        return Promise.resolve(new Response("{}", { status: 404 }));
      });
      const controller = new AbortController();
      controller.abort();
      const port = billingProviderPortOf(
        {
          ...valid,
          WOOVI_APP_ID: "fake-app-id",
          WOOVI_BASE_URL: "https://api.woovi-sandbox.com",
        },
        "woovi",
        { fetch: fetchFake, signal: controller.signal }
      );

      await port
        .hasSubscription(WOOVI_SUBSCRIPTION_ID, null)
        .catch(() => undefined);

      expect(seen.length).toBeGreaterThan(0);
      expect(seen.every((signal) => signal.aborted)).toBe(true);
    });

    it("without a signal, the request carries only the client's own and it is not aborted", async () => {
      const seen: AbortSignal[] = [];
      const fetchFake = vi.fn((_url: string | URL, init?: RequestInit) => {
        seen.push(init?.signal as AbortSignal);
        return emptyList();
      });
      const port = billingProviderPortOf(valid, "asaas", { fetch: fetchFake });

      await port.hasSubscription(CHECKOUT_ID, null);

      expect(seen).toHaveLength(1);
      expect(seen[0]?.aborted).toBe(false);
    });
  });

  describe("Woovi (Pix Automático, cobrança PR 6)", () => {
    const woovi = {
      ...valid,
      WOOVI_APP_ID: "fake-app-id",
      WOOVI_BASE_URL: "https://api.woovi-sandbox.com",
    };

    it("builds the Woovi port from its settings", () => {
      expect(billingProviderPortOf(woovi, "woovi").provider).toBe("woovi");
    });

    it.each(["WOOVI_APP_ID", "WOOVI_BASE_URL"] as const)(
      "refuses to build it without %s",
      (missing) => {
        expect(() =>
          billingProviderPortOf({ ...woovi, [missing]: undefined }, "woovi")
        ).toThrow(ProviderNotConfiguredError);
      }
    );

    it.each([
      "https://api.woovi.com.evil.example",
      "http://api.woovi-sandbox.com",
      "https://api.woovi-sandbox.com/api/v1",
    ])("refuses the host %s", (baseUrl) => {
      expect(() =>
        billingProviderPortOf({ ...woovi, WOOVI_BASE_URL: baseUrl }, "woovi")
      ).toThrow(ProviderNotConfiguredError);
    });

    describe("the refund (WOOVI_REFUND_ENABLED)", () => {
      const SUBSCRIPTION_ID = btoa(
        "PaymentSubscription:0123456789abcdef01234567"
      );
      const refundWith = async (refundFlag: string | undefined) => {
        const fetchFake = vi.fn(() =>
          Promise.resolve(new Response("{}", { status: 404 }))
        );
        const port = billingProviderPortOf(
          {
            ...woovi,
            ...(refundFlag === undefined
              ? {}
              : { WOOVI_REFUND_ENABLED: refundFlag }),
          },
          "woovi",
          { fetch: fetchFake }
        );
        const error = await port
          .refundCurrentPeriod(
            SUBSCRIPTION_ID,
            new Date("2026-10-28T15:00:00Z")
          )
          .then(
            () => null,
            (caught: unknown) => caught
          );
        return { calls: fetchFake.mock.calls.length, error };
      };

      it.each([
        ["absent", undefined],
        ["false", "false"],
        ["empty", ""],
        ["True", "True"],
        ["1", "1"],
      ])(
        "is off when it is %s: not configured, and Woovi is not called",
        async (_name, flag) => {
          const { calls, error } = await refundWith(flag);
          expect(error).toBeInstanceOf(ProviderNotConfiguredError);
          expect(calls).toBe(0);
        }
      );

      it('is on only when it is exactly "true": the port reaches Woovi', async () => {
        const { calls, error } = await refundWith("true");
        // the fake answers 404 to the read of the subscription: it got that far
        expect(error).toBeInstanceOf(ProviderNotFoundError);
        expect(calls).toBe(1);
      });
    });
  });
});
