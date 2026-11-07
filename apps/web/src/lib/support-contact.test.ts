import { readFileSync } from "node:fs";
import { LEGAL_COMPANY_FIELDS } from "@polaris/domain/legal/legal-company";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mailtoHref, supportContactOf } from "./support-contact";

const A_PLAIN_ADDRESS = /^[^@\s{}]+@[^@\s{}]+$/;
const SOURCE = readFileSync(
  new URL("support-contact.ts", import.meta.url),
  "utf8"
);

function fieldOf(token: string) {
  const field = LEGAL_COMPANY_FIELDS.find((item) => item.token === token);
  if (!field) {
    throw new Error(token);
  }
  return field;
}

describe("supportContactOf", () => {
  it("gives the support and the DPO addresses the build carries", () => {
    expect(
      supportContactOf({
        VITE_LEGAL_CONTATO_EMAIL: "suporte@loja.com.br",
        VITE_LEGAL_DPO_EMAIL: "dpo@loja.com.br",
      })
    ).toEqual({
      dpoEmail: "dpo@loja.com.br",
      supportEmail: "suporte@loja.com.br",
    });
  });

  it("trims what the build carries, as the legal texts do", () => {
    expect(
      supportContactOf({ VITE_LEGAL_CONTATO_EMAIL: "  suporte@loja.com.br \n" })
        .supportEmail
    ).toBe("suporte@loja.com.br");
  });

  it("takes the example of the legal field where the variable is absent or empty: what the Terms show outside production", () => {
    for (const env of [
      {},
      { VITE_LEGAL_CONTATO_EMAIL: "" },
      { VITE_LEGAL_CONTATO_EMAIL: "   " },
    ]) {
      expect(supportContactOf(env).supportEmail).toBe(
        fieldOf("{{CONTATO_EMAIL}}").example
      );
    }
    expect(supportContactOf({}).dpoEmail).toBe(
      fieldOf("{{DPO_EMAIL}}").example
    );
  });

  it("never gives an empty address or a token", () => {
    for (const env of [{}, { VITE_LEGAL_CONTATO_EMAIL: "x@loja.com.br" }]) {
      const { dpoEmail, supportEmail } = supportContactOf(env);
      for (const address of [dpoEmail, supportEmail]) {
        expect(address).toMatch(A_PLAIN_ADDRESS);
      }
    }
  });
});

describe("the source of the address (AC-2)", () => {
  it("is the variable that fills {{CONTATO_EMAIL}} in the Terms, and the DPO one that fills {{DPO_EMAIL}}", () => {
    expect(fieldOf("{{CONTATO_EMAIL}}").env).toBe("VITE_LEGAL_CONTATO_EMAIL");
    expect(fieldOf("{{DPO_EMAIL}}").env).toBe("VITE_LEGAL_DPO_EMAIL");
    expect(SOURCE).toContain("import.meta.env.VITE_LEGAL_CONTATO_EMAIL");
    expect(SOURCE).toContain("import.meta.env.VITE_LEGAL_DPO_EMAIL");
  });
});

describe("the constants of the module", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("read the variables of the build", async () => {
    vi.stubEnv("VITE_LEGAL_CONTATO_EMAIL", "suporte@loja.com.br");
    vi.stubEnv("VITE_LEGAL_DPO_EMAIL", "dpo@loja.com.br");
    vi.resetModules();
    const module = await import("./support-contact");
    expect(module.SUPPORT_EMAIL).toBe("suporte@loja.com.br");
    expect(module.DPO_EMAIL).toBe("dpo@loja.com.br");
  });
});

describe("mailtoHref", () => {
  it("is mailto: and the address", () => {
    expect(mailtoHref("suporte@loja.com.br")).toBe(
      "mailto:suporte@loja.com.br"
    );
  });

  it("encodes the local part, so a % or a + is not read as something else", () => {
    expect(mailtoHref("a%41+b@loja.com.br")).toBe(
      "mailto:a%2541%2Bb@loja.com.br"
    );
  });
});
