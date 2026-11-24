import { describe, expect, it } from "vitest";
import {
  centsOfMoney,
  changeText,
  fieldTextOfCents,
  moneyOfCents,
  partMessages,
  restOfTotal,
  SPLIT_TOTAL_CHANGED_MESSAGE,
  type SplitDraft,
  splitBalance,
  splitBalanceSentence,
  splitTotalChangedNotice,
} from "./sale-split-model";

const brl = (reais: string, cents: string) =>
  BigInt(reais) * 100n + BigInt(cents);

describe("cents of an amount", () => {
  it("reads and writes without a float", () => {
    expect(centsOfMoney("100.01")).toBe(10001n);
    expect(centsOfMoney("0.07")).toBe(7n);
    expect(centsOfMoney("100")).toBe(10000n);
    expect(moneyOfCents(10001n)).toBe("100.01");
    expect(moneyOfCents(7n)).toBe("0.07");
    expect(fieldTextOfCents(6668n)).toBe("66,68");
  });
});

describe("the rest of the total", () => {
  it("is exact: total 100,01 with 33,33 in part 1 leaves 66,68", () => {
    const rest = restOfTotal(centsOfMoney("100.01"), centsOfMoney("33.33"));
    expect(moneyOfCents(rest)).toBe("66.68");
  });

  it("is exact where a float is not", () => {
    const rest = restOfTotal(centsOfMoney("0.30"), centsOfMoney("0.10"));
    expect(moneyOfCents(rest)).toBe("0.20");
    expect(
      moneyOfCents(restOfTotal(centsOfMoney("1.10"), centsOfMoney("0.10")))
    ).toBe("1.00");
  });

  it("keeps the cent a float would lose", () => {
    expect(
      moneyOfCents(restOfTotal(centsOfMoney("0.11"), centsOfMoney("0.10")))
    ).toBe("0.01");
    expect(
      moneyOfCents(restOfTotal(centsOfMoney("0.15"), centsOfMoney("0.01")))
    ).toBe("0.14");
  });

  it("is zero when part 1 takes the whole total or more", () => {
    expect(restOfTotal(10000n, 10000n)).toBe(0n);
    expect(restOfTotal(10000n, 15000n)).toBe(0n);
  });
});

describe("the state of the parts", () => {
  const total = centsOfMoney("100.01");

  it("closes with the rest in part 2: Fechou", () => {
    const balance = splitBalance({
      first: centsOfMoney("33.33"),
      methods: ["pix", "cash"],
      second: null,
      total,
    });
    expect(balance.kind).toBe("closed");
    expect(balance.second).toBe(6668n);
    expect(balance.text).toBe("Fechou: R$ 100,01");
    expect(balance.action).toBeNull();
    expect(balance.hint).toBeNull();
  });

  it("says what is missing and offers to put it in part 2", () => {
    const balance = splitBalance({
      first: centsOfMoney("33.33"),
      methods: ["pix", "cash"],
      second: centsOfMoney("60.00"),
      total,
    });
    expect(balance.kind).toBe("short");
    expect(balance.difference).toBe(-668n);
    expect(balance.text).toBe("Falta R$ 6,68");
    expect(balance.action).toEqual({
      amount: centsOfMoney("66.68"),
      kind: "add_to_second",
      label: "Pôr na parte 2",
    });
  });

  it("says what passed and offers to take it out of part 2", () => {
    const balance = splitBalance({
      first: centsOfMoney("33.33"),
      methods: ["pix", "pix"],
      second: centsOfMoney("70.00"),
      total,
    });
    expect(balance.kind).toBe("over");
    expect(balance.text).toBe("Passou R$ 3,32");
    expect(balance.action).toEqual({
      amount: centsOfMoney("66.68"),
      kind: "take_from_second",
      label: "Tirar da parte 2",
    });
  });

  it("offers no way to take out more than part 2 holds", () => {
    const balance = splitBalance({
      first: centsOfMoney("120.00"),
      methods: ["pix", "pix"],
      second: null,
      total,
    });
    expect(balance.kind).toBe("over");
    expect(balance.second).toBe(0n);
    expect(balance.action).toBeNull();
  });

  it("names the change only for the cash part", () => {
    const over = {
      first: brl("150", "00"),
      second: 0n,
      total: brl("100", "00"),
    };
    const cashFirst = splitBalance({ ...over, methods: ["cash", "pix"] });
    expect(cashFirst.text).toBe("Passou R$ 50,00");
    expect(cashFirst.hint).toBe(
      "Se for troco, a parte em dinheiro é R$ 100,00."
    );
    expect(splitBalanceSentence(cashFirst)).toBe(
      "Passou R$ 50,00. Se for troco, a parte em dinheiro é R$ 100,00."
    );

    const pixOnly = splitBalance({ ...over, methods: ["pix", "pix"] });
    expect(pixOnly.hint).toBeNull();
    expect(splitBalanceSentence(pixOnly)).toBe("Passou R$ 50,00");

    const cardOnly = splitBalance({ ...over, methods: ["credit_card", "pix"] });
    expect(cardOnly.hint).toBeNull();
  });

  it("names the change of the second part when that one is the cash", () => {
    const balance = splitBalance({
      first: brl("40", "00"),
      methods: ["pix", "cash"],
      second: brl("110", "00"),
      total: brl("100", "00"),
    });
    expect(balance.text).toBe("Passou R$ 50,00");
    expect(balance.hint).toBe(
      "Se for troco, a parte em dinheiro é R$ 60,00."
    );
    expect(balance.cashAdjust).toEqual({
      amount: brl("60", "00"),
      change: brl("50", "00"),
      label: "Ajustar para R$ 60,00",
      part: 2,
    });
  });

  it("offers Ajustar para on the cash part when it is part 1, not only Tirar da parte 2", () => {
    const balance = splitBalance({
      first: brl("250", "00"),
      methods: ["cash", "credit_card"],
      second: brl("100", "00"),
      total: brl("300", "00"),
    });
    expect(balance.hint).toBe(
      "Se for troco, a parte em dinheiro é R$ 200,00."
    );
    expect(balance.cashAdjust).toEqual({
      amount: brl("200", "00"),
      change: brl("50", "00"),
      label: "Ajustar para R$ 200,00",
      part: 1,
    });
    expect(changeText(balance.cashAdjust?.change ?? 0n)).toBe(
      "Troco: R$ 50,00"
    );
  });

  it("offers no Ajustar para without a single cash part", () => {
    const over = {
      first: brl("150", "00"),
      second: 0n,
      total: brl("100", "00"),
    };
    expect(
      splitBalance({ ...over, methods: ["pix", "pix"] }).cashAdjust
    ).toBeNull();
    expect(
      splitBalance({ ...over, methods: ["cash", "cash"] }).cashAdjust
    ).toBeNull();
  });

  it("names no change when two parts are cash, or when the extra eats the whole cash part", () => {
    expect(
      splitBalance({
        first: brl("60", "00"),
        methods: ["cash", "cash"],
        second: brl("60", "00"),
        total: brl("100", "00"),
      }).hint
    ).toBeNull();
    expect(
      splitBalance({
        first: brl("100", "00"),
        methods: ["pix", "cash"],
        second: brl("50", "00"),
        total: brl("100", "00"),
      }).hint
    ).toBeNull();
  });

  it("typing in part 2 stops the rest from following: the same first part, another second", () => {
    const first = centsOfMoney("33.33");
    expect(
      splitBalance({ first, methods: ["pix", "pix"], second: null, total })
        .second
    ).toBe(6668n);
    const typed = splitBalance({
      first,
      methods: ["pix", "pix"],
      second: centsOfMoney("10.00"),
      total,
    });
    expect(typed.second).toBe(1000n);
    expect(typed.kind).toBe("short");
  });
});

describe("the warning that the total moved", () => {
  const second = {
    payment: {
      anticipationRequested: false,
      installmentPlan: "",
      installments: "",
      method: "pix",
    },
    profile: { choice: "none", reviewNotice: null, seenVersion: null },
  } as const;
  const split = (
    amount: string | null,
    totalSeen: string | null
  ): SplitDraft => ({
    firstAmount: "10,00",
    second: { ...second, amount },
    totalSeen,
  });

  it("is said when typed parts were checked against another total", () => {
    expect(splitTotalChangedNotice(split("5,00", "15.00"), "20.00")).toBe(
      SPLIT_TOTAL_CHANGED_MESSAGE
    );
    expect(SPLIT_TOTAL_CHANGED_MESSAGE).toBe(
      "O total mudou. Confira as partes."
    );
  });

  it("is not said while part 2 is the rest, with the same total, or before any total was seen", () => {
    expect(splitTotalChangedNotice(split(null, "15.00"), "20.00")).toBeNull();
    expect(splitTotalChangedNotice(split("5,00", "15.00"), "15.00")).toBeNull();
    expect(splitTotalChangedNotice(split("5,00", null), "20.00")).toBeNull();
    expect(splitTotalChangedNotice(split("5,00", "15.00"), null)).toBeNull();
  });
});

describe("the messages of each part", () => {
  it("name the part, and a sale of one part keeps the texts of always", () => {
    const second = partMessages(2);
    expect(second.methodEmpty).toBe("Escolha o método da parte 2.");
    expect(second.amountEmpty).toBe("Informe o valor da parte 2.");
    expect(second.installmentsEmpty).toBe(
      "Informe o número de parcelas da parte 2."
    );
    expect(second.planEmpty).toBe("Escolha quem parcela na parte 2.");
    expect(partMessages(1).methodEmpty).toBe("Escolha o método da parte 1.");
    expect(partMessages(null).methodEmpty).toBe(
      "Escolha o método de pagamento."
    );
    expect(partMessages(null).planEmpty).toBe("Escolha quem parcela.");
  });
});
