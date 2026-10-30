import { fileURLToPath } from "node:url";
import {
  LEGAL_CONTENT_SLUGS,
  LEGAL_DOCUMENT_IDS,
  LEGAL_DOCUMENTS,
  type LegalDocumentId,
} from "@polaris/domain/legal/legal-documents";
import { build, type Plugin } from "vite";
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

describe("the plugin in a real build", () => {
  const content = fileURLToPath(
    new URL("../src/legal/legal-content.ts", import.meta.url)
  );
  const virtualEntry = "virtual:legal-entry";
  const entryPlugin: Plugin = {
    load: (id) =>
      id === `\0${virtualEntry}`
        ? `import { currentLegalText } from ${JSON.stringify(content)};\nconsole.log(currentLegalText("privacy"), currentLegalText("terms"));`
        : null,
    name: "test:entry",
    resolveId: (id) => (id === virtualEntry ? `\0${virtualEntry}` : null),
  };
  const bundle = async (
    plugin: Plugin,
    environment: Record<string, string>
  ): Promise<string> => {
    for (const [name, value] of Object.entries(environment)) {
      vi.stubEnv(name, value);
    }
    const output = await build({
      build: {
        rolldownOptions: { input: virtualEntry },
        write: false,
      },
      configFile: false,
      logLevel: "silent",
      plugins: [entryPlugin, plugin],
    });
    const outputs = Array.isArray(output) ? output : [output];
    return outputs
      .flatMap((item) => ("output" in item ? item.output : []))
      .map((chunk) => ("code" in chunk ? chunk.code : ""))
      .join("\n");
  };

  it("puts the values of the variables, and no token, in the bundle of a staging build", async () => {
    const code = await bundle(legalBuildGuardPlugin(company), {
      CLOUDFLARE_ENV: "staging",
    });
    expect(code).toContain("Agência Summit Serviços Digitais Ltda.");
    expect(code).toContain("dpo@empresa.com.br");
    expect(code).toContain("contato@empresa.com.br");
    expect(code).not.toContain("{{DPO_EMAIL}}");
    expect(code).not.toContain("{{EMPRESA_ENDERECO}}");
  });

  it("stops a production build that has no variable, naming each one", async () => {
    await expect(
      bundle(legalBuildGuardPlugin({}), { CLOUDFLARE_ENV: "production" })
    ).rejects.toThrow("VITE_LEGAL_DPO_EMAIL ausente ou vazia");
  });

  it("only fills, with the examples, in a lab build that does not check", async () => {
    const code = await bundle(legalBuildGuardPlugin({}, { check: false }), {
      CLOUDFLARE_ENV: "production",
    });
    expect(code).not.toContain("{{DPO_EMAIL}}");
    expect(code).toContain("dpo-exemplo@example.com");
  });
});
