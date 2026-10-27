import type { ProductVariantOptionName } from "@polaris/contracts";
import { describe, expect, it } from "vitest";
import {
  clearDefaultSkuLabel,
  clearedDefaultSkuNotice,
  duplicateSkuMessage,
  emptyConfigurationDraft,
  isConfigurationDraftEmpty,
  isDuplicateSkuError,
  MAX_VARIANTS,
  optionLabel,
  optionValuesError,
  parseOptionValues,
  productOptionValues,
  selectedOptionNames,
  validateVariantDrafts,
  variantErrorMessage,
  variantLabel,
  variantSkuErrorMessage,
} from "./product-variants-model";

/** The limit text blames no change of the product, and has no number and no archiving. */
const NOT_IN_LIMIT_TEXT = /mudou|já foram configuradas|\d|arquiv/;

const refusal = (code: string, reason?: string) =>
  Object.assign(new Error(code), {
    code,
    ...(reason ? { data: { reason } } : {}),
  });

describe("valores das opções, um por linha", () => {
  it("separa por linha (LF e CRLF), apara espaços e descarta linhas vazias", () => {
    expect(parseOptionValues(" Azul \r\n\r\nPreta\n  \nVerde")).toEqual([
      "Azul",
      "Preta",
      "Verde",
    ]);
  });

  it("pede ao menos um valor", () => {
    expect(optionValuesError([])).toBe(
      "Informe ao menos um valor, um por linha."
    );
  });

  it("recusa repetidos sem diferenciar maiúsculas, e aceita valores distintos", () => {
    expect(optionValuesError(["Azul", "azul"])).toBe(
      "Remova valores repetidos nesta opção."
    );
    expect(optionValuesError(["Azul", "Preta"])).toBeNull();
  });

  it("lê as três opções de uma vez", () => {
    expect(
      productOptionValues({ color: "Azul\nPreta", model: "", size: "P" })
    ).toEqual({ color: ["Azul", "Preta"], model: [], size: ["P"] });
  });
});

describe("opções marcadas", () => {
  it("saem sempre na ordem Modelo, Cor, Tamanho, não na ordem do clique", () => {
    expect(selectedOptionNames(["size", "model", "color"])).toEqual([
      "model",
      "color",
      "size",
    ]);
  });

  it("o nome de cada opção vem em português", () => {
    expect(optionLabel("model")).toBe("Modelo");
    expect(optionLabel("color")).toBe("Cor");
    expect(optionLabel("size")).toBe("Tamanho");
  });
});

describe("validação das combinações", () => {
  const values = { color: ["Azul", "Preta"], model: [], size: ["P", "M"] };
  const names: ProductVariantOptionName[] = ["color", "size"];

  it("sem opção marcada nada se adiciona nem se salva", () => {
    const result = validateVariantDrafts([], values, []);
    expect(result.canAdd).toBe(false);
    expect(result.canSubmit).toBe(false);
  });

  it("com opções válidas já se pode adicionar, mas salvar pede ao menos uma combinação completa", () => {
    expect(validateVariantDrafts(names, values, []).canAdd).toBe(true);
    expect(validateVariantDrafts(names, values, []).canSubmit).toBe(false);
    expect(
      validateVariantDrafts(names, values, [
        { values: { color: "Azul", size: "P" } },
      ]).canSubmit
    ).toBe(true);
  });

  it("combinação com opção sem valor, ou com valor que não está na lista, não salva", () => {
    expect(
      validateVariantDrafts(names, values, [
        { values: { color: "Azul", size: "" } },
      ]).canSubmit
    ).toBe(false);
    expect(
      validateVariantDrafts(names, values, [
        { values: { color: "Verde", size: "P" } },
      ]).canSubmit
    ).toBe(false);
  });

  it("duas combinações iguais (sem diferenciar maiúsculas) não salvam e dizem que não são únicas", () => {
    const result = validateVariantDrafts(names, values, [
      { values: { color: "Azul", size: "P" } },
      { values: { color: "azul", size: "p" } },
    ]);
    expect(result.combinationsAreUnique).toBe(false);
    expect(result.canSubmit).toBe(false);
  });

  it("linhas ainda sem todos os valores não contam como repetidas (P-5), mas também não salvam", () => {
    const empty = validateVariantDrafts(names, values, [
      { values: { color: "", size: "" } },
      { values: { color: "", size: "" } },
    ]);
    expect(empty.combinationsAreUnique).toBe(true);
    expect(empty.canSubmit).toBe(false);
    const partial = validateVariantDrafts(names, values, [
      { values: { color: "Azul", size: "" } },
      { values: { color: "Azul", size: "" } },
    ]);
    expect(partial.combinationsAreUnique).toBe(true);
    expect(partial.canSubmit).toBe(false);
  });

  it("uma linha vazia ao lado de duas iguais e completas não esconde a repetição", () => {
    const result = validateVariantDrafts(names, values, [
      { values: { color: "", size: "" } },
      { values: { color: "Azul", size: "P" } },
      { values: { color: "Azul", size: "P" } },
    ]);
    expect(result.combinationsAreUnique).toBe(false);
  });

  it("uma opção com valores inválidos trava tanto o adicionar quanto o salvar", () => {
    const result = validateVariantDrafts(names, { ...values, size: [] }, [
      { values: { color: "Azul", size: "P" } },
    ]);
    expect(result.invalidOptions).toEqual(["size"]);
    expect(result.canAdd).toBe(false);
    expect(result.canSubmit).toBe(false);
  });

  it(`o teto é de ${MAX_VARIANTS}: com ${MAX_VARIANTS} não se adiciona mais, e ${MAX_VARIANTS + 1} não salva`, () => {
    const many = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        values: { color: `Cor ${index}` },
      }));
    const colors = {
      color: Array.from({ length: MAX_VARIANTS + 1 }, (_, i) => `Cor ${i}`),
      model: [],
      size: [],
    };
    const atLimit = validateVariantDrafts(
      ["color"],
      colors,
      many(MAX_VARIANTS)
    );
    expect(atLimit.canAdd).toBe(false);
    expect(atLimit.canSubmit).toBe(true);
    expect(
      validateVariantDrafts(["color"], colors, many(MAX_VARIANTS + 1)).canSubmit
    ).toBe(false);
  });
});

describe("rótulo da variante", () => {
  const variant = (
    overrides: Partial<Parameters<typeof variantLabel>[0]>
  ): Parameters<typeof variantLabel>[0] => ({
    id: "v",
    isDefault: false,
    listPrice: null,
    position: null,
    sku: null,
    values: [],
    ...overrides,
  });

  it("a variante padrão sem valores é 'Variante padrão'", () => {
    expect(variantLabel(variant({ isDefault: true }), 0)).toBe(
      "Variante padrão"
    );
  });

  it("as configuradas listam opção: valor, na ordem em que vieram", () => {
    expect(
      variantLabel(
        variant({
          values: [
            {
              optionName: "color",
              optionValueId: "v1",
              optionValueName: "Azul",
            },
            { optionName: "size", optionValueId: "v2", optionValueName: "M" },
          ],
        }),
        2
      )
    ).toBe("Cor: Azul · Tamanho: M");
  });

  it("sem valores e não padrão, cai no número da posição", () => {
    expect(variantLabel(variant({}), 2)).toBe("Variante 3");
  });
});

describe("mensagens de erro das variantes", () => {
  it("falta de aceite legal tem texto próprio, não o genérico", () => {
    const error = refusal("FORBIDDEN", "legal_acceptance_required");
    expect(variantErrorMessage(error, "as variantes")).toContain(
      "Não foi possível carregar as variantes"
    );
    expect(variantErrorMessage(error)).not.toBe(
      "Sua conta não tem acesso a esta loja ou a esta ação."
    );
  });

  it("cada código tem a sua frase", () => {
    expect(variantErrorMessage(refusal("FORBIDDEN"))).toBe(
      "Sua conta não tem acesso a esta loja ou a esta ação."
    );
    expect(variantErrorMessage(refusal("BAD_REQUEST"))).toBe(
      "Revise os valores e as combinações informadas."
    );
    expect(variantErrorMessage(refusal("NOT_FOUND"))).toBe(
      "O produto não existe mais nesta loja."
    );
    expect(variantErrorMessage(refusal("CONFLICT"))).toContain(
      "Confira as variantes"
    );
    // the plan's limit is said as the limit, never as "the product changed" (L1 of the corte 1.6, AC-1)
    expect(
      variantErrorMessage(refusal("CONFLICT", "entitlement_limit_reached"))
    ).toBe("Seu plano chegou ao limite de variantes. Nada foi alterado.");
    expect(
      variantErrorMessage(refusal("CONFLICT", "entitlement_limit_reached"))
    ).not.toMatch(NOT_IN_LIMIT_TEXT);
    // the other conflicts keep their text
    expect(
      variantErrorMessage(refusal("CONFLICT", "product_version_conflict"))
    ).toBe(
      "O produto mudou ou as variantes já foram configuradas. Confira as variantes e tente novamente."
    );
    expect(variantErrorMessage(refusal("SERVICE_UNAVAILABLE"))).toContain(
      "temporariamente indisponível"
    );
    expect(variantErrorMessage(new Error("rede"))).toBe(
      "Não foi possível carregar ou salvar as variantes. Tente novamente."
    );
  });

  it("SKU repetido é dito no campo, com o SKU, e nunca se confunde com o produto que mudou (U-14)", () => {
    const duplicate = refusal("CONFLICT", "duplicate_sku");
    expect(isDuplicateSkuError(duplicate)).toBe(true);
    expect(
      isDuplicateSkuError(refusal("CONFLICT", "product_version_conflict"))
    ).toBe(false);
    expect(isDuplicateSkuError(refusal("CONFLICT"))).toBe(false);
    expect(isDuplicateSkuError(refusal("BAD_REQUEST", "duplicate_sku"))).toBe(
      false
    );
    expect(duplicateSkuMessage("  CAM-001 ")).toBe(
      "O SKU CAM-001 já está em uso por outra variante. Use outro código."
    );
  });

  it("o conflito de versão fala do produto; os outros erros seguem a regra geral", () => {
    expect(variantSkuErrorMessage(refusal("CONFLICT"))).toBe(
      "O produto mudou. Atualize as variantes antes de tentar novamente."
    );
    expect(variantSkuErrorMessage(refusal("NOT_FOUND"))).toBe(
      variantErrorMessage(refusal("NOT_FOUND"))
    );
  });
});

describe("draft of the configuration kept by the dialog", () => {
  it("is empty with nothing picked or typed, and not with an option, a value line or a combination", () => {
    expect(isConfigurationDraftEmpty(emptyConfigurationDraft)).toBe(true);
    expect(
      isConfigurationDraftEmpty({
        ...emptyConfigurationDraft,
        selectedOptions: ["color"],
      })
    ).toBe(false);
    expect(
      isConfigurationDraftEmpty({
        ...emptyConfigurationDraft,
        valueLines: { ...emptyConfigurationDraft.valueLines, size: "P" },
      })
    ).toBe(false);
    expect(
      isConfigurationDraftEmpty({
        ...emptyConfigurationDraft,
        variants: [{ values: {} }],
      })
    ).toBe(false);
  });
});

describe("the SKU the warning's button erases", () => {
  it("the button names the SKU of the default variant", () => {
    expect(clearDefaultSkuLabel("ABC-123")).toBe(
      'Limpar SKU "ABC-123" da variante padrão'
    );
  });

  it("the notice after the action names it too", () => {
    expect(clearedDefaultSkuNotice("ABC-123")).toBe(
      'SKU "ABC-123" apagado da variante padrão.'
    );
  });
});
