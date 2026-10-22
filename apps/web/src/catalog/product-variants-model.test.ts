import type { ProductVariantOptionName } from "@polaris/contracts";
import { describe, expect, it } from "vitest";
import {
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
      "Sua conta não tem acesso a esta organização ou ação."
    );
  });

  it("cada código tem a sua frase", () => {
    expect(variantErrorMessage(refusal("FORBIDDEN"))).toBe(
      "Sua conta não tem acesso a esta organização ou ação."
    );
    expect(variantErrorMessage(refusal("BAD_REQUEST"))).toBe(
      "Revise os valores e as combinações informadas."
    );
    expect(variantErrorMessage(refusal("NOT_FOUND"))).toBe(
      "O produto não existe mais nesta organização."
    );
    expect(variantErrorMessage(refusal("CONFLICT"))).toContain(
      "Atualize a lista"
    );
    expect(variantErrorMessage(refusal("SERVICE_UNAVAILABLE"))).toContain(
      "temporariamente indisponível"
    );
    expect(variantErrorMessage(new Error("rede"))).toBe(
      "Não foi possível carregar ou salvar as variantes. Tente novamente."
    );
  });

  it("o conflito do SKU fala do SKU; os outros erros seguem a regra geral", () => {
    expect(variantSkuErrorMessage(refusal("CONFLICT"))).toContain(
      "O SKU já está em uso"
    );
    expect(variantSkuErrorMessage(refusal("NOT_FOUND"))).toBe(
      variantErrorMessage(refusal("NOT_FOUND"))
    );
  });
});
