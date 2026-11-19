// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();

vi.mock("./browser-connection", () => ({
  browserConnection: {
    fetch: (request: Request, init?: RequestInit) => fetchMock(request, init),
  },
}));

const rpcOk = (json: unknown) =>
  new Response(JSON.stringify({ json, meta: [] }), {
    headers: { "content-type": "application/json" },
    status: 200,
  });

const rpcFail = () => new Response("{}", { status: 500 });

const orgId = "0199c2d0-0000-7000-8000-000000000001";

async function load() {
  const { orpcClient } = await import("./orpc");
  const { planRead } = await import("./plan-read");
  return { orpcClient, planRead };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.resetModules();
});

describe("o cliente RPC e a memória do plano", () => {
  it("uma gravação da lista apaga a memória, mesmo quando falha; uma leitura e uma gravação fora da lista não", async () => {
    const { orpcClient, planRead } = await load();
    const plan = { limits: {}, state: "free", usage: {} };
    let reads = 0;
    fetchMock.mockImplementation((request: Request) => {
      const path = new URL(request.url).pathname;
      if (path === "/rpc/billing/readPlan") {
        reads += 1;
        return Promise.resolve(rpcOk(plan));
      }
      if (path === "/rpc/product/create") {
        return Promise.resolve(rpcFail());
      }
      return Promise.resolve(rpcOk({}));
    });

    await planRead.get(orgId);
    await planRead.get(orgId);
    expect(reads).toBe(1);

    await orpcClient.sale
      .list({ organizationId: orgId } as never)
      .catch(() => undefined);
    await orpcClient.product
      .setVariantSku({ organizationId: orgId } as never)
      .catch(() => undefined);
    await planRead.get(orgId);
    expect(reads).toBe(1);

    await orpcClient.product
      .create({ organizationId: orgId } as never)
      .catch(() => undefined);
    await planRead.get(orgId);
    expect(reads).toBe(2);
  });
});
