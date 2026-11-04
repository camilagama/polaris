import {
  operatorCancelRenewal,
  refundCurrentPeriod,
} from "@polaris/billing/operator-commands";
import { ProviderUnavailableError } from "@polaris/billing/provider-port";
import { operatorProviderPortOf } from "@polaris/billing/provider-ports";
import { BillingCommandInProgressError } from "@polaris/db/billing-store";
import { logger } from "@polaris/observability/logger";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import {
  cancelRenewalCommand,
  InvalidOperatorReasonError,
  type ProviderCommandPorts,
  refundCommand,
} from "./provider-commands";

const PRINCIPAL = "0199a0a0-0000-7000-8000-000000000001";
const CASE_ID = "0199a0a0-0000-7000-8000-0000000000c1";
const COMMAND_ID = "0199a0a0-0000-7000-8000-0000000000d1";
const ORGANIZATION_ID = "7b9c212a-f90b-4e05-9e9a-0c0eb1c9c9b0";
const cancel = { commandId: COMMAND_ID, reason: "Cliente pediu" };
const refund = { ...cancel, expectedAmount: "24.90" };

type FakePorts = {
  [K in keyof ProviderCommandPorts]: Mock<ProviderCommandPorts[K]>;
};

function fakePorts(overrides: Partial<ProviderCommandPorts> = {}) {
  const calls: string[] = [];
  const ports = {
    audit: vi.fn((_principal, _case, event: string) => {
      calls.push(`audit:${event}`);
      return Promise.resolve(ORGANIZATION_ID);
    }),
    cancelRenewal: vi.fn(() => {
      calls.push("port:cancel");
      return Promise.resolve("cancelled" as const);
    }),
    refund: vi.fn(() => {
      calls.push("port:refund");
      return Promise.resolve("refund_requested" as const);
    }),
    report: vi.fn(),
    ...overrides,
  };
  return { calls, ports: ports as unknown as FakePorts };
}

describe("cancelRenewalCommand", () => {
  it("records the request, runs the command, then records the outcome, in this order", async () => {
    const { calls, ports } = fakePorts();

    const result = await cancelRenewalCommand(
      ports,
      PRINCIPAL,
      CASE_ID,
      cancel
    );

    expect(result).toEqual({ outcomeRecorded: true, result: "cancelled" });
    expect(calls).toEqual([
      "audit:billing.operator_renewal_cancel_requested",
      "port:cancel",
      "audit:billing.operator_renewal_cancel_recorded",
    ]);
  });

  it("writes both audit rows under the command ID, the outcome as the detail", async () => {
    const { ports } = fakePorts();

    await cancelRenewalCommand(ports, PRINCIPAL, CASE_ID, cancel);

    expect(ports.audit.mock.calls).toEqual([
      [
        PRINCIPAL,
        CASE_ID,
        "billing.operator_renewal_cancel_requested",
        COMMAND_ID,
        null,
      ],
      [
        PRINCIPAL,
        CASE_ID,
        "billing.operator_renewal_cancel_recorded",
        COMMAND_ID,
        "result=cancelled",
      ],
    ]);
  });

  it("runs the command for the store the audit named, with the operator as actor and the trimmed reason", async () => {
    const { ports } = fakePorts();

    await cancelRenewalCommand(ports, PRINCIPAL, CASE_ID, {
      commandId: COMMAND_ID,
      reason: "  Cliente pediu  ",
    });

    expect(ports.cancelRenewal).toHaveBeenCalledExactlyOnceWith({
      commandId: COMMAND_ID,
      decision: { actor: `admin:${PRINCIPAL}`, reason: "Cliente pediu" },
      organizationId: ORGANIZATION_ID,
    });
  });

  it("does nothing when the request cannot be recorded, and the error goes up", async () => {
    const { ports } = fakePorts({
      audit: vi.fn(() => Promise.reject(new Error("case_not_open"))),
    });

    await expect(
      cancelRenewalCommand(ports, PRINCIPAL, CASE_ID, cancel)
    ).rejects.toThrow("case_not_open");
    expect(ports.cancelRenewal).not.toHaveBeenCalled();
  });

  it("does nothing when the audit names no store", async () => {
    const { ports } = fakePorts({ audit: vi.fn(() => Promise.resolve(null)) });

    await expect(
      cancelRenewalCommand(ports, PRINCIPAL, CASE_ID, cancel)
    ).rejects.toThrow("case_organization_unavailable");
    expect(ports.cancelRenewal).not.toHaveBeenCalled();
  });

  it.each([
    ["a provider that is unavailable", new ProviderUnavailableError()],
    ["any other error", new Error("boom")],
  ])(
    "is provider_unavailable for %s, with the request alone in the audit",
    async (_name, error) => {
      const { ports } = fakePorts({
        cancelRenewal: vi.fn(() => Promise.reject(error)),
      });

      const result = await cancelRenewalCommand(
        ports,
        PRINCIPAL,
        CASE_ID,
        cancel
      );

      expect(result).toEqual({
        outcomeRecorded: false,
        result: "provider_unavailable",
      });
      expect(ports.audit).toHaveBeenCalledOnce();
      expect(ports.audit.mock.calls[0]?.[2]).toBe(
        "billing.operator_renewal_cancel_requested"
      );
    }
  );

  it("reports an unknown outcome with the class of the error and the operation, never its message", async () => {
    const { ports } = fakePorts({
      cancelRenewal: vi.fn(() =>
        Promise.reject(new TypeError("SEGREDO-DO-PROVEDOR dono@example.com"))
      ),
    });

    await cancelRenewalCommand(ports, PRINCIPAL, CASE_ID, cancel);

    expect(ports.report).toHaveBeenCalledExactlyOnceWith(
      "billing_operator_command_unknown",
      { errorClass: "TypeError", operation: "billing.cancel_renewal" }
    );
  });

  it("is command_in_progress when another command holds the store, and the refusal is recorded", async () => {
    const { ports } = fakePorts({
      cancelRenewal: vi.fn(() =>
        Promise.reject(new BillingCommandInProgressError())
      ),
    });

    const result = await cancelRenewalCommand(
      ports,
      PRINCIPAL,
      CASE_ID,
      cancel
    );

    expect(result).toEqual({
      outcomeRecorded: true,
      result: "command_in_progress",
    });
    expect(ports.audit.mock.calls[1]?.[4]).toBe("result=command_in_progress");
    expect(ports.report).not.toHaveBeenCalled();
  });

  it("returns the result of the command when its outcome cannot be recorded", async () => {
    const audit = vi
      .fn()
      .mockResolvedValueOnce(ORGANIZATION_ID)
      .mockRejectedValueOnce(new Error("database down"));
    const { ports } = fakePorts({ audit });

    const result = await cancelRenewalCommand(
      ports,
      PRINCIPAL,
      CASE_ID,
      cancel
    );

    expect(result).toEqual({ outcomeRecorded: false, result: "cancelled" });
    expect(audit).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["empty", ""],
    ["blank", "   "],
    ["too long", "a".repeat(301)],
    ["with a control character", "a\u0007b"],
  ])(
    "refuses a reason that is %s before any audit or command",
    async (_name, reason) => {
      const { ports } = fakePorts();

      await expect(
        cancelRenewalCommand(ports, PRINCIPAL, CASE_ID, { ...cancel, reason })
      ).rejects.toBeInstanceOf(InvalidOperatorReasonError);
      expect(ports.audit).not.toHaveBeenCalled();
      expect(ports.cancelRenewal).not.toHaveBeenCalled();
    }
  );

  it.each(["already_cancelled", "nothing_to_cancel", "not_linked"] as const)(
    "records %s as the outcome",
    async (answer) => {
      const { ports } = fakePorts({
        cancelRenewal: vi.fn(() => Promise.resolve(answer)),
      });

      const result = await cancelRenewalCommand(
        ports,
        PRINCIPAL,
        CASE_ID,
        cancel
      );

      expect(result).toEqual({ outcomeRecorded: true, result: answer });
      expect(ports.audit.mock.calls[1]?.[4]).toBe(`result=${answer}`);
    }
  );
});

describe("refundCommand", () => {
  it("records the request, runs the command, then records the outcome, in this order", async () => {
    const { calls, ports } = fakePorts();

    const result = await refundCommand(ports, PRINCIPAL, CASE_ID, refund);

    expect(result).toEqual({
      outcomeRecorded: true,
      result: "refund_requested",
    });
    expect(calls).toEqual([
      "audit:billing.operator_refund_requested",
      "port:refund",
      "audit:billing.operator_refund_recorded",
    ]);
  });

  it("writes both audit rows under the command ID, the outcome and the amount as the detail", async () => {
    const { ports } = fakePorts();

    await refundCommand(ports, PRINCIPAL, CASE_ID, refund);

    expect(ports.audit.mock.calls).toEqual([
      [
        PRINCIPAL,
        CASE_ID,
        "billing.operator_refund_requested",
        COMMAND_ID,
        null,
      ],
      [
        PRINCIPAL,
        CASE_ID,
        "billing.operator_refund_recorded",
        COMMAND_ID,
        "result=refund_requested;amount=24.90",
      ],
    ]);
  });

  it("asks the command for the amount the operator saw, for the store the audit named", async () => {
    const { ports } = fakePorts();

    await refundCommand(ports, PRINCIPAL, CASE_ID, refund);

    expect(ports.refund).toHaveBeenCalledExactlyOnceWith({
      commandId: COMMAND_ID,
      decision: { actor: `admin:${PRINCIPAL}`, reason: "Cliente pediu" },
      expectedAmount: "24.90",
      organizationId: ORGANIZATION_ID,
    });
  });

  it("does nothing when the request cannot be recorded (the hourly limit, a closed case), and the error goes up", async () => {
    const { ports } = fakePorts({
      audit: vi.fn(() =>
        Promise.reject(new Error("operator_refund_rate_limited"))
      ),
    });

    await expect(
      refundCommand(ports, PRINCIPAL, CASE_ID, refund)
    ).rejects.toThrow("operator_refund_rate_limited");
    expect(ports.refund).not.toHaveBeenCalled();
  });

  it.each([
    ["a provider that is unavailable", new ProviderUnavailableError()],
    ["any other error", new Error("boom")],
  ])(
    "is provider_unavailable for %s, with the request alone in the audit",
    async (_name, error) => {
      const { ports } = fakePorts({
        refund: vi.fn(() => Promise.reject(error)),
      });

      const result = await refundCommand(ports, PRINCIPAL, CASE_ID, refund);

      expect(result).toEqual({
        outcomeRecorded: false,
        result: "provider_unavailable",
      });
      expect(ports.audit).toHaveBeenCalledOnce();
      expect(ports.audit.mock.calls[0]?.[2]).toBe(
        "billing.operator_refund_requested"
      );
      expect(ports.report).toHaveBeenCalledExactlyOnceWith(
        "billing_operator_command_unknown",
        expect.objectContaining({ operation: "billing.refund" })
      );
    }
  );

  it("is command_in_progress when another command holds the store, and the refusal is recorded with the amount", async () => {
    const { ports } = fakePorts({
      refund: vi.fn(() => Promise.reject(new BillingCommandInProgressError())),
    });

    const result = await refundCommand(ports, PRINCIPAL, CASE_ID, refund);

    expect(result).toEqual({
      outcomeRecorded: true,
      result: "command_in_progress",
    });
    expect(ports.audit.mock.calls[1]?.[4]).toBe(
      "result=command_in_progress;amount=24.90"
    );
  });

  it("returns the result of the command when its outcome cannot be recorded", async () => {
    const audit = vi
      .fn()
      .mockResolvedValueOnce(ORGANIZATION_ID)
      .mockRejectedValueOnce(new Error("database down"));
    const { ports } = fakePorts({ audit });

    const result = await refundCommand(ports, PRINCIPAL, CASE_ID, refund);

    expect(result).toEqual({
      outcomeRecorded: false,
      result: "refund_requested",
    });
  });

  it.each([
    ["empty", ""],
    ["too long", "a".repeat(301)],
    ["with a control character", "a\u001Fb"],
  ])(
    "refuses a reason that is %s before any audit or command",
    async (_name, reason) => {
      const { ports } = fakePorts();

      await expect(
        refundCommand(ports, PRINCIPAL, CASE_ID, { ...refund, reason })
      ).rejects.toBeInstanceOf(InvalidOperatorReasonError);
      expect(ports.audit).not.toHaveBeenCalled();
      expect(ports.refund).not.toHaveBeenCalled();
    }
  );

  it.each([
    "amount_changed",
    "nothing_to_refund",
    "not_linked",
    "refund_not_supported",
  ] as const)("records %s as the outcome", async (answer) => {
    const { ports } = fakePorts({
      refund: vi.fn(() => Promise.resolve(answer)),
    });

    const result = await refundCommand(ports, PRINCIPAL, CASE_ID, refund);

    expect(result).toEqual({ outcomeRecorded: true, result: answer });
    expect(ports.audit.mock.calls[1]?.[4]).toBe(
      `result=${answer};amount=24.90`
    );
  });
});

describe("what the provider answers never reaches the result or a log (the real commands over the real Asaas port)", () => {
  const MARKER = "SEGREDO-DO-PROVEDOR";
  const EMAIL = "pagador.secreto@example.com";
  const REF = "chk_REF-BRUTA";
  const SUBSCRIPTION = "sub_BRUTO";
  const API_KEY = "$aact_hmlg_fake";
  const link = {
    provider: "asaas",
    providerRef: REF,
    providerSubscriptionId: SUBSCRIPTION,
  };
  const FORBIDDEN = [MARKER, EMAIL, REF, SUBSCRIPTION, API_KEY, "aact_hmlg"];

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function fakeStore(storedLink: typeof link = link) {
    return {
      processEvent: vi.fn(() => Promise.resolve({ status: "applied" })),
      readProviderLink: vi.fn(() => Promise.resolve(storedLink)),
      readRecord: vi.fn(() => Promise.resolve(null)),
      recordEvent: vi.fn(() =>
        Promise.resolve({ duplicate: false, id: "ev-1" })
      ),
      recordOperatorDecision: vi.fn(() => Promise.resolve()),
      withOrganizationLock: vi.fn(
        (_organizationId: string, operation: () => Promise<unknown>) =>
          operation()
      ),
    };
  }

  const answers = {
    "a 400 whose body carries the provider's text and an e-mail": () => ({
      status: 400,
      text: () =>
        Promise.resolve(
          JSON.stringify({
            errors: [
              { code: "invalid_action", description: `${MARKER} ${EMAIL}` },
            ],
          })
        ),
    }),
    "a 500 whose header and body are marked": () => ({
      headers: { "x-erro": `${MARKER} ${EMAIL}` },
      status: 500,
      text: () => Promise.resolve(`${MARKER} ${EMAIL} ${REF} ${SUBSCRIPTION}`),
    }),
    "a network failure whose message is marked": () => {
      throw new Error(`${MARKER} ${EMAIL} ${API_KEY}`);
    },
  };

  /** Everything the commands and the port can print or hand back, captured over the real logger. */
  function capture() {
    const printed: unknown[][] = [];
    for (const method of ["debug", "error", "info", "log", "warn"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        printed.push(args);
      });
    }
    const logged: unknown[][] = [];
    for (const level of ["debug", "error", "info", "warn"] as const) {
      const original = logger[level].bind(logger);
      vi.spyOn(logger, level).mockImplementation((...args) => {
        logged.push([level, ...args]);
        original(...args);
      });
    }
    const reported: unknown[][] = [];
    return {
      everything: () => JSON.stringify([printed, logged, reported]),
      reported,
      seen: () => printed.length + logged.length,
    };
  }

  function realPorts(
    fetch: (url: string) => unknown,
    reported: unknown[][],
    storedLink: typeof link = link
  ): ProviderCommandPorts {
    const store = fakeStore(storedLink);
    const portFor = (provider: string) =>
      operatorProviderPortOf(
        {
          ASAAS_API_KEY: API_KEY,
          ASAAS_BASE_URL: "https://api-sandbox.asaas.com/v3",
        },
        provider,
        { fetch: ((url: string) => Promise.resolve(fetch(url))) as never }
      );
    return {
      audit: () => Promise.resolve(ORGANIZATION_ID),
      cancelRenewal: (input) =>
        operatorCancelRenewal({ portFor, store: store as never }, input),
      refund: (input) =>
        refundCurrentPeriod(
          { portFor, store: store as never },
          {
            decision: input.decision,
            expectedAmount: input.expectedAmount,
            organizationId: input.organizationId,
            requestId: input.commandId,
          }
        ),
      report: (event, fields) => {
        reported.push([event, fields]);
      },
    };
  }

  describe.each(Object.entries(answers))("%s", (_name, answer) => {
    it("makes the cancellation provider_unavailable and leaks nothing", async () => {
      const spy = capture();
      const ports = realPorts(answer, spy.reported);

      const result = await cancelRenewalCommand(
        ports,
        PRINCIPAL,
        CASE_ID,
        cancel
      );

      expect(result).toEqual({
        outcomeRecorded: false,
        result: "provider_unavailable",
      });
      for (const text of FORBIDDEN) {
        expect(JSON.stringify(result)).not.toContain(text);
        expect(spy.everything()).not.toContain(text);
        expect(JSON.stringify(spy.reported)).not.toContain(text);
      }
      expect(spy.reported).toHaveLength(1);
    });

    it("makes the refund provider_unavailable and leaks nothing", async () => {
      const spy = capture();
      const ports = realPorts(answer, spy.reported);

      const result = await refundCommand(ports, PRINCIPAL, CASE_ID, refund);

      expect(result).toEqual({
        outcomeRecorded: false,
        result: "provider_unavailable",
      });
      for (const text of FORBIDDEN) {
        expect(JSON.stringify(result)).not.toContain(text);
        expect(spy.everything()).not.toContain(text);
        expect(JSON.stringify(spy.reported)).not.toContain(text);
      }
      expect(spy.reported).toHaveLength(1);
    });
  });

  it("sees the logger at work: a command that succeeds does log, and still names no reference", async () => {
    const OK_CHECKOUT = "c6d42a6f-0000-4000-8000-000000000001";
    const OK_SUBSCRIPTION = "sub_fake0000000001";
    const spy = capture();
    const ports = realPorts(
      (url) => {
        if (url.includes(`/subscriptions/${OK_SUBSCRIPTION}`)) {
          return {
            status: 200,
            text: () =>
              Promise.resolve(
                JSON.stringify({
                  billingType: "CREDIT_CARD",
                  checkoutSession: OK_CHECKOUT,
                  customer: "cus_x",
                  cycle: "MONTHLY",
                  deleted: true,
                  id: OK_SUBSCRIPTION,
                  object: "subscription",
                  status: "INACTIVE",
                  value: 24.9,
                })
              ),
          };
        }
        return { status: 404, text: () => Promise.resolve("{}") };
      },
      spy.reported,
      {
        provider: "asaas",
        providerRef: OK_CHECKOUT,
        providerSubscriptionId: OK_SUBSCRIPTION,
      }
    );

    const result = await cancelRenewalCommand(
      ports,
      PRINCIPAL,
      CASE_ID,
      cancel
    );

    expect(result.outcomeRecorded).toBe(true);
    expect(spy.seen()).toBeGreaterThan(0);
    for (const text of [OK_CHECKOUT, OK_SUBSCRIPTION, API_KEY]) {
      expect(spy.everything()).not.toContain(text);
    }
  });
});
