import { describe, expect, it, vi } from "vitest";
import {
  ProviderRejectedError,
  ProviderUnavailableError,
} from "../provider-port";
import type { WooviClient } from "./client";
import { alignWooviCustomer, WooviCustomerMismatchError } from "./customer";

const PAYER = {
  email: "pagador.teste@example.com",
  name: "Pagadora de Teste",
  taxId: "52998224725",
};
const KEY = "cust-fake-0001";

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
    expect(await alignWooviCustomer(client, PAYER)).toBe("absent");
    expect(spies.findCustomerByTaxId).toHaveBeenCalledWith(PAYER.taxId);
    expect(spies.updateCustomer).not.toHaveBeenCalled();
  });

  it("matches: the same name and e-mail are not updated", async () => {
    const { client, spies } = fakeClient({ found: stored() });
    expect(await alignWooviCustomer(client, PAYER)).toBe("matches");
    expect(spies.updateCustomer).not.toHaveBeenCalled();
  });

  it("matches: extra spaces in the name and capitals in the e-mail do not count", async () => {
    const { client, spies } = fakeClient({
      found: stored({
        email: " Pagador.Teste@EXAMPLE.com ",
        name: "  Pagadora   de  Teste ",
      }),
    });
    expect(await alignWooviCustomer(client, PAYER)).toBe("matches");
    expect(spies.updateCustomer).not.toHaveBeenCalled();
  });

  it("matches: a customer with no e-mail differs from a payer with one", async () => {
    const { client, spies } = fakeClient({ found: stored({ email: null }) });
    expect(await alignWooviCustomer(client, PAYER)).toBe("updated");
    expect(spies.updateCustomer).toHaveBeenCalledTimes(1);
  });

  it("diverges: updates by the correlation ID with the trimmed name and e-mail", async () => {
    const { client, spies } = fakeClient({
      found: stored({ email: "outro@example.com", name: "Nome Antigo" }),
    });
    const result = await alignWooviCustomer(client, {
      ...PAYER,
      email: `  ${PAYER.email}  `,
      name: `  ${PAYER.name}  `,
    });
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
    const error = await alignWooviCustomer(client, PAYER).catch(
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
    await expect(alignWooviCustomer(client, PAYER)).rejects.toBeInstanceOf(
      WooviCustomerMismatchError
    );
  });

  it("a refused update propagates", async () => {
    const { client } = fakeClient({
      found: stored({ name: "Nome Antigo" }),
      update: () => Promise.reject(new ProviderRejectedError(422)),
    });
    const error = await alignWooviCustomer(client, PAYER).catch(
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(ProviderRejectedError);
    expect((error as ProviderRejectedError).status).toBe(422);
  });

  it("a lookup that fails propagates and nothing is updated", async () => {
    const { client, spies } = fakeClient();
    spies.findCustomerByTaxId.mockRejectedValueOnce(
      new ProviderUnavailableError()
    );
    await expect(alignWooviCustomer(client, PAYER)).rejects.toBeInstanceOf(
      ProviderUnavailableError
    );
    expect(spies.updateCustomer).not.toHaveBeenCalled();
  });

  it.each([
    ["a customer that is not an object", "x"],
    ["a customer with no name", { correlationID: KEY, email: PAYER.email }],
    ["a customer with no correlation ID", { email: PAYER.email, name: "N" }],
    ["a correlation ID that is a path", stored({ correlationID: "../x" })],
  ])("%s is a malformed answer", async (_name, found) => {
    const { client, spies } = fakeClient({ found });
    await expect(alignWooviCustomer(client, PAYER)).rejects.toMatchObject({
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
});
