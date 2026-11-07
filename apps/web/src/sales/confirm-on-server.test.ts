import { beforeEach, describe, expect, it, vi } from "vitest";

const confirm = vi.hoisted(() => vi.fn());

vi.mock("../lib/orpc", () => ({
  orpcClient: { sale: { confirm: (request: unknown) => confirm(request) } },
}));

import { confirmOnServer } from "./confirm-on-server";
import type { Prepared } from "./confirm-outcome";

function prepared(percentage: string): Prepared {
  return {
    attempt: { commandId: "attempt-1", fingerprint: "f" },
    request: {
      adjustments: [
        { kind: "discount", value: { percentage, type: "percentage" } },
      ],
    },
  } as unknown as Prepared;
}

describe("confirmOnServer", () => {
  beforeEach(() => {
    confirm.mockReset();
  });

  it("tells the percentage cap when the server refuses an adjustment sent above 100%", async () => {
    confirm.mockRejectedValue({
      code: "BAD_REQUEST",
      data: { reason: "invalid_sale_adjustment" },
    });
    const outcome = await confirmOnServer(prepared("150"));
    expect(outcome.completed).toBe(false);
    expect(outcome.submission).toMatchObject({
      failure: { message: "O percentual vai até 100%." },
      phase: "failed",
    });
  });

  it("keeps the generic adjustment message for a percentage within the cap", async () => {
    confirm.mockRejectedValue({
      code: "BAD_REQUEST",
      data: { reason: "invalid_sale_adjustment" },
    });
    const outcome = await confirmOnServer(prepared("10"));
    expect(outcome.submission).toMatchObject({
      failure: {
        message:
          "Revise os ajustes: os valores devem ser positivos e percentual só vale para desconto e acréscimo.",
      },
    });
  });
});
