import { describe, expect, it } from "vitest";
import { withoutRetryAsk } from "./retry-notice";

describe("withoutRetryAsk", () => {
  it.each([
    [
      "Não foi possível carregar o estoque. Tente novamente.",
      "Não foi possível carregar o estoque.",
    ],
    [
      "Não foi possível carregar os perfis: a conexão falhou. Tente novamente.",
      "Não foi possível carregar os perfis: a conexão falhou.",
    ],
    [
      "O catálogo está temporariamente indisponível. Tente novamente.",
      "O catálogo está temporariamente indisponível.",
    ],
  ])("tira o pedido que fecha a frase: %s", (sentence, expected) => {
    expect(withoutRetryAsk(sentence)).toBe(expected);
  });

  it.each([
    "Os dados mudaram. Atualize a lista e tente novamente.",
    "Verifique a conexão e tente de novo.",
    "Não foi possível carregar o estoque.",
    "Tente novamente antes de salvar.",
    "",
  ])("não mexe em outra frase: %s", (sentence) => {
    expect(withoutRetryAsk(sentence)).toBe(sentence);
  });
});
