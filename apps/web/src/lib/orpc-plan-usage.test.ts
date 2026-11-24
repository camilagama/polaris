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

  it("o cartão do plano guarda o uso numa venda enviada pelo sync/push e o perde com um comando de produto", async () => {
    const { orpcClient } = await load();
    const { clearPlanNotice, rememberPlanNotice, rememberedPlanNotice } =
      await import("../subscription/plan-notice");
    fetchMock.mockImplementation(() => Promise.resolve(rpcOk({})));
    const push = (types: string[]) =>
      orpcClient.sync
        .push({
          commands: types.map((type) => ({ type })),
          organizationId: orgId,
        } as never)
        .catch(() => undefined);
    const plan = {
      accessEndsAt: null,
      limits: { goals: 1, images: 50, variants: 50 },
      nextCharge: null,
      state: "free",
      usage: { goals: 0, images: 0, variants: 12 },
    } as never;
    rememberPlanNotice(orgId, plan, 1000, null);

    await push(["sale.confirm", "stock.receive", "stock.write_off"]);
    expect(rememberedPlanNotice(orgId, null)?.variants).toEqual({
      max: 50,
      used: 12,
    });

    await push(["sale.confirm", "product.create"]);
    expect(rememberedPlanNotice(orgId, null)?.variants).toBeNull();
    clearPlanNotice(null);
  });
});
