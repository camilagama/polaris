import { describe, expect, it } from "vitest";
import {
  isProductAlreadyCreated,
  isProductLimitReached,
  productErrorMessage,
} from "./product-errors";

/** The limit text has no unit but the variant, no Assinatura, no archiving or deleting, and no number. */
const NOT_IN_LIMIT_TEXT = /produtos|assinatura|arquiv|exclu|\d/i;

const refusal = (code: string, reason?: string) =>
  Object.assign(new Error(code), {
    code,
    ...(reason ? { data: { reason } } : {}),
  });

describe("mensagem de erro de produto", () => {
  it("o aceite legal pendente tem texto próprio, para a leitura e para a escrita", () => {
    const error = refusal("FORBIDDEN", "legal_acceptance_required");
    expect(productErrorMessage(error)).toContain(
      "Não foi possível carregar os produtos"
    );
    expect(productErrorMessage(error, "create")).toContain("Não foi feito");
    // not the generic FORBIDDEN of the screen
    expect(productErrorMessage(error, "create")).not.toContain(
      "não tem acesso"
    );
  });

  it("sessão recusada: ler diz que não carregou, escrever diz que o produto não mudou", () => {
    expect(productErrorMessage(refusal("UNAUTHORIZED"))).toBe(
      "Não foi possível carregar os produtos."
    );
    expect(productErrorMessage(refusal("UNAUTHORIZED"), "archive")).toBe(
      "O produto não foi alterado."
    );
  });

  it("o conflito depende do que se fazia", () => {
    expect(productErrorMessage(refusal("CONFLICT"), "update")).toContain(
      "categoria pode ter sido arquivada"
    );
    expect(productErrorMessage(refusal("CONFLICT"), "restore")).toContain(
      "mudou em outra solicitação"
    );
    expect(productErrorMessage(refusal("CONFLICT"))).toContain(
      "mudou em outra solicitação"
    );
  });

  it("o limite de variantes do plano tem texto próprio no cadastro, sem número, sem Assinatura e sem mandar arquivar", () => {
    const limit = refusal("CONFLICT", "entitlement_limit_reached");
    const text = productErrorMessage(limit, "create");
    expect(text).toBe(
      "Seu plano chegou ao limite de variantes. Nada foi cadastrado."
    );
    expect(isProductLimitReached(limit)).toBe(true);
    expect(text).not.toMatch(NOT_IN_LIMIT_TEXT);
    // only the registration says it; the other actions keep their texts
    expect(productErrorMessage(limit, "update")).toContain("categoria pode");
    expect(productErrorMessage(limit, "restore")).toContain(
      "mudou em outra solicitação"
    );
    // the code decides first: the same reason under another code is not the limit
    expect(
      isProductLimitReached(refusal("BAD_REQUEST", "entitlement_limit_reached"))
    ).toBe(false);
    expect(isProductLimitReached(refusal("CONFLICT"))).toBe(false);
  });

  it("o texto da categoria vale só para os motivos de categoria; conflito sem motivo conhecido recebe o texto neutro", () => {
    for (const reason of [
      "product_category_unavailable",
      "category_deleted",
      "category_lifecycle_conflict",
    ]) {
      expect(
        productErrorMessage(refusal("CONFLICT", reason), "create")
      ).toContain("categoria selecionada");
    }
    const neutral =
      "Não foi possível cadastrar o produto agora. Atualize a lista e tente novamente.";
    for (const error of [
      refusal("CONFLICT"),
      refusal("CONFLICT", "motivo_que_nao_existe"),
      refusal("CONFLICT", "product_id_conflict"),
      refusal("CONFLICT", "entitlement_denied"),
    ]) {
      expect(productErrorMessage(error, "create")).toBe(neutral);
    }
  });

  it("o produto repetido com outros dados diz que já foi cadastrado, e não culpa a categoria", () => {
    const repeated = refusal("CONFLICT", "product_create_conflict");
    expect(productErrorMessage(repeated, "create")).toBe(
      "Este produto já foi cadastrado, com outros dados. Veja a lista e confira antes de cadastrar de novo."
    );
    expect(isProductAlreadyCreated(repeated)).toBe(true);
    expect(isProductAlreadyCreated(refusal("CONFLICT"))).toBe(false);
    expect(
      isProductAlreadyCreated(refusal("CONFLICT", "product_id_conflict"))
    ).toBe(false);
  });

  it("os demais códigos e o erro sem código", () => {
    expect(productErrorMessage(refusal("FORBIDDEN"))).toBe(
      "Sua conta não tem acesso a esta loja ou a esta ação."
    );
    expect(productErrorMessage(refusal("BAD_REQUEST"), "create")).toBe(
      "Informe um nome de produto válido."
    );
    expect(productErrorMessage(refusal("NOT_FOUND"), "update")).toBe(
      "O produto não existe mais nesta loja."
    );
    expect(productErrorMessage(refusal("SERVICE_UNAVAILABLE"))).toContain(
      "temporariamente indisponível"
    );
    expect(productErrorMessage(new Error("rede"), "archive")).toBe(
      "Não foi possível concluir a operação. Tente novamente."
    );
    expect(productErrorMessage("texto solto")).toBe(
      "Não foi possível concluir a operação. Tente novamente."
    );
  });
});
