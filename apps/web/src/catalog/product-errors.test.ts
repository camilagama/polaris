import { describe, expect, it } from "vitest";
import { productErrorMessage } from "./product-errors";

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
    expect(productErrorMessage(refusal("CONFLICT"), "create")).toContain(
      "categoria selecionada"
    );
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

  it("os demais códigos e o erro sem código", () => {
    expect(productErrorMessage(refusal("FORBIDDEN"))).toBe(
      "Sua conta não tem acesso a esta organização ou ação."
    );
    expect(productErrorMessage(refusal("BAD_REQUEST"), "create")).toBe(
      "Informe um nome de produto válido."
    );
    expect(productErrorMessage(refusal("NOT_FOUND"), "update")).toBe(
      "O produto não existe mais nesta organização."
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
