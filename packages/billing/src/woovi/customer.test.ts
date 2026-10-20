import { describe, expect, it, vi } from "vitest";
import {
  ProviderNotFoundError,
  ProviderRejectedError,
  ProviderResponseMalformedError,
  ProviderUnavailableError,
} from "../provider-port";
import type { WooviClient } from "./client";
import { alignWooviCustomer, WooviCustomerMismatchError } from "./customer";

const KEY = "polaris-payer-0123456789abcdef0123456789abcdef";
const PAYER = {
  correlationId: KEY,
  email: "pagador.teste@example.com",
  name: "Pagadora de Teste",
  taxId: "52998224725",
};

function fakeClient(
  options: {
    create?: (customer: {
      correlationId: string;
      email: string;
      name: string;
      taxId: string;
    }) => Promise<unknown>;
    found?: unknown;
  } = {}
) {
  const client = {
    cancelSubscription: vi.fn(),
    createCustomer: vi.fn(options.create ?? (() => Promise.resolve(stored()))),
    createSubscription: vi.fn(),
    getCustomer: vi.fn(() => Promise.resolve(options.found ?? null)),
    getInstallment: vi.fn(),
    getSubscription: vi.fn(),
    listSubscriptionInstallments: vi.fn(),
    refundPix: vi.fn(),
  };
  return { client: client as unknown as WooviClient, spies: client };
}

/** A customer as Woovi answers it: the document is under `taxID.taxID`. */
const stored = (overrides: Record<string, unknown> = {}) => ({
  correlationID: KEY,
  email: PAYER.email,
  name: PAYER.name,
  taxID: { taxID: PAYER.taxId, type: "BR:CPF" },
  ...overrides,
});

describe("alignWooviCustomer", () => {
  it("matches: one read by the key, nothing created", async () => {
    const { client, spies } = fakeClient({ found: stored() });
    expect(await alignWooviCustomer(client, PAYER)).toBe("matches");
    expect(spies.getCustomer).toHaveBeenCalledTimes(1);
    expect(spies.getCustomer).toHaveBeenCalledWith(KEY);
    expect(spies.createCustomer).not.toHaveBeenCalled();
  });

  it("matches: the document as a plain string is read too", async () => {
    const { client } = fakeClient({ found: stored({ taxID: PAYER.taxId }) });
    expect(await alignWooviCustomer(client, PAYER)).toBe("matches");
  });

  it("matches: extra spaces in the name and capitals in the e-mail do not count", async () => {
    const { client, spies } = fakeClient({
      found: stored({
        email: " Pagador.Teste@EXAMPLE.com ",
        name: "  Pagadora   de  Teste ",
      }),
    });
    expect(await alignWooviCustomer(client, PAYER)).toBe("matches");
    expect(spies.createCustomer).not.toHaveBeenCalled();
  });

  it("matches: a decomposed accent is the same name (NFC)", async () => {
    const { client } = fakeClient({
      found: stored({ name: "José da Silva" }),
    });
    expect(
      await alignWooviCustomer(client, { ...PAYER, name: "José da Silva" })
    ).toBe("matches");
  });

  it("created: Woovi has none, so the customer is created under the key with the trimmed data", async () => {
    const { client, spies } = fakeClient({ found: null });
    const result = await alignWooviCustomer(client, {
      ...PAYER,
      email: `  ${PAYER.email}  `,
      name: `  ${PAYER.name}  `,
    });
    expect(result).toBe("created");
    expect(spies.getCustomer).toHaveBeenCalledTimes(1);
    expect(spies.createCustomer).toHaveBeenCalledTimes(1);
    expect(spies.createCustomer).toHaveBeenCalledWith({
      correlationId: KEY,
      email: PAYER.email,
      name: PAYER.name,
      taxId: PAYER.taxId,
    });
  });

  it("created: the read comes before the creation", async () => {
    const { client, spies } = fakeClient({ found: null });
    await alignWooviCustomer(client, PAYER);
    const read = spies.getCustomer.mock.invocationCallOrder[0] ?? 0;
    const create = spies.createCustomer.mock.invocationCallOrder[0] ?? 0;
    expect(read).toBeGreaterThan(0);
    expect(create).toBeGreaterThan(read);
  });

  it.each([
    ["another name", { name: "Nome Antigo" }],
    ["another e-mail", { email: "outro@example.com" }],
    ["no e-mail", { email: null }],
    ["another document", { taxID: { taxID: "11144477735", type: "BR:CPF" } }],
    ["another document as a plain string", { taxID: "11144477735" }],
    ["another key", { correlationID: `polaris-payer-${"f".repeat(32)}` }],
  ])(
    "a customer with %s is refused, never updated",
    async (_name, difference) => {
      const { client, spies } = fakeClient({ found: stored(difference) });

      const error = await alignWooviCustomer(client, PAYER).catch(
        (caught: unknown) => caught
      );

      expect(error).toBeInstanceOf(WooviCustomerMismatchError);
      expect((error as WooviCustomerMismatchError).code).toBe(
        "payer_data_mismatch"
      );
      expect(JSON.stringify(error)).not.toContain(PAYER.name);
      expect((error as Error).message).not.toContain(PAYER.email);
      expect((error as Error).message).not.toContain(PAYER.taxId);
      expect(spies.getCustomer).toHaveBeenCalledTimes(1);
      expect(spies.createCustomer).not.toHaveBeenCalled();
    }
  );

  it("a creation Woovi refuses (a 4xx) is the generic mismatch, keeping the cause", async () => {
    const failure = new ProviderRejectedError(400);
    const { client } = fakeClient({ create: () => Promise.reject(failure) });

    const error = await alignWooviCustomer(client, PAYER).catch(
      (caught: unknown) => caught
    );

    expect(error).toBeInstanceOf(WooviCustomerMismatchError);
    expect((error as WooviCustomerMismatchError).code).toBe(
      "payer_data_mismatch"
    );
    expect((error as Error).cause).toBe(failure);
    expect((error as Error).message).not.toContain(PAYER.name);
  });

  it.each([401, 403, 404])(
    "a creation answered %i is a fault of the setup, not a refusal of the payer",
    async (status) => {
      const failure =
        status === 404
          ? new ProviderNotFoundError()
          : new ProviderRejectedError(status);
      const { client } = fakeClient({ create: () => Promise.reject(failure) });

      const error = await alignWooviCustomer(client, PAYER).catch(
        (caught: unknown) => caught
      );

      expect(error).toBe(failure);
    }
  );

  it.each([
    ["an outage", new ProviderUnavailableError()],
    ["a malformed answer", new ProviderResponseMalformedError()],
  ])(
    "%s of the creation propagates as it is, never as a refusal",
    async (_name, failure) => {
      const { client } = fakeClient({ create: () => Promise.reject(failure) });
      const error = await alignWooviCustomer(client, PAYER).catch(
        (caught: unknown) => caught
      );
      expect(error).toBe(failure);
      expect(error).not.toBeInstanceOf(WooviCustomerMismatchError);
    }
  );

  it("a created customer that does not hold the payer's data is a mismatch", async () => {
    const { client } = fakeClient({
      create: () => Promise.resolve(stored({ name: "Nome Antigo" })),
    });
    await expect(alignWooviCustomer(client, PAYER)).rejects.toBeInstanceOf(
      WooviCustomerMismatchError
    );
  });

  it("a lookup that fails propagates and nothing is created", async () => {
    const { client, spies } = fakeClient();
    spies.getCustomer.mockRejectedValueOnce(new ProviderUnavailableError());
    await expect(alignWooviCustomer(client, PAYER)).rejects.toBeInstanceOf(
      ProviderUnavailableError
    );
    expect(spies.createCustomer).not.toHaveBeenCalled();
  });

  it.each([
    ["a customer that is not an object", "x"],
    ["a customer with no name", { correlationID: KEY, email: PAYER.email }],
    [
      "a customer with no correlation ID",
      { email: PAYER.email, name: "N", taxID: PAYER.taxId },
    ],
    [
      "a customer with no document",
      { correlationID: KEY, email: PAYER.email, name: "N" },
    ],
    [
      "a document that is not text",
      stored({ taxID: { taxID: 52_998_224_725 } }),
    ],
  ])("%s is a malformed answer", async (_name, found) => {
    const { client, spies } = fakeClient({ found });
    await expect(alignWooviCustomer(client, PAYER)).rejects.toMatchObject({
      code: "provider_response_malformed",
    });
    expect(spies.createCustomer).not.toHaveBeenCalled();
  });

  it.each([
    ["a tax ID with punctuation", { ...PAYER, taxId: "529.982.247-25" }],
    ["a tax ID of the wrong length", { ...PAYER, taxId: "5299822472" }],
    ["a key that is the CPF", { ...PAYER, correlationId: PAYER.taxId }],
    ["a key of another shape", { ...PAYER, correlationId: "cust-1" }],
    ["an empty name", { ...PAYER, name: "" }],
    ["a name of only spaces", { ...PAYER, name: "   " }],
    ["an empty e-mail", { ...PAYER, email: "" }],
  ])("%s is a TypeError before any call", async (_name, payer) => {
    const { client, spies } = fakeClient();
    await expect(alignWooviCustomer(client, payer)).rejects.toBeInstanceOf(
      TypeError
    );
    expect(spies.getCustomer).not.toHaveBeenCalled();
    expect(spies.createCustomer).not.toHaveBeenCalled();
  });
});
