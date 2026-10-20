import { describe, expect, it, vi } from "vitest";
import {
  ProviderRejectedError,
  ProviderResponseMalformedError,
  ProviderUnavailableError,
} from "../provider-port";
import type { WooviClient } from "./client";
import {
  alignWooviCustomer,
  liveSubscriptionsOfTaxId,
  WooviCustomerHeldError,
  WooviCustomerMismatchError,
} from "./customer";

const PAYER = {
  email: "pagador.teste@example.com",
  name: "Pagadora de Teste",
  taxId: "52998224725",
};
const KEY = "cust-fake-0001";
/** No live subscription of another organization: the update may go ahead. */
const MAY_UPDATE = { mayUpdate: () => Promise.resolve(true) };
const subscriptionId = (hex: string) =>
  btoa(`PaymentSubscription:${hex.padEnd(24, "0")}`);

function fakeClient(
  options: {
    found?: unknown;
    update?: (
      key: string,
      fields: { email: string; name: string }
    ) => Promise<unknown>;
  } = {}
) {
  const client = {
    cancelSubscription: vi.fn(),
    createSubscription: vi.fn(),
    findCustomerByTaxId: vi.fn(() => Promise.resolve(options.found ?? null)),
    getInstallment: vi.fn(),
    getSubscription: vi.fn(),
    listSubscriptionInstallments: vi.fn(),
    listSubscriptions: vi.fn(),
    refundPix: vi.fn(),
    updateCustomer: vi.fn(
      options.update ??
        ((_key: string, fields: { email: string; name: string }) =>
          Promise.resolve({ correlationID: KEY, ...fields }))
    ),
  };
  return { client: client as unknown as WooviClient, spies: client };
}

const stored = (overrides: Record<string, unknown> = {}) => ({
  correlationID: KEY,
  email: PAYER.email,
  name: PAYER.name,
  ...overrides,
});

describe("alignWooviCustomer", () => {
  it("absent: Woovi has no customer, nothing is updated", async () => {
    const { client, spies } = fakeClient({ found: null });
    expect(await alignWooviCustomer(client, PAYER, MAY_UPDATE)).toBe("absent");
    expect(spies.findCustomerByTaxId).toHaveBeenCalledWith(PAYER.taxId);
    expect(spies.updateCustomer).not.toHaveBeenCalled();
  });

  it("matches: the same name and e-mail are not updated", async () => {
    const { client, spies } = fakeClient({ found: stored() });
    expect(await alignWooviCustomer(client, PAYER, MAY_UPDATE)).toBe("matches");
    expect(spies.updateCustomer).not.toHaveBeenCalled();
  });

  it("matches: extra spaces in the name and capitals in the e-mail do not count", async () => {
    const { client, spies } = fakeClient({
      found: stored({
        email: " Pagador.Teste@EXAMPLE.com ",
        name: "  Pagadora   de  Teste ",
      }),
    });
    expect(await alignWooviCustomer(client, PAYER, MAY_UPDATE)).toBe("matches");
    expect(spies.updateCustomer).not.toHaveBeenCalled();
  });

  it("matches: a customer with no e-mail differs from a payer with one", async () => {
    const { client, spies } = fakeClient({ found: stored({ email: null }) });
    expect(await alignWooviCustomer(client, PAYER, MAY_UPDATE)).toBe("updated");
    expect(spies.updateCustomer).toHaveBeenCalledTimes(1);
  });

  it("diverges: updates by the correlation ID with the trimmed name and e-mail", async () => {
    const { client, spies } = fakeClient({
      found: stored({ email: "outro@example.com", name: "Nome Antigo" }),
    });
    const result = await alignWooviCustomer(
      client,
      {
        ...PAYER,
        email: `  ${PAYER.email}  `,
        name: `  ${PAYER.name}  `,
      },
      MAY_UPDATE
    );
    expect(result).toBe("updated");
    expect(spies.updateCustomer).toHaveBeenCalledWith(KEY, {
      email: PAYER.email,
      name: PAYER.name,
    });
  });

  it("an update that does not hold is a WooviCustomerMismatchError", async () => {
    const { client } = fakeClient({
      found: stored({ name: "Nome Antigo" }),
      update: () => Promise.resolve(stored({ name: "Nome Antigo" })),
    });
    const error = await alignWooviCustomer(client, PAYER, MAY_UPDATE).catch(
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(WooviCustomerMismatchError);
    expect((error as WooviCustomerMismatchError).code).toBe(
      "payer_data_mismatch"
    );
    expect(JSON.stringify(error)).not.toContain(PAYER.name);
    expect((error as Error).message).not.toContain(PAYER.email);
  });

  it("an update that holds only the e-mail is still a mismatch", async () => {
    const { client } = fakeClient({
      found: stored({ name: "Nome Antigo" }),
      update: () =>
        Promise.resolve(stored({ email: PAYER.email, name: "Nome Antigo" })),
    });
    await expect(
      alignWooviCustomer(client, PAYER, MAY_UPDATE)
    ).rejects.toBeInstanceOf(WooviCustomerMismatchError);
  });

  it.each([
    ["a 4xx", new ProviderRejectedError(422)],
    ["a 5xx", new ProviderUnavailableError()],
    ["a malformed answer", new ProviderResponseMalformedError()],
  ])(
    "%s of the update is the generic mismatch, keeping the cause",
    async (_name, failure) => {
      const { client } = fakeClient({
        found: stored({ name: "Nome Antigo" }),
        update: () => Promise.reject(failure),
      });
      const error = await alignWooviCustomer(client, PAYER, MAY_UPDATE).catch(
        (caught: unknown) => caught
      );
      expect(error).toBeInstanceOf(WooviCustomerMismatchError);
      expect((error as WooviCustomerMismatchError).code).toBe(
        "payer_data_mismatch"
      );
      expect((error as Error).cause).toBe(failure);
      expect((error as Error).message).not.toContain(PAYER.name);
    }
  );

  it("a lookup that fails propagates and nothing is updated", async () => {
    const { client, spies } = fakeClient();
    spies.findCustomerByTaxId.mockRejectedValueOnce(
      new ProviderUnavailableError()
    );
    await expect(
      alignWooviCustomer(client, PAYER, MAY_UPDATE)
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(spies.updateCustomer).not.toHaveBeenCalled();
  });

  it.each([
    ["a customer that is not an object", "x"],
    ["a customer with no name", { correlationID: KEY, email: PAYER.email }],
    ["a customer with no correlation ID", { email: PAYER.email, name: "N" }],
    ["a correlation ID that is a path", stored({ correlationID: "../x" })],
  ])("%s is a malformed answer", async (_name, found) => {
    const { client, spies } = fakeClient({ found });
    await expect(
      alignWooviCustomer(client, PAYER, MAY_UPDATE)
    ).rejects.toMatchObject({
      code: "provider_response_malformed",
    });
    expect(spies.updateCustomer).not.toHaveBeenCalled();
  });

  it.each([
    ["a tax ID with punctuation", { ...PAYER, taxId: "529.982.247-25" }],
    ["a tax ID of the wrong length", { ...PAYER, taxId: "5299822472" }],
    ["an empty name", { ...PAYER, name: "" }],
    ["a name of only spaces", { ...PAYER, name: "   " }],
    ["an empty e-mail", { ...PAYER, email: "" }],
  ])("%s is a TypeError before any call", async (_name, payer) => {
    const { client, spies } = fakeClient();
    await expect(alignWooviCustomer(client, payer)).rejects.toBeInstanceOf(
      TypeError
    );
    expect(spies.findCustomerByTaxId).not.toHaveBeenCalled();
    expect(spies.updateCustomer).not.toHaveBeenCalled();
  });

  describe("the customer of a live subscription of another organization (ADR 0101, PR 6)", () => {
    it("is not updated, and the refusal is the generic one", async () => {
      const { client, spies } = fakeClient({
        found: stored({ name: "Outro Nome" }),
      });
      const mayUpdate = vi.fn(() => Promise.resolve(false));

      const error = await alignWooviCustomer(client, PAYER, {
        mayUpdate,
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(WooviCustomerHeldError);
      // the same code as a mismatch: the reason is never told
      expect((error as WooviCustomerHeldError).code).toBe(
        "payer_data_mismatch"
      );
      expect(mayUpdate).toHaveBeenCalledTimes(1);
      expect(spies.updateCustomer).not.toHaveBeenCalled();
    });

    it.each(["52998224725", "11222333000181"])(
      "never updates a customer whose correlationID is shaped like a document (%s): it would go in the URL",
      async (correlationID) => {
        const { client, spies } = fakeClient({
          found: stored({ correlationID, name: "Outro Nome" }),
        });

        await expect(
          alignWooviCustomer(client, PAYER, MAY_UPDATE)
        ).rejects.toBeInstanceOf(WooviCustomerMismatchError);
        expect(spies.updateCustomer).not.toHaveBeenCalled();
      }
    );

    it("without the question, nothing is ever updated (fail closed)", async () => {
      const { client, spies } = fakeClient({
        found: stored({ email: "outro@example.com" }),
      });

      await expect(alignWooviCustomer(client, PAYER)).rejects.toBeInstanceOf(
        WooviCustomerHeldError
      );
      expect(spies.updateCustomer).not.toHaveBeenCalled();
    });

    it("a failure of the question changes nothing and propagates", async () => {
      const { client, spies } = fakeClient({
        found: stored({ name: "Outro Nome" }),
      });

      await expect(
        alignWooviCustomer(client, PAYER, {
          mayUpdate: () => Promise.reject(new ProviderUnavailableError()),
        })
      ).rejects.toBeInstanceOf(ProviderUnavailableError);
      expect(spies.updateCustomer).not.toHaveBeenCalled();
    });

    it("is not asked when the customer is absent or already matches", async () => {
      const mayUpdate = vi.fn(() => Promise.resolve(false));

      expect(
        await alignWooviCustomer(fakeClient().client, PAYER, { mayUpdate })
      ).toBe("absent");
      expect(
        await alignWooviCustomer(
          fakeClient({ found: stored() }).client,
          PAYER,
          {
            mayUpdate,
          }
        )
      ).toBe("matches");
      expect(mayUpdate).not.toHaveBeenCalled();
    });
  });
});

describe("liveSubscriptionsOfTaxId", () => {
  const entry = (
    hex: string,
    taxID: string,
    status: string,
    approval: string | null = "APPROVED"
  ) => ({
    customer: { name: "Fulana", taxID: { taxID, type: "BR:CPF" } },
    globalID: subscriptionId(hex),
    pixRecurring: approval === null ? {} : { status: approval },
    status,
  });

  it("an ACTIVE subscription still waiting for the payer does not count", async () => {
    const { client, spies } = fakeClient();
    spies.listSubscriptions.mockResolvedValue([
      entry("b1", PAYER.taxId, "ACTIVE", null),
      entry("b2", PAYER.taxId, "ACTIVE", "CREATED"),
      entry("b3", PAYER.taxId, "ACTIVE", "APPROVED"),
    ]);

    expect(await liveSubscriptionsOfTaxId(client, PAYER.taxId)).toEqual([
      subscriptionId("b3"),
    ]);
  });

  it.each([
    ["no customer", { customer: undefined }],
    ["a customer with no taxID", { customer: { name: "Fulana" } }],
    [
      "a taxID that is not text",
      { customer: { taxID: { taxID: 52_998_224_725 } } },
    ],
    ["a taxID that is null", { customer: { taxID: null } }],
  ])("an ACTIVE entry with %s fails closed", async (_name, overrides) => {
    const { client, spies } = fakeClient();
    spies.listSubscriptions.mockResolvedValue([
      { ...entry("c1", PAYER.taxId, "ACTIVE"), ...overrides },
    ]);

    await expect(
      liveSubscriptionsOfTaxId(client, PAYER.taxId)
    ).rejects.toBeInstanceOf(ProviderResponseMalformedError);
  });

  it("an INACTIVE entry with no readable taxID is ignored", async () => {
    const { client, spies } = fakeClient();
    spies.listSubscriptions.mockResolvedValue([
      { ...entry("d1", PAYER.taxId, "INACTIVE"), customer: undefined },
      entry("d2", PAYER.taxId, "ACTIVE"),
    ]);

    expect(await liveSubscriptionsOfTaxId(client, PAYER.taxId)).toEqual([
      subscriptionId("d2"),
    ]);
  });

  it("keeps only the ACTIVE subscriptions of that exact tax ID", async () => {
    const { client, spies } = fakeClient();
    spies.listSubscriptions.mockResolvedValue([
      entry("a1", PAYER.taxId, "ACTIVE"),
      entry("a2", PAYER.taxId, "INACTIVE"),
      entry("a3", "11144477735", "ACTIVE"),
      entry("a4", PAYER.taxId, "ACTIVE"),
    ]);

    expect(await liveSubscriptionsOfTaxId(client, PAYER.taxId)).toEqual([
      subscriptionId("a1"),
      subscriptionId("a4"),
    ]);
  });

  it("an entry of the tax ID with an ID of another shape is not an answer to trust", async () => {
    const { client, spies } = fakeClient();
    spies.listSubscriptions.mockResolvedValue([
      { ...entry("a1", PAYER.taxId, "ACTIVE"), globalID: "../outra" },
    ]);

    await expect(
      liveSubscriptionsOfTaxId(client, PAYER.taxId)
    ).rejects.toMatchObject({ code: "provider_response_malformed" });
  });

  it("refuses a tax ID that is not digits before any call", async () => {
    const { client, spies } = fakeClient();

    await expect(
      liveSubscriptionsOfTaxId(client, "529.982.247-25")
    ).rejects.toBeInstanceOf(TypeError);
    expect(spies.listSubscriptions).not.toHaveBeenCalled();
  });
});
