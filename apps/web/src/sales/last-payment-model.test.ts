import { describe, expect, it } from "vitest";
import {
  lastPaymentKey,
  paymentOfSentForm,
  readLastPayment,
  salePresetFrom,
  writeLastPayment,
} from "./last-payment-model";
import {
  applySalePreset,
  createBlankSaleForm,
  isSaleFormDirty,
  NO_PROFILE_CHOICE,
  NO_SALE_PRESET,
  reconcileProfileReload,
  type SaleFormState,
  withdrawSalePreset,
} from "./sale-form-model";

const ORG = "11111111-1111-4111-8111-111111111111";
const PROFILE = "22222222-2222-4222-8222-222222222222";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    removeItem: (key: string) => {
      data.delete(key);
    },
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}

let ids = 0;
const nextId = () => {
  ids += 1;
  return `draft-${ids}`;
};
const blank = () => createBlankSaleForm(nextId);

function profileModel(version: number) {
  return {
    id: PROFILE,
    name: "Maquininha",
    status: "active",
    version,
  } as unknown as Parameters<typeof reconcileProfileReload>[1][number];
}

describe("o método e o perfil da última venda, neste aparelho", () => {
  it("guarda por loja e lê de volta o que guardou", () => {
    const storage = memoryStorage();
    writeLastPayment(storage, ORG, {
      method: "pix",
      profile: { id: PROFILE, version: 3 },
    });
    expect(storage.data.has(lastPaymentKey(ORG))).toBe(true);
    expect(readLastPayment(storage, ORG)).toEqual({
      method: "pix",
      profile: { id: PROFILE, version: 3 },
    });
    expect(readLastPayment(storage, "outra-loja")).toBeNull();
  });

  it("o que não se lê não é lembrado: JSON quebrado, método desconhecido, perfil sem versão", () => {
    for (const text of [
      "{",
      JSON.stringify({ method: "cheque", profile: null }),
      JSON.stringify({ method: "pix", profile: { id: PROFILE } }),
      JSON.stringify({ method: "pix", profile: { id: "", version: 1 } }),
      JSON.stringify({
        method: "pix",
        profile: { id: NO_PROFILE_CHOICE, version: 1 },
      }),
      JSON.stringify(null),
    ]) {
      const storage = memoryStorage({ [lastPaymentKey(ORG)]: text });
      expect(readLastPayment(storage, ORG), text).toBeNull();
    }
    expect(readLastPayment(null, ORG)).toBeNull();
  });

  it("um armazenamento cheio só custa a conveniência", () => {
    const storage = {
      getItem: () => null,
      removeItem: () => undefined,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(() =>
      writeLastPayment(storage, ORG, { method: "cash", profile: null })
    ).not.toThrow();
  });

  it("do formulário enviado: o método e o perfil com a versão revisada, ou Sem perfil", () => {
    const form: SaleFormState = {
      ...blank(),
      payment: { ...blank().payment, method: "debit_card" },
      profile: { choice: PROFILE, reviewNotice: null, seenVersion: 7 },
    };
    expect(paymentOfSentForm(form)).toEqual({
      method: "debit_card",
      profile: { id: PROFILE, version: 7 },
    });
    expect(
      paymentOfSentForm({
        ...form,
        profile: {
          choice: NO_PROFILE_CHOICE,
          reviewNotice: null,
          seenVersion: null,
        },
      })
    ).toEqual({ method: "debit_card", profile: null });
    expect(paymentOfSentForm(blank())).toBeNull();
  });
});

describe("a venda nova começa com o que quase nunca muda", () => {
  it("sem lembrança e loja sem perfil ativo: Sem perfil já escolhido, método em branco", () => {
    expect(salePresetFrom(null, 0)).toEqual({
      method: "",
      profileChoice: NO_PROFILE_CHOICE,
      profileVersion: null,
    });
    // perfis ainda não lidos, ou loja com perfis: nada escolhido pela pessoa
    expect(salePresetFrom(null, null)).toEqual(NO_SALE_PRESET);
    expect(salePresetFrom(null, 2)).toEqual(NO_SALE_PRESET);
  });

  it("com lembrança: o método e o perfil da última venda, com a versão usada", () => {
    expect(
      salePresetFrom({ method: "pix", profile: { id: PROFILE, version: 4 } }, 3)
    ).toEqual({ method: "pix", profileChoice: PROFILE, profileVersion: 4 });
    expect(salePresetFrom({ method: "cash", profile: null }, 0)).toEqual({
      method: "cash",
      profileChoice: NO_PROFILE_CHOICE,
      profileVersion: null,
    });
  });

  it('"Sem perfil" lembrado numa loja com perfil ativo mantém o método e deixa o perfil em branco', () => {
    const remembered = { method: "pix" as const, profile: null };
    const methodOnly = {
      method: "pix",
      profileChoice: "",
      profileVersion: null,
    };
    for (const count of [1, 3, null]) {
      expect(salePresetFrom(remembered, count)).toEqual(methodOnly);
    }
    const stillOnTheScreen = applySalePreset(
      blank(),
      salePresetFrom(remembered, 0)
    );
    expect(stillOnTheScreen.profile.choice).toBe(NO_PROFILE_CHOICE);
    expect(stillOnTheScreen.payment.method).toBe("pix");
    const afterFirstProfile = applySalePreset(
      blank(),
      salePresetFrom(remembered, 1)
    );
    expect(afterFirstProfile.profile.choice).toBe("");
    expect(afterFirstProfile.payment.method).toBe("pix");
    expect(
      isSaleFormDirty(afterFirstProfile, salePresetFrom(remembered, 1))
    ).toBe(false);
  });

  it("o perfil lembrado com id continua valendo com a leitura em curso, sem perfil ou com perfis", () => {
    const remembered = {
      method: "pix" as const,
      profile: { id: PROFILE, version: 4 },
    };
    const expected = {
      method: "pix",
      profileChoice: PROFILE,
      profileVersion: 4,
    };
    for (const count of [null, 0, 1]) {
      expect(salePresetFrom(remembered, count)).toEqual(expected);
    }
  });

  it('a loja que ganha o primeiro perfil tira só o "Sem perfil" que a tela tinha marcado; o método fica', () => {
    const remembered = { method: "cash" as const, profile: null };
    const before = salePresetFrom(remembered, 0);
    const after = salePresetFrom(remembered, 1);
    const marked = applySalePreset(blank(), before);
    expect(marked.profile.choice).toBe(NO_PROFILE_CHOICE);
    expect(marked.payment.method).toBe("cash");
    const withdrawn = withdrawSalePreset(marked, before, after);
    expect(withdrawn.profile.choice).toBe("");
    expect(withdrawn.payment.method).toBe("cash");
    expect(isSaleFormDirty(withdrawn, after)).toBe(false);
    // a venda em andamento da pessoa fica como está
    const worked: SaleFormState = {
      ...marked,
      adjustments: [
        { draftId: "a1", kind: "discount", value: "5", valueType: "fixed" },
      ],
    };
    expect(withdrawSalePreset(worked, before, after)).toBe(worked);
    // o que a pessoa escolheu diferente do preset também
    const chosen: SaleFormState = {
      ...marked,
      profile: { choice: PROFILE, reviewNotice: null, seenVersion: 1 },
    };
    expect(withdrawSalePreset(chosen, before, after).profile.choice).toBe(
      PROFILE
    );
  });

  it("preenche só o que a pessoa não escolheu", () => {
    const preset = {
      method: "pix" as const,
      profileChoice: PROFILE,
      profileVersion: 4,
    };
    const filled = applySalePreset(blank(), preset);
    expect(filled.payment.method).toBe("pix");
    expect(filled.profile).toEqual({
      choice: PROFILE,
      reviewNotice: null,
      seenVersion: 4,
    });
    const chosen: SaleFormState = {
      ...blank(),
      payment: { ...blank().payment, method: "cash" },
      profile: {
        choice: NO_PROFILE_CHOICE,
        reviewNotice: null,
        seenVersion: null,
      },
    };
    expect(applySalePreset(chosen, preset)).toBe(chosen);
    // um perfil tirado com aviso para ler continua vazio: a pessoa escolhe de novo
    const cleared: SaleFormState = {
      ...blank(),
      profile: { choice: "", reviewNotice: "saiu", seenVersion: null },
    };
    expect(applySalePreset(cleared, preset).profile).toEqual(cleared.profile);
  });

  it("o que a tela escolheu não é venda em andamento; o que a pessoa troca é", () => {
    const preset = {
      method: "pix" as const,
      profileChoice: NO_PROFILE_CHOICE,
      profileVersion: null,
    };
    const filled = applySalePreset(blank(), preset);
    expect(isSaleFormDirty(filled, preset)).toBe(false);
    expect(isSaleFormDirty(filled)).toBe(true);
    expect(
      isSaleFormDirty(
        { ...filled, payment: { ...filled.payment, method: "cash" } },
        preset
      )
    ).toBe(true);
    expect(
      isSaleFormDirty(
        {
          ...filled,
          profile: { choice: PROFILE, reviewNotice: null, seenVersion: 1 },
        },
        preset
      )
    ).toBe(true);
    // um rascunho de antes, sem método, também não conta só por não bater com a lembrança
    expect(isSaleFormDirty(blank(), preset)).toBe(false);
  });

  it("o perfil lembrado que mudou desde a última venda pede revisar a prévia", () => {
    const form = applySalePreset(blank(), {
      method: "pix",
      profileChoice: PROFILE,
      profileVersion: 4,
    });
    const reloaded = reconcileProfileReload(form, [profileModel(5)]);
    expect(reloaded.profile.choice).toBe(PROFILE);
    expect(reloaded.profile.reviewNotice).toContain(
      "mudou desde a última venda"
    );
    expect(reconcileProfileReload(form, [profileModel(4)])).toBe(form);
    // o que saiu da lista é tirado com aviso, e o preset não o põe de volta
    const gone = reconcileProfileReload(form, []);
    expect(gone.profile.choice).toBe("");
    expect(applySalePreset(gone, salePresetFrom(null, 0)).profile.choice).toBe(
      ""
    );
  });
});
