import { describe, expect, it } from "vitest";
import {
  fillLegalCompanyFields,
  findUnfilledFields,
  LEGAL_COMPANY_FIELDS,
} from "./legal-company";

const legalVariable = /^VITE_LEGAL_[A-Z_]+$/;

describe("the company tokens", () => {
  it("name four distinct tokens, each with its own VITE_LEGAL_ variable and an example that says so", () => {
    expect(LEGAL_COMPANY_FIELDS.map((field) => field.token)).toEqual([
      "{{EMPRESA_RAZAO_SOCIAL}}",
      "{{EMPRESA_ENDERECO}}",
      "{{CONTATO_EMAIL}}",
      "{{DPO_EMAIL}}",
    ]);
    expect(new Set(LEGAL_COMPANY_FIELDS.map((f) => f.env)).size).toBe(4);
    for (const { env, example } of LEGAL_COMPANY_FIELDS) {
      expect(env).toMatch(legalVariable);
      expect(example).toContain("exemplo");
    }
  });

  it("fills every occurrence of a token and leaves the dollar patterns of a value alone", () => {
    expect(
      fillLegalCompanyFields(
        "a {{DPO_EMAIL}} b {{DPO_EMAIL}} c {{CONTATO_EMAIL}}",
        {
          "{{CONTATO_EMAIL}}": "c@x.com",
          "{{DPO_EMAIL}}": "$&d$1@x.com",
        }
      )
    ).toBe("a $&d$1@x.com b $&d$1@x.com c c@x.com");
  });

  it("leaves a token with no value, and an unknown one, as they are", () => {
    const text = "{{DPO_EMAIL}} {{OUTRA}}";
    expect(fillLegalCompanyFields(text, {})).toBe(text);
  });

  it("finds the tokens left in a text, closed or not", () => {
    expect(findUnfilledFields("a {{X}} b {{Y_Z}} c {{aberta\nok")).toEqual([
      "{{X}}",
      "{{Y_Z}}",
      "{{aberta",
    ]);
    expect(findUnfilledFields("sem fichas { } {")).toEqual([]);
  });
});
