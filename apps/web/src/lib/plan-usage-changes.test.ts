import { polarisContract } from "@polaris/contracts";
import { traverseContractProcedures } from "@orpc/server";
import { describe, expect, it, vi } from "vitest";
import {
  notifyPlanUsageChanged,
  PLAN_USAGE_CONDITIONAL_WRITES,
  PLAN_USAGE_NEUTRAL_WRITES,
  PLAN_USAGE_WRITES,
  subscribePlanUsageChanges,
  trackPlanUsageWrite,
  writeChangesPlanUsage,
} from "./plan-usage-changes";
import { READ_PROCEDURES } from "./read-procedures";

const GROUPS = ["billing", "plan", "product"];

describe("as gravações que mudam o uso do plano", () => {
  it("cada escrita de produto, plano e cobrança do contrato está na lista ou nas exclusões, e a lista não tem nome que o contrato não tem", () => {
    const writes: string[] = [];
    traverseContractProcedures(
      { path: [], router: polarisContract },
      ({ path }) => {
        const name = path.join("/");
        if (GROUPS.includes(path[0] ?? "") && !READ_PROCEDURES.includes(name)) {
          writes.push(name);
        }
      }
    );
    expect(writes.sort()).toEqual(
      [...PLAN_USAGE_WRITES, ...PLAN_USAGE_NEUTRAL_WRITES].sort()
    );
  });

  it("sync/push é a única escrita condicional e existe no contrato", () => {
    const names: string[] = [];
    traverseContractProcedures(
      { path: [], router: polarisContract },
      ({ path }) => {
        names.push(path.join("/"));
      }
    );
    expect(PLAN_USAGE_CONDITIONAL_WRITES).toEqual(["sync/push"]);
    expect(names).toContain("sync/push");
    expect(PLAN_USAGE_WRITES).not.toContain("sync/push");
  });

  it("só as gravações da lista apagam a memória", () => {
    expect(writeChangesPlanUsage(["product", "create"])).toBe(true);
    expect(writeChangesPlanUsage(["product", "importBatch"])).toBe(true);
    expect(writeChangesPlanUsage(["plan", "selectOperationalVariants"])).toBe(
      true
    );
    expect(writeChangesPlanUsage(["product", "setVariantSku"])).toBe(false);
    expect(writeChangesPlanUsage(["sale", "confirm"])).toBe(false);
    expect(writeChangesPlanUsage(["billing", "readPlan"])).toBe(false);
  });

  it("um lote de sync/push só com venda, estoque ou cliente não apaga a memória", () => {
    const batch = (...types: string[]) => ({
      commands: types.map((type) => ({ type })),
    });
    const push = ["sync", "push"];
    expect(writeChangesPlanUsage(push, batch("sale.confirm"))).toBe(false);
    expect(
      writeChangesPlanUsage(
        push,
        batch("stock.receive", "stock.count", "stock.write_off")
      )
    ).toBe(false);
    expect(
      writeChangesPlanUsage(push, batch("customer.create", "customer.update"))
    ).toBe(false);
  });

  it("um lote de sync/push com um comando de produto, ou de tipo desconhecido, apaga a memória", () => {
    const push = ["sync", "push"];
    expect(
      writeChangesPlanUsage(push, {
        commands: [{ type: "sale.confirm" }, { type: "product.create" }],
      })
    ).toBe(true);
    expect(
      writeChangesPlanUsage(push, { commands: [{ type: "product.archive" }] })
    ).toBe(true);
    expect(writeChangesPlanUsage(push, { commands: [{}] })).toBe(true);
    expect(writeChangesPlanUsage(push, undefined)).toBe(true);
    expect(writeChangesPlanUsage(push, { commands: "x" })).toBe(true);
    expect(writeChangesPlanUsage(push, null)).toBe(true);
    expect(writeChangesPlanUsage(push, "x")).toBe(true);
  });

  it("avisa quando a gravação responde e quando ela falha", async () => {
    const heard = vi.fn();
    const stop = subscribePlanUsageChanges(heard);
    await trackPlanUsageWrite(() => Promise.resolve("ok"));
    expect(heard).toHaveBeenCalledTimes(1);
    await expect(
      trackPlanUsageWrite(() => Promise.reject(new Error("rede")))
    ).rejects.toThrow("rede");
    expect(heard).toHaveBeenCalledTimes(2);
    stop();
    notifyPlanUsageChanged();
    expect(heard).toHaveBeenCalledTimes(2);
  });
});
