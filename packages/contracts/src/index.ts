import type { ContractRouterClient } from "@orpc/contract";
import { oc } from "@orpc/contract";
import { z } from "zod";

const category = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  organizationId: z.string().min(1),
});

const organization = z.object({
  currency: z.literal("BRL"),
  id: z.string().uuid(),
  name: z.string().min(1),
  status: z.enum(["active", "suspended", "closed"]),
  timezone: z.string().min(1),
});

export const polarisContract = {
  category: {
    create: oc
      .input(
        z.object({
          name: z.string().trim().min(1).max(100),
          organizationId: z.string().trim().min(1),
        })
      )
      .output(category),
    list: oc
      .input(z.object({ organizationId: z.string().trim().min(1) }))
      .output(z.object({ categories: z.array(category) })),
  },
  organization: {
    createInitial: oc
      .input(
        z.object({
          name: z.string().trim().min(1).max(128),
          timezone: z.string().trim().min(1).max(64),
        })
      )
      .output(z.object({ created: z.boolean(), organization })),
  },
  system: {
    ping: oc.output(z.object({ message: z.literal("pong") })),
  },
};

export type PolarisRpcClient = ContractRouterClient<typeof polarisContract>;
