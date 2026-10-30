import { fileURLToPath } from "node:url";
import {
  LEGAL_CONTENT_SLUGS,
  LEGAL_DOCUMENT_IDS,
  LEGAL_DOCUMENTS,
  type LegalDocumentId,
} from "@polaris/domain/legal/legal-documents";
import type { Plugin } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { legalBuildGuardPlugin } from "./legal-build-guard-plugin";

const company = {
  VITE_LEGAL_CONTATO_EMAIL: "contato@empresa.com.br",
  VITE_LEGAL_DPO_EMAIL: "dpo@empresa.com.br",
  VITE_LEGAL_ENDERECO: "Rua das Flores, 10, Centro",
  VITE_LEGAL_RAZAO_SOCIAL: "Agência Summit Serviços Digitais Ltda.",
};
const exportPrefix = /^export default /;
const exportSuffix = /;$/;
const contactEmail = /contato@empresa\.com\.br/;
const dpoEmail = /dpo@empresa\.com\.br/;
const templateId = (document: LegalDocumentId) =>
  `${fileURLToPath(
    new URL(
      `../src/legal/content/${LEGAL_CONTENT_SLUGS[document]}/v${LEGAL_DOCUMENTS[document].version}.md`,
      import.meta.url
    )
  )}?raw`;

function setUp(env: Record<string, string | undefined>, command: string) {
  const plugin = legalBuildGuardPlugin(env) as Plugin & {
    configResolved: (config: { command: string }) => void;
    load: (id: string) => string | null;
  };
  plugin.configResolved({ command });
  return plugin;
}

const exported = (code: string | null) =>
  JSON.parse((code ?? "").replace(exportPrefix, "").replace(exportSuffix, ""));

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the plugin that fills the templates", () => {
  it.each(LEGAL_DOCUMENT_IDS)(
    "loads %s with the values of the variables and no token",
    (document) => {
      vi.stubEnv("CLOUDFLARE_ENV", "production");
      const text = exported(setUp(company, "build").load(templateId(document)));
      expect(text).not.toContain("{{");
      expect(text).not.toContain("[preencher");
      expect(text).toMatch(document === "terms" ? contactEmail : dpoEmail);
      expect(text).toContain("Agência Summit Serviços Digitais Ltda.");
      expect(text).toContain("Rua das Flores, 10, Centro");
    }
  );

  it("loads the examples, which say so, in staging with no variable", () => {
    vi.stubEnv("CLOUDFLARE_ENV", "staging");
    const text = exported(setUp({}, "build").load(templateId("privacy")));
    expect(text).not.toContain("{{");
    expect(text).toContain("dpo-exemplo@example.com");
    expect(text).toContain("(endereço de exemplo)");
  });

  it("loads the examples on the dev server, whatever the environment says", () => {
    vi.stubEnv("CLOUDFLARE_ENV", "production");
    const text = exported(setUp({}, "serve").load(templateId("terms")));
    expect(text).not.toContain("{{");
    expect(text).toContain("contato-exemplo@example.com");
  });

  it("keeps the token of a production build with no variable, which the guard refuses", () => {
    vi.stubEnv("CLOUDFLARE_ENV", "production");
    const text = exported(setUp({}, "build").load(templateId("privacy")));
    expect(text).toContain("{{DPO_EMAIL}}");
  });

  it("leaves any other module to the default loader", () => {
    const plugin = setUp(company, "build");
    expect(plugin.load("/x/apps/web/src/main.tsx")).toBeNull();
    expect(
      plugin.load("/x/apps/web/src/legal/content/termos/v1.md")
    ).toBeNull();
  });
});
