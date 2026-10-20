import {
  configureLogging,
  type LogFields,
  logger,
} from "@polaris/observability/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FAKE_CARD_TOKEN,
  FAKE_PAYER,
  paymentJson,
} from "../../../../../packages/billing/src/asaas/test-fixtures";

/**
 * ADR 0089: a refunded payment as Asaas answers it, with the payer's data in
 * the places the provider puts it, must not leave the logger readable even if
 * a future change logs the whole object.
 */

const PIX_KEY = "pagador.pix@example.com";
const EMV = "00020126580014br.gov.bcb.pix0136fake-emv-payload-0123456789";
const PHONE = "11987654321";

describe("redaction of an Asaas refund in the log (ADR 0089)", () => {
  let error: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    configureLogging({ service: "polaris-test" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the holder, the tax ID, the Pix key, the payload and the card token out of the output", () => {
    const refunded = {
      ...paymentJson({
        refunds: [
          {
            creditCardHolderInfo: {
              cpfCnpj: FAKE_PAYER.cpf,
              email: FAKE_PAYER.email,
              name: FAKE_PAYER.name,
              phone: PHONE,
            },
            dateCreated: "2026-10-27 10:00:00",
            status: "DONE",
            value: 24.9,
          },
        ],
        status: "REFUNDED",
      }),
      emv: EMV,
      pixKey: PIX_KEY,
      taxID: FAKE_PAYER.cpf,
      taxId: FAKE_PAYER.cpf,
    };

    logger.error("billing_refund_probe", {
      payment: refunded,
    } as unknown as LogFields);

    expect(error).toHaveBeenCalledTimes(1);
    const output = JSON.stringify(error.mock.calls);
    for (const leaked of [
      FAKE_PAYER.cpf,
      FAKE_PAYER.cpf.replace(/\D/g, ""),
      FAKE_PAYER.email,
      FAKE_PAYER.name,
      PIX_KEY,
      EMV,
      FAKE_CARD_TOKEN,
      PHONE,
    ]) {
      expect(output).not.toContain(leaked);
    }
    expect(output).toContain("[REDACTED:");
    // what is not personal stays readable, so the event is still useful
    expect(output).toContain("REFUNDED");
    expect(output).toContain("billing_refund_probe");
  });

  it("marks each category it removed", () => {
    logger.error("billing_refund_probe", {
      payment: {
        creditCardHolderInfo: {
          cpfCnpj: FAKE_PAYER.cpf,
          email: FAKE_PAYER.email,
          name: FAKE_PAYER.name,
          phone: PHONE,
        },
        creditCardToken: FAKE_CARD_TOKEN,
        emv: EMV,
        pixKey: PIX_KEY,
        taxID: FAKE_PAYER.cpf,
      },
    } as unknown as LogFields);

    const output = JSON.stringify(error.mock.calls);
    expect(output).toContain("[REDACTED:card]");
    expect(output).toContain("[REDACTED:cpf]");
    expect(output).toContain("[REDACTED:secret]");
  });
});
