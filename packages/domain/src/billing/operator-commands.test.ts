import { describe, expect, it } from "vitest";
import {
  normalizeOperatorReason,
  OPERATOR_REASON_MAX_LENGTH,
  operatorDecisionEventId,
  operatorDecisionFactType,
} from "./operator-commands";

const COMMAND_ID = "0199a1b2-c3d4-7e5f-9a6b-7c8d9e0f1a2d";

describe("normalizeOperatorReason", () => {
  it("o teto é de 300 caracteres", () => {
    expect(OPERATOR_REASON_MAX_LENGTH).toBe(300);
  });

  it("tira os espaços das pontas", () => {
    expect(normalizeOperatorReason(" motivo ")).toBe("motivo");
    expect(normalizeOperatorReason("\nabc")).toBe("abc");
  });

  it("mantém o espaço interno comum", () => {
    expect(normalizeOperatorReason("cliente pediu estorno")).toBe(
      "cliente pediu estorno"
    );
  });

  it.each(["", "  \n "])(
    "texto vazio ou só de espaços (%j) vira null",
    (text) => {
      expect(normalizeOperatorReason(text)).toBeNull();
    }
  );

  it("aceita 300 caracteres e recusa 301", () => {
    expect(normalizeOperatorReason("a".repeat(300))).toBe("a".repeat(300));
    expect(normalizeOperatorReason("a".repeat(301))).toBeNull();
  });

  it("conta por ponto de código, não por unidade UTF-16", () => {
    expect(normalizeOperatorReason("😀".repeat(300))).toBe("😀".repeat(300));
    expect(normalizeOperatorReason("😀".repeat(301))).toBeNull();
  });

  it("conta o tamanho depois de tirar os espaços das pontas", () => {
    expect(normalizeOperatorReason(` ${"a".repeat(300)} `)).toBe(
      "a".repeat(300)
    );
  });

  it.each([
    ["quebra de linha", "a\nb"],
    ["tabulação", "a\tb"],
    ["DEL", "a\u007fb"],
    ["NUL na ponta, que o trim não tira", "\u0000abc"],
    ["U+001F, o último controle antes do espaço", "a\u001fb"],
    ["U+001F na ponta, que o trim não tira", "\u001fabc"],
  ])("caractere de controle no meio (%s) vira null", (_label, text) => {
    expect(normalizeOperatorReason(text)).toBeNull();
  });

  it("aceita o espaço U+0020 no meio, o primeiro caractere acima dos controles", () => {
    expect(normalizeOperatorReason("a b")).toBe("a b");
    expect(normalizeOperatorReason("a!b")).toBe("a!b");
  });
});

describe("operatorDecisionEventId", () => {
  it("monta o ID do razão com o tipo e o ID do comando", () => {
    expect(operatorDecisionEventId("refund", COMMAND_ID)).toBe(
      `command:operator_refund:${COMMAND_ID}`
    );
    expect(operatorDecisionEventId("cancel_renewal", COMMAND_ID)).toBe(
      `command:operator_cancel_renewal:${COMMAND_ID}`
    );
  });

  it("UUID em maiúsculas sai em minúsculas e igual ao de minúsculas", () => {
    const upper = operatorDecisionEventId("refund", COMMAND_ID.toUpperCase());
    expect(upper).toBe(`command:operator_refund:${COMMAND_ID}`);
    expect(upper).toBe(operatorDecisionEventId("refund", COMMAND_ID));
  });

  it("os dois tipos com o mesmo commandId dão IDs diferentes", () => {
    expect(operatorDecisionEventId("refund", COMMAND_ID)).not.toBe(
      operatorDecisionEventId("cancel_renewal", COMMAND_ID)
    );
  });

  it("o mesmo par dá sempre o mesmo ID (idempotência)", () => {
    expect(operatorDecisionEventId("refund", COMMAND_ID)).toBe(
      operatorDecisionEventId("refund", COMMAND_ID)
    );
  });

  it.each([
    ["vazio", ""],
    ["texto qualquer", "abc"],
    ["1 caractere a menos", COMMAND_ID.slice(0, -1)],
    ["1 caractere a mais", `${COMMAND_ID}0`],
    ["com espaço", ` ${COMMAND_ID}`],
    ["entre chaves", `{${COMMAND_ID}}`],
    ["caractere não hexadecimal", COMMAND_ID.replace("0199", "g199")],
  ])("recusa o ID do comando inválido: %s", (_label, id) => {
    expect(() => operatorDecisionEventId("refund", id)).toThrow(
      new TypeError("invalid_command_id")
    );
  });
});

describe("operatorDecisionFactType", () => {
  it("dá o tipo do fato de cada comando", () => {
    expect(operatorDecisionFactType("refund")).toBe(
      "operator_refund_requested"
    );
    expect(operatorDecisionFactType("cancel_renewal")).toBe(
      "operator_renewal_cancel_requested"
    );
  });

  it("os dois tipos são diferentes", () => {
    expect(operatorDecisionFactType("refund")).not.toBe(
      operatorDecisionFactType("cancel_renewal")
    );
  });
});
