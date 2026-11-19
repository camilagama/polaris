import { polarisContract } from "@polaris/contracts";
import { traverseContractProcedures } from "@orpc/server";
import { describe, expect, it, vi } from "vitest";
import {
  notifyPlanUsageChanged,
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
      [
        ...PLAN_USAGE_WRITES.filter((name) => name !== "sync/push"),
        ...PLAN_USAGE_NEUTRAL_WRITES,
      ].sort()
    );
    expect(PLAN_USAGE_WRITES).toContain("sync/push");
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
